#!/usr/bin/env python3
"""Inert Linux-only FD handoff tests. Never starts OpenCode or Owner."""

import array
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
import unittest

HERE = Path(__file__).resolve().parent


class BootstrapTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="hosted-fd3-bootstrap-test-")
        cls.root = Path(cls.temp.name)
        cls.target = cls.root / "inert-target"
        cls.bootstrap = cls.root / "bootstrap"
        subprocess.run(["cc", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-static",
                        "-o", str(cls.target), str(HERE / "inert-target.c")], check=True)
        subprocess.run(["cc", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-static",
                        f'-DOPENCODE_PATH="{cls.target}"', "-o", str(cls.bootstrap),
                        str(HERE / "bootstrap.c")], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def start(self, sender_uid=None):
        name = "fd3-" + secrets.token_hex(16)
        uid = os.getuid() if sender_uid is None else sender_uid
        proc = subprocess.Popen([str(self.bootstrap), "--socket-name", name,
                                 "--sender-uid", str(uid)], stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, close_fds=True)
        return name, proc

    def connect(self, name):
        peer = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        for _ in range(100):
            try:
                peer.connect("\0" + name)
                return peer
            except ConnectionRefusedError:
                time.sleep(.02)
        peer.close()
        self.fail("bootstrap listener did not become ready")

    def finish(self, proc, expected):
        out, err = proc.communicate(timeout=8)
        self.assertEqual(proc.returncode == 0, expected, (out, err))
        return err

    def test_connected_socket_becomes_only_fd3(self):
        name, proc = self.start()
        owner, carried = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        with self.connect(name) as control:
            control.sendmsg([b"F"], [(socket.SOL_SOCKET, socket.SCM_RIGHTS,
                                       array.array("i", [carried.fileno()]))])
        carried.close()
        owner.settimeout(3)
        self.assertEqual(owner.recv(32), b"FD3_OK")
        owner.close()
        self.finish(proc, True)
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as second:
            with self.assertRaises(ConnectionRefusedError):
                second.connect("\0" + name)

    def test_sender_uid_mismatch_fails_closed(self):
        name, proc = self.start(os.getuid() + 1)
        with self.connect(name):
            pass
        self.assertIn(b"sender-credential", self.finish(proc, False))

    def test_missing_rights_fails_closed(self):
        name, proc = self.start()
        with self.connect(name) as control:
            control.send(b"F")
        self.assertIn(b"handoff-rights", self.finish(proc, False))

    def test_second_descriptor_fails_closed(self):
        name, proc = self.start()
        first, second = socket.socketpair()
        with self.connect(name) as control:
            control.sendmsg([b"F"], [(socket.SOL_SOCKET, socket.SCM_RIGHTS,
                                       array.array("i", [first.fileno(), second.fileno()]))])
        first.close()
        second.close()
        self.assertIn(b"handoff-rights", self.finish(proc, False))

    def test_second_frame_fails_closed(self):
        name, proc = self.start()
        owner, carried = socket.socketpair()
        with self.connect(name) as control:
            rights = [(socket.SOL_SOCKET, socket.SCM_RIGHTS,
                       array.array("i", [carried.fileno()]))]
            control.sendmsg([b"F"], rights)
            control.sendmsg([b"F"], rights)
        owner.close()
        carried.close()
        self.assertIn(b"handoff-extra-frame", self.finish(proc, False))

    def test_empty_ancillary_attempt_cannot_hide_following_frame(self):
        name, proc = self.start()
        owner, carried = socket.socketpair()
        with self.connect(name) as control:
            rights = [(socket.SOL_SOCKET, socket.SCM_RIGHTS,
                       array.array("i", [carried.fileno()]))]
            control.sendmsg([b"F"], rights)
            # SOCK_STREAM cannot carry a zero-byte record. This attempt must
            # not masquerade as EOF while a later frame is pending.
            control.sendmsg([b""], rights)
            control.sendmsg([b"X"], rights)
        owner.close()
        carried.close()
        self.assertIn(b"handoff-extra-frame", self.finish(proc, False))

    def test_unconnected_socket_fails_closed(self):
        name, proc = self.start()
        unconnected = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        with self.connect(name) as control:
            control.sendmsg([b"F"], [(socket.SOL_SOCKET, socket.SCM_RIGHTS,
                                       array.array("i", [unconnected.fileno()]))])
        unconnected.close()
        self.assertIn(b"handoff-socket", self.finish(proc, False))

    def test_missing_sender_times_out(self):
        _, proc = self.start()
        self.assertIn(b"timeout", self.finish(proc, False))


if __name__ == "__main__":
    unittest.main()
