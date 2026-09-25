#!/usr/bin/python3 -I
"""Inactive Linux root helper for one attested OpenCode FD3 handoff.

Only the root supervisor may invoke this program. It accepts the already
admitted Owner socket on inherited FD 3; it never creates that socket.
"""

import argparse
import array
from contextlib import suppress
import ctypes
import hashlib
import json
import os
import re
import select
import sqlite3
import socket
import struct
import subprocess
import sys
import time
from urllib.parse import quote


DOCKER = "/usr/bin/docker"
GENERATION_LABEL = "org.agentteams.hosted-opencode.generation"
SO_PEERPIDFD = 77
PR_SET_NO_NEW_PRIVS = 38
PR_CAPBSET_DROP = 24
PR_CAP_AMBIENT = 47
PR_CAP_AMBIENT_CLEAR_ALL = 4
LINUX_CAPABILITY_VERSION_3 = 0x20080522
HANDOFF_SECONDS = 8.0
OFFICIAL_BINARY_SHA = "513f500a1a5ea1dc7d865547ac87b32a8936334e8d5abd5b3ff585c45a170080"
BOOTSTRAP_SHA = "af0644070946ef34bef205c1940b02bd76a09ffcef4b5cffb8b072ae04ca32e6"
AUTHORITY_CONFIG_DIRECTORY = "/run/agent-teams/fd3"
AUTHORITY_CONFIG_MAX_BYTES = 4096
PRODUCT_DB_BUSY_SECONDS = 0.25
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
CANONICAL_IDS = {
    "runId": re.compile(r"run_[0-9a-f]{32}\Z"),
    "memberId": re.compile(r"member_[0-9a-f]{32}\Z"),
    "teamId": re.compile(r"team_[0-9a-f]{32}\Z"),
    "laneId": re.compile(r"lane_[0-9a-f]{32}\Z"),
    "runtimeWorkspaceId": re.compile(r"workspace_[0-9a-f]{32}\Z"),
    "deploymentId": re.compile(r"deployment_[A-Za-z0-9][A-Za-z0-9._-]*\Z"),
}
PRODUCT_BINDING_KEYS = frozenset((*CANONICAL_IDS, "planSha256", "rosterBindingSha256",
                                  "restoreGeneration", "mountGeneration", "operationId"))
CONTAINER_BINDING_KEYS = frozenset(("containerId", "handle", "generation", "networkId",
                                    "pid", "startTicks", "netns", "binarySha256"))


class HandoffError(Exception):
    pass


class HandoffUncertain(HandoffError):
    """A sendmsg may have delivered FD3; local close cannot revoke that copy."""


class HandoffAttempt:
    def __init__(self):
        self.may_have_sent = False

    def send(self, control, owner):
        # Set before entering the kernel. An exception or a short send is not
        # proof that SCM_RIGHTS was withheld from the receiver.
        self.may_have_sent = True
        sent = control.sendmsg([b"F"], [(socket.SOL_SOCKET, socket.SCM_RIGHTS,
                                          array.array("i", [owner.fileno()]))])
        require(sent == 1, "handoff-send")

    def fail(self, error):
        if self.may_have_sent:
            raise HandoffUncertain("uncertain-transfer") from error
        raise error


def require(condition, reason):
    if not condition:
        raise HandoffError(reason)


def exact_object(value, keys, reason):
    require(type(value) is dict and value.keys() == keys, reason)
    return value


def canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def trusted_ancestor(path, uid, test_only=False):
    """Production accepts only root-owned non-writable ancestors, then one private Product leaf."""
    require(os.path.isabs(path) and os.path.normpath(path) == path, "authority-path")
    parts = path.split(os.sep)
    current = os.sep
    for index, part in enumerate(parts[1:]):
        if not part:
            continue
        current = os.path.join(current, part)
        st = os.lstat(current)
        require(not os.path.islink(current) and os.path.isdir(current), "authority-ancestor")
        final = index == len(parts[1:]) - 1
        if final:
            require(st.st_uid == uid and (st.st_mode & 0o077) == 0, "authority-ancestor")
        elif not test_only:
            require(st.st_uid == 0 and (st.st_mode & 0o022) == 0, "authority-ancestor")
        else:
            require(st.st_uid in (0, os.getuid()) and
                    ((st.st_mode & 0o022) == 0 or st.st_uid == 0 and
                     (st.st_mode & 0o1000) != 0), "authority-ancestor")


