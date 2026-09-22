# Goclaw + Gastown - Architectural Study For A Better Rust Orchestrator

Date: 2026-04-16

## Scope

Этот документ фиксирует глубокий разбор двух проектов:

- `nextlevelbuilder/goclaw`
- `gastownhall/gastown`  - важно: активный репозиторий `gastownhall/gastown`, но `go.mod` и часть путей все еще используют module path `github.com/steveyegge/gastown`

Цель не в том, чтобы выбрать "кто круче", а в том, чтобы:

- понять сильные архитектурные решения
- понять системные ошибки и pain points
- не повторить эти ошибки в новом `Rust` оркестраторе
- сформировать более сильную архитектуру, учитывая будущий frontend contract уровня `claude agent teams`

## Method

Что было сделано:

- обновлен локальный `goclaw` до свежего `origin/dev`
- свежим клоном взят `gastown`
- просмотрены README, design/docs, ключевые orchestration-пакеты, scheduler/runtime/task lifecycle
- отдельно подняты и изучены свежие GitHub issues как источник реальных жалоб пользователей

Ревизии на момент анализа:

- `goclaw`: `/tmp/goclaw` at `2cbf8381` on branch `dev`
- `gastown`: `/tmp/gastown` at `bdbe8c4b` on branch `main`

Публичные сигналы на 2026-04-16:

- `goclaw`: 2754 stars, 699 forks, 202 open issues, pushed `2026-04-16T08:09:51Z`
- `gastown`: 14171 stars, 1283 forks, 215 open issues, pushed `2026-04-15T21:50:33Z`

Структурные сигналы:

- `goclaw`: 1562 Go files, 461 test files, 48 top-level `internal/*` areas
- `gastown`: 1115 Go files, 492 test files, 68 top-level `internal/*` areas

## Executive Summary

Самый короткий честный вывод:

- `goclaw` сильнее как durable orchestration engine
- `gastown` сильнее как process-model thought experiment и как источник нестандартных идей про persistent workers, work packages, capability routing и crash recovery
- оба проекта содержат важные архитектурные ошибки, которые в новом `Rust` оркестраторе повторять нельзя

Если строить лучший новый оркестратор, то:

- orchestration core стоит брать ближе к `goclaw`
- execution/runtime contract надо строить ближе к тому, что сам `gastown` хочет иметь в будущем, а не к его текущему `tmux` shim слою
- frontend contract надо делать typed и productized с самого начала, а не лепить поверх runtime-хака

## What Goclaw Gets Right

### 1. Durable task state machine

Самая сильная сторона `goclaw` - не UI и не branding, а оркестрационный core:

- lane-based scheduler и session queues в `internal/scheduler/*`
- durable team-task engine в `internal/tools/team_tasks_*`
- recovery ticker в `internal/tasks/task_ticker.go`
- explicit orchestration mode selection в `internal/agent/orchestration_mode.go`

Что особенно хорошо:

- статусы задач явно моделируются и реально используются
- `blocked`, `failed`, `in_review`, `stale` - это не только UI-лейблы
- recovery и redispatch живут в core, а не как "оператор потом вручную поправит"
- зависимости между задачами - это first-class concept, а не комментарии и договоренности

Это хорошая база для `Rust` версии.

### 2. Clear subsystem decomposition

У `goclaw` ядро разложено лучше, чем у большинства agent platforms:

- `scheduler`
- `tasks`
- `tools`
- `store`
- `pipeline`
- `tracing`
- `hooks`
- `providers`
- `gateway`

Это важный плюс: orchestration не спрятана в одном giant runtime loop.

### 3. Runtime invariants are enforced in code

Хороший признак зрелости:

- claim/assign/retry/review/approve/reject живут как code-paths
- stale recovery делается background subsystem
- circuit breaker по dispatch count живет в коде, а не в prompt

Это ровно то, что нужно брать.

### 4. Productization discipline

`goclaw` силен в том, что многие вещи оформлены как отдельные продуктовые подсистемы:

- hooks
- permissions
- tracing
- audit
- tenant scoping
- channels
- secure CLI grants

Даже если половина этого не нужна в v1, сама дисциплина разбиения полезна.

## What Goclaw Gets Wrong

### 1. Scope explosion

Главная проблема `goclaw` - слишком широкая поверхность продукта.

В одном продукте одновременно живут:

- orchestration
- multi-tenancy
- channels
- provider matrix
- hooks
- KG
- vault
- cron
- desktop
- web
- OAuth
- permissions
- tracing

Это делает систему мощной, но дорогой по cognitive load.

Архитектурный урок:

- не смешивать v1 orchestration core и "все остальные платформенные мечты"

### 2. Stringly-typed context propagation

