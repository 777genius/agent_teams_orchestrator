#!/usr/bin/env python3
"""Inert contract tests. No Docker container, Owner, model, or agent is started."""

import importlib.util
import array
import copy
import hashlib
import io
import json
import os
from pathlib import Path
from contextlib import redirect_stderr
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("handoff", Path(__file__).with_name("handoff.py"))
handoff = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(handoff)


def arguments():
    return handoff.parse_args([
        "--container-id", "a" * 64,
        "--handle", "opencode_" + "b" * 32,
        "--generation", "b" * 32,
        "--network-id", "c" * 64,
        "--pid", "12345",
        "--start-ticks", "987654321",
        "--netns", "net:[4026532999]",
        "--binary-sha256", handoff.OFFICIAL_BINARY_SHA,
    ])


def inspection(args):
    return {
        "Id": args.container_id,
        "Name": "/" + args.handle,
        "Config": {"Labels": {handoff.GENERATION_LABEL: args.generation}},
        "State": {"Running": True, "Pid": args.pid},
        "NetworkSettings": {"Networks": {"one": {"NetworkID": args.network_id}}},
    }


def authority_config(args, db_path):
    run_id = "run_" + "1" * 32
    member_id = "member_" + "2" * 32
    plan_sha = "a" * 64
    operation_id = "start_" + hashlib.sha256(
        b"agent-teams.hosted-opencode-member-start/v1\0" +
        json.dumps([run_id, member_id, plan_sha], separators=(",", ":")).encode()).hexdigest()
    return {
        "version": 1,
        "databasePath": str(db_path),
        "expectedProductUid": os.getuid(),
        "binding": {
            "runId": run_id, "memberId": member_id, "teamId": "team_" + "3" * 32,
            "laneId": "lane_" + "4" * 32, "deploymentId": "deployment_fixture1234",
            "runtimeWorkspaceId": "workspace_" + "5" * 32,
            "planSha256": plan_sha, "rosterBindingSha256": "b" * 64,
            "restoreGeneration": 0, "mountGeneration": 1, "operationId": operation_id,
        },
        "container": {
            "containerId": args.container_id, "handle": args.handle,
            "generation": args.generation, "networkId": args.network_id,
            "pid": args.pid, "startTicks": args.start_ticks, "netns": args.netns,
            "binarySha256": args.binary_sha256,
        },
    }


def synthetic_authority_directory():
    temp = tempfile.TemporaryDirectory(prefix="fd3-product-fence-")
    directory = Path(temp.name).resolve()
    directory.chmod(0o700)
    return temp, directory


def current_member(config):
    """Canonical decision shape only; this fixture is not a Product validator."""
    member = {key: value for key, value in config["binding"].items() if key != "operationId"}
    member.update({
        "workspaceId": "workspace_" + "6" * 32, "actorId": "actor_fixture1234",
        "bootId": "boot_fixture1234", "promotionOperationId": "promotion_" + "7" * 32,
        "memberName": "builder", "model": "qwen/model", "promptSha256": "c" * 64,
        "admittedWorkspaceRoot": "/sandbox/workspace", "grantRevision": "d" * 64,
        "grantGeneration": config["binding"]["restoreGeneration"], "laneOrdinal": 0,
        "memberOrdinal": 0,
    })
    return member