def load_authority_config(args, test_only=False):
    """The root daemon must create one immutable private config for this generation."""
    directory = AUTHORITY_CONFIG_DIRECTORY
    require(os.path.isabs(directory) and os.path.normpath(directory) == directory,
            "authority-config-path")
    trusted_ancestor(directory, os.getuid() if test_only else 0, test_only)
    path = os.path.join(directory, f"member-{args.generation}.json")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        st = os.fstat(fd)
        current = os.lstat(path)
        require(st.st_dev == current.st_dev and st.st_ino == current.st_ino and
                st.st_nlink == 1 and current.st_nlink == 1 and
                st.st_uid == (os.getuid() if test_only else 0) and
                (st.st_mode & 0o077) == 0 and 1 <= st.st_size <= AUTHORITY_CONFIG_MAX_BYTES and
                (st.st_mode & 0o170000) == 0o100000, "authority-config-identity")
        data = os.read(fd, AUTHORITY_CONFIG_MAX_BYTES + 1)
        require(len(data) == st.st_size, "authority-config-size")
    finally:
        os.close(fd)
    config = exact_object(json.loads(data.decode("utf-8")),
                          {"version", "databasePath", "expectedProductUid", "binding", "container"},
                          "authority-config-schema")
    require(type(config["version"]) is int and config["version"] == 1 and
            type(config["expectedProductUid"]) is int and
            0 <= config["expectedProductUid"] <= 2**31 - 1 and
            data == canonical_json(config), "authority-config-canonical")
    binding = exact_object(config["binding"], PRODUCT_BINDING_KEYS, "authority-binding")
    container = exact_object(config["container"], CONTAINER_BINDING_KEYS, "authority-container")
    for key, pattern in CANONICAL_IDS.items():
        require(type(binding[key]) is str and pattern.fullmatch(binding[key]), "authority-binding")
    require(all(type(binding[key]) is str and SHA256.fullmatch(binding[key]) for key in
                ("planSha256", "rosterBindingSha256")) and
            type(binding["restoreGeneration"]) is int and
            0 <= binding["restoreGeneration"] <= 2**53 - 1 and
            type(binding["mountGeneration"]) is int and
            1 <= binding["mountGeneration"] <= 2**53 - 1,
            "authority-binding")
    operation = "start_" + hashlib.sha256(
        b"agent-teams.hosted-opencode-member-start/v1\0" +
        json.dumps([binding["runId"], binding["memberId"], binding["planSha256"]],
                   separators=(",", ":")).encode("utf-8")).hexdigest()
    require(binding["operationId"] == operation, "authority-binding")
    expected = {"containerId": args.container_id, "handle": args.handle,
                "generation": args.generation, "networkId": args.network_id,
                "pid": args.pid, "startTicks": args.start_ticks, "netns": args.netns,
                "binarySha256": args.binary_sha256}
    require(container == expected, "authority-container")
    db_path = config["databasePath"]
    require(type(db_path) is str and os.path.isabs(db_path) and
            os.path.normpath(db_path) == db_path and len(db_path) <= 4096 and
            not any(value in db_path for value in ("\0", "?", "#")), "authority-database-path")
    return config


