# Member Log Stream Runtime Contract Notes

## Purpose

This note records what `claude_team` needs from `agent_teams_orchestrator` for Member Log Stream V2.

Conclusion: variant 2 should not require orchestrator code changes. The existing `runtime transcript` command already exposes the important OpenCode contract. Desktop needs to use it carefully.

## Existing Contract

Relevant CLI command:

```bash
runtime transcript \
  --json \
  --provider opencode \
  --team <teamId> \
  --member <memberName> \
  --lane <laneId> \
  --projection-only \
  --limit <count>
```

Important behavior:

- `src/main.tsx` registers `runtime transcript` with `--team`, `--member`, optional `--lane`, `--projection-only`, `--provider` and `--limit`.
- `src/cli/handlers/runtime.ts` resolves OpenCode records by exact `team/lane/member` when `--lane` is provided.
- `--team` and `--member` are required.
- `--lane` is optional only when a single stored OpenCode session exists for that `team/member`.
- If multiple records exist and `--lane` is omitted, the CLI throws: `Multiple OpenCode session records exist ... pass --lane to select one`.
- `--projection-only` returns the log projection payload desktop already needs for stream rendering.
- `--limit` should be used by desktop to avoid pulling too much runtime history into a popup.
- For variant 2, desktop should start with `--limit 400`, matching the member popup response budget.

## Desktop Integration Rule

For Member Log Stream V2, `claude_team` should:

- pass `--lane` when it has a reliable lane id for the member;
- call without `--lane` only as best-effort for single-session members;
- catch the "pass --lane" ambiguity error and skip OpenCode runtime projection for that member;
- never silently pick the first OpenCode session record;
- expose ambiguity as a warning/coverage note in the member stream response.
- validate `laneId` on the desktop IPC boundary. `laneId` can contain `:`, so it should not reuse member-name validation.
- add the new desktop member-log-stream IPC/API path without changing the orchestrator CLI contract.

This preserves correctness. A partial stream is better than showing another lane's logs as if they belonged to the selected participant.

## Desktop Wiring Risk

The latest desktop-side research found one important non-orchestrator risk: `claude_team` wires team IPC services through positional optional dependencies in `initializeTeamHandlers()`.

Implementation rule for desktop:

- add `MemberLogStreamService` append-only after the existing `ioGovernor` dependency, or do a separate dependency-object refactor;
- do not insert it next to task stream services in the middle of the positional list;
- add browser-mode API fallback returning an empty member stream response;
- use a desktop popup-specific timeout for OpenCode transcript calls and report timeout as partial coverage;
- add a desktop-side short TTL cache and in-flight join for member popup OpenCode transcript calls, so repeated live refreshes do not spawn duplicate `runtime transcript` processes;
- keep `forceRefresh` as a desktop-only cache bypass signal. It should not become a new orchestrator CLI flag in variant 2;
- keep orchestrator untouched unless `runtime transcript --lane` cannot satisfy a real OpenCode member case.

This does not change the runtime transcript contract. It just lowers the risk of breaking existing task-log and exact-log IPC handlers while adding the member stream endpoint.

## Provider Coverage Boundary

The orchestrator contract currently helps with OpenCode only.

It does not solve:

- Claude JSONL transcript discovery. That belongs in `claude_team`.
- Codex native member-wide trace indexing. That belongs in a future variant 3 design.
- Multi-provider merge policy. That belongs in `claude_team` stream composition.

## When Orchestrator Code Would Be Needed

Orchestrator changes become necessary only if product scope moves beyond variant 2.

Examples:

🎯 7   🛡️ 7   🧠 7  
Approx 250-500 LOC. Add a safe `runtime transcript list` or `runtime transcript --all-lanes` mode for one `team/member`. This would let desktop intentionally merge all OpenCode lanes for the selected member.

🎯 6   🛡️ 6   🧠 8  
Approx 500-900 LOC. Add stable runtime session metadata output with lane, createdAt, updatedAt, provider state and projection counts. Useful for precise UI coverage, but not required for first member stream.

🎯 5   🛡️ 5   🧠 9  
Approx 1000+ LOC. Add provider-neutral runtime transcript contract for OpenCode/Codex/other runtimes. This is closer to a variant 3 effort.

## Risk Notes

