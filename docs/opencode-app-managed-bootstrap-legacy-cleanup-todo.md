# TODO: Remove Legacy OpenCode Bootstrap MCP Proof

## Summary

Current state: OpenCode runtime launch, reconcile, send, and turn-settled paths now use **app-managed bootstrap** as the default and authoritative proof.

Remaining work: physically remove or quarantine the old OpenCode bootstrap MCP proof implementation based on `runtime_bootstrap_checkin` and `member_briefing`, after the app-managed path has shipped safely.

Decision score for the recommended cleanup path:

- 🎯 8 - clear target, most conflict has already been removed from runtime paths.
- 🛡️ 8 - safe if done in phases with migration handling for old session records and fixtures.
- 🧠 5 - moderate complexity because the old tool names still exist in non-OpenCode team bootstrap code, historical fixtures, log projectors, and compatibility tests.
- Estimated change size: 120-220 lines if only removing OpenCode legacy proof gates; 300-600 lines if also cleaning fixtures and shared docs/tests aggressively.

## Why This TODO Exists

The previous bug was caused by two proof systems disagreeing:

1. New launch flow injected app-managed OpenCode bootstrap context from the app side.
2. Some readiness, status, send recovery, and turn-settled paths still expected the model to call old MCP tools:
   - `runtime_bootstrap_checkin`
   - `member_briefing`
3. App-managed OpenCode sessions correctly did not call those tools just to prove launch readiness.
4. The old checker interpreted that absence as failure:
   - `OpenCode bootstrap MCP did not complete required tools before assistant response: runtime_bootstrap_checkin, member_briefing`
5. Send recovery could then recreate a valid session because it believed bootstrap MCP failed.

That conflict is now removed from the normal OpenCode runtime path. The old checker still exists for explicitly marked legacy records and for tests that prove legacy behavior remains isolated.

## Current Runtime Contract

For current and new OpenCode sessions:

- `OpenCodeSessionRecord.bootstrapMode` defaults to `app_managed_context`.
- Missing `bootstrapMode` also means `app_managed_context`.
- App-managed evidence is authoritative:
  - `bootstrapEvidenceSource: 'app_managed_bootstrap'`
  - `appManagedBootstrap`
  - assistant response after app-managed context injection
- Lack of `runtime_bootstrap_checkin` or `member_briefing` is not an error.
- Readiness still depends on real app MCP availability through `ensureSessionAppMcpReady`.
- Real failures are still failures:
  - stale session
  - reconcile error
  - app MCP unavailable
  - permission blocked
  - model/provider/auth/runtime errors

For legacy sessions:

- Only records explicitly marked `bootstrapMode: 'model_tool_checkin'` should use old MCP proof.
- Records with no bootstrap metadata must not fall into legacy mode.

## What Is Already Done

Production behavior already changed:

- OpenCode direct MCP readiness no longer requires `runtime_bootstrap_checkin` or `member_briefing`.
- Fresh OpenCode sessions are created with `bootstrapMode: 'app_managed_context'`.
- Launch persists app-managed bootstrap metadata after successful injection.
- App-managed readiness/status no longer calls the old bootstrap MCP readiness checker.
- App-managed send recovery does not recreate sessions because old bootstrap tools are absent.
- App-managed launch turn-settled outcome can succeed without old tool calls.
- Old bootstrap MCP failure diagnostics are filtered out for app-managed records.

Test coverage already added or migrated:

- App-managed launch without old tools does not fail.
- App-managed reconcile without old tools can become ready from app-managed evidence.
- App-managed send path does not recreate a session after old bootstrap MCP absence.
- Legacy `model_tool_checkin` still uses old checker.
- Mixed OpenCode handoff safe e2e now expects launch to be pending until app-managed evidence/reconcile confirms readiness.

Known green checks from this migration:

```bash
bun test src/services/teamBootstrap/teamBootstrapMixedOpenCodeHandoff.safe-e2e.test.ts
bun test src/services/opencode/OpenCodeBridgeCommandHandler.test.ts \
  src/services/opencode/OpenCodeTurnSettledEmissionCoordinator.test.ts \
  src/services/opencode/OpenCodeSessionBridge.test.ts \
  src/services/opencode/OpenCodeEventTranslator.test.ts \
  src/services/opencode/OpenCodeBootstrapMcpFailure.test.ts
bun test src/services/opencode/OpenCodeAuthStore.test.ts \
  src/services/runtimeBackends/registry.agentTeams.test.ts
bun test src/services/opencode/OpenCodeExecutionProbe.test.ts
bun run build:dev
git diff --check
```

## What Still Remains

These are the remaining legacy surfaces. Do not delete them blindly.

### OpenCode-Specific Legacy Proof

Files to inspect:

- `src/services/opencode/OpenCodeBootstrapMcpFailure.ts`
- `src/services/opencode/OpenCodeBootstrapMcpFailure.test.ts`
- `src/services/opencode/OpenCodeBridgeCommandHandler.ts`
- `src/services/opencode/OpenCodeTurnSettledEmissionCoordinator.ts`
- `src/services/opencode/OpenCodeBridgeCommandHandler.test.ts`
- `src/services/opencode/OpenCodeTurnSettledEmissionCoordinator.test.ts`
- `src/services/opencode/types.ts`

Remaining concepts:

- `OpenCodeBootstrapMode = 'app_managed_context' | 'model_tool_checkin'`
- `OpenCodeBootstrapEvidenceSource = 'app_managed_bootstrap' | 'runtime_bootstrap_checkin'`
- `summarizeOpenCodeBootstrapMcpReadiness`
- `summarizeOpenCodeBootstrapMcpFailure`
- tests that explicitly create `bootstrapMode: 'model_tool_checkin'`

These are now compatibility surfaces, not the normal path.

### Non-OpenCode Team Bootstrap

Files to leave alone unless doing a wider product migration:

- `src/services/teamBootstrap/teamBootstrapPromptBuilder.ts`
- `src/services/teamBootstrap/teamBootstrapMemberBriefingGuard.ts`
- `src/services/teamBootstrap/bootstrapProofValidation.ts`
- `src/services/teamBootstrap/nativeAppManagedBootstrapContext.ts`
- related tests

Important: `member_briefing` is not only an OpenCode legacy proof artifact. Other team bootstrap flows may still use `member_briefing` as a valid teammate onboarding contract. Removing all references globally can break non-OpenCode teammates.

### Historical Fixtures And Log Projection

Files to inspect before broad cleanup:

- `src/services/opencode/fixtures/*`
- `src/services/opencode/OpenCodeLogProjector.test.ts`
- `src/services/opencode/OpenCodeDeliveryResponseObserver.ts`
- `src/services/opencode/OpenCodeDeliveryResponseObserver.test.ts`

Historical fixtures may include old transcripts with `runtime_bootstrap_checkin` and `member_briefing`. They may still be useful for log projection compatibility. Delete or rewrite only after checking what behavior they protect.

## Recommended Cleanup Plan

### Phase 1: Prove No Normal OpenCode Path Can Enter Legacy Mode

Goal: make legacy impossible unless a test or old persisted record explicitly opts in.

Checklist:

- Search for every `model_tool_checkin` branch.
- Confirm all constructors and fresh session paths set app-managed mode or default to it.
- Confirm records without `bootstrapMode` resolve to app-managed mode.
- Confirm `runtime_bootstrap_checkin` and `member_briefing` are not in OpenCode launch readiness required tools.
- Confirm send recovery returns before old checker for app-managed records.
- Confirm turn-settled launch suppresses old MCP failure details for app-managed records.

Useful command:

```bash
rg -n "model_tool_checkin|runtime_bootstrap_checkin|member_briefing|summarizeOpenCodeBootstrapMcp" \
  src/services/opencode src/services/teamBootstrap
```

Expected result:

- OpenCode runtime path references should be only:
  - app-managed prompt text saying not to call old tools
  - explicit legacy compatibility branches
  - tests and historical fixtures

### Phase 2: Add A Stronger Guard Test Before Deleting Anything

Goal: catch accidental reintroduction of old proof requirements.

Add or keep tests that assert:

- app-managed record with no old tool calls returns no `opencode_bootstrap_mcp_failed`.
- app-managed record with a reconcile summary that would fail old checker still resolves through app-managed path.
- app-managed send path does not emit:
  - `opencode_send_session_recreated_after_bootstrap_mcp_failure`
  - `opencode_bootstrap_mcp_failed`
- records with no `bootstrapMode` behave as app-managed.
- direct readiness required tool names do not include:
  - `runtime_bootstrap_checkin`
  - `member_briefing`

Prefer focused tests in:

- `src/services/opencode/OpenCodeBridgeCommandHandler.test.ts`
- `src/services/opencode/OpenCodeTurnSettledEmissionCoordinator.test.ts`

### Phase 3: Decide Whether To Keep Or Remove Legacy Compatibility

There are three realistic options.

#### Option A: Keep Legacy Code Isolated

🎯 9   🛡️ 9   🧠 2

Estimated change size: 0-40 lines.

What this means:

- Keep `OpenCodeBootstrapMcpFailure.ts`.
- Keep `model_tool_checkin` type.
- Keep legacy tests.
- Add a clear comment near `isAppManagedOpenCodeBootstrap` explaining that legacy is only for explicitly marked records.

Pros:

- Safest for old persisted sessions.
- Lowest risk of breaking historical transcript analysis.
- Good if we expect older app versions or old session stores to still exist in user environments.