class ProductMemberFence:
    """Owns a Product writer lock across the exact FD send; currentness stays denied for now."""

    def __init__(self, config, test_only=False):
        self.config = config
        self.test_only = test_only
        self.connection = None
        self.identity = None

    def begin(self):
        path = self.config["databasePath"]
        parent = os.path.dirname(path)
        trusted_ancestor(parent, self.config["expectedProductUid"], self.test_only)
        before = os.lstat(path)
        require((before.st_mode & 0o170000) == 0o100000 and before.st_nlink == 1 and
                before.st_uid == self.config["expectedProductUid"] and
                (before.st_mode & 0o022) == 0, "product-database-identity")
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            opened = os.fstat(fd)
            require((opened.st_dev, opened.st_ino) == (before.st_dev, before.st_ino),
                    "product-database-substituted")
        finally:
            os.close(fd)
        self.identity = (before.st_dev, before.st_ino)
        uri = "file:" + quote(path, safe="/") + "?mode=rw"
        connection = sqlite3.connect(uri, uri=True, isolation_level=None,
                                     timeout=PRODUCT_DB_BUSY_SECONDS)
        self.connection = connection
        try:
            connection.execute("PRAGMA busy_timeout=250")
            require(connection.execute("PRAGMA user_version").fetchone() == (33,) and
                    connection.execute("PRAGMA journal_mode").fetchone() == ("wal",),
                    "product-schema-unavailable")
            self.assert_file_identity()
            connection.execute("BEGIN IMMEDIATE")
            self.assert_current()
        except Exception:
            self.abort()
            raise

    def assert_file_identity(self):
        st = os.lstat(self.config["databasePath"])
        require((st.st_dev, st.st_ino) == self.identity and st.st_nlink == 1 and
                st.st_uid == self.config["expectedProductUid"] and
                (st.st_mode & 0o022) == 0, "product-database-substituted")

    def assert_current(self):
        # No Python parity proof yet for Product v33 reservation, roster,
        # publication, grant, OIDC/personal session, and launcher epochs.
        # A lock alone is never authorization. Keep FD3 denied.
        raise HandoffError("product-authority-unavailable")

    def finish(self):
        require(self.connection is not None, "product-fence-state")
        try:
            self.assert_file_identity()
            self.connection.execute("COMMIT")
        finally:
            self.connection.close()
            self.connection = None

    def abort(self):
        if self.connection is not None:
            try:
                if self.connection.in_transaction:
                    self.connection.execute("ROLLBACK")
            finally:
                self.connection.close()
                self.connection = None


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--container-id", required=True)
    parser.add_argument("--handle", required=True)
    parser.add_argument("--generation", required=True)
    parser.add_argument("--network-id", required=True)
    parser.add_argument("--pid", required=True, type=int)
    parser.add_argument("--start-ticks", required=True)
    parser.add_argument("--netns", required=True)
    parser.add_argument("--binary-sha256", required=True)
    args = parser.parse_args(argv)
    require(re.fullmatch(r"[0-9a-f]{64}", args.container_id), "identity")
    require(re.fullmatch(r"opencode_[0-9a-f]{32}", args.handle), "identity")
    require(re.fullmatch(r"[0-9a-f]{32}", args.generation), "identity")
    require(re.fullmatch(r"[0-9a-f]{64}", args.network_id), "identity")
    require(1 < args.pid <= 2**31 - 1, "identity")
    require(re.fullmatch(r"[1-9][0-9]*", args.start_ticks), "identity")
    require(re.fullmatch(r"net:\[[1-9][0-9]*\]", args.netns), "identity")
    require(args.binary_sha256 == OFFICIAL_BINARY_SHA, "binary-policy")
    return args


def process_start_ticks(pid):
    with open(f"/proc/{pid}/stat", "rb", buffering=0) as source:
        row = source.read(4096)
    end = row.rfind(b")")
    require(end > 0, "process-identity")
    fields = row[end + 2:].split()
    require(len(fields) > 19 and fields[19].isdigit(), "process-identity")
    return fields[19].decode("ascii")


def pidfd_live(pidfd):
    poller = select.poll()
    poller.register(pidfd, select.POLLIN | select.POLLHUP | select.POLLERR)
    return not poller.poll(0)


def inspect_exact(args):
    result = subprocess.run(
        [DOCKER, "inspect", "--format", "{{json .}}", args.container_id],
        check=False, capture_output=True, timeout=5,
        env={"PATH": "/usr/bin:/bin", "HOME": "/root", "DOCKER_HOST": "unix:///var/run/docker.sock"},
    )
    require(result.returncode == 0 and len(result.stdout) <= 1_048_576, "docker-inspect")
    try:
        row = json.loads(result.stdout)
        networks = row["NetworkSettings"]["Networks"]
        valid_network = isinstance(networks, dict) and len(networks) == 1 and any(
            isinstance(network, dict) and network.get("NetworkID") == args.network_id
            for network in networks.values()
        )
        valid = (
            row["Id"] == args.container_id
            and row["Name"] == "/" + args.handle
            and row["Config"]["Labels"][GENERATION_LABEL] == args.generation
            and row["State"]["Running"] is True
            and type(row["State"]["Pid"]) is int
            and row["State"]["Pid"] == args.pid
            and valid_network
        )
    except (KeyError, TypeError, ValueError):
        valid = False
    require(valid, "docker-identity")


