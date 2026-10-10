# V2 source run qualification limits

The current V2 source owner is qualified for finite sessions on Linux with Bun
1.3.11 and the exact OpenCode 2.0.0 / 2.0.21 dialects. Its maximum run lifetime is
24 hours; this is a deadline ceiling, not a guarantee of 24 hours of continuous
input at arbitrary transcript volume.

The retained session/admission implementation currently has these limits:

- 128 admitted intents per member/session, including settled and proved
  not-submitted admissions. Settlement releases the active slot but retains the
  original admission and intent for identity and replay protection.
- A complete terminal/admission cut contains at most 2,048 durable log events.
- Transcript cuts allow at most eight page reads and 1,600 total unique rows.
  Admission/terminal reads require an empty tail page within those eight calls,
  so seven full 200-row pages plus the empty tail fit that traversal.
- The durable admission snapshot is limited to 1 MiB. This byte limit may be
  reached before the count limits when identities or boundary metadata are large.

These are current qualification boundaries, not tunable caller inputs. The
owner does not prune original admissions, allocate a replacement session or
silently discard history to make a successor fit. Incremental log windows and
safe archival of original identity/evidence require separate qualification;
raising these caps alone does not establish that behavior.

When a fresh input cannot acquire a reservation, the authenticated owner returns
`send_refused / not_reserved` only after reading durable proof that neither its
request ID nor its native input ID has an admission. The shared app journal then
records `failed_before_accept`, preserving its original request, delivery attempt,
session, payload and native input identity. `safeToRetry` means that retrying that
same intent cannot duplicate a submitted input; it does not promise that a full
session will acquire more capacity. An explicitly started new run is the supported
way to obtain a new session after a permanent capacity limit.

A lost refusal response can be recovered only from the owner's retained refusal
for the original send generation and immutable intent. An observe that overtakes
an unseen original send remains UNKNOWN. The owner retains at most 128 refused
generations per member; saturation stays UNKNOWN rather than discarding an older
generation's fence. A delayed send for an already refused generation cannot invoke
native transport, even after a newer generation succeeds. The shared journal's
separate generation CAS prevents a delayed refusal from releasing a newer retry.

A callback failure before the submitting marker terminalizes only its exact
still-prepared reservation as `not_submitted`, releasing the slot for a successor.
The rejected original retains its identity and cannot replay. A failed CAS or
write, lost responses after invocation and uncertain native effects remain
UNKNOWN and retain their replay fences. Accepted inputs whose terminal evidence
exceeds a cut limit remain unsettled; an empty or partial cut cannot claim completion.
