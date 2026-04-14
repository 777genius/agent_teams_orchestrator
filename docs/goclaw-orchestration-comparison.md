# Сравнение orchestration core: `goclaw` vs наш оркестратор

Дата сверки: 12 апреля 2026

Проверенные ревизии:
- `goclaw`: `origin/dev @ 0546850`
- наш код: локальный workspace `agent_teams_orchestrator` на 12 апреля 2026

Скоуп сравнения:
- `goclaw` как orchestration runtime и durable subsystem
- наш `agent_teams_orchestrator` как orchestration runtime
- UI сюда не включён, для него есть отдельный документ: [goclaw-ui-comparison.md](./goclaw-ui-comparison.md)

Публичные источники:
- [GoClaw repo](https://github.com/nextlevelbuilder/goclaw)
- [GoClaw docs](https://docs.goclaw.sh/)
- [GoClaw full docs](https://docs.goclaw.sh/llms-full.txt)

Как сравнивал:
- читал код `goclaw` по `internal/scheduler`, `internal/tools/subagent_*`, `internal/tools/team_*`, `internal/tasks`, `internal/store/pg`, `internal/store/sqlitestore`, `internal/gateway/methods`
- читал наш код по `src/services/teamBootstrap`, `src/tools/shared/spawnMultiAgent.ts`, `src/utils/swarm/inProcessRunner.ts`, `src/utils/tasks.ts`, `src/query.ts`, `src/utils/QueryGuard.ts`, `src/services/boardTaskActivity`
- отдельно сверял публичную доку `goclaw` по scheduling, tracing, teams, changelog
- смотрел не только наличие фич, но и насколько они оформлены как durable subsystem, какие у них state transitions, recovery paths, tests и trace continuity
- не проводил load test, chaos/fault injection и длинный live soak test, поэтому сравнение основано на коде, тестах и документации, а не на нагрузочном прогоне

## Короткий вердикт

Если вопрос именно такой:

- кто лучше как **autonomous multi-agent orchestrator** с durable task lifecycle, stale recovery, retry, review, redispatch, fairness и trace continuity

то сейчас сильнее **`goclaw`**.

- 🎯 9.2   🛡️ 8.8   🧠 3

Если вопрос такой:

- кто лучше как **terminal-first local coding swarm orchestrator**, где сильный lead вручную рулит агентами, backends локальные, а bootstrap должен быть максимально предсказуем

то сильнее **наш оркестратор**.

- 🎯 9.0   🛡️ 8.9   🧠 3

Самая честная формулировка:

- `goclaw` сильнее как **platform-grade orchestration subsystem**
- мы сильнее как **operator-centric local swarm runtime**

## Расшифровка терминов

### Что я называю orchestration engine

Это не UI и не удобство лида, а сам runtime координации:
- как создаются и живут задачи
- как ведутся зависимости и `blocked_by`
- как переживаются `stale`, `failed`, retry и followup
- как устроены dispatch, fairness и anti-loop guardrails
- как сохраняются state, audit trail и traces
- как система ведёт себя, если lead временно не вмешивается

Коротко:
- **engine** = насколько система сама умеет координировать пачку агентов как устойчивую машину

### Что я называю orchestration cockpit

Это уже операторский control plane:
- насколько удобно лиду поднять команду
- насколько просто видеть, кто чем занят
- насколько легко вручную вмешаться, остановить, перезапустить, переназначить
- насколько хороший local coding loop вокруг swarm
- насколько хорошо orchestration встроена в terminal/runtime workflow

Коротко:
- **cockpit** = насколько удобно сильному человеку-оператору рулить командой здесь и сейчас

### Что я называю deterministic bootstrap

В нашем контексте это строго управляемый запуск команды агентов, где один и тот же bootstrap-spec при одинаковом окружении должен давать один и тот же результат или явно падать.

Это означает:
- жёсткая валидация спеки
- stable request hash
- workspace assertion
- timeout budget
- runtime identity drift detection
- ownership lock
- persisted bootstrap phases

Коротко:
- **обычный bootstrap** = "попробовали поднять команду"
- **deterministic bootstrap** = "подняли команду по строгому контракту, иначе зафейлились с точной причиной"

## Сценарная таблица

| Сценарий | Кто сильнее | Почему |
|---|---|---|
| Автономная orchestration нескольких агентов | `goclaw` | scheduler, durable task states, stale recovery, retry, followups, redispatch |
| Long-running unattended team workflow | `goclaw` | система лучше держит долгий task graph без постоянного ручного контроля |
| Team task lifecycle с review/reject/approve | `goclaw` | review loop и transitions оформлены как durable store-backed lifecycle |
| Local terminal-first coding swarm | наш | сильнее operator control, backends, live вмешательство, bootstrap discipline |
| Предсказуемый запуск локальной команды | наш | deterministic bootstrap заметно сильнее и строже оформлен |
| Fair dispatch и anti-loop safety | `goclaw` | у них это оформлено как отдельные guardrails уровня runtime |
| Live operator-centric control | наш | лучше ручное руление teammate loops и локальными сессиями |
| Durable task history, audit, trace continuity | `goclaw` | store-backed comments/events/followups/traces и recovery trail |
| Живой runtime context вокруг текущей работы | наш | локальный transcript/runtime context плотнее и ближе к живой работе |

## Короткие ответы на вопросы, которые уже всплывали

### Кто сильнее по orchestration нескольких агентов

Если без скидок и именно по orchestration core:
- **в целом сильнее `goclaw`**

Если сужать вопрос до local terminal-first coding swarm:
- **сильнее наш оркестратор**

### `goclaw` лучше как orchestration engine, а мы как orchestration cockpit - что это значит

Это значит:
- `goclaw` лучше отвечает на вопрос "как сделать, чтобы пачка агентов жила как автономная система"
- мы лучше отвечаем на вопрос "как дать сильному оператору удобный пульт для управления coding-командой"

### Есть ли у `goclaw` удобные логи по каждой таске

Частично да.

У них есть:
- task-scoped comments
- audit events
- attachments
- progress/followup
- traces и realtime team events

Но я не нашёл настолько же сильного raw per-task execution log cockpit в стиле "открыл таску и видишь непрерывно, что именно делает агент".

Вывод:
- durable task activity у них сильная
- raw per-task execution console не выглядит их самой сильной стороной

## Итоговый scorecard

| Критерий | Наш | `goclaw` | Кто лучше |
|---|---:|---:|---|
| Scheduler, queue semantics, backpressure | 6.6 | 9.4 | `goclaw` |
| Session isolation and cancellation semantics | 7.2 | 9.1 | `goclaw` |
| Subagent lifecycle and steering | 8.0 | 8.8 | `goclaw` |
| Team task state machine | 6.8 | 9.5 | `goclaw` |
| Dependencies and blocked work | 7.1 | 9.3 | `goclaw` |
| Recovery, stale handling, retry, followups | 7.3 | 9.5 | `goclaw` |
| Dispatch fairness and loop prevention | 6.9 | 9.2 | `goclaw` |
| Persistence, audit, trace continuity | 7.0 | 9.2 | `goclaw` |
| Human-in-the-loop operator control | 9.5 | 7.4 | наш |
| Local execution backends and ergonomics | 9.1 | 7.7 | наш |
| Deterministic bootstrap safety | 9.6 | 7.5 | наш |
| Direct orchestration test surface | 7.6 | 8.6 | `goclaw` |

Итог:

- `goclaw`: **8.9 / 10**
- наш оркестратор: **7.9 / 10**

## 1. Scheduler и queue model

### `goclaw`

Сильнее структурно.

Причины:
- Есть реальный scheduler как отдельная подсистема: lanes `main/subagent/team/cron` с явными concurrency ceilings  
  [lanes.go](https://github.com/nextlevelbuilder/goclaw/blob/dev/internal/scheduler/lanes.go)
- Есть session queue с режимами `queue`, `followup`, `interrupt`, капами, `drop old/new`, debounce и adaptive throttle near context pressure  
  [queue.go](https://github.com/nextlevelbuilder/goclaw/blob/dev/internal/scheduler/queue.go)
- Есть `CancelSession`, `CancelOneSession`, draining mode и stale completion filtering через generation/reset  
  [scheduler.go](https://github.com/nextlevelbuilder/goclaw/blob/dev/internal/scheduler/scheduler.go)  
  [scheduler_queue_test.go](https://github.com/nextlevelbuilder/goclaw/blob/dev/internal/scheduler/scheduler_queue_test.go)

Самое важное:
- orchestration не размазана по UI loop и не держится на implicit local discipline
- queue semantics у них оформлена как **явный контракт runtime**

Оценка:
- 🎯 9.5   🛡️ 9.1   🧠 6

### Наш оркестратор

У нас сильнее не scheduler, а **guarded single-active execution discipline**.

Что есть:
- `QueryGuard` защищает от re-entry между `idle/dispatching/running`  
  [src/utils/QueryGuard.ts](../src/utils/QueryGuard.ts)
- Есть process-global command queue, shared by main thread and in-process subagents, с `agentId` scoping  
  [src/query.ts](../src/query.ts)

Что слабее:
- нет отдельной lane-based scheduler subsystem
- нет configurable queue modes `interrupt/followup/drop policies`
- нет явного backpressure policy уровня runtime

Вывод:
- у нас хороший control guard
- у них хороший scheduler

Оценка:
- 🎯 9.3   🛡️ 8.7   🧠 4

## 2. Subagent lifecycle

### `goclaw`

Здесь у них зрелый runtime.

Есть:
- depth limit
- tenant-scoped concurrency caps
- max children per parent
- detached cancellation chain
- async persistence
- cancel `all/last/id`
- steer через cancel + respawn
- wait for children
- auto-archive
- token accounting и trace spans

Код:
- [subagent_spawn.go](https://github.com/nextlevelbuilder/goclaw/blob/dev/internal/tools/subagent_spawn.go)
- [subagent_exec.go](https://github.com/nextlevelbuilder/goclaw/blob/dev/internal/tools/subagent_exec.go)
- [subagent_control.go](https://github.com/nextlevelbuilder/goclaw/blob/dev/internal/tools/subagent_control.go)
- [subagent_persist.go](https://github.com/nextlevelbuilder/goclaw/blob/dev/internal/tools/subagent_persist.go)

Сильный момент:
- subagents у них живут не просто в памяти цикла, а как нормальный tracked workload

Честная оговорка:
- прямой test surface именно по `subagent_*` я почти не нашёл
- то есть код выглядит сильно, но тестовая уверенность тут ниже, чем у scheduler/team tasks

Оценка:
- 🎯 8.8   🛡️ 8.1   🧠 6

### Наш оркестратор

У нас subagent-like teammate runtime сильный именно для local coding swarm.

Есть:
- in-process teammates на общем `runAgent()` loop  
  [src/utils/swarm/inProcessRunner.ts](../src/utils/swarm/inProcessRunner.ts)
- mailbox-driven wakeup model
- per-turn abort отдельно от lifecycle abort
- permission prompts возможны для in-process teammates
- duplicate spawn protection и canonical teammate identity  
  [src/tools/shared/spawnMultiAgent.ts](../src/tools/shared/spawnMultiAgent.ts)

Сильные стороны:
- очень хорошая ergonomics для реальной ручной работы
- одинаковое ядро `runAgent()` даёт поведенческую консистентность

Слабые стороны:
- lifecycle менее durable
- steering/wait/persistence не оформлены как отдельный subsystem contract

Оценка:
- 🎯 8.5   🛡️ 8.2   🧠 5

## 3. Team task lifecycle

### `goclaw`

Здесь у них самый большой перевес.

Статусы:
- `pending`
- `in_progress`
- `completed`
- `blocked`
- `failed`
- `in_review`
- `cancelled`
- `stale`

Код:
- [team_store.go](https://github.com/nextlevelbuilder/goclaw/blob/dev/internal/store/team_store.go)

Есть реальный lifecycle:
- create
- claim
- complete
- cancel
- review
- approve
- reject
- reset
- retry
- followup
- blocker escalation

Код:
- [team_tasks_create.go](https://github.com/nextlevelbuilder/goclaw/blob/dev/internal/tools/team_tasks_create.go)
- [team_tasks_lifecycle.go](https://github.com/nextlevelbuilder/goclaw/blob/dev/internal/tools/team_tasks_lifecycle.go)
- [team_tasks_mutations.go](https://github.com/nextlevelbuilder/goclaw/blob/dev/internal/tools/team_tasks_mutations.go)
- [team_tasks_followup.go](https://github.com/nextlevelbuilder/goclaw/blob/dev/internal/tools/team_tasks_followup.go)
- [team_tasks_blocker.go](https://github.com/nextlevelbuilder/goclaw/blob/dev/internal/tools/team_tasks_blocker.go)

Сильный момент:
- review loop у них не только в prompt semantics, а реально в store transitions
- reject может auto-redispatch обратно owner'у, а не просто завершить историю

Оценка:
- 🎯 9.7   🛡️ 9.2   🧠 7

### Наш оркестратор

У нас task layer сильно проще.

Статусы в task store:
- `pending`
- `in_progress`
- `completed`

Код:
- [src/utils/tasks.ts](../src/utils/tasks.ts)

Что есть:
- `blocks` и `blockedBy`
- atomic claim
- owner-based coordination
- unassign to pending on teammate termination

Что важно:
- у нас есть board-task semantics для `task_start`, `task_complete`, `review_start`, `review_approve`, `review_request_changes`, `review_request`, но это сейчас в основном **transcript projection / runtime annotation**, а не полноценный durable task store  
  [src/services/boardTaskActivity/BoardTaskToolInterpreter.ts](../src/services/boardTaskActivity/BoardTaskToolInterpreter.ts)  
  [src/services/boardTaskActivity/RuntimeBoardTaskExecutionStore.ts](../src/services/boardTaskActivity/RuntimeBoardTaskExecutionStore.ts)

То есть:
- review semantics у нас **есть**
- но как orchestration truth source они пока **слабее, чем у `goclaw`**

Оценка:
- 🎯 9.4   🛡️ 8.0   🧠 4

## 4. Dependencies, blocked work, recovery

### `goclaw`

У них dependency management намного более зрелый.

Есть:
- `blocked_by` validation at create time
- blocked tasks как отдельный status
- batch stale recovery
- batch mark stale
- mark `in_review` stale separately
- fix orphaned blocked tasks
- reset task from `stale/failed/cancelled/in_review`
- followup reminders
- explicit retry path

Код:
- [teams_tasks_progress.go](https://github.com/nextlevelbuilder/goclaw/blob/dev/internal/store/pg/teams_tasks_progress.go)
- [task_ticker.go](https://github.com/nextlevelbuilder/goclaw/blob/dev/internal/tasks/task_ticker.go)

Это очень важно:
- у них recovery не висит на лиде вручную
- оно живёт как background subsystem

Оценка:
- 🎯 9.6   🛡️ 9.0   🧠 7

### Наш оркестратор

Что есть:
- blockedBy проверяется при claim  
  [src/utils/tasks.ts](../src/utils/tasks.ts)
- teammate termination/shutdown умеет unassign unresolved tasks обратно в `pending`

Но:
- нет отдельного background stale ticker
- нет `stale/failed/in_review/blocked` как durable task states
- нет automated orphan fix
- нет systematic retry/followup pipeline

Сильный момент:
- простота
- локальная предсказуемость

Слабый момент:
- recovery у нас сильна в bootstrap, но слабее в long-running task graph

Оценка:
- 🎯 8.9   🛡️ 7.8   🧠 4

## 5. Dispatch fairness и anti-loop safety

### `goclaw`

Тут у них много практичных guardrails:
- max dispatch count = 3
- auto-fail lead-owned tasks
- one task per owner per dispatch round
- append blocker results to redispatched task
- append recent comments to redispatched task
- restore leader trace context for deferred dispatch

Код:
- [team_tool_dispatch.go](https://github.com/nextlevelbuilder/goclaw/blob/dev/internal/tools/team_tool_dispatch.go)

Это прям production-minded слой:
- предотвращение loop'ов
- fairness per owner
- context preservation on re-dispatch

Оценка:
- 🎯 9.4   🛡️ 9.0   🧠 6

### Наш оркестратор

У нас другой тип safety:
- duplicate teammate spawn protection
- canonical identity
- bootstrap runtime identity drift detection
- team file locking with stale reclaim

Код:
- [src/tools/shared/spawnMultiAgent.ts](../src/tools/shared/spawnMultiAgent.ts)
- [src/services/teamBootstrap/teamBootstrapRuntimeIdentity.ts](../src/services/teamBootstrap/teamBootstrapRuntimeIdentity.ts)
- [src/services/teamBootstrap/teamBootstrapLock.ts](../src/services/teamBootstrap/teamBootstrapLock.ts)

Это очень хороший safety layer, но он в основном про:
- spawn correctness
- identity correctness
- bootstrap correctness

А не про:
- repeated task dispatch fairness
- redispatch circuit breakers

Оценка:
- 🎯 9.1   🛡️ 8.8   🧠 5

## 6. Human-in-the-loop control

### Наш оркестратор

Здесь у нас сильный перевес.

Причины:
- tmux / iTerm2 / in-process backends
- local operator может визуально и процедурно контролировать swarm
- teammate lifecycle тесно встроен в terminal workflow
- permission flow и interrupts живут рядом с оператором

Основной код:
- [src/tools/shared/spawnMultiAgent.ts](../src/tools/shared/spawnMultiAgent.ts)
- [src/utils/swarm/inProcessRunner.ts](../src/utils/swarm/inProcessRunner.ts)

Это не просто orchestration runtime.
Это orchestration runtime + operator cockpit, пусть и terminal-first.

Оценка:
- 🎯 9.6   🛡️ 9.1   🧠 5

### `goclaw`

У них HITL есть, но акцент другой:
- agent platform
- team tasks
- dashboard-driven flows
- channel-driven operations

Они сильнее в autonomous/team workflow.
Мы сильнее в live operator control.

Оценка:
- 🎯 8.7   🛡️ 7.6   🧠 4

## 7. Deterministic bootstrap

### Наш оркестратор

Это наш самый сильный orchestration subsystem.

Есть:
- strict spec schema
- normalized-name collision checks
- stable request hash
- regular-file only spec reads
- oversize rejection
- workspace assertion
- monotonic timeout budget
- runtime identity drift detection
- persisted phases and member spawn results
- stale lock reclaim only after dead-owner + ownership correlation

Код:
- [src/services/teamBootstrap/teamBootstrapSpec.ts](../src/services/teamBootstrap/teamBootstrapSpec.ts)
- [src/services/teamBootstrap/teamBootstrapRunner.ts](../src/services/teamBootstrap/teamBootstrapRunner.ts)
- [src/services/teamBootstrap/teamBootstrapLock.ts](../src/services/teamBootstrap/teamBootstrapLock.ts)
- [src/services/teamBootstrap/teamBootstrapStateStore.ts](../src/services/teamBootstrap/teamBootstrapStateStore.ts)

Это реально хороший engineering layer, не просто convenience feature.

Оценка:
- 🎯 9.8   🛡️ 9.4   🧠 6

### `goclaw`

У них bootstrap не выглядит таким отдельным и строго формализованным subsystem'ом.
Они сильнее уже после старта orchestration.
Мы сильнее именно в **deterministic bring-up** локальной команды.

Оценка:
- 🎯 8.2   🛡️ 7.7   🧠 4

## 8. Persistence, audit, observability

### `goclaw`

Сильнее:
- DB-backed tasks
- comments
- events
- attachments
- followup metadata
- trace propagation
- durable task history

Код:
- [team_store.go](https://github.com/nextlevelbuilder/goclaw/blob/dev/internal/store/team_store.go)
- [teams_tasks_progress.go](https://github.com/nextlevelbuilder/goclaw/blob/dev/internal/store/pg/teams_tasks_progress.go)
- [team_tool_dispatch.go](https://github.com/nextlevelbuilder/goclaw/blob/dev/internal/tools/team_tool_dispatch.go)

Итог:
- state continuity у них выше
- postmortem capability у них выше

Оценка:
- 🎯 9.3   🛡️ 9.0   🧠 6

### Наш оркестратор

У нас persistence есть, но другого типа:
- team file
- task files
- mailbox files
- bootstrap-state journal
- runtime stores

Это хороший local-first design, но он хуже подходит под:
- auditability
- cross-scope recovery
- platform-grade orchestration history

Оценка:
- 🎯 8.8   🛡️ 7.9   🧠 4

## 9. Task visibility, logs и traces

Это важный кусок, который легко перепутать с UI, но по факту он влияет на orchestration quality:
- насколько видно, что происходит с задачей
- можно ли отследить прогресс, review, stale, fail и followup
- есть ли task-scoped activity trail
- есть ли живой raw execution log именно по задаче

### `goclaw`

Сильнее по **durable activity trail**.

Что есть:
- task detail подтягивает `task + comments + events + attachments`  
  [internal/gateway/methods/teams_tasks.go](https://github.com/nextlevelbuilder/goclaw/blob/dev/internal/gateway/methods/teams_tasks.go)
- у task store есть отдельные сущности для `comments`, `events`, `attachments`, `progress`, `followup`  
  [team_store.go](https://github.com/nextlevelbuilder/goclaw/blob/dev/internal/store/team_store.go)
- progress и followup встроены прямо в `TeamTaskData`, а не висят сбоку  
  [team_store.go](https://github.com/nextlevelbuilder/goclaw/blob/dev/internal/store/team_store.go)
- есть полноценный tracing subsystem с `traces + spans`, trace propagation через task/disaptch paths, export и aggregate metrics  
  [10-tracing-observability.md](https://github.com/nextlevelbuilder/goclaw/blob/dev/docs/10-tracing-observability.md)
- docs прямо фиксируют `Comments, Events & Attachments`, audit trail и realtime team events  
  [11-agent-teams.md](https://github.com/nextlevelbuilder/goclaw/blob/dev/docs/11-agent-teams.md)  
  [13-ws-team-events.md](https://github.com/nextlevelbuilder/goclaw/blob/dev/docs/13-ws-team-events.md)

Где у них ограничение:
- я не нашёл настолько сильного **raw per-task execution log cockpit**
- то есть история task activity у них хорошая, но это не совсем то же самое, что открыть задачу и видеть непрерывный stream "что именно агент сейчас делает"
- traces у них сильные, но это скорее observability layer, чем прямой transcript-style per-task console

Оценка:
- task-scoped activity/audit: 🎯 9.4   🛡️ 9.1   🧠 5
- raw per-task execution log UX: 🎯 7.6   🛡️ 7.8   🧠 4

### Наш оркестратор

У нас лучше **живой runtime-context visibility**, но она слабее как durable truth source.

Что есть:
- `inProcessRunner` активно пишет runtime debug trail по polling, claim, abort, prompt processing, interruption и shutdown  
  [../src/utils/swarm/inProcessRunner.ts](../src/utils/swarm/inProcessRunner.ts)
- `BoardTaskTranscriptProjector` умеет приклеивать task-aware links и tool actions к транскрипту, а не просто хранить голый чат  
  [../src/services/boardTaskActivity/BoardTaskTranscriptProjector.ts](../src/services/boardTaskActivity/BoardTaskTranscriptProjector.ts)
- `RuntimeBoardTaskExecutionStore` отслеживает open scopes, active execution seq и actor context per task/per agent  
  [../src/services/boardTaskActivity/RuntimeBoardTaskExecutionStore.ts](../src/services/boardTaskActivity/RuntimeBoardTaskExecutionStore.ts)
- в `tasks.ts` и teammate loop видно claim/unassign/pending semantics и живой task flow  
  [../src/utils/tasks.ts](../src/utils/tasks.ts)  
  [../src/utils/swarm/inProcessRunner.ts](../src/utils/swarm/inProcessRunner.ts)

Где у нас ограничение:
- большая часть этой видимости пока **runtime-projected**, а не store-backed durable audit history
- task-aware transcript и execution scopes сильны для локальной работы и операторского контроля, но хуже для долгоживущего platform-grade postmortem
- если процесс умер, непрерывность истории и recovery trail слабее, чем у `goclaw`

Оценка:
- live local task visibility: 🎯 9.1   🛡️ 8.3   🧠 5
- durable task audit continuity: 🎯 7.5   🛡️ 7.4   🧠 4

Честный вывод по этой подсистеме:
- если нужен **durable task timeline + comments/events/traces** - сильнее `goclaw`
- если нужен **живой operator-centric runtime context around current work** - сильнее мы

## 10. Тестовая уверенность

### Наш оркестратор

Что внушает доверие:
- bootstrap runner tests покрывают partial failure, create-vs-launch policy, workspace drift, persisted terminal failure, monotonic timeout
- spawn integration test ловит cleanup после partial registration failure

Код:
- [src/services/teamBootstrap/teamBootstrapRunner.test.ts](../src/services/teamBootstrap/teamBootstrapRunner.test.ts)
- [src/tools/shared/spawnMultiAgent.integration.test.ts](../src/tools/shared/spawnMultiAgent.integration.test.ts)

Честный минус:
- именно orchestration lifecycle после старта команды покрыт уже слабее, чем bootstrap

Оценка:
- 🎯 8.8   🛡️ 8.0   🧠 3

### `goclaw`

Сильнее по breadth:
- scheduler tests
- queue policy tests
- task lifecycle tests
- blocker tests
- followup tests
- ticker tests

Код:
- [scheduler_test.go](https://github.com/nextlevelbuilder/goclaw/blob/dev/internal/scheduler/scheduler_test.go)
- [scheduler_queue_test.go](https://github.com/nextlevelbuilder/goclaw/blob/dev/internal/scheduler/scheduler_queue_test.go)
- [team_tasks_lifecycle_test.go](https://github.com/nextlevelbuilder/goclaw/blob/dev/internal/tools/team_tasks_lifecycle_test.go)
- [task_ticker_test.go](https://github.com/nextlevelbuilder/goclaw/blob/dev/internal/tasks/task_ticker_test.go)

Честная оговорка:
- direct `subagent_*` tests почти не видно

Оценка:
- 🎯 9.1   🛡️ 8.6   🧠 3

## 11. Что важно не перепутать

### Где мы реально сильнее

1. Deterministic bootstrap
2. Local operator control
3. Local execution backends
4. Terminal-native swarm work
5. Canonical teammate identity and duplicate-spawn protection

### Где `goclaw` реально сильнее

1. Scheduler как отдельный subsystem
2. Durable task lifecycle
3. Recovery и stale handling
4. Retry, followup, blocker escalation
5. Fair dispatch и anti-loop guardrails
6. Persistence and audit trail
7. Team-task orchestration как platform runtime, а не как набор локальных механизмов

## 12. Главная architectural разница

### Наш подход

Это:
- local-first
- operator-first
- bootstrap-heavy
- lightweight file/task/mailbox coordination

Сильная сторона:
- очень хороший контроль

Слабая сторона:
- orchestration truth сильно зависит от локального runtime context

### Подход `goclaw`

Это:
- durable state machine
- scheduler-first
- task-store-first
- recovery-first

Сильная сторона:
- orchestration переживает сбои, задержки, stale state и долгие циклы намного лучше

Слабая сторона:
- менее сильный terminal-first operator experience

## Финальный вывод

Если отвечать на вопрос без скидок:

- **как orchestrator в общем смысле** сейчас сильнее **`goclaw`**
- **как local coding swarm orchestrator с сильным lead в терминале** сильнее **наш оркестратор**

То есть:

- `goclaw` выигрывает по **systemic orchestration maturity**
- мы выигрываем по **операторскому контролю и deterministic startup discipline**

Именно поэтому корректный общий verdict такой:

- **`goclaw` лучше как orchestration engine**
- **мы лучше как orchestration cockpit**

## Что может изменить verdict в будущем

Если у нас появятся:
- durable task statuses beyond `pending/in_progress/completed`
- background stale ticker
- retry/followup/blocker pipeline
- explicit dispatch fairness/circuit breaker
- store-backed review/reject/approve lifecycle

тогда разрыв по orchestration core можно сократить очень сильно.

С практической точки зрения самый большой недостающий кусок у нас сейчас такой:

- 🎯 9.5   🛡️ 9.0   🧠 7
- примерно **1200-2500 строк** на первую вменяемую версию durable task lifecycle + recovery subsystem

## Ограничения сравнения

- Это сравнение по коду, тестам и документации на 12 апреля 2026.
- Я не делал долгий live soak test на реальных multi-agent сценариях в обоих продуктах.
- Я не прогонял controlled fault injection типа network partitions, forced DB restarts, duplicated dispatch storms и массового stale recovery.
- Для `goclaw` часть выводов опирается на локально синхронизированный клон и публичную документацию, а не на мой собственный production run.
- Для нашего стека я отделял orchestration core от UI. Подробный UI-док отдельно: [goclaw-ui-comparison.md](./goclaw-ui-comparison.md).
