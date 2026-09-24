# Hosted OpenCode FD3 bootstrap

Build on Linux with `./build.sh /absolute/output/path`. The static executable
must be included in the pinned OpenCode image at
`/usr/local/bin/hosted-opencode-fd3-bootstrap`; record its SHA256 in the image
label and release configuration. Production builds always exec the pinned path
`/usr/local/bin/opencode` with `serve --hostname 0.0.0.0 --port 4096`.

Docker Entrypoint is `/usr/local/bin/hosted-opencode-fd3-bootstrap`. Cmd is
exactly `--socket-name fd3-<32 lowercase hex> --sender-uid 0`. The name is an
abstract AF_UNIX address in the container's private network namespace, not a
filesystem path. It is one-use: the listener closes after accepting one peer.

The trusted supervisor must inspect the exact container generation, image,
host PID/start ticks and network namespace before transfer. Its helper enters
only that network namespace, connects with `AF_UNIX/SOCK_STREAM`, and checks
the peer's `SO_PEERCRED` host PID/UID and `SO_PEERPIDFD` against the inspected
container process. It sends one data byte `F` with exactly one
`SCM_RIGHTS` descriptor for a connected `AF_UNIX/SOCK_STREAM`, then closes the
control connection. The descriptor itself must already have been admitted
from Owner through the authenticated supervisor protocol. This shim cannot
authenticate that earlier admission.

The bootstrap requires the sender UID supplied in Cmd, a live `SO_PEERPIDFD`,
one valid descriptor and EOF after the packet. It duplicates the descriptor
to FD3, closes every FD above 3, and execs OpenCode in the same PID. Any
failure, extra frame, or 5-second wait timeout exits before OpenCode starts.
The sender's host PID is not representable inside the container's private PID
namespace; checking the exact container PID from the supervisor side is
mandatory. The reviewed seccomp profile must permit the bootstrap's
`SO_PEERPIDFD`, `recvmsg`, `close_range`, and `execve` calls as well as its socket
setup. A denied syscall fails closed.

`./test.py` runs inert Linux tests with a test-only executable path. It never
starts OpenCode, Owner or a model.