Cons:

- Legacy code remains in repo.
- Future readers may ask why it exists.

Use this if the product is close to release or live user state migration is uncertain.

#### Option B: Quarantine Legacy Code Behind A Test-Only Or Migration-Only Boundary

🎯 8   🛡️ 8   🧠 5

Estimated change size: 120-220 lines.

What this means:

- Move old proof checker to a clearly named legacy module or keep it but rename intent:
  - `OpenCodeLegacyBootstrapMcpProof.ts`
- Remove normal runtime imports where possible.
- Keep only a small adapter function for explicitly marked `model_tool_checkin` records.
- Add comments saying no new OpenCode records may be written with `model_tool_checkin`.
- Keep old transcript fixtures if they test log projection.

Pros:

- Makes the current architecture clearer.
- Keeps compatibility without letting legacy leak into normal paths.
- Best balance of cleanup and safety.

Cons:

- Still not a full deletion.
- Requires careful test updates.

Recommended if we want a proper cleanup soon without risking old user sessions.

#### Option C: Full Physical Deletion

🎯 7   🛡️ 6   🧠 6

Estimated change size: 300-600 lines.

What this means:

- Remove `OpenCodeBootstrapMcpFailure.ts`.
- Remove `model_tool_checkin` and `runtime_bootstrap_checkin` bootstrap evidence types.
- Remove legacy tests.
- Remove legacy branches in command handler and turn-settled coordinator.
- Rewrite or delete old OpenCode fixtures that depend on old bootstrap proof.
- Ensure old persisted records with `bootstrapMode: 'model_tool_checkin'` are migrated or treated as app-managed.

Pros:

- Cleanest codebase.
- No ambiguity about the proof model.

Cons:

- Highest risk.
- Can break old session stores unless a migration rule is added.
- Can accidentally remove non-OpenCode `member_briefing` behavior if done too broadly.

Only do this after we are comfortable discarding old OpenCode bootstrap proof compatibility.

## Recommended Path

Use Option B first.

Rationale:

- The main conflict is already fixed.
- Full deletion is not urgent and has avoidable risk.
- Quarantine gives future maintainers a clear boundary:
  - current OpenCode proof is app-managed
  - legacy proof is only a compatibility reader for old explicitly marked records

## Detailed Implementation Steps For Option B

### Step 1: Rename Or Document Legacy Module

Preferred:

- Rename `OpenCodeBootstrapMcpFailure.ts` to `OpenCodeLegacyBootstrapMcpProof.ts`.
- Rename exports:
  - `summarizeOpenCodeBootstrapMcpReadiness` -> `summarizeOpenCodeLegacyBootstrapMcpReadiness`
  - `summarizeOpenCodeBootstrapMcpFailure` -> `summarizeOpenCodeLegacyBootstrapMcpFailure`

If renaming is too noisy:

- Keep file name.
- Add header comment:

```ts
// Legacy OpenCode model-tool bootstrap proof.
// Do not use this for current app-managed OpenCode sessions.
// Only records explicitly marked bootstrapMode: 'model_tool_checkin' may enter this path.
```

### Step 2: Centralize The Mode Gate

Create one helper for mode resolution and use it everywhere:

```ts
function isAppManagedOpenCodeBootstrap(
  record: Pick<OpenCodeSessionRecord, 'bootstrapMode'>,
): boolean {
  return record.bootstrapMode !== 'model_tool_checkin'
}
```

Do not duplicate this helper in multiple modules long term. Either:

- move it to a small OpenCode bootstrap utility file, or
- keep duplicate local helpers only if avoiding new public surface is preferred.

The invariant must be documented:

- `undefined` means app-managed.
- Only explicit `model_tool_checkin` means legacy.

### Step 3: Remove Legacy Failure From App-Managed Diagnostics

Verify these remain true:

- `summarizeBootstrapMcpFailure(record, summary)` returns `null` for app-managed records.
- launch diagnostics for app-managed records do not include old MCP failure text.
- turn-settled launch detail for app-managed records does not include old MCP failure text.

Search for this old message and ensure app-managed tests reject it:

```bash
rg -n "OpenCode bootstrap MCP did not complete required tools|opencode_bootstrap_mcp_failed|opencode_send_session_recreated_after_bootstrap_mcp_failure" \
  src/services/opencode src/services/teamBootstrap
```

### Step 4: Keep Send Recovery Strictly App-MCP Based

Correct send behavior:

1. Load stored session.
2. If stale for real reasons, recreate.
3. Ensure app MCP is ready through `ensureSessionAppMcpReady`.
4. If app MCP cannot attach, recreate once or fail gracefully.
5. Do not recreate app-managed sessions just because old bootstrap tool calls are absent.

Test expectations:

