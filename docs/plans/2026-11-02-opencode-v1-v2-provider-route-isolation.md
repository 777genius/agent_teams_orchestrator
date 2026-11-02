# OpenCode V1/V2 provider route isolation (2026-11-02)

## User outcome

Add V2-specific provider adapters without changing working V1 Cursor, Kiro, Copilot or SuperGrok behavior. New installations remain V1-first, existing V2 stays V2, and credentials, installed binaries, profiles and in-flight sessions are not migrated automatically.

## Verified baseline

- The public provider-management adapter currently dispatches selected V2 to `OpenCodeV2ProviderManagement` for models, setup, key connect and model-test. The V1 path retains OpenCode managed host/auth/OAuth handling.
- The V2 connector currently admits only `method === 'api'`; an OAuth call returns an explicit refusal.
- V1 plugin profile policy owns `opencode-kiro@0.4.0` and `@rama_nigg/open-cursor@2.5.2`; the V2 model catalog excludes V1-only extension provider IDs.
- `agent-teams-ai` has a UI compatibility matrix, but it is not an authorization boundary for the runtime.
- Upstream OpenCode migration guidance identifies separate V2 plugin and server/client APIs; V1 plugins cannot be assumed to run on V2.
- Runtime and app repositories must be qualified together through their exact source/release pins.

## Architectural options and review

| Option | Change cost | V1 risk | Critic verdict |
| --- | --- | --- | --- |
| Upgrade the shared V1 plugin/auth path to work with V2 | Low initial code; high migration cost | High: shared plugin and credential shapes | Reject |
| Duplicate entire 6k-line provider adapter into V1 and V2 | Very high and divergent | Medium: fixes and guard drift | Reject |
| Keep existing V1 implementation, explicitly dispatch to an isolated V2 adapter at the selected-native boundary | Small, focused | Low if fail-closed and regression-covered | Choose |

Use one product-owned generation-selection contract; separate V1 behavior/transport from V2 keys and future V2 OAuth/CLI integrations. Keep shared only type-safe read-only DTOs and common validation. Avoid feature flags, speculative generic plugin framework, storage migration and implicit fallback.

## Cross-generation invariants

1. **Selection**: check the actual selected native generation and identity for every routed operation; error or missing native selection must never fall back to V1 and must never invoke V2 with stale authority. Avoid inferring a generation from credentials or catalog entries.
2. **Routing**: explicit V1 uses V1-owned host and plugin paths; explicit V2 uses V2-owned catalog and execution. Never attempt V1 auth, plugin setup, or host start as a V2 fallback.
3. **Credentials and profiles**: V2 transactions use isolated project-scoped private owned paths; V1 stores and plugin caches remain untouched by V2 failure. Preserve existing V1 identity and existing V2 state.
4. **Capabilities**: V1-only Cursor/Kiro managed plugin routes and subscription OAuth remain refused on V2 until **native** V2 proof exists. xAI API key is not SuperGrok OAuth. Never change a badge to Supported based on CLI login or a catalog listing.
5. **No hidden mutations**: generation switching does not rewrite configuration, copy credentials, issue OAuth callbacks, install plugins or reset sessions.
6. **Testing**: exhaustive V1/V2/identity-error route contract tests; model/setup/connect/selection before UI; then targeted packaged desktop native E2E. For real subscription/provider claims require entitled live execution evidence.

## Implementation slices

1. Add a narrow typed runtime generation dispatch contract on the public provider-management boundary, reusing the existing adapters (no rewrite of V1).
2. Route high-risk setup, connection, model retrieval and model tests through that contract; fail closed on incomplete or unknown selected identity.
3. Negative regressions for V1 preserved, V2 incompatible adapters not downgraded, identity failures non-mutating and v1-v2-v1 transitions with isolated state.
4. Have two independent critic passes: safety/auth and Clean Architecture/DRY; repair findings, then GitHub CodeQL/Codex/CodeRabbit and exact-head CI/native E2E.
5. Only after verified V2 CLI/OAuth transport exists introduce additional V2 capability per provider as separate scoped PRs. Do not bypass currently unsupported API contracts.

## External references

- OpenCode V2 migration: https://dev.opencode.ai/v2/docs/migrate-v1/
- OpenCode V2 provider/auth flows: https://dev.opencode.ai/v2/docs/cli/providers
- Fowler, Branch by Abstraction: https://martinfowler.com/bliki/BranchByAbstraction.html
- AWS, Branch by Abstraction: https://docs.aws.amazon.com/prescriptive-guidance/latest/modernization-decomposing-monoliths/branch-by-abstraction.html
- Pact, Consumer Contracts: https://docs.pact.io/consumer

## Qualification status

- [ ] Public route boundary and tests
- [ ] Independent critic loops and corrections
- [ ] Full CI and cross-platform native E2E on exact PR head
- [ ] Follow-up Agent Teams app UI pin/contract acceptance
- [ ] Merge and post-merge verification

No claim of model entitlement or real paid-provider inference without credentials.