У `goclaw` много orchestration context гоняется через:

- `context.WithValue`
- `TenantIDFromContext`
- `Tool*FromCtx`
- metadata maps в dispatch path

При этом в `internal/store/run_context.go` сами авторы уже признают проблему и вводят typed `RunContext`, чтобы заменить 27 разрозненных `context.WithValue`.

Это очень важный урок для `Rust`:

- не тащить business-critical routing через loosely typed context values
- использовать typed command envelope / run envelope / actor context

### 3. Onboarding and config complexity leaks into core value

Показательные issues:

- `#89 docker goclaw not start`
- `#320 built-in skills seeding failures, permission issues, dependency scanner bugs in Docker`
- `#616 tool not allowed by policy: team_tasks`
- `#555 kanban board doesn't get updated`

Сигнал тут такой:

- если у продукта сложный runtime/config/policy surface, пользователь начинает биться не с orchestration value, а с env/policy drift

Архитектурный урок:

- оркестратор должен иметь минимальный "activation energy"
- orchestration UX не должен тонуть в policy/provider/setup complexity

### 4. Too much product in the hot path

`goclaw` инженерно силен, но местами видно, что platform concerns начинают проникать слишком близко к runtime decisions.

Это опасно потому что:

- сложнее reasoning
- сложнее отладка
- сложнее локальная разработка
- выше риск regressions в seemingly unrelated features

## What Gastown Gets Right

### 1. Process model thinking

Главная ценность `gastown` - способ мышления.

Они не строят систему как "чат с несколькими агентами". Они строят ее как process model:

- persistent identities
- explicit roles
- work packages
- crash-surviving state
- lifecycle agents
- coordination через внешнее durable state, а не только через conversation memory

Это очень сильная идея.

### 2. Worktree-per-worker isolation

Идея с отдельным worktree на worker полезна и сильна:

- изоляция изменений
- прозрачный diff surface
- дешевый parallelism
- удобнее human review и merge discipline

Это архитектурно лучше, чем один shared workspace на всех, если речь именно про coding orchestration.

### 3. Checkpoint + recovery mindset

`internal/checkpoint/checkpoint.go` показывает хорошее мышление:

- agent session может упасть
- важно уметь восстановить не только факт "был запущен", а контекст работы

Это правильный уровень зрелости.

### 4. Capability-based dispatch research

Очень полезный design thought находится в `docs/gas-city/crew-specialization-design.md`.

Там хороши сами идеи:

- capability profiles
- delegation as an alternative to cognition
- routing based on evidence, not только на role name
- learning from bounces and reopened work

Это стоит использовать, но в гораздо более прагматичной форме.

### 5. Execution sandbox direction is correct

Issues и docs показывают, что команда понимает правильное направление:

- `#2229 support local and remote execution sandboxes for polecats`
- `docs/proxy-server.md`

Идея правильная:

- control plane отдельно
- execution plane отдельно
- sandbox/remote worker как adapter

Это нужно брать, но реализовывать аккуратнее.

### 6. Self-awareness about first-generation hacks

Самый ценный документ в `gastown` с точки зрения уроков - `docs/design/factory-worker-api.md`.

Они прямо признают, что текущий слой интеграции с агентами слаб:

- `tmux send-keys`
- regex по prompt prefix
- JSONL scraping
- process tree walking
- timing-sensitive shims

И они сами формулируют правильные принципы:

- push, not scrape
- structured, not string-matched
- agent-agnostic
- correlation by design
- fail-closed defaults

Это надо считать не слабостью, а подарком для нас: они уже показали, на какие грабли не надо наступать.

## What Gastown Gets Wrong

### 1. Hard coupling to substrate

`gastown` слишком сильно привязан к:

- `tmux`
- `Dolt`
- `Beads`
- git worktree conventions
- filesystem layouts
- shell/runtime heuristics

Это не просто implementation detail. Это глубоко прошито в model и tooling.

Показательные issues:

- `#3538 Windows is not a viable platform`
- `#3042 tmux socket isolation reverted, sessions disappear`
- `#2003 doctor checks still read issues.jsonl after Dolt migration`
- `#2384 stale hook_bead remains after unsling`

Урок:

- backend execution mechanism не должен быть обязательной частью domain model

### 2. Too many sources of truth

В `gastown` состояние размазано между:

- Dolt
- Beads
- git
- worktree layout
- tmux session state
- heartbeat files
- redispatch-state JSON
- checkpoint files
- env vars

Это увеличивает resiliency в одном смысле, но повышает шанс silent drift в другом.

Issue `#2003` особенно показателен:

- после миграции на новый backend часть doctor-checks продолжала читать старый `issues.jsonl`
- в результате проверки молча говорили "все ок", хотя уже смотрели не туда

