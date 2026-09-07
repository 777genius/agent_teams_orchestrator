# Cursor: два варианта восстановления перед релизом

Дата: 2026-09-07. Статус: план для выбора; реализация не начата. В репозиториях ничего не изменено.

Основание: runtime `a16da080808d6a1ea99775a6b3fbf252124a93c2`, frontend `242d5598f0ef3b0402dfbf907f3862acfc82f465`. Перед реализацией сохранить чужие изменения. Обновляет прежний native-permissions plan.

## Что уже доказано

- Неизменённый `@rama_nigg/open-cursor@2.5.2` выполнил один настоящий native MCP вызов и записал полученный случайный nonce в файл. OpenCode получил ноль исполняемых tool parts. Рабочая комбинация: `TOOL_LOOP_MODE=opencode`, ноль OpenCode tools, `ENABLE_OPENCODE_TOOLS=false`, `MCP_BRIDGE=false`, `FORWARD_TOOL_CALLS=false`, native backend, `FORCE=false`, отключённые proxy reuse/pool/resume. Режим `off` пропускает native tool events в OpenCode и не подходит.
- Временный cancellation patch выбрал существующий Bun HTTP handler и связал отмену запроса с его дочерним процессом. Под actual OpenCode это остановило прямой native Cursor процесс и запись файла: 1 строка до Stop и 1 через 24 секунды. Однако три helper-процесса остались живы. Их последующая уборка harness не является работой product Stop.
- Fake CLI проверки покрыли concurrent requests, раннюю отмену, buffered response и 12 секунд до первого токена. Для Bun нужен `idleTimeout: 0`; внешние deadlines остаются ограниченными.
- Совместного доказательства App MCP + team task + результат + Stop всех потомков + relaunch пока нет. Synthetic POSIX process-group proof не является native E2E или Windows proof.

Источники: [сравнение](/tmp/cursor-cancel-scope.8c7HNP/options.md), [native MCP](/tmp/cursor-direct-mcp.7JQspU/proof.json), [cancellation patch](/tmp/cursor-abort-patch.pWOf7Z/verdict.md), [native cancellation](/tmp/cursor-cancel-scope.8c7HNP/native-patched/report.json).

## Вариант 1. Минимальное исправление для ближайшего релиза - рекомендован

🎯 Уверенность 7/10 · 🛡️ Надёжность после приёмки 8/10 · 🧠 Сложность 5/10

Cursor выполняет файловые/shell операции и App MCP нативно. OpenCode сохраняет транспорт, сессии, задачи и существующие launch-защиты. Добавляем request-owned supervisor в имеющийся native wrapper и временный закреплённый патч плагина. Общие OpenCode hosts сохраняются.

Поддержка включается только для конфигураций и ОС, прошедших приёмку. Первый кандидат для доказательства - macOS. Это не обещание готовности всех платформ релиза. Для остальных нужен явный capability gate с корректным объяснением; если ближайший релиз обязан поддерживать Cursor на всех ОС, объёма этого варианта недостаточно.

### Объём

`changed LOC` означает добавленные + удалённые строки собственного кода, а не чистый прирост. Диапазоны предварительные, не гарантированные сроки модели.

| Часть собственного production-кода | Changed LOC |
| --- | ---: |
| Native auth/status authority и Cursor-only допуск strict scope | 100-170 |
| Managed native MCP/permissions config, ownership, передача ошибок | 100-180 |
| Request-owned supervisor и завершение потомков | 120-190 |
| Readiness/Stop/lifecycle integration с существующими доказательствами | 120-220 |
| Честная обработка Cursor permission mode в существующем UI/backend | 30-60 |
| Детерминированная доставка динамически загружаемого plugin artifact | 80-130 |
| **Production всего** | **550-950** |
| **Патч upstream dependency, отдельно** | **55-90** |
| **Focused tests и sandbox harness, отдельно** | **350-650** |
| **Всего текстовых изменений без generated/lockfiles** | **955-1690** |

Оценка: **6-12 человеко-часов реализации + 6-12 проверки = 12-24 человеко-часа**, включая spikes и E2E. Ожидание внешних сервисов/машин отдельно. Провал ключевого эксперимента требует пересчёта до расширения реализации.

### Последовательность