class ExactClaimContractTest(unittest.TestCase):
    def setUp(self):
        self.config = authority_config(arguments(), "/unused/product.sqlite")
        self.current = current_member(self.config)

    def check(self, current=None, owner_binding=None, owner_container=None):
        handoff.assert_exact_handoff_claim(
            self.current if current is None else current, self.config["binding"],
            self.config["container"], self.config["binding"] if owner_binding is None else owner_binding,
            self.config["container"] if owner_container is None else owner_container)

    def test_exact_decision_and_owner_claim_projections_match(self):
        self.check()
        # Mapping insertion order is not authority.
        self.check(owner_binding=dict(reversed(list(self.config["binding"].items()))))

    def test_stale_product_member_plan_and_epoch_are_rejected(self):
        replacements = {
            "runId": "run_" + "f" * 32, "memberId": "member_" + "f" * 32,
            "teamId": "team_" + "f" * 32, "laneId": "lane_" + "f" * 32,
            "deploymentId": "deployment_stale1234", "runtimeWorkspaceId": "workspace_" + "f" * 32,
            "planSha256": "f" * 64, "rosterBindingSha256": "f" * 64,
            "restoreGeneration": 1, "mountGeneration": 2,
        }
        for field, value in replacements.items():
            for source in ("current", "owner_binding"):
                changed = copy.deepcopy(self.current if source == "current" else self.config["binding"])
                changed[field] = value
                with self.subTest(field=field, source=source), self.assertRaises(handoff.HandoffError):
                    self.check(**{source: changed})
        changed = dict(self.config["binding"], operationId="start_" + "f" * 64)
        with self.assertRaises(handoff.HandoffError):
            self.check(owner_binding=changed)

    def test_owner_claim_cannot_change_any_dispatch_target_field(self):
        replacements = {
            "containerId": "f" * 64, "handle": "opencode_" + "f" * 32,
            "generation": "f" * 32, "networkId": "f" * 64, "pid": 12346,
            "startTicks": "987654322", "netns": "net:[4026533000]", "binarySha256": "f" * 64,
        }
        for field, value in replacements.items():
            changed = dict(self.config["container"], **{field: value})
            with self.subTest(field=field), self.assertRaises(handoff.HandoffError):
                self.check(owner_container=changed)

    def test_ambiguous_types_missing_fields_and_unknown_fields_are_rejected(self):
        for source, original in (("current", self.current), ("owner_binding", self.config["binding"]),
                                 ("owner_container", self.config["container"])):
            invalid = [None, [], dict(original, unexpected=True)]
            missing = dict(original)
            missing.pop(next(iter(missing)))
            invalid.append(missing)
            field = "pid" if source == "owner_container" else "mountGeneration"
            for value in (True, float(original[field]), str(original[field])):
                invalid.append(dict(original, **{field: value}))
            for value in invalid:
                with self.subTest(source=source, value=value), self.assertRaises(handoff.HandoffError):
                    # Call directly so None cannot select the fixture default.
                    inputs = {"current_member": self.current, "owner_binding": self.config["binding"],
                              "owner_container": self.config["container"]}
                    inputs["current_member" if source == "current" else source] = value
                    handoff.assert_exact_handoff_claim(binding=self.config["binding"],
                                                      container=self.config["container"], **inputs)


