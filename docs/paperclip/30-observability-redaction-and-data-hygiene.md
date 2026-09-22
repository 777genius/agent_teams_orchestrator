# Observability, Redaction, And Data Hygiene

## The good news

`paperclip` has more quiet engineering taste here than many competitors.

There are real positive patterns:

- `server/src/redaction.ts` sanitizes event payload records
- `packages/adapter-utils/src/server-utils.ts` redacts sensitive env keys for logs
- `packages/adapter-utils/src/log-redaction.ts` redacts home-path/user segments in transcripts
- activity/event paths already use redaction helpers in several places

There is also a real storage/data-hygiene fix for the old UTF-8 issue.

Current code now forces UTF-8 for embedded Postgres initialization:

- `server/src/index.ts`
- `packages/db/src/migration-runtime.ts`

and database creation is explicitly:

- `encoding 'UTF8'`
- `lc_collate 'C'`
- `lc_ctype 'C'`

in `packages/db/src/client.ts`.

That means issue `#636` is now best read as:

- a real historical lesson
- mostly fixed for fresh clusters

This is good boring platform work.

## The bad news

The HTTP error logging seam is still much weaker than the surrounding redaction taste.

In current `server/src/middleware/logger.ts`:

- pino redaction only covers `req.headers.authorization`
- `customProps()` adds raw `reqBody`, `reqParams`, and `reqQuery` on 4xx/5xx

That means the public `master` still appears vulnerable to the class described in `#3072`:

- failed auth or other error requests can push sensitive request body fields into `server.log`

This is a very useful competitor lesson because it shows a classic trap:

- local redaction helpers can be strong
- whole-surface logging contract can still be weak

## Why this matters architecturally

Logs are not "just ops".

In a control plane, logs become:

- incident evidence
- operator trust surface
- credential risk surface
- compliance surface

So a system that has:

- careful event redaction
- transcript path redaction
- secret-aware env logging

but still logs raw request bodies on error

is telling you something important:

⚠️ subsystem-local hardening is not the same thing as whole-surface observability closure.

## Another useful nuance

The UTF-8 fix and the request-body logging seam point in opposite directions:

- storage/bootstrap hygiene improved
- runtime observability hygiene is still less sealed

That makes `paperclip` a very good study case.

It is not simply:

- "good security"
- or "bad security"

It is a mixed system with:

- strong data/bootstrap fixes
- weaker logging/redaction closure

## Test signal

There are redaction tests:

- `server/src/__tests__/redaction.test.ts`

There are also log-related tests like:

- `server/src/__tests__/logger-tz.test.ts`

But the current tree does not show an equally obvious regression test proving:

- auth request password fields cannot reach `server.log`

That gap matters.

## Architect takeaway

Steal:

- explicit event payload sanitization
- env redaction helpers
- transcript path redaction
- UTF-8-by-default database bootstrap discipline

Avoid:

- assuming many local redaction helpers equal global logging safety
- treating request-body logging on error as harmless
- leaving observability surfaces weaker than storage/data hygiene surfaces
