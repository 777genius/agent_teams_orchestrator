# Effective inherited model in runtime status

`runtime status --json` keeps schema version 2 and adds the optional provider
field `effectiveDefaultModel: string | null`. It is the runtime-resolved model
for an inherited team selection in the command's working-directory scope.
Missing or null means that this response does not identify that model. It is
not authentication, catalog freshness, or launch authorization.

For Anthropic, the runtime uses its existing user model setting resolver after
the command has applied allowed settings environment variables. This preserves
the existing precedence of the startup/session model setting, `ANTHROPIC_MODEL`,
and saved `model` settings. The existing model parser resolves family aliases
and applied `ANTHROPIC_DEFAULT_*_MODEL` mappings. The same owner supplies the
Anthropic `model list` default so a non-first gateway model is not replaced by
the catalog recommendation when a team inherits its model.

With no configured model, the full status resolves the existing catalog team
default. A summary without a catalog leaves that value null. Desktop context
limits continue to normalize the launch value through the existing context
policy; explicit selected models continue to take precedence.

The desktop host owns connection mode filtering. Auto and compatible modes
can apply their supported model settings. Direct subscription/API-key modes
clear inherited route/model environment variables and prevent settings from
restoring them. This field does not introduce a second settings parser or
expose environment variables, credentials, endpoint URLs, or capability JSON.

Consumers must accept the value only from a matching current, authoritative,
verified provider response without a status-check error. A removed value,
failed refresh, or different provider/project must not retain an older value
as a current default. Older runtimes omit the field and retain their existing
launch behavior.

Codex and OpenCode do not gain inferred values from this change. A catalog's
first item, static fallback, or native model recommendation does not prove
the currently applied user configuration. Existing explicit OpenCode route
resolution remains separate.

Verification lives in `effectiveDefaultModel.test.ts`,
`anthropicCompatibleRuntime.integration.test.ts`, and
`src/cli/effectiveDefaultModel.entry.test.ts`. The CLI entry test uses disposable
homes/projects and a local synthetic gateway; it checks model status in two
project scopes and one real CLI Messages request without paid provider calls.
