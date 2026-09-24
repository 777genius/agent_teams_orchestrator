# Hosted OpenCode image recipe (inactive)

This directory defines a release artifact for official Linux x64 OpenCode
v1.18.32. It is **not** a launch path. `prepare-context.py` refuses to emit a
Docker build context while `artifact-lock.json` remains
`inactive-pending-bootstrap-review`.

## Artifact boundaries

- The official `opencode-linux-x64.tar.gz` release archive must match the
  archive SHA-256 in `artifact-lock.json`. The extracted `opencode` executable
  must independently match the binary SHA-256. The exact source revision and
  Ubuntu base image digest are pinned there too. No build step downloads from
  a mutable tag or runs a package installer.
- The FD3 bootstrap is supplied as an absolute path to a reviewed ELF file.
  After its source and build are reviewed, the release operator must record
  its **actual** SHA-256 in the lock and change status to `reviewed`. The image
  labels that digest. Until then, the recipe is intentionally unusable.
- The resulting image must be published and deployed by its immutable
  `repo@sha256:<manifest-digest>` reference. That digest is recorded in the
  root-owned release lease and checked against Docker's `RepoDigests` and
  image ID. An image cannot truthfully contain a label for its own manifest
  digest because adding the label changes the digest.
- The image contains only the two pinned executables above the pinned base.
  Both are owned by root and copied mode 0555. The default user is UID/GID
  1000. The bootstrap is the entrypoint; the trusted supervisor supplies the
  exact socket name and sender UID command. No credentials, user home,
  runtime package cache, provider config, or writable image layer is copied.

After bootstrap review, prepare a build context in a **new disposable**
directory outside the repository:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 deploy/hosted-opencode-image/prepare-context.py \
  --archive /absolute/path/to/opencode-linux-x64.tar.gz \
  --bootstrap /absolute/path/to/reviewed-bootstrap \
  --output-dir /absolute/new/disposable/context
```

Build only after the independent review and host admission test finish. Use
Docker's pinned platform and record the resulting manifest digest, image ID,
labels, and binary checks in root-only evidence. The image recipe does not
prove the live process: the supervisor must also check the executing
`/proc/<pid>/exe` digest against the pinned official binary before effects.

## Inert configuration

`build-config.py` accepts only `inert-config-spec.json` and emits exactly one
canonical `opencode.json` with all permissions denied, no configured plugins,
and sharing disabled. It requires root and a new output directory below an
entirely root-owned, non-writable, symlink-free ancestry. Every component is
opened from `/` with directory file descriptors; creation and chmod stay bound
to those descriptors. It emits a 0555 directory with one root-owned 0444 file
plus its SHA-256 receipt. The supervisor mounts the directory
read-only at `/sandbox/config`. It must still isolate HOME/XDG directories,
disable project and Claude Code config, and mount an empty `/etc/opencode`.
The inert config is only for capability and image attestation; it does not
authorize a model request or agent command.

The root-owned release process must check the config receipt and directory
identity before container creation. The container has no inherited provider
credentials or environment. Its internal-only Docker bridge has no provider
egress. A separately reviewed, lease-bound gateway is required for the local
Qwen sandbox profile described in `SELECTED_LOCAL_QWEN.md`.
