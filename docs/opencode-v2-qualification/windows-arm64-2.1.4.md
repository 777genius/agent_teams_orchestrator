# Windows ARM64 OpenCode V2 2.1.4 qualification

Date: 2026-10-29 (UTC). Runtime **0.0.147** is public and its complete asset set
has passed source, inventory, native execution and anonymous full-download checks.
The strict model-backed native ARM64 **candidate** app run also passed.

**The actual published ARM64 and x64 five-cycle qualifications passed and were
independently reviewed.** The packaged app, using public runtime 0.0.147, installed
native default 2.1.4, reused it across two warm starts, completed an explicitly
requested support-only repair and reused the repaired support after restart.
All automatic checks on the reviewed app head passed or were appropriately
skipped. App PR #1049 merged normally with the reviewed source tree. This report
does not claim a desktop app release.

| Evidence scope | Status | What it establishes |
| --- | --- | --- |
| Native runtime candidate | Passed | Official ARM64 CLI, shipped Bun, receipt admission, server/PTY and source-owner readiness/stop |
| Strict full native app candidate | Passed and independently reviewed | Real Electron MCP controller, external model, exact native commands, task ownership, peer messages and lifecycle |
| Final runtime release | Passed and independently reviewed | All five bases and supports, exact published bytes, final native Windows archive execution |
| App public 0.0.147 pin and automatic checks | Merged normally and independently reviewed; all automatic checks successful/skipped as applicable | Reviewed pin/default activation and merged app source, with exact reviewed-tree identity |
| Published ARM64 app five-cycle qualification | Passed and independently reviewed | Actual public default install, cold/warm continuity, support-only repair, repaired restart and physical cleanup |
| Manual x64 comparison | Passed and independently reviewed | Corresponding five-cycle public gate, all recorded cycles successful |

## Exact source and release identities

