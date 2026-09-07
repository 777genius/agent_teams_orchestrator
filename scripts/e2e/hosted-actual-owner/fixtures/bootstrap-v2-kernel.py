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

# Register every resource as soon as it is created, including pre-handshake
# failures. The parent never signals a reaped/reused PID. No recursive deletion.
fds, endpoints = set(), []
child, reaped = None, False
deadline = time.monotonic() + 15
commands = bytearray()
def own(fd):
    fds.add(fd); return fd
def drop(fd):
    if fd in fds:
        fds.remove(fd); os.close(fd)
def pair():
    result = socket.socketpair(); endpoints.extend(result); return result
def bounded():
    if time.monotonic() >= deadline: raise TimeoutError('fixture absolute deadline')
def command_now():
    if b'\n' not in commands:
        try: data = os.read(0, 65536)
        except BlockingIOError: return None
        if not data: raise EOFError('fixture controller closed')
        commands.extend(data)
        if len(commands) > 2 * 1024 * 1024: raise ValueError('fixture command overflow')
    if b'\n' not in commands: return None
    line, _, tail = commands.partition(b'\n'); commands[:] = tail
    return json.loads(line)
def command_wait():
    while True:
        bounded(); value = command_now()
        if value is not None: return value
        select.select([0], [], [], .01)
def reap():
    global reaped
    if child is None or reaped: return True
    try: pid, status = os.waitpid(child, os.WNOHANG)
    except ChildProcessError: reaped = True; return True
    reaped = pid == child and (os.WIFEXITED(status) or os.WIFSIGNALED(status))
    return reaped
def terminate(signum, frame):
    raise SystemExit(128 + signum)
