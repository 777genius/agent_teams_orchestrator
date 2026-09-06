# Linux descriptor fixture only. Not an OpenCode provider or a qualified launcher.
# It deliberately permits invalid seals/access so Owner independently rejects them.
import base64, ctypes, fcntl, json, os, select, signal, socket, stat, sys, time

image, module, selection_path, result_path, scenario = sys.argv[1:]
slots = [3, 4, 5, 6, 7, 8, 9, 11]
libc = ctypes.CDLL('libc.so.6', use_errno=True)
libc.ptrace.argtypes = [ctypes.c_uint, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p]
libc.ptrace.restype = ctypes.c_long

def trace(request, pid=0):
    if libc.ptrace(request, pid, None, None) == -1:
        raise OSError(ctypes.get_errno(), 'fixture ptrace failed')

def ticks(pid):
    return open('/proc/%s/stat' % pid).read().rsplit(')', 1)[1].split()[19]

def ns(pid, kind):
    return str(os.stat('/proc/%s/ns/%s' % (pid, kind)).st_ino)

def emit(value):
    print(json.dumps(value, separators=(',', ':')), flush=True)

def row(fd, child):
    s = os.fstat(fd); flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    try: seals = fcntl.fcntl(fd, 1034)
    except OSError: seals = None
    return dict(sourceFd=fd, childFd=child, kind='regular-file' if stat.S_ISREG(s.st_mode) else 'socket',
        accessMode=['read-only', 'write-only', 'read-write'][flags & 3], append=bool(flags & os.O_APPEND),
        mode=stat.S_IMODE(s.st_mode), uid=s.st_uid, gid=s.st_gid, seals=seals, device=str(s.st_dev),
        inode=str(s.st_ino), size=str(s.st_size), nlink=str(s.st_nlink), mtimeNs=str(s.st_mtime_ns),
        ctimeNs=str(s.st_ctime_ns), closedMonotonicNs='0')

lease = os.memfd_create('hosted-owner-v2-fixture', os.MFD_ALLOW_SEALING)
os.fchmod(lease, 0o600)
ro = os.open('/proc/self/fd/%d' % lease, os.O_RDONLY)
boot, boot_child = socket.socketpair(); auth, auth_child = socket.socketpair()
activation, activation_child = socket.socketpair(); live, live_child = socket.socketpair()
for endpoint in (boot, auth): endpoint.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 1024)
raw = os.open(result_path + '.raw', os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_EXCL, 0o600)
wal = os.open(result_path + '.wal', os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_EXCL, 0o600)
anchor = os.open(image, os.O_RDONLY)
source = [ro, boot_child.fileno(), activation_child.fileno(), live_child.fileno(), auth_child.fileno(), raw, wal, anchor]
if scenario == 'writable-lease': source[0] = os.dup(lease)
if scenario == 'alias': os.close(wal); wal = os.dup(raw); source[6] = wal
rows = [row(fd, child) for fd, child in zip(source, slots)]
release_read, release_write = os.pipe()
before = str(time.monotonic_ns()); fork_at = str(time.monotonic_ns()); child = os.fork()
if child == 0:
    copies = [fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 256) for fd in source]
    gate = fcntl.fcntl(release_read, fcntl.F_DUPFD_CLOEXEC, 256)
    for fd, target in zip(copies, slots): os.dup2(fd, target, inheritable=True)
    for fd in range(3, max(copies + [gate]) + 1):
        if fd not in slots and fd != gate:
            try: os.close(fd)
            except OSError: pass
    os.read(gate, 1); os.close(gate)
    trace(0) # PTRACE_TRACEME: observe exec before any Bun/Owner instructions.
    os.execve('/proc/self/fd/11', [image, 'run', module, selection_path, result_path, scenario],
        {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'NODE_ENV': 'test'})
# Detach Python socket wrappers before closing child copies exactly once.
for endpoint in [boot_child, activation_child, live_child, auth_child]: endpoint.detach()
for fd, r in zip(source, rows):
    os.close(fd); r['closedMonotonicNs'] = str(time.monotonic_ns())