| Identity | Value |
| --- | --- |
| Reviewed candidate runtime | `44c139a44e300a4347f2dcf2d4e81b1779a88857` |
| Strict candidate app | `64d100de8f504a97350af14c170e3713269ee2a5` |
| Normal app merge | `df0aeb8b36cbe0acb9008cbbb6afb14c45ed11f9` ([PR #1049](https://github.com/777genius/agent-teams-ai/pull/1049)) |
| Reviewed and merged app tree | `86f08fc3a82b9e9490305e3f56bc668b7a4f23b1` |
| Reviewed candidate and merged source tree | `c16e8979665a65c43a1df7f562fe4a65c092d249` |
| Normal runtime merge | `1aff030bac3e7d98e795a27ae77661411f4786e0` ([PR #188](https://github.com/777genius/agent_teams_orchestrator/pull/188)) |
| Immutable source tag | [`v0.0.147`](https://github.com/777genius/agent_teams_orchestrator/tree/v0.0.147), targeting that merge |
| Annotated source tag object | `b1bbb9483438aa911a1132748cda19750edeca07` |
| Public binary release | [`runtime-v0.0.147`](https://github.com/777genius/agent_teams_orchestrator_binaries/releases/tag/runtime-v0.0.147), ID `428177950` |
| Complete public roster | Five base archives, five support ZIPs, manifest and checksums: **12 assets, 856,617,209 bytes** |

The merged source tree was compared in full with the reviewed candidate tree.
The candidate app run used archives built at
`44c139a44e300a4347f2dcf2d4e81b1779a88857`; the final release was built separately
from immutable source `1aff030bac3e7d98e795a27ae77661411f4786e0`. Their archive hashes are
recorded separately below. Final release archive execution and inventory checks
bind the public bytes to the merged source.

## Native ARM64 delivery and source-owner execution

The official `@opencode/cli-windows-arm64@2.1.4` reported `opencode v2.1.4`.
Its PE machine was `0xaa64` and executable SHA256 was
`4255cf5d2703c064c4ecd90b9d9c385fb3c592c11b65a4b1d91eb738c54a5b95`.
The selected CLI and copied controller Node image were admitted against the
actual native host architecture; malformed, DLL and foreign-architecture images
were rejected. Windows executes the hash-verified shipped native **Bun 1.4.3**.

[Exact-head runtime CI 40905791380](https://github.com/777genius/agent_teams_orchestrator/actions/runs/40905791380)
passed all fourteen jobs. The [ARM64 packaged job 123564759019](https://github.com/777genius/agent_teams_orchestrator/actions/runs/40905791380/job/123564759019)
ran on `windows-11-arm`; the paired [x64 job 123564759054](https://github.com/777genius/agent_teams_orchestrator/actions/runs/40905791380/job/123564759054)
also passed. Their small proof artifacts are [12915165107 (ARM64)](https://github.com/777genius/agent_teams_orchestrator/actions/runs/40905791380/artifacts/12915165107)
and [12915232319 (x64)](https://github.com/777genius/agent_teams_orchestrator/actions/runs/40905791380/artifacts/12915232319).

| Check | Observed result on the reviewed runtime candidate |
| --- | --- |
| Physical delivery | Extracted base/descriptor/Bun/JS entry hashes and separate support identities matched; base carried no V2 helper graph |
| Real staged server | ARM64 ready in 7,864 ms; x64 ready in 9,234 ms; native grammar loaded and both servers exited 0 |
| Native PTY | Correct native DLL image, natural command exit 0, original PID absent and TEST fixture removed |
| Source owner | Genuine CLI and copied Node receipts accepted under shipped Bun; original member reached `accepted` with verified silent bootstrap |
| MCP readiness | Synthetic SDK schema peer connected as `agent-teams`; `message_send` schema read back through the selected controller contract |
| Public stop | Reply `stopped`, `ownerRetired:true`, member scope closed and process retired; both owned leader PIDs independently absent |
| Isolated probe | No model input submitted, zero session messages, selected rejecting loopback provider endpoint observed zero requests, TEST fixture removed |

The last row describes the selected rejecting endpoint, not all possible network
traffic. This source-owner probe is separate from the real model-backed desktop
run below. Windows descendant retirement remains best effort: the source-owner
receipt records `descendantsRetired:false`; the independent PID checks establish
absence of the owned run owner and execution process.

[Windows identity run 40905791253](https://github.com/777genius/agent_teams_orchestrator/actions/runs/40905791253)
passed native ARM64 and x64 idle/CPU-contention catalog checks and staged PTY
regressions. That existing catalog lane selects CLI **1.19.2**; the dedicated
V2 delivery/source-owner jobs above select **2.1.4**.

The candidate PTY receipts now record exact source
`44c139a44e300a4347f2dcf2d4e81b1779a88857` in `sourceHead` and synthetic event
checkout `a3e33d70893b932b8c75f23545e8e2b23be2c71a` in
`checkoutSha`. The final release receipts record `1aff030bac3e7d98e795a27ae77661411f4786e0` in both fields.
Earlier [runtime CI 40896361191](https://github.com/777genius/agent_teams_orchestrator/actions/runs/40896361191)
passed on `14483a99517a87aa3c88f8493d88911ed02f5e5d`; its older PTY receipt
used synthetic merge `f8ea112f750842a57397ec857ca693333d53dda5` for both fields
before the explicit PR-head environment fix. The current receipts supersede that
ambiguous PTY source label.

## Strict model-backed native app candidate

[Full ARM64 run 40907462966](https://github.com/777genius/agent-teams-ai/actions/runs/40907462966)
completed successfully with app `64d100de8f504a97350af14c170e3713269ee2a5`,
bundled runtime `44c139a44e300a4347f2dcf2d4e81b1779a88857` (0.0.147),
`win32-arm64`, native CLI 2.1.4 and external
`openrouter/openai/gpt-4.1-mini`. It used the actual Electron MCP controller.
The current V2 scenario ran with short-task, source-only and provider-only flags
all disabled. The bundled SDK was selected without a runtime override.

The [sanitized proof artifact 12916691551](https://github.com/777genius/agent-teams-ai/actions/runs/40907462966/artifacts/12916691551)
was independently audited, including its downloaded ZIP digest and all strict
command facts. Artifact ZIP SHA256:
`2c201bc9a84af5b0c5f6a9984458c634c4e271cafacbef90ac316b15da523046`.
The retained `proof.json` SHA256 is
`632aec90aee9852fc357f90228aef836276ab56ed405640868d6e26da8d5642a`.

| Observation | Completed result |
| --- | --- |
| Native shell syntax preflight | PowerShell and cmd forms matched their expected markers and exited 0 |
| Three real commands | Literal staged Node/script invocation; each command paired with its own successful result and marker |
| Strict command policy | `exact-staged-node-script-paired-own-result-v1`; all ten flags true for each of `alice`, `bob` and `alice-fresh` |
| Task ownership | Three exact owner comments preceded their terminal completions; owner/session attribution and timestamps matched |
| Peer messages | All four challenge/ACK matches passed; both delivery ledgers recorded responded visible messages |
| Held stop and persistence | Both confirmed; no changed persistence fields and no additional field difference |
| Relaunch and final stop | Both confirmed, including a fresh member after relaunch |
| Cleanup | No cleanup failures and no recorded launch, startup, task, transcript or pump failure |

The ten command flags check actor, session and model identity, exact native
execution, allowed invocation form, exact staged Node, exact program, pairing to
the command's own result, successful result and matching marker. An echo of a
Node path or marker is insufficient. The earlier successful
[run 40896435354](https://github.com/777genius/agent-teams-ai/actions/runs/40896435354)
used the previous looser matcher; the strict rerun above supplies final command
qualification.

The candidate support was a `verified_candidate_fixture`, separate from public
acquisition. Its base ZIP SHA256 was
`16683c7666577fc10c4cb6197a644476e7188822a280a6cc43ad3a3d4325dd5c`;
its support ZIP SHA256 was
`edf67011f4c16ae7c1e9817333248b1b4ad8df166634264fc71f79b83fc712a3`
(61,891,037 bytes), with manifest SHA256
`cb707b837cffe515fd3d3b60b1ce2785a061df5cbcec88a687c36fa9527e86e6`.
The copied native Node dependency SHA256 was
`92490b88097fd3ca715a2b3afeac33766aef35c35b3b2e27ff97fd9ccc046086`.
This completed app run establishes candidate controller/model/task behaviour;
normal published installation is recorded separately in the completed public
five-cycle sections below.

## Final public runtime archives and native execution

The immutable tag triggered exactly one automatic
[Release Runtime producer 40918283663](https://github.com/777genius/agent_teams_orchestrator/actions/runs/40918283663).
Preparation, all five platform builds and the complete draft upload passed.
Linux x64, Darwin ARM64 and Darwin x64 each served their staged graphs from an
extracted final archive. Both Windows builds executed natively, preserving the
existing compiler Bun 1.4.2 and separately verifying shipped Bun 1.4.3.
Windows x64 also retained its compiled-runtime regression smoke.

The final [ARM64 build 123606298250](https://github.com/777genius/agent_teams_orchestrator/actions/runs/40918283663/job/123606298250)
and [x64 build 123606298401](https://github.com/777genius/agent_teams_orchestrator/actions/runs/40918283663/job/123606298401)
checked the final ZIPs extracted outside the checkout. Front-door version,
source/version/platform descriptors, shipped Bun architecture/version, real
server startup and native PTY all passed.

| Final archive execution | Windows ARM64 | Windows x64 |
| --- | --- | --- |
| Source and checkout | `1aff030bac3e7d98e795a27ae77661411f4786e0` | `1aff030bac3e7d98e795a27ae77661411f4786e0` |
| Shipped Bun | Native 1.4.3 | Native 1.4.3 |
| Real 2.1.4 server readiness | 5,148 ms, exit 0 | 5,290 ms, exit 0 |
| Native PTY DLL machine | `0xaa64` | `0x8664` |
| Natural PTY exit/PID absence | Exit 0, original PID gone | Exit 0, original PID gone |
| TEST fixture cleanup | Removed | Removed |

The ARM64 PTY DLL SHA256 was
`80c44d8cb5123b95494fdb785fe7e2716a5c1f9a57c5d890e469ffc046bddb98`;
the x64 DLL SHA256 was
`0cd0a5124fa6a924329cec8ca74067b268e5f773a0107cc2a792a070f9f3cfe2`.
The final ARM64 base's Bun SHA256 is
`b662cf80f932866036fc2ef33d0d4e2efcf9e4ba282d2deb3391effdcfe0b98f`
and physical JS entry SHA256 is
`d0499006e6b53ee043ccf5287ef6848f5495b9eb96cb676121c06a3ccf877d61`.

| Native proof artifact | Downloaded ZIP SHA256 |
| --- | --- |
| [12918046626, Windows ARM64](https://github.com/777genius/agent_teams_orchestrator/actions/runs/40918283663/artifacts/12918046626) | `507dd7561b28a0ffe05e8a884d3db0ac358c85fd5c3c326f9db19b1b2a43bf6a` |
| [12917512610, Windows x64](https://github.com/777genius/agent_teams_orchestrator/actions/runs/40918283663/artifacts/12917512610) | `46d7d43ad196630c70942f415b2a25884d8abb20f1e13d94d4fc87f1b405f32f` |

Each artifact contains `release-delivery-smoke.json`,
`packaged-server-smoke.json` and `packaged-pty-smoke.json`, all `ok:true`.
The wrapper binds the exact base/support hashes in the roster below; PTY delivery
identity matches the validated base's Bun/entry identity and fixture cleanup.

### Exact twelve-asset roster

All rows below were downloaded completely and matched both retained API size and
SHA256 digest. The ten archive hashes also match the generated manifest and
checksums. The same asset IDs and bytes survived publication unchanged.

| Asset | GitHub asset ID | Bytes | SHA256 |
| --- | --- | --- | --- |
| `agent-teams-opencode-v2-support-darwin-arm64-v0.0.147.zip` | `689321121` | 109,511,385 | `6f6dbecb83f2f79905497b4dddac47fc5d478627d9bee5ddd3f0a46dc9884006` |
| `agent-teams-opencode-v2-support-darwin-x64-v0.0.147.zip` | `689321376` | 90,025,385 | `c7fc8468fb530e96d37dfc3332eb26baaeb865e571b2a081a5e48ab38e9f51e6` |
| `agent-teams-opencode-v2-support-linux-x64-v0.0.147.zip` | `689321676` | 130,482,979 | `abf1d2d517c44a79690c0e7734572d19cf294efe80712b499396adaec53a7ac1` |
| `agent-teams-opencode-v2-support-win32-arm64-v0.0.147.zip` | `689321889` | 61,581,853 | `398e8f827e46c117c6fd9bf522a5bf573c6bd605dde580875251323b199605cd` |
| `agent-teams-opencode-v2-support-win32-x64-v0.0.147.zip` | `689322021` | 63,456,618 | `0ced6fe0a805b94cb04c994f2e8a41dbfa3a06c7a2eb4c39fed71a363f3dfe42` |
| `agent-teams-runtime-SHA256SUMS-v0.0.147` | `689322158` | 1,171 | `bcdd40ee816f4628f5d2f02a2809e6cc7200df18e73b20393f57efe80a195f2a` |
| `agent-teams-runtime-darwin-arm64-v0.0.147.tar.gz` | `689322200` | 60,765,204 | `93e9137ae8c88a33679305c8d16c6e631f89c53516c7a3c805b9cd7d8921ffc8` |
| `agent-teams-runtime-darwin-x64-v0.0.147.tar.gz` | `689322359` | 65,655,171 | `0f1ec339de724ccd8d2b377d256c68517ede4ad1b257ad076dff86b275cf54b4` |
| `agent-teams-runtime-linux-x64-v0.0.147.tar.gz` | `689322526` | 87,229,792 | `8bf7f4ed6c134bf621af818fdd55ec6bb9f3c4a5c39c15fac23058a45213cae0` |
| `agent-teams-runtime-manifest-v0.0.147.json` | `689322841` | 6,387 | `8f6c7acdc3da30afb2bd4cc7b7cb0a8a405896874b4f4f2d4e0854cf2217efd3` |
| `agent-teams-runtime-win32-arm64-v0.0.147.zip` | `689322887` | 90,077,171 | `6f6d068b73cc5d2f4e57f64233e3f36d768b9416e33532766d83b7603980999c` |
| `agent-teams-runtime-win32-x64-v0.0.147.zip` | `689323098` | 97,824,093 | `91a68f68d0a876c1f983d02687617bfa3017a175542a401d4536e9735d86b745` |

The public [manifest](https://github.com/777genius/agent_teams_orchestrator_binaries/releases/download/runtime-v0.0.147/agent-teams-runtime-manifest-v0.0.147.json)
and [checksums](https://github.com/777genius/agent_teams_orchestrator_binaries/releases/download/runtime-v0.0.147/agent-teams-runtime-SHA256SUMS-v0.0.147)
record the immutable source and complete delivery roster.

### Full archive inventory and public byte checks

A one-off offline validator reused the production pure descriptor, manifest,
qualification and identity contracts. It read the complete downloaded archives;
it did not execute foreign-architecture binaries. Independent review included
negative cases for missing Cursor payload, POSIX execute bits, ZIP directory
attributes, links, path escapes and file/child collisions.

All five bases passed `VERSION`, `COMMIT_SHA`, descriptor, required Bun and
physical JS identity hashes, graph-free base checks and required managed Cursor
manifest plus hashed entrypoint/MCP tool files. POSIX front-door and Bun
owner-executable bits passed. All five support ZIPs passed exact entry rosters,
no extras/duplicates/links/path escapes, manifest inventory hashes, executable
attributes and qualified engine package identities.

| Support platform | Qualified staged engines | Files verified | Support manifest SHA256 |
| --- | --- | --- | --- |
| `darwin-arm64` | 2.0.0, 2.0.32, 2.1.4 | 42,201 | `7fffc798fc04f05c1ce384988c900d4115623a7c8817666685a2fbfe1aebfe08` |
| `darwin-x64` | 2.0.0, 2.0.32 | 33,589 | `b059ead66be4500f3f8a54bed3abff384136b91719517353c29a31b771fd1eb2` |
| `linux-x64` | 2.0.0, 2.0.32, 2.1.4 | 42,277 | `0d2714d8b62e2d7df4753fbc70c9021c8af9fa35e614b37dfa9e508336c76cef` |
| `win32-arm64` | 2.1.4 | 24,628 | `de6190cec36d2be9bbc23cdba09c1aad4fb5eb6bd4ee4670435cee16f0266d31` |
| `win32-x64` | 2.1.4 | 24,631 | `553f64e434906dcd3ce0907112b6e570ebfaddc151bdaa21aad09052014b4873` |

The frozen validator SHA256 was
`f6169135bd80de6c1574fbd8375d9f8ae89a291e4b6cc6d2b26566a0db6d1425`.
The following retained reports all record successful checks:

| Report | SHA256 |
| --- | --- |
| Original draft-byte qualification, `qualification-report.json` | `ed497defaae08c20e0861490f9d9de8d97fe3338f24e12c5f0b9ff5256bb0c60` |
| Independent fresh public-snapshot qualification, `root-qualification-report.json` | `4e350ba6e1fa835d4ea4f3ed7746cc353e4736152d820a8ca797c88857cec161` |
| Full anonymous twelve-body download/hash check, `root-anonymous-assets.json` | `110ab01fff3909afa1146183714d4921382e84fad84263d92032bcaaadcb9bca` |

The independent anonymous check downloaded all **856,617,209 bytes** without
authentication from 17:29:06 to 17:29:24 UTC and matched the retained draft
identities. The already-existing
[public verification dispatch 40921309898](https://github.com/777genius/agent_teams_orchestrator/actions/runs/40921309898)
also completed successfully at the immutable source/tag: preparation and the
anonymous-download workflow gate passed, while build and upload were skipped.
No rebuild or replacement of published assets occurred in that run.

## Observed publication chronology

The evidence establishes the following order; it does not attribute publication
to an actor from same-account metadata alone:

| UTC time on 2026-10-29 | Observed event |
| --- | --- |
| 17:23:19 | Original producer completed draft upload with `PUBLISH_RELEASE:false` and logged that publication required approval |
| 17:25:11 | Raw API snapshot recorded `draft:true`, `published_at:null` |
| 17:25:34 | All twelve full downloads complete; second raw API snapshot still `draft:true` with the same IDs/digests |
| 17:26:12 | Release API records publication while offline qualification was running |
| 17:26:14 | Existing public verification workflow dispatch was created |
| 17:26:57 | Original frozen byte audit completed successfully |
| 17:29:06–17:29:24 | Independent full anonymous download/hash check of every published asset passed |

The two original draft snapshots have the same SHA256,
`979dae419a899aba0b58f03aea768828cc412551f4a486b3eec3fc41061eb563`.
Neither the release executor nor coordinating auditor issued a promotion or
redispatch command. The publication actor remains unattributed. The release
was not recreated or modified during the subsequent verification, and all twelve
asset identities, sizes and digests remained unchanged.

## Published app pin and qualification results

The app branch's [activation commit
`51a808da9169f40e76a0570d6a85e613fbb45d11`](https://github.com/777genius/agent-teams-ai/commit/51a808da9169f40e76a0570d6a85e613fbb45d11)
pins runtime 0.0.147, source tag `v0.0.147`, immutable source
`1aff030bac3e7d98e795a27ae77661411f4786e0` and public release
`runtime-v0.0.147`, with matching base/support descriptor hashes. It enables
native automatic V2 activation and qualification of the default 2.1.4 install.
Its tree is `d5798ccc77c7508d7acf62449d1b0b8b0de2f915`.

The latest independently reviewed app source is
`68400055a4cc5e1ff8d16b3d90759c6538ddaaa1`, tree
`86f08fc3a82b9e9490305e3f56bc668b7a4f23b1`. It includes normal main integrations.
All automatic checks on that head returned success or were skipped as
appropriate. The completed workflows include:

| Automatic app workflow | Result |
| --- | --- |
| [Canonical source CI 40930266108](https://github.com/777genius/agent-teams-ai/actions/runs/40930266108) | Success |
| [Linux/Windows desktop diagnostics 40930266065](https://github.com/777genius/agent-teams-ai/actions/runs/40930266065) | Success |
| [Public bootstrap 40930266175](https://github.com/777genius/agent-teams-ai/actions/runs/40930266175) | Success |
| [Electron five-platform build and full qualification 40930266046](https://github.com/777genius/agent-teams-ai/actions/runs/40930266046) | Success |
| [OpenCode workflow 40930266123](https://github.com/777genius/agent-teams-ai/actions/runs/40930266123) | Success |
| [Anthropic workflow 40930266077](https://github.com/777genius/agent-teams-ai/actions/runs/40930266077) | Success |

The latest check rollup reported all ten automatic workflow runs successful;
individual conditional jobs were skipped as appropriate. At the pre-merge gate
review the PR was open, mergeable and `CLEAN`, with four review threads resolved.
The normal app PR #1049 merge is recorded below. The completed strict model-backed
candidate run above remains
evidence for app source `64d100de8f504a97350af14c170e3713269ee2a5`; it is not
relabeled as a run of the later published-install app source.

### Earlier diagnostic and incomplete public attempts

The [same-pin 0.0.146 diagnostic 40921945413](https://github.com/777genius/agent-teams-ai/actions/runs/40921945413)
passed its cold, warm-1 and warm-2 cycles without changing production installer
behaviour. It had three cycles and supplies no 0.0.147 support-repair/restart
qualification. The single earlier `EPERM` failure in
[run 40915306330](https://github.com/777genius/agent-teams-ai/actions/runs/40915306330)
remains unexplained. The successful same-pin diagnostic does not establish that
failure's cause or a verified fix.

The first actual public 0.0.147 attempts were
[ARM64 run 40925735091](https://github.com/777genius/agent-teams-ai/actions/runs/40925735091)
and [x64 run 40925808014](https://github.com/777genius/agent-teams-ai/actions/runs/40925808014).
**Both runs failed overall.** Each captured the cold native default 2.1.4
installation, complete support-file hash verification and two warm-cycle
observations before the Settings inventory assertion failed. Every cycle retained
`passed:false`; these observations are not completed cold/warm qualifications.
The harness drained cleanup and correctly refused support repair because it did
not have three successful owned cold/warm runs. Repair and post-repair restart
were not exercised.

The failure was the Settings harness's legacy inventory-provenance expectation:
the native V2 provider directory emitted `opencode-provider`, while that
assertion accepted only the older `inventory` provenance. The narrow
[two-file harness correction
`68400055a4cc5e1ff8d16b3d90759c6538ddaaa1`](https://github.com/777genius/agent-teams-ai/commit/68400055a4cc5e1ff8d16b3d90759c6538ddaaa1)
recognizes both legitimate native sources. It retains the expected provider,
positive safe-integer model count, known-model, native error, disclaimer and
quiet-window guards; seed/config-only records remain insufficient. The correction
passed 89 focused checks and independent review. It changes the diagnostic
harness and its tests, not the production installer.

| Retained attempt artifact | Overall scope/result | Artifact ZIP SHA256 |
| --- | --- | --- |
| [12918913214, same-pin 146](https://github.com/777genius/agent-teams-ai/actions/runs/40921945413/artifacts/12918913214) | Passed three diagnostic cycles | `7101da53bfb7a73e3e7a9d6a53eeebe3c6a70f6174fe56ee2707f75322b1cbf4` |
| [12922498940, public 147 ARM64](https://github.com/777genius/agent-teams-ai/actions/runs/40925735091/artifacts/12922498940) | Failed Settings provenance guard; repair refused | `dfe6647a97b737df237596cd6aebdd98ac51274d34570cea09d21291099febf3` |
| [12922245359, public 147 x64](https://github.com/777genius/agent-teams-ai/actions/runs/40925808014/artifacts/12922245359) | Failed Settings provenance guard; repair refused | `bb5f3e66ec012404537d81309e832068993ffdc6dcda0a8ba6c34e407cfac90e` |

### Completed actual public ARM64 five-cycle gate

[ARM64 run 40930296753](https://github.com/777genius/agent-teams-ai/actions/runs/40930296753),
[job 123646634748](https://github.com/777genius/agent-teams-ai/actions/runs/40930296753/job/123646634748),
completed with `SUCCESS` on native `windows-11-arm`, app
`68400055a4cc5e1ff8d16b3d90759c6538ddaaa1`, tree
`86f08fc3a82b9e9490305e3f56bc668b7a4f23b1`. The qualified step ran from
18:46:24 to 19:17:16 UTC; the final successful workflow status had API update
time 19:18:34 UTC. Both the coordinating reviewer and independent published-flow
reviewer approved the actual retained five-cycle proof.

[Artifact 12924838964](https://github.com/777genius/agent-teams-ai/actions/runs/40930296753/artifacts/12924838964)
is 1,232,096 bytes; its ZIP SHA256 is
`6cdaf55765bd7c1c0f2f9c3341bccd5267a744c26605a92b6a1823ff2705dd2f`.
It records five `passed:true`, `providerQualified:true` results with
`qualification:provider-inventory` and successful cleanup. Each cycle checked all
**24,628** support-file hashes against the exact public 0.0.147 descriptor,
source `1aff030bac3e7d98e795a27ae77661411f4786e0`, native `win32-arm64`, Bun
1.4.3, support archive and manifest hashes recorded above.

The packaged app used its normal public installer/status paths in an isolated
TEST environment (`app-install-v2-repair`). The zero-argument install requested
`default`; the previously missing native installation became verified version
**2.1.4** without a candidate archive fixture or version override.

| Support receipt group | Exact instance identity |
| --- | --- |
| Cold, warm-1 and warm-2 | `0e30cf61-74ad-449c-b6e4-b39b9282be01` |
| Support repair and repaired restart | `91d5599d-dbbe-41dc-b0b9-8e7a9c160022` |

| Required completed cycle | ARM64 final proof | x64 final proof |
| --- | --- | --- |
| Fresh/cold default V2 install through public installer/status paths | Passed: missing to default 2.1.4; complete support verified | Passed: default 2.1.4, complete support verified |
| Warm-1 retains cold physical support/native/descriptor/receipt identities | Passed: unchanged cold receipt and selection | Passed: unchanged cold receipt and selection |
| Warm-2 retains the same verified identities | Passed: unchanged cold receipt and selection | Passed: unchanged cold receipt and selection |
| Explicitly requested support-only repair after isolated known-helper corruption, with complete replacement inventory and unchanged native/base identities | Passed: new healthy support instance, native selection unchanged | Passed: explicit support-only ready result, new healthy instance |
| Restart reuses the repaired verified support and reaches ready | Passed: repaired receipt retained, complete support verified | Passed: repaired receipt retained, complete support verified |

The stopped TEST fixture invalidated only
`local-cli/opencodeV2RunOwner.js`, then explicitly requested repair with
`supportOnly:true`. The corrupted file's SHA256,
`84c8400640979fe13765160b6d74c251bc476ccc0814af5fb55b60a30e2b1fa8`,
remained in the old support instance after repair; the app selected a new healthy
instance whose full inventory passed. Repair did not edit the old helper in
place. Restart retained the new verified receipt and all expected helper hashes.

Across all five cycles, the selected native CLI SHA256 remained
`4255cf5d2703c064c4ecd90b9d9c385fb3c592c11b65a4b1d91eb738c54a5b95`;
the native `current.json` SHA256 remained
`c5d81947691e7349d30ac91820058414db5e7c027b4c9d51d0d53423e17c24d1`.
The complete native managed manifest and base/native selection were unchanged.
Support-only repair selected a new support instance while preserving the same
public descriptor and native installation.

Every cycle's cleanup recorded `drained:true`, no remaining owned identities and
no listener PIDs. In cold/warm-1/warm-2/repair/restart order, the cleanup history
established absence of **8/11/11/11/11** recorded identities. Independent review
also checked physical cleanup, sentinel protection and CDP identity binding.

This public run establishes installation, default selection, provider inventory,
support continuity/repair and cleanup. Its catalog expectation deliberately
records `authenticationProven:false` and `launchReadinessProven:false`.
Authenticated model/team/task behaviour remains the separate completed strict
candidate evidence in run 40907462966 above.

### Completed actual public x64 five-cycle gate

The corresponding manual [x64 run 40930345016](https://github.com/777genius/agent-teams-ai/actions/runs/40930345016),
[job 123646800990](https://github.com/777genius/agent-teams-ai/actions/runs/40930345016/job/123646800990),
completed with `SUCCESS` at app head
`68400055a4cc5e1ff8d16b3d90759c6538ddaaa1` and the same immutable public runtime
0.0.147. Qualification, archive and proof-upload steps succeeded; candidate
staging steps were skipped. The coordinating auditor and independent
published-flow reviewer approved the actual retained five-cycle proof, including
the explicit-repair scope limitation below.

[Artifact 12926632129](https://github.com/777genius/agent-teams-ai/actions/runs/40930345016/artifacts/12926632129)
is 1,230,534 bytes; its ZIP SHA256 is
`94512b977fab30183bbc2b6161ec3cb24b63257715af71cbbb315b26db2353cd`.
All five cycles recorded `passed:true`, `providerQualified:true`,
`qualification:provider-inventory` and drained cleanup. Each verified all
**24,631** support files against the exact public Windows x64 descriptor, source
`1aff030bac3e7d98e795a27ae77661411f4786e0`, Bun 1.4.3 and the release's support
archive/manifest hashes. Fresh zero-argument default installation selected
qualified native 2.1.4.

| x64 support receipt group | Exact instance identity |
| --- | --- |
| Cold, warm-1 and warm-2 | `4ba0f682-b68c-422b-842b-5ed1e9a1294e` |
| Support repair and repaired restart | `80ea266b-cf9c-47c2-a092-80da3e2c75d3` |

The known TEST helper `local-cli/opencodeV2RunOwner.js` was intentionally
corrupted to SHA256
`05985e8ec8bc61eb99d12f004cfba0fe90e63c22604da3fd5c6305e93aa65106`,
preserving its original byte count. Its expected healthy SHA256 is
`5d69d04a7d3249676c7378e1a16513557575aa80f52a6c354d6a31b37b8173c0`.
The explicitly requested V2 support-only installation produced an actual ready
result during 19:17:01–19:18:54 UTC, selected a new healthy support instance and
left the corrupted helper in the old instance. Restart retained the repaired
receipt and verified the complete support inventory again.

The retained x64 pre-repair `getStatus()` sample still reported
`v2Support:'ready'` after that same-size byte corruption. The status path's
`withStatus`/`readInstalled(false)` checks the manifest and helper sizes; that
status alone is not a full content-integrity check. The explicit
`supportOnly:true` installation hashes contents and replaces the corrupt support
instance. These results establish explicitly requested repair, not automatic
byte-corruption detection by `getStatus()` or the UI.

The native CLI SHA256 stayed
`b12b0613e9b4a491e5b12d90a5e9bbae6d261fe9688c82bf73125a036963d399`;
its native `current.json` SHA256 stayed
`3495208350f073b1ced083d5269efdabee36fd10c85d1150468c4703b289681a`.
The complete native managed manifest and packaged app artifact identities were
unchanged across all five cycles.

Every cleanup drained with zero owned identities/listeners remaining. The local
cleanup histories recorded **6/9/9/9/12** identities absent in
cold/warm-1/warm-2/repair/restart order; final cleanup was at
19:29:09.263 UTC. The five settled quiet windows were
583/565/563/657/648 ms in the same cycle order. As on ARM64, the catalog evidence
keeps `authenticationProven:false` and `launchReadinessProven:false`; this public
installation run is separate from the strict model-backed candidate run.

### Normal app merge

Both public five-cycle proofs have final independent approval. The normal
[app PR #1049 merge](https://github.com/777genius/agent-teams-ai/pull/1049) completed
at **20:05:09 UTC on 2026-10-29**, producing commit
`df0aeb8b36cbe0acb9008cbbb6afb14c45ed11f9`. Its tree is
`86f08fc3a82b9e9490305e3f56bc668b7a4f23b1`, exactly the reviewed app head
`68400055a4cc5e1ff8d16b3d90759c6538ddaaa1` tree, with no tree delta. The merge
parents are main `f09d3fb766b538d9edd2416692c00284f5457095` and that reviewed
head. The ordinary merge used the expected-head guard and no protection bypass.
The earlier failed-run and unknown-EPERM scope remains unchanged. No desktop
app release is claimed by this report.
