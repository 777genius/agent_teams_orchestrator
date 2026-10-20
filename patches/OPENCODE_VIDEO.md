# OpenCode 2.0.32 inline video transport

These Bun `patchedDependencies` modify the actual published `@opencode/core`
and `@opencode/ai` 2.0.32 package graph loaded by `@opencode/server/process`.
They do not modify an installed user CLI or its binary. The 2.0.0 floor graph
is unchanged. `scripts/opencode-v2/stage.ts` copies the installed patched bytes
into production bundles; the existing execution graph receipt hashes those
actual bytes. Keep these patches in the source archive used to run Bun install.

Upstream: `anomalyco/opencode`, v2.0.32,
official npm registry tarballs (integrities below).

Registry tarball integrity:

- `@opencode/core@2.0.32`: `sha512-nXlB1UXOFV05NihI8ckVYEhfaPkPNc9dy+XVjamphzFuZHu5SDE1yDpgItvXcr/vgbHJszM19pkeaMQzxJWFbQ==`
- `@opencode/ai@2.0.32`: `sha512-NMquAbwiFupqoXuRuvY8jPwNAiCVlQcKDQlOTbULWN283gTp4LI3NQJqrpSWpLporxomDJsjU7soN8TCPv3BKQ==`

The upstream core release bundles `session/prompt.ts` into
`dist/chunks/instance-c01nkdt4.js`, and `session/runner/to-llm-message.ts` into
`dist/chunks/instance-xt4njr3s.js`. The patches target these exact published bytes. Both upstream omissions remain in
2.0.32: inline data URLs discard video MIME and runner conversion drops video
media. The upstream AI codecs still lack the opt-in video body schema/lowering.
The AI port preserves its new `Effect.fnUntraced` wrapper. The current graph uses
Effect/platform 4.0.1, separately from the floor RC graph.
The existing data URL decoder still validates canonical base64 and the existing
attachment size limit still runs before materialization. Only explicitly
allowlisted inline video MIME headers are retained; all existing image/text/PDF
MIME detection remains unchanged. Runner conversion carries video into native
media IR rather than dropping it.

The explicitly selected `openai-compatible-chat` protocol and native
`openrouter` provider's `openrouter-chat` protocol opt into the OpenRouter
`video_url: { url: "data:video/...;base64,..." }` body. The latter is patched in
the published `dist/providers/openrouter.js`, preserving its cache-control and
provider-option handling.
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
stock 2.0.32 (video retention must fail), then after patched frozen installation.
The test uses actual native core conversion, provider compiler, and request body
schema. It asserts exact bytes and explicit native-OpenAI/unsupported-format
refusals without network calls. The existing sandbox Electron/native server
transport E2E must additionally verify that prompt materialization retains inline
video MIME and the provider receives the original video bytes once. Run the
normal build/staged graph checks before release.
