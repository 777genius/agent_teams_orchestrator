# Canopy Prompt Architecture

How overstory uses canopy for agent prompt management: inheritance chains, shared sections, variable substitution, and runtime flow.

## Prompt Inheritance Tree

```
base-agent                          (root — universal principles)
│
├── leaf-worker                     (single-worker constraints)
│   ├── builder                     (implementation specialist)
│   ├── merger                      (branch merge specialist)
│   └── read-only-worker            (read-only restriction layer)
│       ├── scout                   (exploration, no writes)
│       └── reviewer                (validation, no writes)
│
├── coordinator-base                (leadership/orchestration)
│   ├── lead                        (team lead, spawns sub-workers)
│   ├── orchestrator                (multi-repo coordinator)
│   ├── supervisor                  (per-project supervisor) [DEPRECATED]
│   └── coordinator-agent           (top-level coordinator)
│
└── monitor                         (Tier 2 fleet patrol)
```

### Profile / Delivery Prompts (separate chain)

```
ov-delivery                         (base delivery guidance)
├── ov-architecture                 (architecture-focused sessions)
├── ov-co-creation                  (collaborative sessions)
├── ov-discovery                    (brownfield codebase discovery)
├── ov-research                     (research-oriented sessions)
└── ov-red-hat                      (adversarial/risk analysis)
```

### Standalone Utility Prompts (no inheritance)

```
prioritize                          (issue prioritization)
release                             (release management)
pr-reviews                          (pull request review)
issue-reviews                       (issue quality review)
```

## Shared Sections

Sections flow down the inheritance chain. Children inherit all parent sections and can override them.

```
base-agent sections:
┌──────────────────────────┐
│ propulsion-principle     │──→ "Execute immediately, no planning"
│ cost-awareness           │──→ Token efficiency in communications
│ failure-modes            │──→ Named failures: SILENT_FAILURE,
│                          │    PATH_BOUNDARY_VIOLATION, etc.
│ overlay                  │──→ Points to task-specific CLAUDE.md
└──────────────────────────┘
         │
         │ inherited by ALL agent types
         ▼
┌──────────────────────────────────────────────────────────┐
│                                                          │
│  leaf-worker adds:              coordinator-base adds:   │
│  ┌────────────────────┐         ┌──────────────────────┐ │
│  │ intro              │         │ intro                │ │
│  │ role               │         │ role                 │ │
│  │ constraints        │         │ constraints          │ │
│  │  (worktree, file   │         │  (can spawn agents,  │ │
│  │   scope, branch)   │         │   hierarchy limits)  │ │
│  │ communication-     │         │ communication-       │ │
│  │  protocol          │         │  protocol            │ │
│  │ completion-        │         │ completion-          │ │
│  │  protocol          │         │  protocol            │ │
│  └────────────────────┘         └──────────────────────┘ │
│         │                              │                 │
│         ▼                              ▼                 │
│  Specialized agents            Specialized agents        │
│  override/add:                 override/add:             │
│                                                          │
│  builder:                      lead:                     │
│   └ capabilities, workflow      └ task-complexity-       │
│                                    assessment            │
│  merger:                         three-phase-workflow    │
│   └ merge-order, workflow        decomposition-         │
│                                    guidelines            │
│  scout:                                                  │
│   └ capabilities (read-only)   orchestrator:             │
│                                 └ capabilities,          │
│  reviewer:                        workflow               │
│   └ review-checklist,                                    │
│     capabilities               coordinator-agent:        │
│                                 └ capabilities,          │
│                                   workflow               │
└──────────────────────────────────────────────────────────┘
```

## Section Override Map

Which specialized prompts override which inherited sections:

| Section | base-agent | leaf-worker | builder | scout | reviewer | merger | coordinator-base | lead | orchestrator |
|---|---|---|---|---|---|---|---|---|---|
| propulsion-principle | **defines** | inherits | inherits | inherits | inherits | inherits | inherits | inherits | inherits |
| cost-awareness | **defines** | inherits | inherits | inherits | inherits | inherits | inherits | inherits | inherits |
| failure-modes | **defines** | inherits | inherits | inherits | inherits | inherits | inherits | inherits | inherits |
| overlay | **defines** | inherits | inherits | inherits | inherits | inherits | inherits | inherits | inherits |
| intro | — | **defines** | **overrides** | **overrides** | **overrides** | **overrides** | **defines** | **overrides** | **overrides** |
| role | — | **defines** | **overrides** | **overrides** | **overrides** | **overrides** | **defines** | **overrides** | **overrides** |
| constraints | — | **defines** | inherits | inherits | inherits | inherits | **defines** | inherits | inherits |
| communication-protocol | — | **defines** | inherits | inherits | inherits | inherits | **defines** | inherits | inherits |
| completion-protocol | — | **defines** | inherits | inherits | inherits | inherits | **defines** | inherits | inherits |
| capabilities | — | — | **defines** | **defines** | **defines** | — | — | **defines** | **defines** |
| workflow | — | — | **defines** | — | — | **defines** | — | — | **defines** |
| review-checklist | — | — | — | — | **defines** | — | — | — | — |
| merge-order | — | — | — | — | — | **defines** | — | — | — |
| task-complexity-assessment | — | — | — | — | — | — | — | **defines** | — |
| three-phase-workflow | — | — | — | — | — | — | — | **defines** | — |
| decomposition-guidelines | — | — | — | — | — | — | — | **defines** | — |

