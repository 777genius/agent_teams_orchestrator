export const DESCRIPTION =
  'Deterministically create or launch a team through the shared bootstrap runner'

export function getPrompt(): string {
  return `
# TeamBootstrap

Internal deterministic bootstrap entrypoint.

Use this only when deterministic team bootstrap is explicitly enabled.
This tool exists to reuse the same runtime bootstrap core as the app startup path.

Important:
- Do not pass raw teammate prompt blobs from the caller.
- Provide teammate identity, role, workflow, and model/provider overrides.
- The runtime will build deterministic teammate startup prompts itself.
- This tool must not reimplement TeamCreate + Agent orchestration loops.
`.trim()
}
