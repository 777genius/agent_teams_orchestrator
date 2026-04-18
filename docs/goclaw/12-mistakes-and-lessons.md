# GoClaw Mistakes and Lessons

## Biggest mistakes

### 1. Too much implicit state

Important truth rides through:

- context
- metadata
- wrapper chains
- event payloads

instead of one typed contract.

### 2. Execution modes are not first-class contracts

Mode names exist, but real behavior depends on path-specific flag bundles.

### 3. Durable core and realtime model are not equally mature

Backend truth is stronger than event/UI truth.

### 4. Availability-first permissiveness appears in sensitive seams

Some defaults are too soft for security-critical boundaries.

### 5. Store gravity is too strong

The store package absorbs too much cross-cutting meaning.

### 6. Not all persisted systems are equally durable

Task engine is more durable than some of the surrounding runtime layers.

### 7. Human identity, scope identity, and channel identity were not unified early enough

The project learned this later and has been hardening around it since.

## Lessons for us

### 1. Package the execution contract

One run envelope should carry together:

- actor
- scope
- sender
- role
- mode
- trace semantics
- side-effect policy

### 2. Make one truth path for UI

Do not let every screen invent its own projection logic.

### 3. Prefer explicit lifecycle APIs over generic patch side channels

If something is important, it should have an explicit method.

### 4. Do not let provider adapters soften real failure

Failure normalization must be strict.

### 5. Keep auth enforcement singular

Do not spread human access checks across router, handler, and store.

### 6. If a seam needs patch-train fixes, stop and package the seam

Sender, then role, then local key, then session, then trace is a warning sign.

## Best final lesson

GoClaw shows that a system can be genuinely strong in the center and still structurally expensive on the edges.

That is the main thing not to repeat.
