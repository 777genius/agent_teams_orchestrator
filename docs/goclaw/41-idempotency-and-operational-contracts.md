# GoClaw Idempotency and Operational Contracts

## Why this file exists

Some of GoClaw's most reusable ideas are not in the orchestration headlines.

They live in operational contracts:

- idempotent upload paths
- restore modes
- version creation
- session persistence
- seed-on-first-use behavior

These patterns are worth separating because they show both strong engineering taste and subtle platform risks.

## 1. Skill ZIP upload is more disciplined than it first appears

The skill upload flow has several good properties:

- accepts `SKILL.md` at root or inside one top-level wrapper directory
- computes idempotency from `SKILL.md` content hash, not ZIP hash
- uses a per-slug upload lock to avoid TOCTOU races
- returns `status: unchanged` when content hash matches current stored version
- versions always increase, including archived skills
- runs dependency scan and optional auto-install after extraction
- bumps loader/store version and emits cache invalidation after write

This is a good example of an upload flow that is:

- content-oriented
- race-aware
- operationally idempotent

Issue `#845` is useful evidence here.
The feature request itself correctly identified that ZIP-level upload semantics were weaker than content-level skill semantics.

Architect lesson:

- when users upload packaged assets, deduplicate by canonical content, not by transport artifact

## 2. Advisory-locked version creation is a strong platform pattern

The skills/versioning path uses explicit version bump logic and advisory locking.

This is a quietly strong decision because it prevents:

- duplicate versions under concurrency
- optimistic "latest version + 1" races
- accidental overwrite-style semantics

Architect lesson:

- if version identity matters, generate it under lock instead of hoping callers serialize themselves

## 3. Restore modes are explicit, which is good

The tenant restore flow makes the semantic choice explicit:

- `upsert`
- `replace`
- `new`

That is much better than a single "restore" command with hidden behavior.

It also performs:

- schema-version compatibility checks
- warning accumulation
- tenant-id rewriting for clone-style restore
- filesystem extraction as a second explicit phase

Architect lesson:

- destructive and non-destructive restore paths should be explicit modes, not booleans scattered through code

## 4. But restore-mode richness also increases semantic load

This same strength has a cost.

Once a backup/restore system supports:

- upsert
- replace
- clone-to-new-tenant
- partial filesystem restore
- schema-version drift warnings

it becomes a mini-platform of its own.

That means:

- more operator mistakes are possible
- docs must stay extremely sharp
- test coverage must include mode interactions, not just happy paths

Issue `#881` is a useful warning here.
It shows that backup/restore bugs are not "tooling bugs".
They hit cross-cutting platform truth.

Architect lesson:

- explicit restore modes are good, but every extra mode multiplies testing and operator burden

## 5. Idempotent inserts are used well in several places

GoClaw repeatedly uses:

- `ON CONFLICT DO NOTHING`
- idempotent grant creation
- safe re-seeding patterns
- upsert-safe import loops

This is good platform engineering.
It reduces the blast radius of retries, duplicates, and partial retries.

Architect lesson:

- any operational path that may be retried should be designed as idempotent before it is designed as fast

## 6. PostgreSQL `xmax` seeding detection is a clever positive pattern

`GetOrCreateUserProfile` uses PostgreSQL's `xmax = 0` trick to distinguish:

- a true insert
- an update-on-conflict path

That lets the system seed user files only for genuinely new profiles.

This is a good example of:

- using the database to expose real lifecycle meaning
- avoiding extra "is new?" round-trips

Architect lesson:

- when the datastore can tell you whether a write was truly new, use that signal instead of rebuilding it in app logic

## 7. Session persistence shows both good taste and real risk

The PostgreSQL session store has a write-behind cache:

- hot reads and writes stay in memory during the tool loop
- persistence is deferred to `Save()`
- legacy WS and UUID-based keys are migrated on startup
- cache keys are tenant-prefixed to avoid cross-tenant collision

This is good for throughput and reduces DB churn.

But it also creates a real contract question:

- what truth is durable right now
- what truth is only in memory right now

This is one of those patterns that is excellent when the persistence contract is clear and dangerous when it is assumed.

Architect lesson:

- write-behind is acceptable only when the product contract is honest about when data becomes durable

## 8. Owner and bypass semantics are still an operational smell

Issue `#198` is a useful clue.
It shows that `GOCLAW_GATEWAY_TOKEN` and `GOCLAW_OWNER_IDS` do different things:

- authentication
- cross-scope authorization

That distinction is understandable in code.
It is less obvious in setup and ops language.

The warning in `tenant_auth_helpers.go` about owner bypass not guaranteeing a non-nil tenant ID is another signal:

- the bypass works
- but it leaves downstream semantic hazards

Architect lesson:

- operator-facing config should not require people to understand hidden auth layering to predict system behavior

## 9. Onboarding and restore pain are architecture signals, not just UX bugs

Issues `#95`, `#312`, and `#934` all reinforce the same lesson:

- PostgreSQL is not an optional implementation detail
- image/build/update paths are part of architecture truth
- "simple setup" claims can drift away from actual operational prerequisites

Architect lesson:

- if the product depends on a real operational substrate, onboarding must acknowledge that substrate directly instead of hiding it behind marketing simplicity

## 10. Even good upload flows can still fail at the human boundary

Issue `#862` is a good reminder:

- the backend upload logic can be structurally decent
- and the product can still present a misleading error like "Invalid ZIP file"

That is a smaller seam than orchestration.
But it is the same architectural theme:

- runtime truth
- user-visible truth

must stay aligned.

Architect lesson:

- precise operator-facing errors are part of the contract, not polish

## The distilled lesson

GoClaw has strong operational engineering taste in:

- content-hash idempotency
- explicit restore modes
- advisory-locked versioning
- safe retry-friendly inserts
- database-informed lifecycle detection

But it also shows the usual platform danger:

- once operational modes, caches, bypasses, and restore semantics pile up, they become a second architecture that must be kept honest