## Variables

### Quality Gate Variables (4 formats, same content)

Used in completion/capabilities sections. Canopy resolves these at render time based on the project's configured quality gates.

| Variable | Format | Example Output |
|---|---|---|
| `{{QUALITY_GATE_INLINE}}` | Backtick-delimited | `` `bun test`, `bun run lint` `` |
| `{{QUALITY_GATE_STEPS}}` | Numbered steps | `1. Run tests: bun test` |
| `{{QUALITY_GATE_BASH}}` | Code block | `bun test        # tests` |
| `{{QUALITY_GATE_CAPABILITIES}}` | Bullet list | `- Run bun test` |

### Task Tracker Variables

| Variable | Purpose | Values |
|---|---|---|
| `{{TRACKER_CLI}}` | CLI command name | `sd` or `bd` |
| `{{TRACKER_NAME}}` | Human-readable name | `seeds` or `beads` |

### Instruction Path

| Variable | Purpose | Default |
|---|---|---|
| `{{INSTRUCTION_PATH}}` | Where agent reads its task overlay | `.claude/CLAUDE.md` |

### Overlay Variables (set by `ov sling` at spawn time)

These are substituted into `templates/overlay.md.tmpl` when spawning an agent:

```
Task Context                    Git Context
┌───────────────────────┐       ┌───────────────────────┐
│ {{AGENT_NAME}}        │       │ {{BRANCH_NAME}}       │
│ {{TASK_ID}}           │       │ {{WORKTREE_PATH}}     │
│ {{SPEC_PATH}}         │       │ {{BASE_BRANCH}}       │
└───────────────────────┘       └───────────────────────┘

Hierarchy                       Scope
┌───────────────────────┐       ┌───────────────────────┐
│ {{PARENT_AGENT}}      │       │ {{FILE_SCOPE}}        │
│ {{DEPTH}}             │       │ {{MULCH_DOMAINS}}     │
│ {{CAN_SPAWN}}         │       │ {{MULCH_EXPERTISE}}   │
└───────────────────────┘       └───────────────────────┘

Control                         Content
┌───────────────────────┐       ┌───────────────────────┐
│ {{SKIP_SCOUT}}        │       │ {{BASE_DEFINITION}}   │
│ {{DISPATCH_OVERRIDES}}│       │ {{PROFILE_INSTRUCTIONS}}│
└───────────────────────┘       └───────────────────────┘
```

## Runtime Flow

How canopy prompts are assembled and delivered to an agent:

```
                         ov sling <task-id> --capability builder --profile ov-architecture
                                              │
                    ┌─────────────────────────┼──────────────────────────┐
                    ▼                         ▼                          ▼
           1. Resolve base             2. Resolve profile         3. Build overlay
           agent definition            (if --profile set)         from template
                    │                         │                          │
                    ▼                         ▼                          ▼
           cn render builder           cn render                  Read templates/
           --json                      ov-architecture            overlay.md.tmpl
                    │                  --json                          │
                    ▼                         │                        │
           Canopy resolves:                   ▼                        │
           base-agent                  Canopy resolves:                │
             → leaf-worker             ov-delivery                    │
               → builder                → ov-architecture             │
           Joins all sections                 │                        │
           Substitutes variables              ▼                        │
           (QUALITY_GATE_*,            Join sections                   │
            TRACKER_CLI, etc.)         as markdown                     │
                    │                         │                        │
                    ▼                         ▼                        ▼
              {{BASE_DEFINITION}}    {{PROFILE_INSTRUCTIONS}}    overlay.md.tmpl
                    │                         │                        │
                    └─────────────────────────┼────────────────────────┘
                                              │
                                              ▼
                                   Substitute all overlay
                                   variables (AGENT_NAME,
                                   TASK_ID, BRANCH_NAME, etc.)
                                              │
                                              ▼
                                   Write final CLAUDE.md to
                                   agent's worktree at
                                   {{INSTRUCTION_PATH}}
                                              │
                                              ▼
                              ┌───────────────────────────────┐
                              │  Agent reads CLAUDE.md on     │
                              │  startup and follows the      │
                              │  combined instructions:       │
                              │                               │
                              │  - Base definition (HOW)      │
                              │  - Profile guidance (STYLE)   │
                              │  - Overlay specifics (WHAT)   │
                              └───────────────────────────────┘
```

## Key Files

| File | Purpose |
|---|---|
| `.canopy/config.yaml` | Project canopy configuration |
| `.canopy/prompts.jsonl` | All prompt versions (source of truth) |
| `.canopy/schemas.jsonl` | Validation schemas for prompt sections |
| `src/canopy/client.ts` | Canopy CLI wrapper (render, validate, list, show) |
| `src/agents/overlay.ts` | Overlay generation with variable substitution |
| `src/commands/sling.ts` | Profile rendering during agent spawn (lines ~790-804) |
| `templates/overlay.md.tmpl` | Overlay template with all placeholders |
| `agents/*.md` | Emitted (rendered) agent definitions |