def check_process(args, pidfd, netfd):
    require(pidfd_live(pidfd), "process-exited")
    require(process_start_ticks(args.pid) == args.start_ticks, "process-identity")
    require(os.readlink(f"/proc/{args.pid}/ns/net") == args.netns, "network-identity")
    require(os.fstat(netfd).st_ino == int(args.netns[5:-1]), "network-identity")
    require(pidfd_live(pidfd), "process-exited")


def require_owner_socket(fd):
    carried = socket.socket(fileno=fd)
    try:
        require(carried.family == socket.AF_UNIX and carried.type == socket.SOCK_STREAM, "owner-socket")
        require(carried.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN) == 0, "owner-socket")
        carried.getpeername()  # A bound or unconnected AF_UNIX socket is not an Owner channel.
        return carried
    except Exception:
        carried.close()
        raise


def drop_all_caps():
    libc = ctypes.CDLL("libc.so.6", use_errno=True)
    libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    libc.prctl.restype = ctypes.c_int
    libc.capset.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    libc.capset.restype = ctypes.c_int
    libc.setfsuid.argtypes = [ctypes.c_uint]
    libc.setfsuid.restype = ctypes.c_int
    libc.setfsgid.argtypes = [ctypes.c_uint]
    libc.setfsgid.restype = ctypes.c_int

    def prctl(option, arg1=0, arg2=0):
        require(libc.prctl(option, arg1, arg2, 0, 0) == 0, "capability-drop")

    class Header(ctypes.Structure):
        _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]

    class Data(ctypes.Structure):
        _fields_ = [("effective", ctypes.c_uint32), ("permitted", ctypes.c_uint32),
                    ("inheritable", ctypes.c_uint32)]

    prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL)
    with open("/proc/sys/kernel/cap_last_cap", "r", encoding="ascii") as source:
        last_cap = int(source.read(8).strip())
    require(0 <= last_cap <= 255, "capability-drop")
    for capability in range(last_cap + 1):
        prctl(PR_CAPBSET_DROP, capability)
    # The container process is UID/GID 1000. Matching FS credentials allow
    # /proc executable proof after the privileged namespace transition.
    libc.setfsgid(1000)
    libc.setfsuid(1000)
    header = Header(LINUX_CAPABILITY_VERSION_3, 0)
    data = (Data * 2)()
    require(libc.capset(ctypes.byref(header), ctypes.byref(data)) == 0, "capability-drop")
    prctl(PR_SET_NO_NEW_PRIVS, 1)
    with open("/proc/self/status", "r", encoding="ascii") as source:
        status = dict(line.split(":", 1) for line in source if ":" in line)
    require(all(int(status[key].strip(), 16) == 0 for key in
                ("CapEff", "CapPrm", "CapInh", "CapAmb", "CapBnd")), "capability-drop")
    require(status["NoNewPrivs"].strip() == "1", "capability-drop")
    require(status["Uid"].split()[-1] == "1000" and
            status["Gid"].split()[-1] == "1000", "capability-drop")


def enter_netns(netfd):
    libc = ctypes.CDLL("libc.so.6", use_errno=True)
    libc.setns.argtypes = [ctypes.c_int, ctypes.c_int]
    libc.setns.restype = ctypes.c_int
    require(libc.setns(netfd, 0x40000000) == 0, "setns")  # CLONE_NEWNET
    os.setgroups([])
    drop_all_caps()


def peer_pidfd(connection, expected_pid):
    peer = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    pid, uid, _gid = struct.unpack("3i", peer)
    require(pid == expected_pid and uid == 1000, "bootstrap-peer")
    encoded = connection.getsockopt(socket.SOL_SOCKET, SO_PEERPIDFD, struct.calcsize("i"))
    fd = struct.unpack("i", encoded)[0]
    require(fd >= 0, "bootstrap-peer")
    with open(f"/proc/self/fdinfo/{fd}", "r", encoding="ascii") as source:
        info = dict(line.split(":", 1) for line in source if ":" in line)
    require(info.get("Pid", "").strip() == str(expected_pid), "bootstrap-peer")
    require(pidfd_live(fd), "bootstrap-peer")
    return fd


def executable_identity(pid):
    fd = os.open(f"/proc/{pid}/exe", os.O_RDONLY | os.O_CLOEXEC)
    stat = os.fstat(fd)
    return fd, (stat.st_dev, stat.st_ino)


