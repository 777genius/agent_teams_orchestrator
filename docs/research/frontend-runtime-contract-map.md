# Electron app <-> runtime contract map

Дата: 2026-04-16
Worktree: `/Users/belief/dev/projects/claude/agent_teams_orchestrator-rust-research`
Ветка: `research/rust-orchestrator-contract`

## TL;DR

Electron app зависит не просто от факта наличия "оркестратора", а от набора вполне конкретных контрактов:

- CLI launch flags и их семантика
- stdin/stdout `stream-json` протокол
- `control_request` / `control_response`
- deterministic bootstrap system events
- `runtime status`, `auth status`, `model list`
- формат JSONL транскриптов и способ их атрибуции к member/task
- naming/session title conventions
- packaging и бинарный контракт `claude-multimodel`

Хорошая новость:

- основная зависимость сидит в `main` процессе Electron, а не во всём renderer
- значит совместимый rewrite реально делать через compatibility boundary

Плохая новость:

- часть runtime-контракта уже протекла в renderer/shared
- поэтому "заменить только бинарь" недостаточно, если менять форматы/названия/флаги

Мой вывод:

- для первой Rust-фазы нужен не "новый красивый runtime с новым API", а совместимый runtime facade
- внутреннюю архитектуру можно сделать лучше текущей, но внешний контракт лучше сначала сохранить почти 1 в 1

## Что именно использует фронт

### 1. Основной orchestration contract

Главный consumer runtime-контракта - `TeamProvisioningService`.

Крупные узлы связности со стороны Electron app:

- `src/main/services/team/TeamProvisioningService.ts` - 11741 LOC
- `src/main/services/runtime/ClaudeMultimodelBridgeService.ts` - 498 LOC
- `src/main/services/team/TeamMemberLogsFinder.ts` - 1982 LOC
- `src/main/services/team/TeamDataService.ts` - 2974 LOC
- `src/main/ipc/teams.ts` - 3707 LOC
- `src/main/http/teams.ts` - 252 LOC
- `src/renderer/store/slices/teamSlice.ts` - 3461 LOC
- `src/renderer/components/team/dialogs/CreateTeamDialog.tsx` - 1462 LOC
- `src/renderer/components/team/dialogs/LaunchTeamDialog.tsx` - 1847 LOC

### 2. Используемый runtime-срез в текущем orchestrator repo

Это полезно как верхняя оценка того, что потенциально придётся переносить.

- `src/utils/swarm` - 9208 LOC
- `src/services/teamBootstrap` - 3874 LOC
- `src/services/runtimeBackends + src/services/oauth + src/services/gemini` - около 2960 LOC
- плюс CLI glue в `src/main.tsx` и `src/cli/handlers/*`

⚠️ Это не значит, что весь этот код нужен фронту целиком. Но это хорошая оценка масштаба области, куда попадает frontend-used runtime core.

## Карта контрактов

| Контракт | Где задаётся | Кто потребляет | Сила зависимости | Тяжесть изменения |
| --- | --- | --- | --- | --- |
| Launch CLI flags | `claude_team/src/main/services/team/TeamProvisioningService.ts:4606-4632`, `:5193-5225` | main process, renderer preview, shared flag validator | Очень высокая | Высокая |
| `stream-json` stdin/stdout | `claude_team/src/main/services/team/TeamProvisioningService.ts:4310-4387`, `:7530-8053` | main process, live logs, message routing | Очень высокая | Очень высокая |
| Tool approval protocol | `claude_team/src/main/services/team/TeamProvisioningService.ts:8363-8939` | main, preload, renderer store | Очень высокая | Очень высокая |
| Deterministic bootstrap events | `agent_teams_orchestrator/src/services/teamBootstrap/teamBootstrapEvents.ts:39-108` | provisioning progress UI | Высокая | Средне-высокая |
| Runtime status/auth/model commands | `claude_team/src/main/services/runtime/ClaudeMultimodelBridgeService.ts:265-497` | settings/runtime UI | Высокая | Средняя |
| JSONL transcript layout | `claude_team/src/main/services/team/TeamMemberLogsFinder.ts`, `TeamDataService.ts`, `src/main/types/jsonl.ts` | member logs, task logs, lead session extraction | Очень высокая | Очень высокая |
| Session title convention | `claude_team/src/renderer/utils/sessionTitleParser.ts:1-69`, `TeamProvisioningService.ts:1787-1800` | renderer sidebar/session label | Средняя | Низко-средняя |
| Binary resolution and packaging | `ClaudeBinaryResolver.ts:196-305`, `runtime.lock.json` | installer/resolver/app bundle | Высокая | Низко-средняя |
| CLI help validation | `TeamProvisioningService.ts:11589-11618`, `ipc/teams.ts:1415-1438` | advanced CLI args UI | Средняя | Средняя |
| Preflight probe API | `TeamProvisioningService.ts:3508-3604`, `shared/types/team.ts:990-994` | create/launch dialogs | Средняя | Низкая, если сохранить ответ |

