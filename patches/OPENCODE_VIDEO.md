# OpenCode 2.0.21 inline video transport

These Bun `patchedDependencies` modify the actual published `@opencode/core`
and `@opencode/ai` 2.0.21 package graph loaded by `@opencode/server/process`.
They do not modify an installed user CLI or its binary. The 2.0.0 floor graph
is unchanged. `scripts/opencode-v2/stage.ts` copies the installed patched bytes
into production bundles; the existing execution graph receipt hashes those
actual bytes. Keep these patches in the source archive used to run Bun install.

Upstream: `anomalyco/opencode`, v2.0.21,
`8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72`.

Registry tarball integrity:

- `@opencode/core@2.0.21`: `sha512-ATpffzxXaDEHUqV+1+c356XltMGlUsuYkm20fzn3jnrvdVT7EOLo3ThfiL47ZJR2gABvdeRiIL0bJ0yF36ayCA==`
- `@opencode/ai@2.0.21`: `sha512-eB4M0O44VoX075Kv+vIVxIpiKSrfjSXpNaeBSjtPgZdhZCjKN5CxjJXtyPbhrDxvmDf0PxLcvjGNKQBRMkZ0fw==`

The upstream core release bundles `session/prompt.ts` into
`dist/chunks/job-ma9c1wd2.js`, and `session/runner/to-llm-message.ts` into
`dist/chunks/job-rk1r2hx8.js`. The patches target these exact published bytes.
The existing data URL decoder still validates canonical base64 and the existing
attachment size limit still runs before materialization. Only explicitly
allowlisted inline video MIME headers are retained; all existing image/text/PDF
MIME detection remains unchanged. Runner conversion carries video into native
media IR rather than dropping it.

Only the explicitly selected `openai-compatible-chat` protocol opts into the
OpenRouter-compatible `video_url: { url: "data:video/...;base64,..." }` body.
Native OpenAI Chat retains its explicit video refusal. Other provider codecs
retain their own support/refusal contracts. No inference is made from a model
name, host name, or provider display name. Models still need declared video
input support at app admission. This patch proves transport, not semantic video
understanding or support by every compatible provider.

Wire contract: <https://openrouter.ai/docs/guides/overview/multimodal/videos>.
The app's existing mp4/webm/quicktime/mpeg MIME and byte/count limits remain
unchanged; provider errors remain explicit where a selected endpoint rejects a
format. No frames are extracted and no attachment becomes a text reference.

Verification: run `bun test scripts/opencode-v2/native-video.test.ts` first on
stock 2.0.21 (video retention must fail), then after patched frozen installation.
The test uses actual native core conversion, provider compiler, and request body
schema. It asserts exact bytes and explicit native-OpenAI/unsupported-format
refusals without network calls. The existing sandbox Electron/native server
transport E2E must additionally verify that prompt materialization retains inline
video MIME and the provider receives the original video bytes once. Run the
normal build/staged graph checks before release.
