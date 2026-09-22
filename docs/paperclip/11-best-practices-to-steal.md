# Best Practices To Steal

## 1. Explicit execution semantics docs

`🎯 9.8   🛡️ 9.3   🧠 3`

Write down:

- structure
- dependency
- ownership
- execution

and refuse to blur them.

This is one of the best things Paperclip does.

## 2. Checkout lock separate from live execution lock

`🎯 9.6   🛡️ 9.1   🧠 5`

The split between `checkoutRunId` and `executionRunId` is worth copying.

It gives better recovery and better operator truth.

## 3. Conservative stranded-work recovery

`🎯 9.5   🛡️ 9.0   🧠 5`

Try one safe automated recovery wake.
Then surface the failure clearly.

This is a better law than both:

- naive silent retries
- immediate operator-only burden

## 4. Governance as a real subsystem

`🎯 9.4   🛡️ 8.9   🧠 6`

Approvals, budgets, incidents, memberships, and board powers should be first-class if the product needs them.

## 5. Adapter split into server/UI/CLI concerns

`🎯 9.1   🛡️ 8.8   🧠 4`

This keeps runtime, display, and operator tooling from collapsing into one vague contract.

## 6. Capability-gated plugin host boundary

`🎯 9.2   🛡️ 8.9   🧠 5`

Manifest validation plus runtime gating is a real positive pattern.

## 7. Embedded database with real migrations

`🎯 9.0   🛡️ 8.8   🧠 4`

This is boring, correct control-plane engineering.

## 8. Company-scoped access model

`🎯 8.9   🛡️ 8.7   🧠 5`

Even with route bugs, the central instinct is correct:

- company membership
- company access
- board/operator roles
- agent company confinement

## 9. Single actor-resolution middleware

`🎯 9.1   🛡️ 8.8   🧠 4`

Even with fallback seams, the central instinct is correct:

- resolve actor once
- keep board vs agent explicit
- let routes consume a typed actor instead of guessing from headers

## 10. Guarded host-power mutation detection

`🎯 9.2   🛡️ 8.9   🧠 4`

The `workspace-command-authz` pattern is worth stealing:

- detect command-bearing config paths explicitly
- forbid agent mutation of host-executed power surfaces
- regression-test the dangerous paths directly

## 11. Defensive omission in portability

`🎯 8.8   🛡️ 8.8   🧠 3`

Stripping system-dependent setup and cleanup commands from export is a very good law.

Not every powerful local artifact deserves to become portable truth.

## 12. Deployment envelope validation

`🎯 8.9   🛡️ 8.8   🧠 3`

If a trusted local mode exists, it should be fenced by runtime invariants like:

- loopback-only bind
- private-only exposure
- startup refusal when violated

## 13. Quiet SSRF-resistant plugin fetch

`🎯 9.1   🛡️ 9.1   🧠 5`

Pinned-IP fetch, protocol allowlists, reserved-range denial, and no implicit redirects are all worth stealing as a reference pattern.

## 14. Side effects gated on real state change

`🎯 9.3   🛡️ 9.1   🧠 4`

The approvals subsystem shows a very good law:

- service returns whether the transition really applied
- routes emit wakeups/logs only when it did

This is exactly the right pattern for retries and duplicate requests.

## 15. Managed bundle recovery as a first-class subsystem

`🎯 9.0   🛡️ 8.8   🧠 4`

Their instructions-bundle layer has good instincts:

- explicit managed vs external mode
- stale-root recovery
- path containment
- focused tests around recovery

That is worth stealing even if the compatibility shadow is not fully gone.

## 16. UTF-8-by-default embedded DB discipline

`🎯 8.8   🛡️ 8.8   🧠 3`

The fix for the old SQL_ASCII pain is a good quiet pattern:

- initialize embedded Postgres with UTF-8
- create new DBs with explicit UTF-8 and locale settings

It is boring, but it prevents expensive operator-grade corruption bugs later.
