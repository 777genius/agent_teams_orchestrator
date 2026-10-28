# Runtime source release publication

Tag pushes create a draft source release and build binary deliveries independently.
A successful build alone does not authorize or prove public delivery: binary
qualification drafts stay private until the normal `publish_release=true` path
publishes and verifies them.

`Promote Verified Source Releases` runs on the default branch after either
`Release Runtime` or `Runtime Source Release` succeeds. It reconciles source
drafts against published, stable binary releases. Listening to both workflows
handles either completion order. Manual dispatch repairs older drafts without
rebuilding binaries:

```sh
gh workflow run promote-source-releases.yml --repo 777genius/agent_teams_orchestrator --ref main
```

The promotion gate checks anonymous release metadata, exact tag commit provenance,
platform archives, manifest/checksum consistency and anonymous asset URLs before
publishing the source release. It never publishes binary drafts or prereleases,
never changes existing public source releases, and never promotes an old version
to GitHub's latest release. Unsupported or inconsistent deliveries fail closed.
Historical manifests with four platforms are supported; Windows ARM64 was added
later. Archive bytes are qualified by the binary release process; reconciliation
checks metadata and availability rather than redownloading every historical archive.

Preview eligibility without writing:

```sh
python3 scripts/release/promote-source-releases.py
python3 scripts/release/promote-source-releases.py --tag v0.0.145
```

Before updating the desktop app's `runtime.lock.json`, require a published stable
binary release and anonymously accessible assets. An authenticated `gh` listing
can see drafts and is insufficient. Packaged applications include the pinned
runtime; fresh development installs download from the public binaries repository.
