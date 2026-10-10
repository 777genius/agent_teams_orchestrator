# Group chat runtime integration handoff

Runtime-only continuation on the hosted workspace `hosted-v1-group-chats-20261010-runtime-finish-r1`, 2026-10-10 UTC. Imported r2 source is preserved. No commits, reset/revert, app edits, credential reads, real project/team smoke, Mac checks, or publication were performed.

## Authoritative input and Git

Git is now a working standalone repository. `git rev-parse HEAD` returns **265ea83827cff96929a9800432f70b1c8626d73a** (exit 0); this is the exact comparison base, not a committed group implementation. The dirty source contains the adopted WIP and this continuation. The operator supplied adoption-input SHA-256 **3f12e5c78677ff9fd9894911a9a21c89dd8a8bc0b488251286b38b292b7ba7ed**; the original input packet is not mounted here, so that historical digest is operator provenance, not independently verified by this worker. Earlier checkpoint/admission hashes in the r2 packet are historical provenance, not current HEAD. Exact current file hashes and the complete tracked/untracked patch are exported below.

Read: AGENTS.md, CLAUDE.md, .github/SECURITY.md (runtime guardrails), group-chat-plan-input.md, group-chat-operator-review.md, and both handoff copies. Separate app/common guardrail files referenced by the plan are not present in this runtime checkout. Runtime is the only implementation owner here.

## Exact implemented app contract

Negotiate the existing lane with `opencode.handshake`, `requiredCommand: opencode.sendMessage`, teamId/teamName, memberName, laneId, runId/expectedRunId, and the existing capability/manifest preconditions. A compatible current member returns:

```json
{
  "server": {
    "bridgeProtocol": { "groupChatProtocolVersion": 1 },
    "runtime": {
      "groupChatRunProof": {
        "teamName": "<teamId>",
        "memberName": "<member>",
        "runId": "<actual current lane runId>",
        "runKey": "<same actual current lane runId>",
        "laneId": "<current lane or null>",
        "runtimeSessionId": "<current OpenCode session>",
        "runtimePid": 123,
        "processorReady": true
      }
    }
  }
}
```

The PID above is a schema illustration, not runtime evidence. Protocol/proof are withheld when unavailable; a lightweight launch handshake has neither. Explicit member selection cannot receive another member's proof. An unspecified member can receive proof only for an unambiguous single compatible member. There is no published `runtime.groupChatCapabilities` array, flat group protocol/runKey DTO, or independently mutated proof alias.

`readLiveGroupChatRunProofs` in OpenCodeBridgeCommandHandler.ts is the shared current-state boundary for handshake, launch/reconcile projection, and physical send validation. It uses the retained host/config and validated bound context, bypasses the persisted tools cache with actual stdio MCP tools/list, fetches current host `/mcp` and `/session/<id>`, rechecks the member store after those awaits, and derives one proof through `buildOpenCodeGroupChatRunProof`. Derivation requires a healthy retained host, matching positive live PID/host/session, current run, verified app-managed bootstrap, connected MCP, both actual group tools, and valid bound control environment. Missing/stopped/stale/session/tool/PID proof remains closed. Launch/reconcile expose that same object as `members[name].groupChatRunProof`; an app-managed bootstrap candidate references it under `groupChatRunProof` as well. Neither flattens it into a competing DTO. Send derives fresh proof through the same boundary and verifies **body.groupRunKey === proof.runKey === actual lane runId**, then rechecks persisted lane authority before dispatch. A handshake is an observation; the app must retain its second current-run check before physical handoff.

Native/lead remain on the existing runtime-admission capability.json owner. Protocol 1 requires both actual loaded group tools and the captured valid bound control context. `groupRunKey` and its derived `runKey` alias remain **bootstrapRunId:pid**; runtimeRunId derives from the same bootstrap ID. Existing processor/runtime-generation ownership remains in the REPL. Lead resolves its configured name from current team context; the app supplies `CLAUDE_CODE_BOOTSTRAP_RUN_ID=<actual app runId>`.