## Самые жёсткие места

### A. Launch contract

Electron app сейчас запускает runtime с очень конкретным набором флагов:

- `--input-format stream-json`
- `--output-format stream-json`
- `--verbose`
- `--setting-sources user,project,local`
- `--mcp-config <path>`
- `--team-bootstrap-spec <path>`
- `--team-bootstrap-user-prompt-file <path>`
- `--disallowedTools <...>`
- `--dangerously-skip-permissions --permission-mode bypassPermissions`
- или `--permission-prompt-tool stdio --permission-mode default`
- `--resume <sessionId>`
- `--model`
- `--effort`
- `--worktree`
- custom args после `parseCliArgs(...)`

Источники:

- `claude_team/src/main/services/team/TeamProvisioningService.ts:4606-4632`
- `claude_team/src/main/services/team/TeamProvisioningService.ts:5193-5225`

Почему это важно:

- это не только main-process contract
- renderer прямо показывает эти флаги пользователю в preview
- shared код считает часть этих флагов protected

Протечки в UI:

- `claude_team/src/renderer/components/team/dialogs/CreateTeamDialog.tsx:863-872`
- `claude_team/src/renderer/components/team/dialogs/LaunchTeamDialog.tsx:1005-1016`
- `claude_team/src/shared/utils/cliArgsParser.ts:20-34`
- `claude_team/src/renderer/components/team/dialogs/AdvancedCliSection.tsx:31-39`

Вывод:

- если менять launch flags, это уже не "внутренний rewrite runtime"
- это совместная миграция `main + renderer + shared`

### B. `stream-json` protocol

Основной парсер stdout у фронта предполагает newline-delimited JSON и конкретные типы сообщений:

- `user`
- `assistant`
- `control_request`
- `result`
- `system`

Источники:

- `claude_team/src/main/services/team/TeamProvisioningService.ts:210-216`
- `claude_team/src/main/services/team/TeamProvisioningService.ts:4310-4387`
- `claude_team/src/main/services/team/TeamProvisioningService.ts:7530-8053`

Фронт завязан не просто на envelope, а на семантику полей:

- `assistant.message.content[]`
- блоки `text`, `thinking`, `tool_use`, `tool_result`
- `message.usage.input_tokens`
- `cache_creation_input_tokens`
- `cache_read_input_tokens`
- `result.subtype === success|error`
- `result.modelUsage.*.contextWindow`
- `system.subtype === compact_boundary|api_retry`
- `session_id` на любом сообщении

Вывод:

- это hard contract
- в первой Rust-фазе его лучше сохранять максимально точно

### C. Tool approval protocol

Фронт умеет не только получать approval request, но и отвечать обратно в stdin процесса.

Критичный момент:

- `control_response.request_id` ожидается вложенным в `response`, а не на top-level

Источники:

- `claude_team/src/main/services/team/TeamProvisioningService.ts:8363-8939`
- `claude_team/src/shared/types/team.ts:1203-1279`
- `claude_team/src/preload/index.ts:1190-1227`
- `claude_team/src/renderer/store/index.ts:1251-1292`

Вывод:

- тут менять форму сообщений почти нельзя без одновременной миграции UI flow
- для совместимого Rust runtime это один из контрактов, который нужно эмулировать 1 в 1

### D. JSONL transcript contract

Это недооценённый, но очень важный слой. Electron app читает runtime-логи не "как текст", а как структурированные transcript files.

Жёсткие ожидания:

- lead transcript лежит как `${leadSessionId}.jsonl`
- member root session - `${sessionId}.jsonl`
- subagents - `${sessionId}/subagents/agent-*.jsonl`
- JSONL entry имеет поля `type`, `message`, `content`, `toolUseResult`, `process.team.memberName`, `routing.sender`

Источники:

- `claude_team/src/main/services/team/TeamMemberLogsFinder.ts:26-64`
- `claude_team/src/main/services/team/TeamMemberLogsFinder.ts:974-1029`
- `claude_team/src/main/services/team/TeamMemberLogsFinder.ts:1099-1269`
- `claude_team/src/main/services/team/TeamMemberLogsFinder.ts:1490-1537`
- `claude_team/src/main/services/team/TeamMemberLogsFinder.ts:1617-1645`
- `claude_team/src/main/types/jsonl.ts:1-320`
- `claude_team/src/main/services/team/TeamDataService.ts:2653-2804`