1. **45-90 минут на config go/no-go после выбора.** Уже установлено: `CURSOR_CONFIG_DIR` меняет CLI settings, но MCP загружается из HOME/project `.cursor/mcp.json`; один override недостаточен. Конкретный минимальный путь - согласованная выбором этого варианта регистрация уникальной app-owned записи в HOME MCP через existing writer, с сохранением всех чужих entries; project config не менять. В новом sandbox проверить effective endpoint, scoped approvals/permissions, неизменность чужих entries и native auth. Если понадобится overwrite чужой записи/перенос credentials, остановиться и пересчитать. Автоматического перехода на другой worktree нет.
2. **Native policy.** Закрепить доказанные flags и пустой OpenCode tool set. Проверять connection approval отдельно от `Mcp(server:tool)`. Сохранить native deny; автономный file/shell task должен реально проходить под выбранной policy. Не переключать `FORCE=true` и не обещать sandbox из одного allowlist.
3. **Cancellation + supervisor.** Удалить fixture port/export, сохранить Bun signal/Node fallback, abort races и `idleTimeout: 0`. Имеющийся wrapper выполняет `exec`/`call`; новый supervisor должен владеть отдельной группой запроса, сохранять streaming, TERM -> bounded KILL и ждать потомков. POSIX `killProcessTree` сейчас сигналит только PID. Запрос A не трогает shared host/B.
4. **Stop completion.** `abort=true` не подтверждает окончание cleanup. Нужна привязка конкретного request к завершению supervisor; если transport не позволяет ждать, добавить узкое acknowledgement. Не угадывать member/run по argv. Native proof должен исключить оставшихся helpers и поздние эффекты; новый PGID у потомка не покрывается одним `kill(-pgid)`.
5. **Strict readiness.** Снять только Cursor bans в scope/launch/handshake через общую capability проверку, сохранить Kiro ban. Marker `cursor-agent` с TTL 30 минут не auth-proof. Использовать bounded native status, безопасный account/executable fingerprint и revalidation перед launch без чтения/копирования token/keychain stores.
6. **Proof binding.** Тот же retained host, model, project, native config/policy, App MCP endpoint/instance, plugin digest и свежий auth. Изменение инвалидирует proof. Native nonce поступает от настоящего App MCP, не fabricated OpenCode tool part. Сохранить leases, attempt/session identity, freshness, bootstrap/no-replay и automatic `testModel` после auth.
7. **UI/backend.** Убрать обещание App manual approvals для Cursor; unsupported manual mode отклонять также для saved launches. Сообщить native permissions, не переключать auto без выбора. Config/unsupported не отображать как logout/reinstall.
8. **Совместный E2E.** Connect -> model check -> launch -> App MCP task -> file/result/reply -> follow-up -> активный Stop без descendants/late effects -> повтор Stop -> relaunch без replay. Sibling продолжает работать. Затем проверить built `cli` и реальный plugin artifact.

### Как доставить временный patch

Pin находится в `OpenCodeProfilePolicy.ts` и subscription catalog как runtime plugin string, а не обычная frontend dependency. Один `pnpm patch` его не доставит.

Доставка: versioned patch + integrity исходного `2.5.2` + повторяемый build отдельного artifact с нужными runtime files/dependencies. Managed config ссылается на абсолютный app-owned artifact path. Проверить cold cache, Bun/import resolution и packaged path. Shared cache не патчить. Digest входит в readiness. Generated/vendor/lockfile diff измерить отдельно после сборки.

Временный downstream patch позволяет не ждать upstream. Fork/issue/PR/package публикация отдельно, без молчаливого разрешения. После upstream fix повторить acceptance перед снятием patch. Проверенная `2.5.8` сама проблему не устранила.

### Managed config ownership

Проектные конфиги не менять. Scoped HOME registration допускает добавление своей записи, но никогда overwrite/delete чужих entries. Permissions/config assets и native approval data принадлежат app scope. Конфликт, invalid JSON, symlink escape, readonly path или недоказанный effective config блокирует launch; native deny сохраняется.

`CursorMcpConfigWriter` даёт образец snapshot ownership/CAS, но пишет global HOME, ловит ошибки и возвращает `void`. Требуется явный результат: `skipped` не успех. Cleanup удаляет только собственные неизменённые assets после освобождения leases.

