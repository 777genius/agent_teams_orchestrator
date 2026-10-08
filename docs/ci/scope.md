# CI scope

Routine PRs and pushes to main/dev retain Linux selected authority and sandbox
lifecycle, provider/HTTP deadline and startup cleanup contracts, client/headless
and task ledger tests, the dev build, and Cursor cancellation/MCP/artifact checks.
The existing inexpensive directory compatibility workflow stays unchanged.
CI runs even for documentation so the aggregate status can report a decision.

`scripts/ci/policy.ts` adds Windows selected authority, packaged Windows candidate
and the three pinned native OpenCode conformance variants for changes to:

- Process identity, C2 custody/authority/recovery, host startup/termination,
  profile/session/OAuth lifecycle, Cursor process ownership and MCP lifecycle.
- Runtime backend/provider application/adapters, team bootstrap, swarm/process
  utilities and runtime CLI handlers.
- Entrypoints, native ABI/install/platform code, build/compile scripts, feature
  configuration, dependencies/lockfile and TypeScript configuration.
- Windows smoke/conformance harnesses, native generation fixtures, workflows
  and CI helpers/tests.

Unrelated source, such as component rendering, model reference parsing or log
projection, skips those expensive jobs. Policy lives in named path boundaries;
new lifecycle modules outside those boundaries must extend policy and tests.
For an explicit full request, dispatch **CI** with `full=true`. False is rejected
to avoid presenting an unclassified dispatch as verified.

PR classification uses the merge base of event base/head (`base...head`), not
the synthetic merge commit. Push uses before/head; a newly created branch
classifies every tracked path. Checkout fetches history using read permissions,
does not retain credentials, and uses the PR head even for forks. Missing Git
objects fail classification. NUL records and disabled rename detection preserve
deleted/renamed-away critical paths and unusual filenames.

`CI required` runs with `always()` and requires classifier, Cursor, ledger and
Linux/selected Windows authority success. Packaged/conformance skips succeed
only with an explicit routine decision and reason; selected-job failures,
cancellations, unexpected skips and missing decisions fail the aggregate.
Existing job/status names are retained, including native matrix variants when
selected. Windows authority/conformance statuses are absent on routine changes.
Required-status/rules API access returned 403: branch protection compatibility
is unknown, and no protection settings were changed. The owner must inspect any
existing Windows-specific requirements before adopting the new aggregate.

Release Runtime and Runtime Source Release are unchanged. Release still builds
native archives and requires packaged Windows smoke before publishing. This CI
task adds no dependency to the active app release. Baseline run 37758106951 at
e558a769f4dc0f8a5cfd9f1a081770f7507c5812 took 30m16s and failed Windows authority
`independent native C2 survives before app successor rename (recovery=false)` at
30000ms. That native baseline remains unverified; this policy does not fix it.

Focused verification: set `TMPDIR` to a new TEST scratch directory and run
`node --test scripts/ci/policy.test.ts` on Node 24. Use TS7 with strict NodeNext,
Node types and `allowImportingTsExtensions` to check both helpers without emit.
Validate workflow YAML and actionlint separately. No native runtime or paid
inference is needed to verify gating.