Physical `opencode.sendMessage` must carry **groupChatProtocolVersion=1, groupRunKey, groupChatId, groupChatName, groupMessageId (canonical UUID), messageId (distinct physical identity), from, timestamp**, plus existing team/member/lane/run/session/preconditions and text. Runtime preserves sender/name/time and the exact physical relay in the group prompt. It rejects missing key/sender/time or invalid envelopes; it does not synthesize the user sender or receive timestamp. The optional stored group name follows the existing raw schema; a supplied name is preserved. Reply tools use the physical messageId as relayOfMessageId. Proactive posts never prove the original reply. No group error redirects to a private message.

Captured control fields are `AGENT_TEAMS_BOUND_CONTROL_URL` (exact loopback HTTP origin with explicit port) and `AGENT_TEAMS_BOUND_CONTEXT_JSON` (appInstanceId, dataRootFingerprint, positive connectionGeneration). The app owns live binding authorization/archive/membership. Runtime tools support group_chat_list and group_chat_send; native aliases and OpenCode proxy canonicalization remain in the existing owners. Exact saved/group/canonical/physical-relay acknowledgements are required.

Imported strict bounded raw mailbox append/claim/read-finalize/clear safeguards remain intact. Parse/container/invalid-group/duplicate/capacity failures preserve bytes, and successful mixed-source mutation preserves unrelated raw entries and unknown fields. No normalization repair or replay platform was added.

## Verification and evidence

Artifact root:
`/srv/worker-state/jobs/agent-teams-ai/hosted-web-v1/jobs/hosted-v1-group-chats-20261010-runtime-finish-r3/tmp/agent/artifacts`

Each recorded command has a `.receipt.json` with argv, cwd, exit code, log path, and timestamps. Final receipts also capture source hashes before/after. `final-file-hashes.json` covers every modified/untracked source and handoff file; `final-runtime.patch` includes tracked changes and all untracked files. `final-patch-receipt.json` records exact patch/file hashes and Git command exits. A no-index diff exit 1 means a recorded added-file difference, not a failed check.

Environment: this sandbox had no Bun on PATH, node_modules, r2 tools, or r2 logs at the referenced job-owned paths. Exact Bun 1.3.11 was restored from its pinned Linux npm artifact into this job's tools directory; `bun install --frozen-lockfile` exited 0. package.json/bun.lock remain byte-identical to the Git base. No Electron install was necessary for these runtime checks. Earlier r2 passing logs could not be reused as accessible evidence; existing imported invariant fixtures were checked once to establish current receipts.

Verification results are recorded in the final audit below. Source fixtures use a live synthetic HTTP host/session and actual stdio MCP process/list/calls. They inspect protocol/run proof, current session/MCP presence, nested reconcile projection, the physical prompt envelope, saved group reply acknowledgement and archived rejection. Lane store/provisioning and prompt dispatch are mocked; the receipt says so. This is model-free boundary evidence, not a real OpenCode/native model turn or mixed-provider desktop smoke. The packaged smoke validates the freshly built ./cli and withholds unready protocol/proof; the preserved dist/cli was not rebuilt and is not asserted current.

Full typecheck is compared against an exact detached disposable checkout of the base, with the same frozen node_modules symlink and identical tsc flags. Diagnostics are matched individually using unchanged-line mapping, column/code/full text, normalized worktree roots, and five explicitly audited baseline rendering changes at byte-identical sources. Exact baseline/current diagnostics and removed baseline errors are retained in typecheck-comparison.json. A nonzero baseline typecheck is never reported green.

## Unresolved app-owned gates