signal.signal(signal.SIGTERM, terminate)
signal.signal(signal.SIGINT, terminate)
try:
    os.set_blocking(0, False)
    lease = own(os.memfd_create('hosted-owner-v2-fixture', os.MFD_ALLOW_SEALING))
    os.fchmod(lease, 0o600)
    ro = own(os.open('/proc/self/fd/%d' % lease, os.O_RDONLY))
    boot, boot_child = pair(); auth, auth_child = pair()
    activation, activation_child = pair(); live, live_child = pair()
    for endpoint in (boot, auth, activation): endpoint.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 1024)
    raw = own(os.open(result_path + '.raw', os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_EXCL, 0o600))
    wal = own(os.open(result_path + '.wal', os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_EXCL, 0o600))
    anchor = own(os.open(image, os.O_RDONLY))
    source = [ro, boot_child.fileno(), activation_child.fileno(), live_child.fileno(), auth_child.fileno(), raw, wal, anchor]
    if scenario == 'writable-lease': source[0] = own(os.dup(lease))
    if scenario == 'alias': drop(wal); wal = own(os.dup(raw)); source[6] = wal
    rows = [row(fd, target) for fd, target in zip(source, slots)]
    release_read, release_write = os.pipe(); own(release_read); own(release_write)
    parent = os.getpid()
    before = str(time.monotonic_ns()); fork_at = str(time.monotonic_ns()); child = os.fork()
    if child == 0:
        try:
            # A killed helper must not strand a held or running Owner child.
            if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != parent: os._exit(125)
            copies = [fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 256) for fd in source]
            gate = fcntl.fcntl(release_read, fcntl.F_DUPFD_CLOEXEC, 256)
            for fd, target in zip(copies, slots): os.dup2(fd, target, inheritable=True)
            for fd in range(3, max(copies + [gate]) + 1):
                if fd not in slots and fd != gate:
                    try: os.close(fd)
                    except OSError: pass
            if os.read(gate, 1) != b'x': os._exit(126)
            os.close(gate); trace(0) # Observe exec before any Bun/Owner instructions.
            os.execve('/proc/self/fd/11', [image, 'run', module, selection_path, result_path, scenario],
                {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'NODE_ENV': 'test'})
        except BaseException as error:
            print('fixture child: ' + str(error), file=sys.stderr, flush=True); os._exit(127)
    for endpoint in (boot_child, activation_child, live_child, auth_child): endpoint.close()
    for fd, r in zip(source, rows):
        drop(fd); r['closedMonotonicNs'] = str(time.monotonic_ns())
    drop(release_read)
    pidfd = own(os.pidfd_open(child)); ps = os.fstat(pidfd)
    held = dict(parentPid=os.getpid(), callerPid=os.getppid(), ownerPid=child,
        parentStartTicks=ticks(os.getpid()), callerStartTicks=ticks(os.getppid()), ownerStartTicks=ticks(child),
        pidfdDevice=str(ps.st_dev), pidfdInode=str(ps.st_ino), parentPidNamespaceInode=ns(os.getpid(), 'pid'),
        parentNetworkNamespaceInode=ns(os.getpid(), 'net'), ownerPidNamespaceInode=ns(child, 'pid'),
        ownerNetworkNamespaceInode=ns(child, 'net'), spawnNonce=os.urandom(32).hex(), beforeMonotonicNs=before,
        forkMonotonicNs=fork_at, heldMonotonicNs=str(time.monotonic_ns()), descriptors=rows)
    emit({'type': 'held', 'held': held})
    command = command_wait()
    lease_bytes = base64.b64decode(command['lease']); os.write(lease, lease_bytes)
    if scenario != 'missing-seals': fcntl.fcntl(lease, 1033, 15)
    drop(lease)
    os.write(release_write, b'x'); drop(release_write)
    while True:
        bounded(); observed, status = os.waitpid(child, os.WNOHANG)
        if observed: break
        time.sleep(.001)
    if observed != child or not os.WIFSTOPPED(status) or os.WSTOPSIG(status) != signal.SIGTRAP:
        reaped = os.WIFEXITED(status) or os.WIFSIGNALED(status)
        raise RuntimeError('fixture exec stop missing')
    actual = os.stat('/proc/%d/exe' % child)
    if actual.st_dev != int(rows[7]['device']) or actual.st_ino != int(rows[7]['inode']):
        raise RuntimeError('fixture executed another image')
    x = dict(rows[7]); x['size'] = str(actual.st_size)
    emit({'type': 'executed', 'executed': dict(ownerPid=child, ownerStartTicks=ticks(child),
        observedMonotonicNs=str(time.monotonic_ns()), executable=x)})
    command_wait() # Selection persisted only after the actual exec observation.
    trace(17, child) # PTRACE_DETACH; then drain both streams while Owner reads.
    pending = {boot: memoryview(base64.b64decode(command['bootstrap'])), auth: memoryview(base64.b64decode(command['auth']))}
    for endpoint in pending: endpoint.setblocking(False)
    # Interleave small writes into BOTH streams, including frames larger than a
    # pipe/socket buffer. EOF on each stream is separate and mandatory.
    while pending:
        bounded()
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
    outgoing = bytearray()
    while True:
        bounded()
        readable, writable, _ = select.select([0, activation, pidfd], [activation] if outgoing else [], [], .01)
        if pidfd in readable: break
        if 0 in readable or b'\n' in commands:
            c = command_now()
            if c is not None:
                if c.get('close'): break
                outgoing.extend(base64.b64decode(c['activation']))
                if len(outgoing) > 1024 * 1024: raise ValueError('fixture activation queue overflow')
        if activation in writable:
            try: n = activation.send(outgoing[:37]); del outgoing[:n]
            except BlockingIOError: pass
            except (BrokenPipeError, ConnectionResetError):
                emit({'type': 'activation_closed'}); break
        if activation in readable:
            try: data = activation.recv(65536)
            except BlockingIOError: continue
            except ConnectionResetError:
                emit({'type': 'activation_closed'}); break
            if not data:
                emit({'type': 'activation_closed'}); break
            emit({'type': 'activation', 'bytes': base64.b64encode(data).decode()})
except EOFError:
    pass # The registered controller closed its input; still reap the owned child.
finally:
    # Ignore repeated graceful signals during this bounded teardown.
    signal.signal(signal.SIGTERM, signal.SIG_IGN); signal.signal(signal.SIGINT, signal.SIG_IGN)
    for endpoint in endpoints: endpoint.close()
    for fd in list(fds):
        try: drop(fd)
        except OSError: pass
    until = time.monotonic() + 3
    while not reap() and time.monotonic() < until: time.sleep(.01)
    if not reap(): os.kill(child, signal.SIGKILL)
    until = time.monotonic() + .5
    while not reap() and time.monotonic() < until:
        time.sleep(.01)
    if not reap(): raise RuntimeError('fixture child did not reap after SIGKILL')
