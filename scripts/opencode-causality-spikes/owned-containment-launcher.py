#!/usr/bin/python3
"""Root TEST-only singleton admission, privilege drop, same-PID exec; no shell."""
import argparse
import ctypes
import json
import os
import re
import stat
import select
import time
import socket
import struct


def await_parent_ack():
    """An intrinsic parent pipe, exact ACK then EOF, within one deadline."""
    mode = os.fstat(0).st_mode
    if stat.S_ISSOCK(mode):
        # Node and Bun use a socketpair for piped stdin on Linux. Bind its peer
        # to this launcher's actual Root parent before accepting any ACK bytes.
        peer = socket.socket(fileno=os.dup(0))
        try:
            if peer.family != socket.AF_UNIX or peer.type != socket.SOCK_STREAM:
                raise RuntimeError('intrinsic parent stream required')
            pid, uid, _ = struct.unpack('3i', peer.getsockopt(
                socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
            if pid != os.getppid() or uid != 0:
                raise RuntimeError('parent admission peer mismatch')
        finally:
            peer.close()
    elif not stat.S_ISFIFO(mode):
        raise RuntimeError('parent admission pipe required')
    deadline = time.monotonic() + 10
    data = b''
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([0], [], [], remaining)[0]:
            raise RuntimeError('parent admission ACK timeout')
        chunk = os.read(0, 5)
        if time.monotonic() >= deadline:
            raise RuntimeError('late parent admission ACK')
        if not chunk:
            if data != b'ACK\n':
                raise RuntimeError('missing/malformed parent admission ACK')
            return
        data += chunk
        if not b'ACK\n'.startswith(data):
            raise RuntimeError('malformed parent admission ACK')


def main():
    parser = argparse.ArgumentParser()
    for name in ('boundary', 'identity', 'uid', 'gid', 'receipt'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    root = '/sys/fs/cgroup'
    pattern = root + r'/TEST-opencode-owned-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
    if os.geteuid() != 0 or not re.fullmatch(pattern, args.boundary):
        raise RuntimeError('Root canonical TEST boundary required')
    if not command or not os.path.isabs(command[0]) or not os.path.isabs(args.receipt):
        raise RuntimeError('explicit binary and receipt paths required')
    uid, gid = int(args.uid), int(args.gid)
    if not (0 < uid < 2**32 and 0 < gid < 2**32):
        raise RuntimeError('unprivileged TEST uid/gid required')
    boot, dev, ino = args.identity.split(':')
    identity = dict(path=args.boundary, bootId=boot, dev=dev, ino=ino)
    for path in (root, args.boundary):
        s = os.lstat(path)
        if not stat.S_ISDIR(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o022 or os.path.realpath(path) != path:
            raise RuntimeError('foreign/symlink boundary')
    ancestor = os.lstat(root + '/cgroup.procs')
    if not stat.S_ISREG(ancestor.st_mode) or ancestor.st_uid != 0 or ancestor.st_mode & 0o022:
        raise RuntimeError('foreign common-ancestor migration authority')
    directory = os.open(args.boundary, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    libc = ctypes.CDLL(None, use_errno=True)
    fs = ctypes.create_string_buffer(256)
    if libc.fstatfs(directory, ctypes.byref(fs)) or ctypes.c_long.from_buffer(fs).value != 0x63677270:
        raise RuntimeError('cgroup v2 required')

    def verify():
        s, pinned = os.lstat(args.boundary), os.fstat(directory)
        with open('/proc/sys/kernel/random/boot_id', encoding='ascii') as source:
            current_boot = source.read(128).strip()
        if (not stat.S_ISDIR(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o022
                or os.path.realpath(args.boundary) != args.boundary
                or str(s.st_dev) != dev or str(s.st_ino) != ino
                or (s.st_dev, s.st_ino) != (pinned.st_dev, pinned.st_ino) or current_boot != boot):
            raise RuntimeError('boundary identity changed')

    def control(name, flags=os.O_RDONLY):
        fd = os.open(name, flags | os.O_NOFOLLOW, dir_fd=directory)
        s = os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o022 or str(s.st_dev) != dev:
            os.close(fd)
            raise RuntimeError('foreign control authority')
        return fd

    def read(name):
        fd = control(name)
        try:
            value = os.read(fd, 65537)
            if len(value) > 65536:
                raise RuntimeError('control read budget exceeded')
            return value.decode('ascii').strip()
        finally:
            os.close(fd)

    verify()
    if read('cgroup.max.depth') != '0' or read('cgroup.max.descendants') != '0':
        raise RuntimeError('private leaf required')
    for name in os.listdir(directory):
        s = os.stat(name, dir_fd=directory, follow_symlinks=False)
        if stat.S_ISDIR(s.st_mode) or stat.S_ISLNK(s.st_mode):
            raise RuntimeError('subgroup/symlink refused')
    events = dict(line.split() for line in read('cgroup.events').splitlines())
    if read('cgroup.procs') or events.get('populated') != '0':
        raise RuntimeError('nonempty boundary refused')
    with open('/proc/self/cgroup', encoding='ascii') as source:
        if '0::' + args.boundary[len(root):] in source.read(65536).splitlines():
            raise RuntimeError('worker/shared boundary refused')
    # Receipt lives in Root-owned evidence, inaccessible to the native uid.
    parent = os.path.dirname(args.receipt)
    s = os.lstat(parent)
    if not stat.S_ISDIR(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o777 != 0o700 or os.path.realpath(parent) != parent:
        raise RuntimeError('foreign receipt directory')
    receipt = os.open(args.receipt, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    procs = control('cgroup.procs', os.O_WRONLY)
    verify()
    try:
        os.write(procs, str(os.getpid()).encode('ascii'))
    finally:
        os.close(procs)
    verify()
    if read('cgroup.procs').split() != [str(os.getpid())]:
        raise RuntimeError('admission is not singleton')
    with open('/proc/self/cgroup', encoding='ascii') as source:
        if '0::' + args.boundary[len(root):] not in source.read(65536).splitlines():
            raise RuntimeError('membership mismatch')
    # no_new_privs forbids setuid/file capabilities restoring migration authority.
    if libc.prctl(38, 1, 0, 0, 0):
        raise RuntimeError('no_new_privs failed')
    os.setgroups([])
    os.setgid(gid)
    os.setuid(uid)
    with open('/proc/self/status', encoding='ascii') as source:
        status = dict(line.split(':', 1) for line in source if ':' in line)
    if (os.geteuid() != uid or os.getegid() != gid or os.getgroups()
            or any(int(status[k].strip(), 16) for k in ('CapEff', 'CapPrm', 'CapAmb'))
            or status['NoNewPrivs'].strip() != '1'):
        raise RuntimeError('privilege drop unproven')
    with open('/proc/self/stat', encoding='ascii') as source:
        ticks = source.read(65536).rsplit(')', 1)[1].split()[19]
    value = dict(pid=os.getpid(), identity=identity, startTicks=ticks, uid=uid, gid=gid)
    data = json.dumps(value, separators=(',', ':')).encode('ascii')
    if os.write(receipt, data) != len(data):
        raise RuntimeError('short receipt')
    os.close(receipt)
    os.close(directory)
    # Native execution cannot precede trusted parent custody. The pipe has no
    # pathname and is consumed through EOF before exec (native stdin is EOF).
    await_parent_ack()
    os.execv(command[0], command)


if __name__ == '__main__':
    main()