- The reviewed OpenCodeRuntimeMessagePayload.ts/OpenCodeTeamRuntimeAdapter app forwarding paths are absent from this runtime checkout. App must preserve groupRunKey/from/groupChatName/timestamp through its actual payload/input/send. Runtime's direct full-envelope receipt proves acceptance of the correct contract; it does not prove those app adapters have been fixed.
- The reported offline draft loss across inline/fullscreen/bottomsheet/floating transitions is app renderer ownership. It was not changed or verified here. Existing copied app claims of editable offline text do not prove transition persistence.
- App CDP/mixed-provider verification, archive/membership/canonical-history/no-repeat delivery integration, and the current live app run registry check remain app-owned. No app receipt is available in this sandbox. This handoff does not claim full group-chat E2E completion.
- No runtime.lock update, release/deployment, automatic sister-workspace transfer, or commit was authorized/performed. The broader final-verification goal remains active pending authoritative app evidence.

## Final audit

| Terminal command / receipt | Exit | Evidence |
| --- | ---: | --- |
| `bun install --frozen-lockfile` / environment-receipt.json | 0 | Pinned 1.3.11, 826 packages; unchanged lock/manifest. |
| Existing native/mailbox/reply fixtures / imported-native-invariants.receipt.json | 0 | 73 passed across four existing files; strict raw-byte/capacity preservation, scope/compaction/relay and DM separation. |
| Affected handshake/bootstrap/send fixture selection / bridge-affected.receipt.json | 0 | 39 passed; 232 filtered. |
| Final current group contract fixture / integrated-final-group-fixture.receipt.json | 0 | 1 passed; 270 filtered; 30 assertions. Nested exact handshake/reconcile, real HTTP session/MCP and stdio tools/calls, full envelope, stale/missing-key rejection and missing readiness. |
| Last expanded group/observer selection / final-contract-fixtures.receipt.json | 1 | 39 passed and one group fixture failed on its placeholder expected capability ID. Corrected to the actual negotiated snapshot; the final current group fixture above passes. Observer passed with the final canonical errored/isError shape. Superseded failure is retained, not hidden. |
| `bun run build` / final-build.receipt.json | 0 | Actual final production source bundle and ./cli generated. Later edits were fixture type narrowing and handoff docs only. |
| `./cli --version` / final-built-version.receipt.json | 0 | Exact output: `2.777.777 (Claude Code)`; package.json remains 0.0.106. No release/version change claimed. |
| Built wrapper model-free handshake / final-built-handshake.receipt.json | 0 | Fresh ./cli withholds unready nested proof/protocol; matching packaged-runtime-proof.json bundle digest. |
| Exact disposable base full tsc / base-typecheck.receipt.json | 2 | 3,468 baseline diagnostics; identical frozen dependencies and flags. |
| Final frozen source full tsc / integrated-final-typecheck.receipt.json | 2 | 3,462 diagnostics; **0 new**, 6 imported baseline diagnostics resolved. All 3,462 match individually; five rendering differences are explicitly audited. Source hashes before/after agree. Full typecheck remains nonzero. |
| `git diff --check` / final-diff-check.receipt.json | 0 | Current tracked diff whitespace check. Complete added-file patch dry-run receipt is included in the packet. |

Actual command argv/cwd/logs for every intermediate and final attempt are retained in final-command-exits.json. Earlier contract mismatch/typecheck attempts are superseded, not erased. The current full typecheck comparison proves no introduced diagnostic; it does not claim the repository-wide baseline was fixed.

Final production SHA-256:

- OpenCodeBridgeCommandHandler.ts: `f92223ce170a7c5b45dbe843287a956ba84d52d083febd614c06febefaa34184`
- OpenCodeGroupChatCapability.ts: `963e510fa8335be0bbdb18d3ff281fff4845ddbaf4a7aa1f4a05716b03249829`
- dist/local-cli/cli.js: `8508879d076bb154811b77c52aa99a11293c8f6d5a705eee2e6cb9f1d70a646f`

All 27 dirty/imported/new file hashes, including both handoff documents, are in final-file-hashes.json. final-patch-receipt.json contains the complete patch SHA-256 and Git export command exit codes. No full app/group feature green is claimed; the app-owned gates above still need their owner's evidence.
