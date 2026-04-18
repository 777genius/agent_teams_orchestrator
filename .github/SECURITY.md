# Security Model

This repository contains the CLI/runtime layer for `claude-multimodel`.
It is not the Electron desktop app, so security boundaries here are centered on
tool permissions, filesystem validation, shell command validation, and runtime
policy enforcement rather than desktop IPC.

## Current security boundaries

### Filesystem access

Filesystem reads and writes are mediated by the permission system in:

- `src/utils/permissions/filesystem.ts`
- `src/utils/permissions/pathValidation.ts`

The effective model is:

- deny rules take precedence over allow rules
- reads are generally allowed inside approved working paths and explicit
  readable internal paths
- writes and creates require either explicit allow rules, `acceptEdits` mode,
  or dedicated internal-path allowances
- sandbox write allowlists are respected, but deny-within-allow rules still win

This is broader and more accurate than the older desktop-oriented wording that
said file reads were only constrained to the project root and `~/.claude`.

### Protected paths

Auto-edit and path-safety checks intentionally protect high-risk files and
directories. The current protected set includes sensitive config and execution
surfaces such as:

- `.git/`
- `.vscode/`
- `.idea/`
- `.claude/`
- `.mcp.json`
- `.claude.json`
- shell startup files like `.bashrc`, `.zshrc`, `.profile`
- Claude settings files such as `.claude/settings.json` and
  `.claude/settings.local.json`

These checks are enforced through the permission and path-validation helpers,
not through a desktop IPC containment layer.

### Shell command validation

Shell commands are validated separately from file operations. Read-only command
flows go through allowlist- and parser-based checks in:

- `src/tools/BashTool/readOnlyValidation.ts`
- `src/utils/shell/readOnlyCommandValidation.js`

These validators aim to prevent writes, code execution, network exfiltration,
and flag-parsing bypasses in commands that are supposed to be read-only.

## What changed from the old wording

The old statement was stale in two ways:

1. it referred to IPC handlers, which do not exist in this runtime repo
2. it implied a narrower file-read boundary than the current permission system
   actually implements

The current repo should be described as a CLI runtime with layered permission
checks, path validation, dangerous-path protection, and shell command
validation.
