# GoClaw UI vs `claude_team` UI

Date: 2026-04-12  
Author: Codex  
Scope: compare the UI layer only, not the orchestration runtime  
Compared products:
- Our UI: `claude_team`
- Their UI: `goclaw` web UI + `ui/desktop`

## Sources

External:
- GoClaw repo: <https://github.com/nextlevelbuilder/goclaw>
- GoClaw docs: <https://docs.goclaw.sh/>
- GoClaw full docs export: <https://docs.goclaw.sh/llms-full.txt>

Local code snapshots used:
- `goclaw` dev branch at commit `0546850`
- local `claude_team` checkout at `/Users/belief/dev/projects/claude/claude_team`

## Short verdict

There is no single universal winner.

- For a **daily lead cockpit for coding teams**, our `claude_team` UI is stronger.
- For a **self-hosted agent platform dashboard/control plane**, `goclaw` UI is stronger.
- Raw total score is nearly tied, but the products optimize for different jobs.

## High-level scorecard

| Criterion | Our UI | `goclaw` UI | Winner |
|---|---:|---:|---|
| Navigation / information architecture | 7.7 | 9.4 | `goclaw` |
| Desktop workspace / multi-pane workflow | 9.6 | 6.8 | ours |
| Team creation / launch | 9.3 | 7.2 | ours |
| Board and task workflow actions | 9.4 | 8.1 | ours |
| Task detail depth | 9.3 | 8.7 | ours |
| Review / diff / approvals UX | 9.5 | 7.4 | ours |
| Terminal / editor / local processes | 9.7 | 6.4 | ours |
| Explicit orchestration settings | 7.2 | 9.3 | `goclaw` |
| Workspace / files UI | 8.2 | 8.8 | `goclaw` |
| Platform admin / config / observability | 7.2 | 9.5 | `goclaw` |
| Responsive web / localization | 4.6 | 9.4 | `goclaw` |
| Maintainability / modularity | 6.4 | 9.0 | `goclaw` |

Totals:
- `claude_team`: `98.1 / 120`
- `goclaw`: `99.9 / 120`

Important caveat:
- If you weight **coding workflow** higher, we win.
- If you weight **product/web maturity** higher, `goclaw` wins.

## What our UI is objectively better at

### 1. IDE-like desktop workbench

We have a real multi-pane desktop workspace, not just a dashboard wrapper.

Evidence:
- `src/renderer/components/layout/PaneContent.tsx`
- `src/renderer/components/layout/TabBarRow.tsx`
- `src/renderer/store/slices/paneSlice.ts`

What this means:
- tabs
- split panes
- persistent workspace state
- easier lead workflow across team board, review, terminal, editor, graph

### 2. Code review depth

This is still our biggest UI advantage.

Evidence:
- `src/renderer/components/team/review/ChangeReviewDialog.tsx`
- `src/renderer/components/team/ToolApprovalSheet.tsx`
- `src/renderer/hooks/useDiffNavigation.ts`

What we have:
- hunk-level review
- file-level decisions
- editable diff flow
- viewed-file persistence
- stronger review-as-workflow, not only review-as-status

### 3. Embedded terminal and editor integration

We feel much closer to an operator cockpit for a coding swarm.

Evidence:
- `src/renderer/components/terminal/EmbeddedTerminal.tsx`
- `src/renderer/components/team/editor/ProjectEditorOverlay.tsx`
- `src/renderer/components/team/ProcessesSection.tsx`

What we have:
- PTY terminal
- editor overlay
- process visibility
- local URL/process loop
- direct coding workflow inside the app

### 4. Action-dense team workflow

Our team screen is denser and more operational.

Evidence:
- `src/renderer/components/team/TeamDetailView.tsx`
- `src/renderer/components/team/kanban/KanbanBoard.tsx`
- `src/renderer/components/team/dialogs/TaskDetailDialog.tsx`

What is stronger:
- start
- complete
- approve
- request changes
- cancel
- reorder
- view changes
- inline editing

## What `goclaw` UI is objectively better at

### 1. Product shell and information architecture

Their app is much clearer as a platform product.

Evidence:
- `ui/web/src/components/layout/sidebar.tsx`
- `ui/web/src/components/layout/app-layout.tsx`
- `ui/web/src/pages/overview/overview-page.tsx`
- `ui/web/src/pages/config/config-page.tsx`
- `ui/web/src/pages/providers/provider-detail/provider-detail-page.tsx`

What this gives them:
- clearer discoverability
- cleaner admin story
- better separation between product areas
- less cognitive load than our overloaded screens

### 2. Orchestration settings surfaced productively

They expose orchestration policy more clearly in the UI.

Evidence:
- `ui/web/src/pages/teams/team-orchestration-section.tsx`

What is better surfaced there:
- workspace scope
- member request settings
- auto-dispatch
- blocker escalation
- follow-up behavior

We have a lot of orchestration behavior in runtime, but less of it is visible and controllable in product UX.

### 3. Web maturity

Their web product is much more mature than our browser mode.

Evidence:
- `ui/web/src/components/layout/app-layout.tsx`
- `ui/web/src/components/layout/topbar.tsx`
- `ui/web/src/pages/teams/teams-page.tsx`

What is better:
- real responsive app shell
- mobile drawer and adaptive layout
- web-first navigation
- better parity of core product surfaces on the web

### 4. Localization and product polish

They are far ahead on i18n.

Measured signals:
- `ui/web/src/i18n/locales`: `114` locale files
- `ui/web/src`: `421` `useTranslation()` call sites
- our `claude_team/src/renderer`: `0` `useTranslation()` call sites

