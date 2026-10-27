# Codex conversation continuity: bounded correction

Status: revision 3, approved in two design-review rounds; native storage spike pending.
Date: 2026-10-27.
Scope: fix repeated loss of an agent's direct conversation in native Codex,
qualify both transports, and deliver the runtime through the desktop app pin.

## 1. Evidence and why the current design exists

Reviewed orchestrator `95248bff2ad5b9190c31edf448c090aae349aa54` and app
`11fa963ceee01f6879cfe22dffedf8ee67b6e215`; the app pins runtime `0.0.144`.

- Native Codex began with a fresh `exec --ephemeral` per turn in
  [f44b1d8, 2026-04-19](https://github.com/777genius/agent_teams_orchestrator/commit/f44b1d8a6c445e9a4b60636c1e9a56daadd3fb26).
  The host kept a transcript but supplied only the current prompt to Codex.
- This was an explicitly limited phase-0 experiment. The original
  [implementation spec](https://github.com/777genius/agent-teams-ai/blob/11fa963ceee01f6879cfe22dffedf8ee67b6e215/docs/research/codex-native-runtime-phase-0-implementation-spec.md#L302-L314)
  chose raw exec to expose native persistence/ownership tradeoffs. Its
  [resume policy](https://github.com/777genius/agent-teams-ai/blob/11fa963ceee01f6879cfe22dffedf8ee67b6e215/docs/research/codex-native-runtime-phase-0-implementation-spec.md#L984-L1001)
  deferred continuity; the integration decision called out competing host/native
  session ownership. A single-turn smoke did not establish conversational recall.
- The app's first verified affected runtime pin is `0.0.5` on 2026-04-23
  ([e01e099](https://github.com/777genius/agent-teams-ai/commit/e01e099c6cf457284321d1ecef94a94274ebba02)).
- App-server approval support added on 2026-05-22 also starts a fresh thread.
  The 2026-06-10 temporary Codex home prevents inherited user configuration from
  breaking app-managed launches. Later exclusions avoid importing user sessions.
  These configuration/authentication boundaries must survive the correction.
- [2026-10-13 PR 127](https://github.com/777genius/agent_teams_orchestrator/pull/127)
  repeats trusted startup context on each turn. It explains remembered project
  instructions, but did not add conversation continuation.
- Local diagnostic capture reproduced omission of the previous message and
  previous thread in both transports with persistence on and off (5 cases,
  42 assertions). This is transport reproduction, not live-model proof.
- Group mailbox processing intentionally supplies bounded same-run group history.
  A persistent private conversation must not become a new source of group input.

Conclusion: an early native-lane limitation survived product adoption. This is
not evidence that a recent OpenUI change caused the loss of ordinary history.

## 2. Product contract and limits

1. Consecutive direct turns for one persisted orchestrator session and agent use
   the same native Codex thread. The model sees previous user and assistant turns,
   plus native tool history, through Codex's own persistence.
2. Another agent, project, explicit new session, or `/clear` cannot inherit that
   thread. An explicit full host resume of the same owned session can recover it.
   Partial resume/rewind/fork must not resurrect removed turns or mutate a parent.
   Native rollback/fork mapping is outside this fix: refuse those unsupported
   operations before changing host state or submitting another native prompt.
3. Existing group turns keep their bounded ephemeral history contract. Bootstrap
   readiness/proof turns stay outside the private conversation. Use structured
   delivery provenance; quoted marker text cannot select a conversation scope.
   Bootstrap can also execute initial assigned work. Its existing ephemeral
   behavior is retained; this fix does not claim to restore that work's native
   tool history into the later direct conversation.
4. The current model, effort, approval policy, sandbox, working directory, MCP
   configuration, and authentication still govern every resumed turn.
5. A missing/corrupt/mismatched saved thread or uncertain creation must surface
   an actionable error. Never select `--last`, another agent's thread, or silently
   retry as a fresh conversation. Never automatically replay an uncertain prompt.
6. Preserve explicit non-persistent callers. `--no-session-persistence`
   is print-only; normal desktop lead/teammate turns persist their host session.
   This flag can also accompany multiple stream-json inputs; its existing
   ephemeral semantics stay outside this persistence fix. It creates no durable
   binding or native rollout. Do not infer desktop semantics from such unit fixtures.
7. Old ephemeral conversations have no native history to resume. Do not claim
   to restore lost native tool history or blindly concatenate the UI transcript.
   A genuine legacy resume gets a one-time visible context-reset notice before
   its first newly bound direct thread; subsequent turns preserve history. Never
   label that a restoration. A missing binding for an already upgraded session
   is an error, not a legacy reset; retain a small versioned owner reference in
   the existing host transcript so the two cases cannot be confused.

Out of scope: a general memory service, semantic summaries, a new agent runtime,
long-lived app-server pool, rewriting OpenCode, changing group routing, automatic
replay of every UI message, new settings, and unrelated provider/auth refactors.

## 3. Minimal implementation shape (subject to the spike below)

### A. One small conversation binding

- Add a Codex-local binding helper, composed by `turnExecutor`; no new repository
  layer or generic session framework.
- Place native storage next to the owning orchestrator session's existing
  transcript directory. Identity includes host session, agent/team, project and
  source Codex profile. Use safe generated directory names, not user text paths.
  Exclude PID, runtime instance, work-sync generation and per-launch run ID: a
  full resume may start a new process/run while retaining the same host session.
- Store the exact native thread UUID, owner/schema metadata, startup-context hash,
  and a minimal creating/active/ready state atomically.
  Keep native rollout files in this owned directory; they remain Codex's model
  context, while the host transcript remains the UI/observability projection.
- Reserve creation before spawning/submitting. Record the created thread as soon
  as native identity is observed, not only after successful completion. Reuse
  existing locking/atomic-write helpers; refuse concurrent ownership instead of
  starting two threads. App-server must expose/await identity before turn/start.
- A proved pre-submission failure restores the prior ready binding. A confirmed
  terminal failure/interruption permits a NEW user request after owned-child
  shutdown; it does not replay the failed request. A crash, lost transport or
  unconfirmed shutdown retains uncertainty and refuses another submission.
- Correlate the saved conversation with its latest host turn boundary. Reject a
  truncated/rewound host transcript before native input; never infer that a UUID
  alone means the full original conversation is still the requested context.
  Use authoritative lineage/explicit operation guards, not absence of an old UUID
  from a filtered/compacted UI projection. Persist and flush the versioned owner
  reference before first native submission to close the legacy-reset crash gap.
- Capture identity at turn entry. `/clear`/session switches during a turn must
  not attach the old result to the new conversation. Forks cannot reuse a parent
  native ID; no hidden parent mutation.

### B. Two transports, one explicit continuation contract

- Extend both runner options with exact `resumeThreadId` and owned native storage.
- Exec: first turn creates a persistent thread; later turns use `exec ... resume
  <UUID> -`. Preserve supported parent flag positions, attachments, stdin,
  config overrides, deadlines and process cleanup.
- App-server: choose `thread/start` once, then `thread/resume` with that UUID
  followed by `turn/start`. Apply current policy/model/cwd on resume. Reject a
  resumed response that names another thread before submitting the prompt.
- Preserve the existing private temporary configuration/auth overlay. Mount only
  the owned native `sessions` directory into it; share this storage between the
  two transports so approval-mode changes retain the conversation.
- Do not mount global sessions/history/SQLite into the owned conversation. Skip
  source state_*.sqlite and sidecars; override inherited CODEX_SQLITE_HOME and
  equivalent config with the temporary overlay. Keep its index/SQLite local. Mounts
  must be links/junctions, never copy-on-failure that loses subsequent writes.
- Hold conversation ownership until bounded native child shutdown/exit confirms
  writes have ended. Apply bounded owned-process kill escalation if necessary;
  an unconfirmed stop leaves uncertain state. Cleanup then removes the temporary
  overlay and its link, never the persistent target. Test Windows target survival.
  Preserve loopback secret handling and strict MCP/user-config behavior.
- Inject trusted operating context once on first direct-thread creation; unchanged
  context must not accumulate each turn (the file permits up to 96 KB). Validate
  its hash every turn. If trusted context changes, inject the updated context once
  and record its hash only after confirmed submission. Private proof stays excluded.

### C. Narrow integration and delivery

- Propagate trusted direct/group/bootstrap scope through existing query/REPL
  entry points; do not classify arbitrary user text as trusted protocol.
- Add semantic continuity regressions to the actual Codex CI step and ensure
  changes to `src/services/codexNative` trigger the relevant platform checks.
- Publish a reviewed runtime by the existing immutable-tag release process;
  update the app pin from verified published manifest bytes. Do not invent hashes
  or treat a source-only merge as delivery to packaged desktop launches.

## 4. Small spike before committing to storage design

Use a disposable TEST project/profile and the real native Codex CLI against a
local scripted Responses endpoint. No personal auth/profile and no live team.

1. Verify exact exec resume argument parsing and app-server schema against the
   supported CLI; local available binary is `0.135.0`.
2. Create a native thread and submit a unique marker plus URL. Restart the native
   child with a new config overlay, only the shared `sessions` mount, and no old
   SQLite/index. Resume the exact UUID and inspect the second HTTP request input.
3. Require the previous user and assistant content to be present in model input,
   with the new message once. Repeat exec -> exec, server -> server, exec ->
   server and server -> exec if permission mode can change in one host session.
4. Test absent UUID, owner mismatch, inherited SQLite override, and cleanup target
   survival. Verify Windows junction semantics in CI.
5. If sessions-only resume does not work reliably, revise the plan with critics
   before introducing a more persistent profile. Do not silently copy global state.

## 5. Acceptance matrix

| Scenario | Required result |
| --- | --- |
| Lead direct chat, three turns | Exact prior marker/URL remains in native model input |
| Teammate direct inbox, three turns | Same continuity and correct visible reply recipient |
| Auto and manual approval | Both preserve history; approval callbacks/policies remain valid |
| Host restart + explicit resume | Same owned native UUID and previous history |
| New host session, agent, project, profile, or clear | No foreign history/thread reuse |
| Rewind / partial resume / fork | Refusal before mutation/submission; no removed turns or parent mutation |
| Direct -> group -> direct | Group has only its authorized bounded history; direct resumes its own thread |
| Bootstrap -> direct | No readiness-only answer or private proof token enters the direct thread |
| Model/effort and permission changes | Current launch intent applied, exact thread retained where supported |
| Attachment follow-up | New attachment reaches the resumed native turn correctly |
| Abort/timeout/missing thread/corrupt binding | Error is explicit; no fresh fallback or duplicate submission |
| Crash before native UUID / lost transport after UUID | Reservation remains uncertain; no second creation |
| Proven pre-submission failure / confirmed interruption | Safe next NEW request; no permanent accidental poisoning |
| Concurrent attempts for same conversation | No split thread or overlapping owner; established queue/lock applies |
| Overlay cleanup | Native history survives; user config/auth/session files are not deleted |
| Existing explicit ephemeral callers | Their documented non-persistent contract remains intact |
| Three direct turns with unchanged startup context | Startup context marker appears once in native history |
| Legacy resume / deleted upgraded binding | Honest one-time legacy notice / explicit refusal respectively |

Use deterministic transport tests for failures/isolation and real native CLI
loopback tests for model-input continuity. A scripted endpoint is not a real
model recall test; report that distinction. No full app visual run is needed for
an unchanged UI, but exercise actual lead/inbox composition and packaged runtime.

## 6. Review and completion gates

1. Review this plan independently for lifecycle/storage and message-scope safety.
   Resolve material findings and document the decisions below before production
   implementation. No speculative infrastructure expansion.
2. Implement in small commits on a draft PR, keeping changes confined to native
   continuity, necessary scope propagation, tests and release integration.
3. Run focused regression suites and native CLI spike; inspect generated native
   requests/history, not merely UI bubbles or a generic `OK` response.
4. Two independent implementation critics review final source and evidence;
   fix confirmed findings and rerun tests for the affected risk.
5. Require current-commit CI and normal repository merge rules. Publish the exact
   verified runtime draft without rebuilding/replacing its verified assets.
6. App pin PR, required qualification/bootstrap checks, merge, and post-merge
   verification. Report separately: source merged, runtime published, app pin
   merged, installed desktop release (if one was actually published).

## Design review decisions

- Review round 1: three independent critics confirmed the original history and
  scoped sessions-only design, and identified required lifecycle protections.
- Accepted: reserve before creation; expose app-server identity before admission;
  distinguish safe terminal interruption from uncertain transport; await physical
  child shutdown; inject unchanged startup context once; keep SQLite local.
- Accepted: preserve structured group/bootstrap fences and document bootstrap
  task-history limit; explicit print no-persistence remains unchanged.
- Accepted: add rewind/partial-resume/fork refusal and transcript correlation;
  do not add a native rollback/fork subsystem to this bug fix.
- Native 0.135.0 parser/version was exercised. A local live storage spike reached
  thread/start but the host's managed /etc/codex configuration contains a hook
  unsupported by that binary. System hooks were not modified. Run the native
  loopback spike in a clean GitHub Actions job before accepting storage behavior.
- Review round 2: no remaining blocking architecture issue. Clarified stable
  resume identity, owner-reference flush before admission, authoritative lineage,
  and the fact that no-persistence stream-json can still contain multiple turns.
- Pending gates: real sessions-only/cross-transport spike and access to the
  existing immutable release publication path. Production code remains unchanged.
