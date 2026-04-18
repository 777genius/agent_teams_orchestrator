# GoClaw Cache Invalidation and Freshness

## Why this matters

In a broad platform, consistency problems are often cache problems in disguise.

GoClaw is a good example:

- some of its caches are designed very well
- some of its stale-state bugs come from invalidation gaps
- the system uses several different freshness models at once

That makes this a high-value file for architect review.

## Core observation

GoClaw is good at building local caches.
It is weaker at guaranteeing one uniform freshness contract across the whole product.

That is the real lesson.

## 1. Good cache patterns worth stealing

### API key cache

This is one of the cleaner cache implementations.

Good signals:

- negative cache exists to protect the DB from token spraying
- negative cache size is capped at `10000`
- entries are TTL-based
- invalidation is explicit

Architect lesson:

- negative caches are good
- negative caches must be capped
- security caches should be treated as real subsystems, not map hacks

### Hooks prompt-decision cache

The hooks subsystem uses a strong pattern:

- cache key includes `hook_id`, `version`, `tool_name`, `tool_input`
- hook edits bust the cache by changing version
- TTL is explicit and documented

This is a strong best practice.

Architect lesson:

- when cache correctness depends on configuration shape, version the config and include it in the cache key

### Skills version-bump strategy

Skills use a healthy combination:

- content hashing
- version bumping
- loader version invalidation
- list cache busting

This is much stronger than plain TTL.

Architect lesson:

- version-busted cache is usually safer than "wait for TTL"

### Permission cache invalidation tests

Their permission cache tests are actually useful.
They validate targeted invalidation instead of only "clear everything".

Architect lesson:

- cache invalidation should be tested as a behavioral contract

## 2. Where the freshness model gets weaker

### Storage size cache bug

Issue `#683` is a clean example.

What it shows:

- upload invalidates `/v1/storage/size`
- delete does not
- move does not

So the platform has the right cache idea, but mutation paths are not uniformly sealed.

This is a classic broad-product bug:

- cache exists
- one write path busts it
- neighboring write paths forget
- product truth becomes inconsistent for up to TTL

Architect lesson:

- invalidation logic should not be copy-pasted into handlers
- it should live behind one mutation boundary

### Cache invalidation via pubsub events

A lot of GoClaw cache coherence depends on message-bus invalidation:

- `cache:agent`
- `cache:skills`
- `cache:cron`
- `cache:heartbeat`
- `cache:custom_tools`

This is practical, but it also means:

- freshness depends on transport
- invalidation depends on publishing the right event
- subscribers must all stay correct

Architect lesson:

- pubsub invalidation is useful
- pubsub invalidation is not the same as one canonical source of truth

### Mixed freshness models

GoClaw uses several different models at once:

- pure TTL
- version-busted cache
- pubsub invalidation
- write-behind caches
- UI refetch-on-event
- UI local mutation

Each one is reasonable alone.
Together they create semantic drift risk.

Architect lesson:

- pick a small number of cache patterns
- document which pattern each subsystem is allowed to use

## 3. Strong and weak examples side by side

### Strong

- hooks decision cache
- skills loader versioning
- API key negative cache cap
- targeted permission-cache invalidation

### Weak

- storage size stale cache path
- UI state freshness depending on different screens using different event/refetch logic
- many `cache:*` paths relying on all publishers and subscribers to stay in sync

## 4. Redis and fail-open cache posture

`internal/cache/redis.go` treats Redis errors as cache misses.

That is often the right tradeoff.
It preserves availability.

But it is still a design choice with consequences:

- good for non-authoritative caches
- dangerous if applied to policy or correctness-critical truth

Architect lesson:

- fail-open caches are acceptable only when the cache is not authoritative

## 5. Best practices to steal

- version-busted cache keys
- negative cache caps
- tenant-scoped invalidation keys
- explicit cache docs
- targeted invalidation tests
- keeping authoritative truth in the store, not in the cache

## 6. Bad practices to avoid

- cache invalidation scattered across handlers
- too many freshness models in one product
- pubsub invalidation as a substitute for authoritative domain truth
- TTL-only convergence where users expect immediate consistency
- allowing UI projections to invent their own freshness strategies per screen

## The distilled lesson

GoClaw shows a useful split:

- it knows how to build good caches
- it is less disciplined about giving the whole product one honest freshness model

Steal the local cache techniques.
Do not copy the global freshness fragmentation.
