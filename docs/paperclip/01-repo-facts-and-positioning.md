# Repo Facts And Positioning

## Fresh facts

- repo: [paperclipai/paperclip](https://github.com/paperclipai/paperclip)
- studied revision: `b9a80dcf226c50c8778a70443e41557980376a03`
- latest commit seen locally: `2026-04-17`
- branch: `master`
- GitHub stars at study time: `55.4k`

## Stack

From the repo and official architecture docs:

- frontend: React 19, Vite 6, React Router 7, Tailwind 4, TanStack Query
- backend: Node.js 20+, Express 5, TypeScript
- database: PostgreSQL 17 / embedded local mode, Drizzle ORM
- auth: Better Auth + API keys
- package manager: pnpm workspaces

## What Paperclip says it is

Paperclip consistently positions itself as:

- open-source orchestration for zero-human companies
- a control plane for autonomous AI companies
- company-centric, not chat-centric
- not a code-review tool
- not primarily a workflow builder

That positioning is important because the architecture mostly matches it.

## What kind of competitor it really is

Paperclip is not our closest competitor in "agentic IDE" terms.

It is a stronger competitor in:

- company operating system
- board/operator workflow
- approvals and governance
- multi-user org control
- budget and cost management

It is a weaker competitor in:

- tight coding loop ergonomics
- local operator steering
- direct coding-cockpit feel
- low-overhead local orchestration

## Immediate architect lesson

Paperclip is useful to study because it has:

- more serious control-plane ambition than many agent tools
- more persisted domain objects than most competitors
- enough real product surface to show where theory and operator reality diverge