This is a major maturity gap.

### 5. Workspace/files product surface

Their workspace UI is more productized.

Evidence:
- `ui/web/src/pages/teams/board/team-workspace-dialog.tsx`
- `ui/web/src/pages/vault/components/vault-tree.tsx`

What is better:
- browse/read/upload/move/download feel more explicit
- workspace is a clearer first-class surface

## Important nuance about their desktop UI

At first glance the main docs make it look like they only have web UI.

What I confirmed:
- `goclaw` **does have desktop UI**
- repo contains both `ui/web` and `ui/desktop`
- full docs export mentions a `Desktop Edition`

But the product signal is uneven:
- desktop exists in code
- desktop is much less visible in the main docs
- desktop looks thinner than our workstation-style desktop

So the honest statement is:
- they do have desktop UI
- but their desktop story is weaker and less central than ours

## Browser mode parity: our biggest product gap

One of the most important findings is that our browser mode is not close to desktop parity.

Evidence in `claude_team`:
- `src/renderer/api/httpClient.ts`

Observed limitations in browser mode:
- teams disabled
- launch disabled
- review disabled
- approvals disabled
- terminal disabled
- editor disabled

Conclusion:
- our UI is **desktop-first**
- `goclaw` is much closer to a real web product

## Maintainability findings

This is where `goclaw` gets a very real engineering advantage.

### Our heavy files

- `src/renderer/components/team/TeamDetailView.tsx` - `2803` lines
- `src/renderer/components/team/dialogs/LaunchTeamDialog.tsx` - `1858`
- `src/renderer/components/team/review/ChangeReviewDialog.tsx` - `1399`
- `src/renderer/components/dashboard/DashboardView.tsx` - `878`

### Their equivalent surfaces

- `ui/web/src/pages/teams/team-detail-page.tsx` - `162`
- `ui/web/src/pages/teams/board/board-container.tsx` - `174`
- `ui/web/src/pages/teams/task-sections/task-detail-dialog.tsx` - `268`
- `ui/web/src/pages/config/config-page.tsx` - `180`
- `ui/web/src/pages/overview/overview-page.tsx` - `295`

Conclusion:
- we have more depth packed into fewer giant surfaces
- they have better UI decomposition and maintainability

## Testing signals

These are UI-layer-only signals, not whole-repo signals.

Counts observed:
- `claude_team/src/renderer`: `0` UI test files
- `goclaw/ui/web/src`: `2` UI test files
- `goclaw/ui/desktop/frontend/src`: `0` UI test files

Conclusion:
- neither side is strong on UI-level tests
- `goclaw` still looks more maintainable structurally
- their overall repo test surface is much larger, but UI specifically is not heavily tested either

## Detailed feature-by-feature observations

### Team board

Our board is stronger as an operator surface.  
Their board is cleaner and more product-like.

Our evidence:
- `src/renderer/components/team/kanban/KanbanBoard.tsx`

Their evidence:
- `ui/web/src/pages/teams/board/board-container.tsx`
- `ui/web/src/pages/teams/board/kanban-board.tsx`

### Task detail

Our task detail is stronger for execution and coding workflow.  
Their task detail is stronger for platform-grade metadata, comments, and lifecycle context.

Our evidence:
- `src/renderer/components/team/dialogs/TaskDetailDialog.tsx`

Their evidence:
- `ui/web/src/pages/teams/task-sections/task-detail-dialog.tsx`

### Chat-task linkage

Their task panel inside chat is better than ours.

Their evidence:
- `ui/web/src/components/chat/task-panel.tsx`
- `ui/web/src/pages/chat/hooks/use-chat-team-tasks.ts`

This is a small feature with high leverage.

### Graph views

We have a stronger team/agent workflow graph for lead usage.  
They have stronger knowledge/vault graph product surfaces.

Our evidence:
- `src/renderer/features/agent-graph/ui/TeamGraphTab.tsx`

Their evidence:
- `ui/web/src/pages/memory/knowledge-graph/kg-graph-view.tsx`

### Admin/config/ops

They win clearly here.

Evidence:
- `ui/web/src/pages/providers/providers-page.tsx`
- `ui/web/src/pages/config/config-page.tsx`
- `ui/web/src/pages/logs/logs-page.tsx`
- `ui/web/src/pages/approvals/approvals-page.tsx`

We have settings and extension surfaces, but not the same breadth as platform control plane.

## What we should steal from `goclaw`

Priority order:

1. Explicit orchestration settings UI  
Why: high leverage, low risk

2. Better workspace/files product surface  
Why: fills a daily workflow gap without changing our core strengths

3. Cleaner app shell and navigation taxonomy  
Why: improves discoverability and reduces overloaded screens

4. Chat task panel  
Why: small feature, high awareness value

5. Better browser/web parity  
Why: hardest item, but biggest product gap

6. More modular page decomposition  
Why: engineering velocity and maintainability

## What they should steal from us

1. Real code review cockpit
2. Embedded terminal + editor overlay
3. Denser board actions for lead workflow
4. Workbench-style desktop with panes/tabs
5. Better tool approval UX
6. Process/status surface for local dev loops

## What we should not copy

- Chat-first task creation as the main UX
- Thin desktop-wrapper model
- Weaker review workflow

## Final conclusion

The cleanest formulation is this:

- `claude_team` is a stronger **coding-team workstation**
- `goclaw` is a stronger **agent-platform dashboard**

If we keep our coding-workbench advantage and import their best product-shell ideas, we can close a real product gap without giving up our strongest differentiator.