def executable_sha256(fd, deadline):
    digest = hashlib.sha256()
    while True:
        require(time.monotonic() < deadline, "digest-timeout")
        block = os.read(fd, 1024 * 1024)
        if not block:
            return digest.hexdigest()
        digest.update(block)


def verified_post_exec(args, pidfd, bootstrap_identity, deadline):
    while time.monotonic() < deadline:
        require(pidfd_live(pidfd), "bootstrap-exited")
        require(process_start_ticks(args.pid) == args.start_ticks, "process-identity")
        executable, identity = executable_identity(args.pid)
        try:
            if identity != bootstrap_identity:
                require(executable_sha256(executable, deadline) == args.binary_sha256, "post-exec-binary")
                current, current_identity = executable_identity(args.pid)
                os.close(current)
                require(current_identity == identity and pidfd_live(pidfd), "post-exec-race")
                require(process_start_ticks(args.pid) == args.start_ticks, "process-identity")
                return
        finally:
            os.close(executable)
        time.sleep(0.02)
    raise HandoffError("post-exec-timeout")


def handoff(args):
    require(sys.platform == "linux" and os.getuid() == 0 and os.geteuid() == 0, "root-linux")
    require(os.getppid() > 1, "root-parent")
    os.environ.clear()
    os.umask(0o077)
    config = load_authority_config(args)
    for name in os.listdir("/proc/self/fd"):
        fd = int(name)
        if fd > 3:
            try:
                os.close(fd)
            except OSError:
                pass  # The directory FD used by listdir may already be closed.
    owner = require_owner_socket(3)
    pidfd = os.pidfd_open(args.pid, 0)
    netfd = os.open(f"/proc/{args.pid}/ns/net", os.O_RDONLY | os.O_CLOEXEC)
    attempt = HandoffAttempt()
    fence = ProductMemberFence(config)
    try:
        inspect_exact(args)
        check_process(args, pidfd, netfd)
        executable, bootstrap_identity = executable_identity(args.pid)
        try:
            require(executable_sha256(executable, time.monotonic() + HANDOFF_SECONDS) == BOOTSTRAP_SHA,
                    "bootstrap-binary")
        finally:
            os.close(executable)
        inspect_exact(args)
        check_process(args, pidfd, netfd)
        # The helper itself acquires the Product writer before entering the
        # namespace. No parent-held lock is inherited or trusted here.
        fence.begin()
        enter_netns(netfd)
        check_process(args, pidfd, netfd)

        name = "\0fd3-" + args.generation
        deadline = time.monotonic() + HANDOFF_SECONDS
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM | socket.SOCK_CLOEXEC) as control:
            control.settimeout(max(0.01, deadline - time.monotonic()))
            control.connect(name)
            peerfd = peer_pidfd(control, args.pid)
            try:
                check_process(args, pidfd, netfd)
                require(pidfd_live(peerfd), "bootstrap-peer")
                fence.assert_file_identity()
                fence.assert_current()
                attempt.send(control, owner)
                fence.finish()
                control.shutdown(socket.SHUT_WR)
                control.settimeout(max(0.01, deadline - time.monotonic()))
                require(control.recv(1) == b"", "handoff-eof")
            finally:
                os.close(peerfd)
        verified_post_exec(args, pidfd, bootstrap_identity, deadline)
        check_process(args, pidfd, netfd)
    except Exception as error:
        attempt.fail(error)
    finally:
        with suppress(Exception):
            fence.abort()
        with suppress(OSError):
            os.close(netfd)
        with suppress(OSError):
            os.close(pidfd)
        with suppress(OSError):
            owner.close()


def main():
    try:
        handoff(parse_args(sys.argv[1:]))
    except HandoffUncertain:
        print("hosted-fd3-handoff:uncertain-transfer", file=sys.stderr)
        return 2
    except (HandoffError, OSError, subprocess.SubprocessError, json.JSONDecodeError,
            UnicodeError, ValueError, KeyError) as error:
        reason = str(error) if isinstance(error, HandoffError) else "system-failure"
        print(f"hosted-fd3-handoff:{reason}", file=sys.stderr)
        return 1
    except Exception:
        print("hosted-fd3-handoff:system-failure", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
