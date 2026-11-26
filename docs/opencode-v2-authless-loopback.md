# OpenCode V2 configured authless loopback admission

## Observed failure

The application local-provider native run on 2026-11-24 used app
`c98d92faf66e16b22c693f1834da503b080938c7`, runtime
`5841f978fa0c03345eb8c1fd05ed94530d8ed612`, Bun 1.4.4, and OpenCode 2.1.4
on macOS Intel. It failed before local model execution with
`native_owner_retired:execution_selected_auth_anonymous_unproven`.
The original [run and artifact](https://github.com/777genius/agent-teams-ai/actions/runs/45511740646)
preserve the failed readiness gate and the cleared lane index.

The selected provider was explicitly configured as `local-lab`, with the
OpenAI-compatible package, a literal loopback URL, and an exact model declaration.
The existing profile manager already imports that declaration into a sealed V2
profile. Its empty selected authentication store previously reached only the
native public/free-model admission checks. A local provider has no native
`apiKey: public` marker, so it was refused before the execution probe could run.

## Admission boundary

The added route admits only an explicit selected
`aisdk:@ai-sdk/openai-compatible` declaration with an HTTP(S) literal loopback
endpoint. It checks the existing configuration digest, selected provider/model,
and declared upstream model ID. The profile still comes from the normal owned
launch-plan factory; no caller-supplied admission flag or credential is added.

The selected native provider must report the enabled compatible adapter and the
same endpoint. Native OpenCode rewrites the AI SDK package declaration to
`@opencode/ai/providers/openai-compatible`. Its integration must retain the same
provider identity and have no connections. The exact native model must be enabled
and active, with the expected upstream ID. Model and variant overrides cannot
change the endpoint, adapter, or identity, or attach credentials through settings,
headers, or request bodies.

No model price is invented or required by this local route. Public/free remote
admission retains its existing native marker, zero-cost, and empty-integration
checks. API-key and OAuth admission retain their existing paths. A nonlocal
configuration receives no authority from the local-route helper.

This narrow route rejects wildcard `0.0.0.0`, URL credentials, query/fragment
parameters, unsupported adapters, and nonempty header/body overrides. It does not
add admission for implicit local-provider discovery or other provider packages.

## Qualification limits

The current registry qualifies **2.1.4** for team launch. The staged **2.0.32**
graph remains a readable historical wire fixture; it is not newly qualified for
launch by this change. Configuration translation and native readback assertions
use the selected graph's existing public schema and package behavior.

Passing route admission does not establish model execution, member bootstrap,
message delivery, or a successful E2E. The unchanged owned probe must still
observe its fresh response and physical cleanup before granting launch. A real
native rerun is required for this candidate. The local-provider failure does not
establish the cause of the separate `opencode/big-pickle` incident.

Regression coverage includes the rejected old path, the exact local route,
nonliteral/remote endpoints, changed sealed configuration, native identity and
endpoint drift, hidden request overrides, and the existing remote public/free
contract. No real user project or provider credential is used by those tests.