class HandoffContractTest(unittest.TestCase):
    def test_private_generation_config_binds_exact_container_member_and_db(self):
        args = arguments()
        temp, directory = synthetic_authority_directory()
        try:
            db_path = directory / "product.sqlite"
            config = authority_config(args, db_path)
            path = directory / f"member-{args.generation}.json"
            path.write_bytes(handoff.canonical_json(config))
            path.chmod(0o600)
            with patch.object(handoff, "AUTHORITY_CONFIG_DIRECTORY", str(directory)):
                self.assertEqual(handoff.load_authority_config(args, test_only=True), config)
                forged = arguments()
                forged.container_id = "f" * 64
                with self.assertRaisesRegex(handoff.HandoffError, "authority-container"):
                    handoff.load_authority_config(forged, test_only=True)
                config["binding"]["memberId"] = "member_" + "f" * 32
                path.write_bytes(handoff.canonical_json(config))
                with self.assertRaisesRegex(handoff.HandoffError, "authority-binding"):
                    handoff.load_authority_config(args, test_only=True)
                config["binding"]["memberId"] = "member_" + "2" * 32
                path.write_bytes(b" " + handoff.canonical_json(config))
                with self.assertRaisesRegex(handoff.HandoffError, "authority-config-canonical"):
                    handoff.load_authority_config(args, test_only=True)
        finally:
            temp.cleanup()

    def test_missing_config_and_default_product_policy_refuse_transfer(self):
        args = arguments()
        temp, directory = synthetic_authority_directory()
        try:
            with patch.object(handoff, "AUTHORITY_CONFIG_DIRECTORY", str(directory)):
                with self.assertRaises(FileNotFoundError):
                    handoff.load_authority_config(args, test_only=True)
            db_path = directory / "product.sqlite"
            db = sqlite3.connect(db_path)
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA user_version=33")
            db.close()
            db_path.chmod(0o600)
            fence = handoff.ProductMemberFence(authority_config(args, db_path), test_only=True)
            with self.assertRaisesRegex(handoff.HandoffError, "product-authority-unavailable"):
                fence.begin()
            self.assertIsNone(fence.connection)
        finally:
            temp.cleanup()

    def test_synthetic_writer_lock_is_retained_through_exact_fd_send(self):
        args = arguments()
        temp, directory = synthetic_authority_directory()
        sender = recipient = owner = carried = None
        try:
            db_path = directory / "product.sqlite"
            db = sqlite3.connect(db_path)
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA user_version=33")
            db.execute("CREATE TABLE synthetic_revocation(value INTEGER)")
            db.execute("INSERT INTO synthetic_revocation VALUES (0)")
            db.commit()
            db.close()
            db_path.chmod(0o600)
            config = authority_config(args, db_path)
            fence = handoff.ProductMemberFence(config, test_only=True)
            revoker = sqlite3.connect(db_path, timeout=0)
            sender, recipient = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
            owner, carried = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
            # The real validator is intentionally unavailable. Exercise only the
            # exact comparison and transaction/send boundary with inert fixtures.
            def fixture_check():
                self.assertTrue(fence.connection.in_transaction)
                handoff.assert_exact_handoff_claim(current_member(config), config["binding"],
                    config["container"], dict(config["binding"]), dict(config["container"]))

            with patch.object(handoff.ProductMemberFence, "assert_current", side_effect=fixture_check):
                fence.begin()
                with self.assertRaises(sqlite3.OperationalError):
                    revoker.execute("UPDATE synthetic_revocation SET value=1")
                attempt = handoff.HandoffAttempt()
                fence.assert_current()
                attempt.send(sender, carried)
                marker, ancillary, _flags, _address = recipient.recvmsg(1, socket.CMSG_SPACE(4))
                self.assertEqual(marker, b"F")
                received = array.array("i")
                received.frombytes(ancillary[0][2][:received.itemsize])
                os.close(received[0])
                with self.assertRaises(sqlite3.OperationalError):
                    revoker.execute("UPDATE synthetic_revocation SET value=1")
                fence.finish()
            revoker.execute("UPDATE synthetic_revocation SET value=1")
            revoker.commit()
            self.assertEqual(revoker.execute("SELECT value FROM synthetic_revocation").fetchone(), (1,))
            revoker.close()
        finally:
            if sender: sender.close()
            if recipient: recipient.close()
            if owner: owner.close()
            if carried: carried.close()
            temp.cleanup()

    def test_only_pinned_official_binary_is_accepted(self):
        args = arguments()
        self.assertEqual(args.binary_sha256, handoff.OFFICIAL_BINARY_SHA)
        with self.assertRaises(handoff.HandoffError):
            handoff.parse_args([
                "--container-id", args.container_id, "--handle", args.handle,
                "--generation", args.generation, "--network-id", args.network_id,
                "--pid", str(args.pid), "--start-ticks", args.start_ticks,
                "--netns", args.netns, "--binary-sha256", "0" * 64,
            ])

    def test_delivered_fd_is_uncertain_until_post_exec_and_supervisor_proof(self):
        sender, recipient = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        owner, carried = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            attempt = handoff.HandoffAttempt()
            attempt.send(sender, carried)
            marker, ancillary, _flags, _address = recipient.recvmsg(1, socket.CMSG_SPACE(4))
            self.assertEqual(marker, b"F")
            self.assertEqual(len(ancillary), 1)
            received = array.array("i")
            received.frombytes(ancillary[0][2][:received.itemsize])
            os.close(received[0])
            with self.assertRaises(handoff.HandoffUncertain):
                attempt.fail(handoff.HandoffError("post-exec-timeout"))

            not_sent = handoff.HandoffAttempt()
            with self.assertRaises(handoff.HandoffError) as failure:
                not_sent.fail(handoff.HandoffError("pre-transfer"))
            self.assertNotIsInstance(failure.exception, handoff.HandoffUncertain)
        finally:
            sender.close()
            recipient.close()
            owner.close()
            carried.close()

    def test_uncertain_transfer_has_distinct_process_exit_status(self):
        with patch.object(handoff, "parse_args", return_value=arguments()), \
                patch.object(handoff, "handoff", side_effect=handoff.HandoffUncertain()), \
                redirect_stderr(io.StringIO()) as output:
            self.assertEqual(handoff.main(), 2)
        self.assertEqual(output.getvalue(), "hosted-fd3-handoff:uncertain-transfer\n")

    def test_docker_inspection_requires_exact_generation_process_and_network(self):
        args = arguments()
        correct = inspection(args)
        wrongs = []
        for path, value in [
            (("Id",), "d" * 64),
            (("Name",), "/foreign"),
            (("Config", "Labels", handoff.GENERATION_LABEL), "d" * 32),
            (("State", "Running"), False),
            (("State", "Pid"), args.pid + 1),
            (("NetworkSettings", "Networks", "one", "NetworkID"), "d" * 64),
        ]:
            row = json.loads(json.dumps(correct))
            node = row
            for key in path[:-1]:
                node = node[key]
            node[path[-1]] = value
            wrongs.append(row)
        extra_network = json.loads(json.dumps(correct))
        extra_network["NetworkSettings"]["Networks"]["other"] = {"NetworkID": "e" * 64}
        wrongs.append(extra_network)

        def check(row):
            result = subprocess.CompletedProcess([], 0, json.dumps(row).encode(), b"")
            with patch.object(handoff.subprocess, "run", return_value=result):
                handoff.inspect_exact(args)

        check(correct)
        for row in wrongs:
            with self.subTest(row=row), self.assertRaises(handoff.HandoffError):
                check(row)

    @unittest.skipUnless(sys.platform == "linux", "Linux SO_ACCEPTCONN contract")
    def test_only_connected_unix_stream_descriptor_is_accepted(self):
        unconnected = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            with self.assertRaises(OSError):
                handoff.require_owner_socket(unconnected.detach())
        finally:
            unconnected.close()
        owner, carried = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            accepted = handoff.require_owner_socket(carried.detach())
            accepted.close()
        finally:
            owner.close()
            carried.close()

    @unittest.skipUnless(sys.platform == "linux", "Linux pidfd and /proc executable contract")
    def test_post_exec_proof_requires_exact_executable_bytes(self):
        child = subprocess.Popen(
            [sys.executable, "-c", "import os,sys; print('READY', flush=True); "
             "os.read(0,1); os.execv('/bin/sleep', ['sleep','5'])"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        pidfd = -1
        try:
            self.assertEqual(child.stdout.readline(), b"READY\n")
            executable, before = handoff.executable_identity(child.pid)
            os.close(executable)
            pidfd = os.pidfd_open(child.pid)
            args = SimpleNamespace(pid=child.pid, start_ticks=handoff.process_start_ticks(child.pid),
                                   binary_sha256=hashlib.sha256(Path("/bin/sleep").read_bytes()).hexdigest())
            child.stdin.write(b"x")
            child.stdin.flush()
            handoff.verified_post_exec(args, pidfd, before, time.monotonic() + 3)
            wrong = SimpleNamespace(pid=child.pid, start_ticks=args.start_ticks, binary_sha256="0" * 64)
            with self.assertRaises(handoff.HandoffError):
                handoff.verified_post_exec(wrong, pidfd, before, time.monotonic() + 3)
        finally:
            if pidfd >= 0:
                os.close(pidfd)
            child.terminate()
            child.communicate(timeout=3)

    @unittest.skipUnless(sys.platform == "linux", "Linux pidfd and namespace contract")
    def test_pid_start_ticks_and_network_namespace_are_one_identity(self):
        pid = os.getpid()
        pidfd = os.pidfd_open(pid)
        netfd = os.open(f"/proc/{pid}/ns/net", os.O_RDONLY)
        try:
            exact = SimpleNamespace(pid=pid, start_ticks=handoff.process_start_ticks(pid),
                                    netns=os.readlink(f"/proc/{pid}/ns/net"))
            handoff.check_process(exact, pidfd, netfd)
            with self.assertRaises(handoff.HandoffError):
                handoff.check_process(SimpleNamespace(pid=pid, start_ticks="1", netns=exact.netns),
                                      pidfd, netfd)
            with self.assertRaises(handoff.HandoffError):
                handoff.check_process(SimpleNamespace(pid=pid, start_ticks=exact.start_ticks,
                                                      netns="net:[1]"), pidfd, netfd)
        finally:
            os.close(netfd)
            os.close(pidfd)


if __name__ == "__main__":
    unittest.main()
