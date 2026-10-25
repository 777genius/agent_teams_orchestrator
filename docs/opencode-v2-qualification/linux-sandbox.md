# OpenCode V2 on Linux: the bubblewrap sandbox

Every OpenCode V2 execution on Linux (catalog reads, provider connect, model tests
and team members) runs inside `/usr/bin/bwrap`. The runtime qualifies that launcher
before its first sandbox in each process; a refusal names its cause in provider
connect, model tests and the provider status.

## What the launcher must provide

1. **bubblewrap 0.12.0 or later.** Earlier releases follow an absolute symlink into
   `/oldroot` while creating a mount point ([CVE-2026-87766][advisory]), so a sandboxed
   process could plant one in a writable root and make the next sandbox setup create
   host paths. The version is read from `bwrap --version`.
2. **Setup that stays inside the new root.** The runtime runs the upstream advisory
   reproduction once each for a directory, a directory bind and a file bind under a
   symlinked parent, and for a file bind onto a dangling symlink, in a private temporary
   directory. Any host-side effect refuses the launcher, whatever version it reports; a
   probe that does not finish within 3 seconds counts as not reached.
3. **Unprivileged user namespaces for `/usr/bin/bwrap`.** The sandbox runs as the
   ordinary user. The runtime checks that the live child has no capabilities and
   `NoNewPrivs` set; bwrap itself asserts that nested user namespaces are disabled.
4. `/usr/bin/bwrap` is a root-owned regular file, not setuid or setgid, and not writable
   by group or others.

| Refusal | Cause | Provider status |
|---|---|---|
| `execution_containment_launcher_missing` | No `/usr/bin/bwrap`. | unsupported, with the cause |
| `execution_containment_launcher_unsupported` | Older than 0.12.0, or not a `bubblewrap X.Y.Z` report. | unsupported, with the cause |
| `execution_containment_launcher_unsafe` | The setup probe created a host path. | unsupported, with the cause |
| `execution_containment_launcher_authority` | Not root-owned, or an unsafe file mode. | unsupported, with the cause |
| `execution_containment_launcher_denied` | The sandbox could not be built (usually the user-namespace restriction). | retryable, with the cause |
| `execution_containment_launcher_version_unknown` | `bwrap --version` failed or timed out. | retryable, with the cause |
| `execution_containment_launcher_exited` | The sandbox started but the child ended before it answered. | retryable, generic |

These texts are used on Linux only; the darwin and Windows adapters keep their own codes.

## Ubuntu 24.04

A stock Ubuntu 24.04 system meets neither 1 nor 3, measured on a GitHub `ubuntu-24.04`
runner on 2026-10-25 (AppArmor `4.0.1really4.0.1-0ubuntu0.24.04.8`, kernel `6.17.0-1022-azure`):

- The archive's bubblewrap is `0.9.0-1ubuntu0.3`. Ubuntu reverted its CVE-2026-87766
  fix ([USN-8779-2][usn]); the advisory reproduction creates the host directory with it.
- `kernel.apparmor_restrict_unprivileged_userns = 1` and no AppArmor profile covers
  `/usr/bin/bwrap` (Flatpak's profile covers `/usr/bin/flatpak`, which then runs bwrap).
  Every tested bubblewrap (0.9.0, 0.12.0, 0.13.0, 0.13.1), at `/usr/bin/bwrap` or
  elsewhere, is denied the namespace it needs.

With bubblewrap 0.12.0, 0.13.0 or 0.13.1 built from the upstream release at
`/usr/bin/bwrap` (root-owned, mode 0755) and this profile, the restriction stays on and
the runtime's kernel containment fixture passes for every case:

```text
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
}
```

The profile, like Ubuntu's own profiles for applications that need user namespaces,
lets any local process obtain one through `/usr/bin/bwrap`. That is the trade-off the
restriction exists to limit, so it is an administrator's decision; the runtime does not
install it. A bubblewrap outside `/usr/bin` is not covered by such a profile and is
denied as well.

[advisory]: https://github.com/containers/bubblewrap/security/advisories/GHSA-pxhw-h44j-8pfx
[usn]: https://ubuntu.com/security/notices/USN-8779-2