Это один из самых опасных типов ошибок.

### 3. Polling and shim logic instead of stable worker protocol

`gastown` сегодня в значительной степени оркестрирует через shim-слой:

- pane scraping
- readiness guessing
- send-keys
- hook side effects
- heartbeat files

Даже сами docs это называют timing-sensitive.

Это годится как bootstrap path, но не как долгосрочный core contract.

### 4. Domain language overload

Терминология у `gastown` креативная, но перегруженная:

- mayor
- deacon
- dog
- polecat
- convoy
- wisp
- wasteland

Это хорошо для lore, но плохо для maintainability, onboarding и API clarity.

Урок:

- допустимы expressive product labels
- core domain model должен использовать boring names

### 5. Invariants are not enforced hard enough in some loops

Issue `#2386 deacon patrol can fast-loop fake cycles without executing formula steps` очень показателен.

Это уже не UX-баг. Это архитектурный баг:

- система могла "отчитываться" о работе без фактического выполнения всех шагов

Урок:

- lifecycle invariants должны быть проверяемыми в коде и данных
- "cycle completed" нельзя разрешать без подтвержденного step execution trail

## Community Pain - What Users Actually Complain About

### Goclaw recurring pain

- Docker/onboarding/environment problems
- permissions/tool policy surprises
- UI/runtime desync
- confusing provider/config setup
- documentation gaps on non-happy paths

Representative issues:

- `#89`
- `#320`
- `#555`
- `#616`
- `#862`

### Gastown recurring pain

- `tmux` and platform coupling
- Windows incompatibility
- migration drift between storage layers
- stale runtime artifacts and repair burden
- polling and wakeup semantics
- provider/runtime integration fragility

Representative issues:

- `#741`
- `#925`
- `#1066`
- `#2003`
- `#2067`
- `#2229`
- `#2384`
- `#2386`
- `#3042`
- `#3538`

## Best Ideas To Keep

### From Goclaw

- durable task state machine
- explicit dependency graph and blocker handling
- recovery ticker and stale recovery
- scheduler lanes and per-session queues
- tracing/audit as first-class subsystems
- clear separation between pipeline, store, tools, scheduler

### From Gastown

- worktree-per-agent isolation for coding tasks
- checkpoint/resume concept
- capability-based dispatch as a long-term evolution path
- process-model view of orchestration
- remote/sandbox execution as pluggable adapter
- explicit worker API direction from `factory-worker-api.md`

## Anti-Patterns To Avoid

### 1. Do not make `tmux` the architecture

`tmux` can be an adapter.

`tmux` must not be:

- the lifecycle truth
- the liveness truth
- the routing truth
- the primary integration contract

### 2. Do not make the storage migration half-complete

If backend moves from A to B:

- doctor
- health
- dashboards
- reports
- repair commands
- recovery jobs

must all read the same truth source.

### 3. Do not let prompts enforce invariants

Prompt text can guide agents.

Prompt text must not be the only thing preventing:

- duplicate claims
- fake completion
- incorrect approval
- unsafe retry
- invalid dispatch chains

### 4. Do not spread routing state across ad-hoc maps and context keys

In Rust this should become:

- typed command envelope
- typed runtime/session identity
- typed origin metadata
- explicit event schema

not:

- anonymous metadata maps
- dozens of string keys

### 5. Do not mix v1 orchestrator core with full platform ambition

For v1, avoid pulling in:

- multi-tenancy
- marketplace
- channels matrix
- KG
- self-evolution
- cloud federation

unless they materially improve the orchestration core.

## Recommended Rust Architecture

### Core principle

Build a `durable local-first orchestration engine` with `pluggable execution backends` and a `typed frontend contract`.

This means:

- closer to `goclaw` in state-machine maturity
- closer to `gastown` future worker API than to its current `tmux` shim
- closer to `claude agent teams` in operator UX and frontend contract

### Bounded contexts

Suggested crates/modules:

1. `orchestrator-domain`
   - task graph
   - dependency model
   - session lifecycle
   - approvals
   - failure and retry semantics

2. `orchestrator-store`
   - SQLite first
   - Postgres later
   - repositories for tasks, runs, agents, events, checkpoints

3. `orchestrator-scheduler`
   - lanes
   - per-session queues
   - fairness
   - cancellation
   - backpressure

4. `orchestrator-worker-protocol`
   - typed JSON schema over UDS/WebSocket/stdio
   - lifecycle events
   - prompt submission
   - telemetry
   - tool authorization
   - checkpoint exchange

5. `orchestrator-exec`
   - local PTY adapter
   - `tmux` adapter
   - SSH adapter
   - container sandbox adapter

6. `orchestrator-policy`
   - tool policy
   - workspace policy
   - approval policy

