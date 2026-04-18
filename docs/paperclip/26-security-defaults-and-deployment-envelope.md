# Security Defaults And Deployment Envelope

## The first impression is too rough

If смотреть только на громкие issue вроде `#2554`, легко сделать слишком грубый вывод:

- "у них всё небезопасно по умолчанию"

После более глубокого прохода это уже не совсем честно.

Более точная формула такая:

- ⚠️ у `paperclip` есть **опасные unattended defaults**
- но часть из них живёт внутри довольно жёсткого **deployment envelope**

Именно это важно правильно понять.

## Что у них уже лучше, чем кажется по issue

### Hardcoded auth secret сейчас не выглядит живым багом

Issue `#2554` обвиняет `better-auth` в fallback на `paperclip-dev-secret`.

Current `master` уже не выглядит так.

`server/src/auth/better-auth.ts` сейчас:

- требует `BETTER_AUTH_SECRET` или `PAPERCLIP_AGENT_JWT_SECRET`
- иначе падает на startup

То есть этот пункт security scan уже выглядит скорее историческим или устаревшим.

### `local_trusted` реально зажат в жёсткий runtime envelope

Да, `local_trusted` остаётся default в config schema.

Но рядом есть сильные ограничения:

- bind обязан быть loopback
- exposure обязан быть `private`
- server сам валится, если это нарушено

Это важная nuance.

То есть `local_trusted` не равно "открытый insecure public mode".

Это скорее:

- developer/operator convenience mode
- внутри намеренно узкого локального deployment envelope

## Где риск реально остаётся живым

### Dangerous unattended flags по локальным adapters

Эта часть по коду выглядит живой и важной.

Current `master` всё ещё даёт сильные permissive defaults:

- `codex_local`: `dangerouslyBypassApprovalsAndSandbox = true`
- `claude_local`: `dangerouslySkipPermissions = true`
- `opencode_local`: `dangerouslySkipPermissions = true`

Это не мелочь.

Это значит:

- local agent execution по умолчанию ориентирован на unattended throughput
- а не на conservative safety

Это может быть прагматично для продукта.

Но как architectural lesson это опасно:

⚠️ если dangerous flag превращается в normal path, у тебя уже availability-first runtime, а не safety-first runtime.

### JWT TTL и revocation story остаются мягкими

`server/src/agent-auth-jwt.ts` всё ещё даёт:

- default TTL = 48h
- `jti` поле читается, но не становится first-class revocation contract

Это не catastrophic self-hosted bug.

Но это и не сильная revocable token model.

### Telemetry всё ещё opt-out

`packages/shared/src/telemetry/config.ts` всё ещё включает telemetry по умолчанию, если:

- не стоит `PAPERCLIP_TELEMETRY_DISABLED=1`
- не стоит `DO_NOT_TRACK=1`
- не CI

Это не execution-core bug.

Но это полезный product/governance lesson:

- privacy posture тут availability/product-growth-first, не privacy-first

## Почему это важно как architect lesson

`paperclip` тут показывает очень типичный self-hosted tradeoff:

- локальная operator convenience
- unattended agent execution
- faster onboarding

против

- stricter security defaults
- harder startup
- more explicit operator acknowledgement

Они часто выбирают первое.

Не всегда безответственно.

Но системно.

## Architect takeaway

Steal:

- deployment-mode validation as a first-class contract
- strict loopback/private envelope for trusted local mode
- startup failure for missing auth secret instead of silently inventing one

Avoid:

- making dangerous unattended flags the default path for local adapters
- confusing "safe because local envelope is narrow" with "safe as a general architectural default"
- leaving long-lived run-scoped credentials without a stronger revocation story