os.close(release_read)
pidfd = os.pidfd_open(child); ps = os.fstat(pidfd)
held = dict(parentPid=os.getpid(), callerPid=os.getppid(), ownerPid=child,
    parentStartTicks=ticks(os.getpid()), callerStartTicks=ticks(os.getppid()), ownerStartTicks=ticks(child),
    pidfdDevice=str(ps.st_dev), pidfdInode=str(ps.st_ino), parentPidNamespaceInode=ns(os.getpid(), 'pid'),
    parentNetworkNamespaceInode=ns(os.getpid(), 'net'), ownerPidNamespaceInode=ns(child, 'pid'),
    ownerNetworkNamespaceInode=ns(child, 'net'), spawnNonce=os.urandom(32).hex(), beforeMonotonicNs=before,
    forkMonotonicNs=fork_at, heldMonotonicNs=str(time.monotonic_ns()), descriptors=rows)
emit({'type': 'held', 'held': held})
try:
    command = json.loads(sys.stdin.readline())
    lease_bytes = base64.b64decode(command['lease']); os.write(lease, lease_bytes)
    if scenario != 'missing-seals': fcntl.fcntl(lease, 1033, 15)
    os.close(lease)
    os.write(release_write, b'x'); os.close(release_write)
    observed, status = os.waitpid(child, 0)
    if observed != child or not os.WIFSTOPPED(status) or os.WSTOPSIG(status) != signal.SIGTRAP:
        raise RuntimeError('fixture exec stop missing')
    actual = os.stat('/proc/%d/exe' % child)
    if actual.st_dev != int(rows[7]['device']) or actual.st_ino != int(rows[7]['inode']):
        raise RuntimeError('fixture executed another image')
    x = dict(rows[7]); x['size'] = str(actual.st_size)
    emit({'type': 'executed', 'executed': dict(ownerPid=child, ownerStartTicks=ticks(child),
        observedMonotonicNs=str(time.monotonic_ns()), executable=x)})
    json.loads(sys.stdin.readline()) # Selection persisted only after the actual exec observation.
    trace(17, child) # PTRACE_DETACH; then drain both streams while Owner reads.
    pending = {boot: memoryview(base64.b64decode(command['bootstrap'])), auth: memoryview(base64.b64decode(command['auth']))}
    for endpoint in pending: endpoint.setblocking(False)
    # Interleave small writes into BOTH streams, including frames larger than a
    # pipe/socket buffer. EOF on each stream is separate and mandatory.
    while pending:
        _, writable, _ = select.select([], list(pending), [], .1)
        for endpoint in writable:
            data = pending[endpoint]
            try: n = endpoint.send(data[:37]) if data else 0
            except BlockingIOError: continue
            except BrokenPipeError: del pending[endpoint]; continue
            pending[endpoint] = data[n:]
            if not pending[endpoint]:
                if scenario != 'missing-eof' or endpoint is not auth: endpoint.shutdown(socket.SHUT_WR)
                del pending[endpoint]
    emit({'type': 'delivered'})
    # Actual FD5 peer used by the retained server tests; relay bytes unchanged.
    activation.setblocking(False)
    while True:
        readable, _, _ = select.select([sys.stdin, activation, pidfd], [], [], .1)
        if pidfd in readable: break
        if sys.stdin in readable:
            line = sys.stdin.readline()
            if not line: break
            c = json.loads(line)
            if c.get('close'): break
            activation.setblocking(True); activation.sendall(base64.b64decode(c['activation'])); activation.setblocking(False)
        if activation in readable:
            data = activation.recv(65536)
            if not data: break
            emit({'type': 'activation', 'bytes': base64.b64encode(data).decode()})
finally:
    live.close(); activation.close(); boot.close(); auth.close()
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        pid, _ = os.waitpid(child, os.WNOHANG)
        if pid: break
        time.sleep(.01)
    else: os.kill(child, signal.SIGKILL); os.waitpid(child, 0)
    os.close(pidfd)
