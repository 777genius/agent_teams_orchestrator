#!/usr/bin/env python3
"""Inert contract tests. No Docker container, Owner, model, or agent is started."""

import importlib.util
import array
import hashlib
import io
import json
import os
from pathlib import Path
from contextlib import redirect_stderr
import socket
import subprocess
import sys
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


class HandoffContractTest(unittest.TestCase):
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