## Вариант 2. Более полное восстановление Cursor

🎯 Уверенность 7/10 · 🛡️ Надёжность после приёмки 9/10 · 🧠 Сложность 7/10

То же решение и те же инварианты, плюс доказанная работа на заявленных ОС, полноценная обработка конфликтующих native configs и восстановление lifecycle после рестарта. Dedicated per-member OpenCode hosts не вводятся: они не нужны для request-owned отмены, а текущий strict launch привязывает нескольких members к общему retained host.

| Дополнение к варианту 1 | Production changed LOC |
| --- | ---: |
| Config conflicts, concurrent app instances, native config updates и cleanup recovery | +120-180 |
| Platform-specific supervisor/packaging, включая доказанный Windows путь | +160-240 |
| App/host restart, crash cleanup и исключение stale ownership/PID reuse | +80-120 |
| Точные сообщения о native denial/auth/config/stop failure в существующих статусах | +40-60 |
| **Production всего** | **950-1550** |
| **Dependency patch, отдельно** | **55-100** |
| **Tests/harness, отдельно** | **600-1000** |
| **Всего без generated/lockfiles** | **1605-2650** |

Оценка: **12-22 человеко-часа реализации + 12-22 проверки = 24-44 человеко-часа**, без внешних ожиданий. Если Windows потребует новый native helper/Job Object packaging, сначала пересчитать блок. Неподтверждённую платформу не включать.

Дополнительная приёмка: native Stop/sibling isolation на каждой заявленной ОС; crash cleanup; restart без replay/чужих PID; config change invalidation; concurrent app instances; packaged cold start. Недоказанная платформа недоступна. Config go/no-go сохраняется.

## Обязательные edge cases и проверки для обоих вариантов

- Auth: logout/account change при свежем marker, CLI update, model unavailable, quota/timeout/cancellation. Не повторять неопределённые модельные операции.
- Config: чужое имя, project override, deny, invalid JSON, concurrent change, другой endpoint/instance, readonly path.
- Cancellation: before/after spawn, slow token, streaming/buffered, normal exit, repeated Stop, parent exit, orphan helper, TERM ignored, sibling, late callback после relaunch. Неподтверждённый Stop не успешен.
- Proof: один native MCP nonce/file, ноль executable OpenCode tool parts, настоящий task result/reply; stale host/model/auth/config/plugin/attempt отвергаются.
- Быстрые gates: focused `bun test` для runtime profile/session/launch/supervisor; frontend focused Vitest + `pnpm typecheck` + `pnpm lint:fast:files -- <touched files>`. Применимые source-size/provisioning guards сохраняются. Перед релизом выполнить требуемые проектом gates, build runtime через `bun run build` и frontend build; не повторять доказанные проверки без нового изменения/ошибки.
- UI проверять через отдельный `pnpm dev:mcp` renderer CDP, только sandbox/test state. Пользовательский packaged app и его команды/терминалы/teams не трогать.

## Приёмка и rollback

Вариант выбран пользователем -> bounded config и cancellation proof -> реализация полного минимального vertical slice -> совместный E2E -> packaged proof на заявленной ОС. До выполнения этих условий Cursor не получает зелёный launch-ready статус. Каждый gate проверяет конкретную ещё не доказанную границу; ожиданий ради процесса нет.

Rollback: отключить только Cursor native capability, инвалидировать его новые proofs, завершить только собственные запросы; новые Cursor launches снова получают честный unsupported статус. Вернуть runtime pin/artifact selection узким revert. Не откатывать целиком strict-launch commit `45a3892e5ad6d86e4974abda4cfbae271a03d414`, не менять Kiro и остальные providers. Управляемые assets удалять только после освобождения leases и проверки ownership.

`plan-improve` вынес слабые предположения в начальные проверки. Реализация и внешние публикации не выполнялись.

Официальные источники для начального config proof: [Cursor configuration](https://cursor.com/docs/cli/reference/configuration), [native permissions](https://cursor.com/docs/cli/reference/permissions), [CLI parameters](https://cursor.com/docs/cli/reference/parameters). Документация задаёт доступные настройки; реальную совместимость с установленным CLI подтверждает только sandbox proof.