Почему это больно:

- это влияет на per-member logs
- это влияет на task activity
- это влияет на lead session extraction
- это влияет на attribution heuristics

Вывод:

- если Rust runtime не пишет совместимый transcript format, ломается не одна фича, а целый слой UI-аналитики и inbox/history

## Средняя связность

### Runtime status/auth/model

Фронт умеет жить в двух режимах:

1. Новый unified contract:
   - `runtime status --json`
   - `runtime status --json --provider <provider>`

2. Legacy fallback:
   - `auth status --json --provider all`
   - `model list --json --provider all`

Источники:

- `claude_team/src/main/services/runtime/ClaudeMultimodelBridgeService.ts:265-497`
- `agent_teams_orchestrator/src/main.tsx:4098-4166`
- `agent_teams_orchestrator/src/cli/handlers/runtime.ts:59-79`
- `agent_teams_orchestrator/src/cli/handlers/auth.ts:417-507`
- `agent_teams_orchestrator/src/cli/handlers/model.ts:101-140`
- `agent_teams_orchestrator/src/services/runtimeBackends/types.ts:32-63`

UI ожидает поля:

- `supported`
- `authenticated`
- `authMethod`
- `verificationState`
- `statusMessage`
- `detailMessage`
- `models`
- `canLoginFromUi`
- `capabilities.teamLaunch`
- `capabilities.oneShot`
- `selectedBackendId`
- `resolvedBackendId`
- `availableBackends`
- `externalRuntimeDiagnostics`
- `backend.*`

Вывод:

- менять можно, но лучше оставить тот же JSON schema version 1
- этот контракт значительно легче стабилизировать, чем transcripts/stream-json

### Preflight prepare API

Create/launch dialogs сначала делают preflight:

- IPC `prepareProvisioning`
- ответ `TeamProvisioningPrepareResult { ready, message, warnings }`

Источники:

- `claude_team/src/main/services/team/TeamProvisioningService.ts:3508-3604`
- `claude_team/src/shared/types/team.ts:990-994`
- `claude_team/src/main/ipc/teams.ts:1441-1486`

Это хороший кандидат для сохранения без изменений даже при сильном внутреннем rewrite.

## Слабее, но тоже важно

### Session title convention

Renderer парсит title строки, которые сам runtime/launch flow генерирует:

- `agent_teams_ui [Agent Team: "..."]`
- `Team Start [Agent Team: "..."]`
- `Team Start (resume) [Agent Team: "..."]`

Источники:

- `claude_team/src/renderer/utils/sessionTitleParser.ts:1-69`
- `claude_team/src/main/services/team/TeamProvisioningService.ts:1787-1800`

Это не core protocol, но если silently поменять title convention, sidebar labels начнут вести себя странно.

### CLI help as contract source

Фронт валидирует custom CLI args через парсинг `claude --help`.

Источники:

- `claude_team/src/main/services/team/TeamProvisioningService.ts:11589-11618`
- `claude_team/src/main/ipc/teams.ts:1415-1438`

Вывод:

- даже help output частично стал API
- это ещё один аргумент сначала формализовать контракт, а потом переписывать

## Где зависимость сидит на самом деле

Самое важное архитектурное наблюдение:

- renderer в основном зависит не напрямую от runtime, а от Electron main services

Главные точки:

- `ipc/teams.ts`
- `http/teams.ts`
- `TeamProvisioningService`
- `ClaudeMultimodelBridgeService`

Это хорошо, потому что даёт нормальную границу для совместимости:

- если сохранить main-process API и expected payload shapes
- можно глубоко переписать внутренний runtime

Но есть утечки в renderer/shared:

- internal args preview
- protected CLI flags
- session title parsing
- tool approval event typing
- runtime provider status shape
- `streamJsonParser` в renderer

Поэтому rewrite надо делать contract-first, а не только backend-first.

## Что можно менять без боли, если сохранить facade

Ниже вещи, которые фронт почти не видит напрямую, если совместимость держится на фасаде:

- внутренняя state machine deterministic bootstrap
- способ supervisor lifecycle management
- внутреннее устройство tmux/process backend
- внутренняя provider adapter architecture
- кэширование auth/model/runtime probes
- внутренние структуры состояния и конкурентности
- journal/lock implementation

Это как раз та область, где Rust может дать максимальную пользу.

## Что лучше не менять в первой фазе

Если цель - максимально безопасная миграция, то в Rust v1 лучше сохранить:

- имя бинаря `claude-multimodel`
- команды `runtime status`, `auth status`, `model list`
- launch flags, которые уже использует Electron app
- `stream-json` envelope и ключевые message types
- `control_request` / `control_response` shape
- bootstrap progress `system` events
- совместимый JSONL transcript layout
- `schemaVersion: 1` для runtime status payload

## Рекомендуемая Rust-архитектура

### Слой 1. Compatibility facade

Внешний CLI должен выглядеть как текущий runtime:

- тот же бинарь
- те же subcommands
- те же launch flags
- те же stream event envelopes

Именно этот слой защищает Electron app от архитектурных изменений внутри.

### Слой 2. Supervisor core

Это главное место для Rust:

- process lifecycle
- stdin/stdout routing
- cancellation
- permission bridge
- session registry
- run registry
- progress state machine
- resume attachment

### Слой 3. Team bootstrap engine

Отдельный доменный слой:

- spec loading
- ownership lock
- spawn schedule
- bootstrap phases
- audit truth phase
- partial success / strict fail modes

Текущий TS-код уже очень похож на state machine. Это хороший кандидат для прямого архитектурного улучшения в Rust.

### Слой 4. Provider status/auth/model surface

Отдельный модуль, не смешанный с supervisor:

- Anthropic status
- Codex backend resolution
- Gemini backend resolution
- unified status JSON

Это хороший кандидат на отдельный "capability/status plane".

### Слой 5. Transcript compatibility writer

Если вы хотите сохранить существующие UI/log views без переписывания фронта, нужен отдельный writer, который пишет фронту ожидаемый JSONL shape.

Важно:

- это должен быть не побочный эффект "как получилось", а сознательно поддерживаемый compatibility layer

## Практическая стратегия миграции

### Вариант 1. Rust supervisor + compatibility facade

`🎯 10   🛡️ 9   🧠 7`
Примерно `8k-14k` строк нового Rust + `1k-2k` строк тестов/fixtures

Что переносить:

- launch/runtime facade
- process supervisor
- team bootstrap engine
- approval bridge
- unified status commands

Что временно можно не трогать:

- часть legacy fallback команд
- некоторые внутренние TS helper paths, если они не видны фронту

Это лучший баланс.

### Вариант 2. Полный frontend-used runtime rewrite с transcript compatibility

`🎯 8   🛡️ 10   🧠 9`
Примерно `14k-22k` строк нового Rust + `2k-4k` строк тестов/golden fixtures

Что входит:

- всё из варианта 1
- полноценный JSONL compatibility writer
- точная эмуляция используемого stream-json поведения
- status/auth/model plane

Это уже "правильный" rewrite, но заметно дороже.

### Вариант 3. Сначала formalize contract, потом Rust

`🎯 9   🛡️ 10   🧠 5`
Примерно `1.5k-4k` строк TS + `1k-2k` тестов/fixtures

Что делать:

- вынести контракт в явные схемы/fixtures
- записать golden traces для stdout/stdin/JSONL/status payload
- только потом начинать Rust rewrite

Это даёт наименьший риск багов и лучший фундамент для последующего rewrite.

## Что я бы сделал на практике

1. Зафиксировал внешний контракт в тестах и golden fixtures.
2. Выделил "frontend compatibility adapter" как отдельную концепцию.
3. Писал Rust runtime так, чтобы он сначала умел быть drop-in replacement для Electron app.
4. Уже потом постепенно убирал странности и legacy, когда фронт перестанет зависеть от них напрямую.

## Конкретно по сложности смены контракта

### Почти нельзя менять без боли

- `stream-json` schema и message semantics
- tool approval protocol
- transcript layout и attribution metadata
- launch flags, которые уже отражены в UI и validation

### Можно менять, но лучше через совместимый adapter

- runtime status internals
- provider backend resolution
- bootstrap implementation
- process orchestration implementation

### Можно менять относительно легко

- внутренние state structs
- внутреннюю модель ошибок
- concurrency model
- журналирование внутри runtime

## Финальный вывод

Electron app сейчас зависит от runtime сильно, но зависимость в основном не "широкая по всему UI", а "глубокая в нескольких конкретных протоколах".

Это значит:

- rewrite на Rust реален
- но только если он начинается с contract compatibility, а не с "давайте перепишем логику красивее"

Самая безопасная цель первой фазы:

- новый Rust runtime с тем же CLI, теми же ключевыми командами, тем же `stream-json`, тем же approval flow и совместимыми transcript files

Самая опасная ошибка:

- сначала улучшить архитектуру ценой изменения внешнего контракта, а потом пытаться догонять совместимость патчами

Для этого проекта правильнее наоборот:

- сначала жёсткая совместимость
- потом внутренняя архитектурная чистка