7. `orchestrator-observability`
   - traces
   - task events
   - per-task logs
   - run timelines

8. `orchestrator-api`
   - frontend contract
   - websocket streams
   - snapshots
   - commands/query handlers

### Source of truth

Single durable truth:

- task state
- dispatch attempts
- run lifecycle
- approvals
- checkpoints
- structured events

Optional truth:

- git worktrees
- `tmux` sessions
- containers
- transcripts

These are execution artifacts, not domain truth.

### Worker contract

Adopt the principles from `gastown` future worker API:

- worker pushes lifecycle
- worker pushes telemetry
- worker asks for tool authorization
- orchestrator sends typed prompts/context blocks
- all messages carry `run_id`, `task_id`, `worker_id`, `session_id`

Do not scrape:

- terminal output for readiness
- shell prompt text
- JSONL internals of vendor CLIs

### Coding orchestration model

For code work, prefer:

- one task -> one run
- one worker -> isolated worktree or isolated writable subtree
- result = structured completion + artifacts + diff references + optional checkpoint

This gives you `gastown` isolation benefits without inheriting its whole ontology.

### Frontend contract

Because the future frontend is expected to be in the spirit of `claude agent teams`, API contracts should be explicit from day one:

- task board snapshots
- per-task event timeline
- per-task raw logs
- per-worker live status
- approvals and reviews
- run graph
- workspace/file surfaces

Frontend should consume typed DTOs, not reconstruct orchestration state from logs.

## Top 3 Architecture Directions

### 1. Recommended - Durable local-first orchestrator with pluggable executors

`🎯 9.5   🛡️ 9.3   🧠 7`

Approx size for solid v1 core: `18k-30k` LOC

Shape:

- Rust daemon/core
- SQLite first
- Axum API + WebSocket
- worker protocol over UDS/stdio
- local PTY and worktree adapters first
- `tmux` optional, not required

Why this is best:

- avoids `goclaw` scope explosion
- avoids `gastown` substrate lock-in
- gives strong UX for local coding teams
- still leaves room for later Postgres/web platform growth

### 2. Local-supervisor desktop orchestrator

`🎯 8.6   🛡️ 8.8   🧠 6`

Approx size for v1: `14k-24k` LOC

Shape:

- core embedded in desktop app
- SQLite embedded
- minimal separate daemon
- very strong local UX

Tradeoff:

- faster to ship
- strongest for solo/power-user workflow
- weaker long-term if you later want remote agents and multi-host orchestration

### 3. Platform-first multi-tenant orchestrator

`🎯 7.2   🛡️ 8.5   🧠 9`

Approx size for serious v1: `30k-55k` LOC

Shape:

- Postgres-first
- multi-tenant API
- web UI first
- broader provider/channel model

Tradeoff:

- closest to `goclaw`
- technically powerful
- highest risk of building a platform before the orchestration engine and operator experience are excellent

## Final Recommendation

If the goal is "сделать еще лучше версию", то лучший путь сейчас:

- взять `goclaw` как reference по durable orchestration semantics
- взять `gastown` как reference по process model, worktree isolation, checkpoint/recovery и future worker API
- сознательно НЕ брать их текущие слабости:
  - `goclaw` scope explosion
  - `gastown` tmux/Dolt/Beads hard coupling

Идеальная целевая формула для нового проекта:

- boring core model
- typed worker protocol
- durable task graph
- optional execution backends
- strong local coding UX
- frontend contract as a first-class API, not a reconstruction layer

## Links And References

### Repos

- https://github.com/nextlevelbuilder/goclaw
- https://github.com/gastownhall/gastown

### Key Goclaw references

- `internal/scheduler/scheduler.go`
- `internal/tasks/task_ticker.go`
- `internal/tools/team_tool_dispatch.go`
- `internal/tools/subagent_spawn.go`
- `internal/pipeline/pipeline.go`
- `internal/store/run_context.go`
- `docs/11-agent-teams.md`

### Key Gastown references

- `docs/design/architecture.md`
- `docs/design/factory-worker-api.md`
- `docs/agent-provider-integration.md`
- `docs/proxy-server.md`
- `docs/gas-city/crew-specialization-design.md`
- `internal/deacon/manager.go`
- `internal/deacon/redispatch.go`
- `internal/polecat/manager.go`
- `internal/polecat/session_manager.go`
- `internal/session/registry.go`
- `internal/checkpoint/checkpoint.go`

### Representative issues

- Goclaw: `#89`, `#320`, `#555`, `#616`, `#862`
- Gastown: `#741`, `#925`, `#1066`, `#2003`, `#2067`, `#2229`, `#2384`, `#2386`, `#3042`, `#3538`