1. Ambiguous OpenCode lanes.
   - Current behavior is correct: fail and request `--lane`.
   - Desktop must not bypass this by guessing.

2. Stale session record.
   - Runtime transcript may return no projected messages.
   - Desktop should treat this as skipped or partial coverage.

3. Large session.
   - Always use `--limit` from desktop, initially `400`.
   - Member popup is not an audit export UI.

4. Projection-only semantics.
   - Desktop should consume projection payload, not raw canonical messages, for variant 2.
   - Raw transcript handling would expand the blast radius.

5. Future all-lanes support.
   - Needs explicit CLI contract.
   - It must return lane identity with every projected segment to avoid unsafe merge.

## Verification Commands

Use these checks before changing orchestrator code:

```bash
pnpm typecheck
./cli-dev runtime transcript --help
./cli-dev runtime transcript --json --provider opencode --team <team> --member <member> --projection-only --limit 50
./cli-dev runtime transcript --json --provider opencode --team <team> --member <member> --lane <lane> --projection-only --limit 50
```

Expected result:

- no code change needed when `--lane` path works;
- ambiguous no-lane member returns a clear error;
- desktop handles that error as partial coverage.

## Recommendation

Keep orchestrator code unchanged for Member Log Stream V2.

Make the desktop bridge pass optional `laneId` and record ambiguity as a normal partial-coverage condition. Start a separate orchestrator task only if the product requirement becomes "merge every OpenCode lane for this member".

## Deep Research Update

After checking the desktop repo and the orchestrator CLI source, the safest contract is clearer:

- `claude_team` already has deterministic lane ids through `buildPlannedMemberLaneIdentity()`;
- `TeamMemberSnapshot` already carries `providerBackendId`, `selectedFastMode`, `resolvedFastMode`, `laneId`, `laneKind`, and `laneOwnerProviderId`;
- renderer can pass `laneId` into `getMemberLogStream`;
- `ClaudeMultimodelBridgeService.getOpenCodeTranscript()` only needs to append `--lane <laneId>` when provided;
- `resolveOpenCodeSessionRecordForCli()` already rejects ambiguous no-lane calls, so desktop should treat that error as partial OpenCode coverage;
- desktop should pass `--limit 400` for popup use, then apply its own `maxChunks`/`maxSegments` budget after merge;
- desktop should handle refresh pressure with source-local cache/in-flight protection, not by changing the orchestrator CLI contract;
- desktop `forceRefresh` should bypass only desktop discovery/completed caches. It should still join active in-flight `runtime transcript` work and should not alter CLI semantics;
- desktop `since` is a desktop/API performance hint only. It should not become a new orchestrator `runtime transcript` flag in variant 2;
- provider/session/lane labels are desktop response metadata. Orchestrator should keep returning projection payloads and not own member-popup participant/filter semantics;
- orchestrator should keep failing ambiguous no-lane calls, because that prevents wrong-member logs.

So no orchestrator code is needed for variant 2. The only orchestrator follow-up worth considering is an explicit all-lanes transcript API, and only if the product requirement changes to "merge every OpenCode lane for one member".

## Latest Desktop-Only Findings

Additional research found several important risks, but all are inside `claude_team`:

- `BoardTaskExactLogStrictParser.parseFiles()` calls `retainOnly()`, and the cache implementation removes both parsed entries and active `inFlight` parse promises. Desktop should use a member-owned parser instance instead of sharing the task-stream parser.
- The canonical OpenCode projection mapper should be extracted from `OpenCodeTaskLogStreamSource`. The mapper in `OpenCodeTaskStallEvidenceSource` is narrower and can drop content/tool-result semantics needed by the popup stream.
- `TeamMemberLogsFinder.findRecentMemberLogFileRefsByMember()` should grow lightweight ref metadata and object-form options, including `forceRefresh`, without parsing every candidate file just to compute `messageCount`.
- Desktop should add a `member_log_stream` `TeamLogSourceTracker` consumer. This is a desktop watcher lifecycle issue, not an orchestrator runtime transcript concern.
- Desktop should keep Codex skipped in the first PR. Current Codex trace support is task-keyed and native-tool-only, so it does not need a new orchestrator transcript flag for this variant.

None of these require orchestrator API changes. They tighten desktop ownership and mapping rules around the existing `runtime transcript --projection-only` contract.