- app-managed missing old tool calls does not call `markStale(..., 'bootstrap_app_mcp_unavailable')`.
- app-managed missing old tool calls does not emit `opencode_send_session_recreated_after_bootstrap_mcp_failure`.
- explicit legacy `model_tool_checkin` still can recreate if old proof failed, until the full deletion phase.

### Step 5: Tighten Session Store Semantics

Fresh records:

- must write `bootstrapMode: 'app_managed_context'`.

Records after injection:

- must write:
  - `bootstrapEvidenceSource: 'app_managed_bootstrap'`
  - `appManagedBootstrap.schemaVersion: 1`
  - `messageID`
  - `contextHash`
  - `briefingHash`
  - `injectionVerifiedAt`
  - optional `model`
  - optional `agent`

Old records:

- no migration script is required for now.
- behavior migration is enough:
  - missing `bootstrapMode` is treated as app-managed.

### Step 6: Do Not Globally Delete `member_briefing`

This is important.

`member_briefing` is still a team bootstrap concept outside this OpenCode proof conflict. Before removing it globally, inspect:

- non-OpenCode teammate prompt builder
- member briefing guard
- bootstrap proof validation
- native app-managed bootstrap context

Safe deletion target is **OpenCode proof dependency**, not the whole `member_briefing` tool.

### Step 7: Update Or Keep Historical Fixtures Intentionally

Historical OpenCode fixtures may contain old bootstrap prompts and tool calls. They should not be rewritten just for aesthetics if they protect:

- log projection
- delivery response observation
- old transcript parsing
- compatibility with existing user history

Delete or rewrite only if tests prove they are no longer used.

### Step 8: Verification Commands

Minimum verification after quarantine cleanup:

```bash
bun test src/services/opencode/OpenCodeBridgeCommandHandler.test.ts
bun test src/services/opencode/OpenCodeTurnSettledEmissionCoordinator.test.ts
bun test src/services/opencode/OpenCodeSessionBridge.test.ts
bun test src/services/opencode/OpenCodeBootstrapMcpFailure.test.ts
bun test src/services/teamBootstrap/teamBootstrapMixedOpenCodeHandoff.safe-e2e.test.ts
bun run build:dev
git diff --check
```

If the cleanup touches delivery response or transcript fixtures, also run:

```bash
bun test src/services/opencode/OpenCodeDeliveryResponseObserver.test.ts
bun test src/services/opencode/OpenCodeLogProjector.test.ts
```

If the cleanup touches non-OpenCode team bootstrap, also run:

```bash
bun test src/services/teamBootstrap/bootstrapProofValidation.test.ts
bun test src/services/teamBootstrap/teamBootstrapMemberBriefingGuard.test.ts
bun test src/services/teamBootstrap/teamBootstrapSpec.test.ts
```

## Acceptance Criteria

The cleanup is done correctly when all of these are true:

- New OpenCode sessions can never be written as `model_tool_checkin`.
- Missing `bootstrapMode` still resolves to app-managed.
- `runtime_bootstrap_checkin` and `member_briefing` are not required for OpenCode readiness.
- App-managed launch without old tool calls succeeds or remains pending based on app-managed evidence, not legacy proof.
- App-managed send never recreates a session due to missing old bootstrap tool calls.
- App-managed turn-settled launch does not emit legacy bootstrap MCP failure detail.
- Legacy code, if kept, is named or commented as legacy and guarded by explicit `bootstrapMode: 'model_tool_checkin'`.
- Non-OpenCode `member_briefing` onboarding behavior still works.
- All relevant tests and `build:dev` pass.

## Common Mistakes To Avoid

- Do not treat `bootstrapEvidenceSource: 'runtime_bootstrap_checkin'` as authoritative unless `bootstrapMode` is also `model_tool_checkin`.
- Do not let missing `bootstrapMode` fall back to legacy. That would re-break old user sessions like `atlas-hq-3`.
- Do not add `runtime_bootstrap_checkin` or `member_briefing` back into OpenCode direct MCP required tools.
- Do not delete `member_briefing` from all team bootstrap code without a wider product migration.
- Do not rewrite historical fixtures unless the owning tests are understood.
- Do not collapse app MCP readiness into app-managed bootstrap evidence. They prove different things:
  - app MCP readiness proves the runtime can access required app tools.
  - app-managed bootstrap evidence proves the app injected the runtime context.

## Final Target State

Long-term ideal:

- OpenCode has one normal bootstrap proof:
  - app-managed context injected by the app
  - app-side evidence persisted in session store
  - readiness checked by app MCP availability
- The model is not asked to call tools merely to prove launch readiness.
- Old model-tool bootstrap proof is either:
  - deleted after migration confidence, or
  - clearly quarantined as legacy compatibility for explicitly marked old records.

