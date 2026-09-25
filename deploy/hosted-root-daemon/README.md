# Hosted OpenCode root daemon package (inactive)

Status: post-v1 hostile-runtime profile. v1 uses the `trusted_process`
host-local lane per owner decision 2026-09-25 (Product
`docs/hosted-web-core-v1-scope-lock.md`, "Owner decisions 2026-09-25").

`package.py` compiles `src/entrypoints/hostedOpenCodeRootDaemon.ts` on Linux x64
for Linux x64 with Bun 1.4.2 and emits an inert release directory. It does not install,
start, configure, or admit the daemon. The ordinary `scripts/build.ts` CLI build
remains portable across macOS, Linux, and Windows and does not include this
root-only executable.

The builder requires an exact committed source tree, an explicit nonzero Owner
UID and GID, and the reviewed official OpenCode v1.18.32 image lock. It extracts
the exact Git commit into a private source tree and copies installed dependencies
there before compiling. The daemon, helper, image lock and recipe all come from
that archived revision. Concurrent worktree changes cannot enter the build.
The builder compiles twice from the same snapshot and rejects differing bytes.
It uses only the official upstream artifact already pinned in
`deploy/hosted-opencode-image/artifact-lock.json`. It never resolves a
host-installed OpenCode binary. The output has a canonical manifest, exact
file SHA-256 values and modes, and `manifest.sha256`. `--verify` checks those
bytes without executing the daemon or OpenCode.

Supply the official `bun-linux-x64.zip` from
`oven-sh/bun` release `bun-v1.4.2`. Its reviewed archive SHA-256 is
`36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913`;
the contained executable SHA-256 is
`a83d263767d839e4d2649ca8e35d07159c7afc99afdc96d731ced29e056dda0c`.
The builder verifies both and runs only that extracted executable; it does not
download or select Bun from PATH.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 deploy/hosted-root-daemon/package.py \
  --output-dir /absolute/new/disposable/hosted-root-daemon-package \
  --owner-uid 1401 --owner-gid 1402 \
  --bun-archive /absolute/path/to/official/bun-linux-x64.zip
PYTHONDONTWRITEBYTECODE=1 python3 deploy/hosted-root-daemon/package.py \
  --verify /absolute/new/disposable/hosted-root-daemon-package
```

The package also copies the reviewed FD3 helper at an exact digest; it never
executes it. The production Python interpreter SHA-256 and seccomp policy are
host admission inputs and must be pinned separately in the root config.

UID/GID 1401/1402 are examples; production values must identify a dedicated
unprivileged Owner account, distinct from root. The manifest specifies
root-owned, non-writable install paths and a root-only mode 0400 config. The
installer must check root ownership, every ancestor's immutability, file modes,
manifest digest, exact daemon digest, and the configured Owner UID/GID after
copying. The manifest is an artifact receipt, not an installer or authority to
activate services.

`imageManifestDigest` is deliberately null and `activation` is `disabled`.
Production activation additionally needs an independently reviewed immutable
`repo@sha256:<manifest-digest>` OpenCode image, a matching root-owned release
lease and config, admitted Docker/network policy, exact official executable
attestation, secret provisioning, and the Owner RPC generation gate. The root
daemon may then read only its installed root-owned config; no Owner-supplied
path or host-local OpenCode fallback is an acceptable activation path for this
daemon. That rule applies to the post-v1 container profile only; it does not
apply to v1, whose runtime is the host-local lane.
