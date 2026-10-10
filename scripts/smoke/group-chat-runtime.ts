// Focused, model-free built wrapper proof. Use only a synthetic artifact root.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const artifacts = resolve(process.argv[2] ?? '/tmp/group-chat-runtime-proof')
await mkdir(artifacts, { recursive: true })
const input = join(artifacts, 'packaged-handshake-input.json')
await writeFile(input, JSON.stringify({
  schemaVersion: 1, requestId: 'synthetic-group-packaged-proof', command: 'opencode.handshake',
  cwd: process.cwd(), startedAt: new Date().toISOString(), timeoutMs: 5000,
  body: { requiredCommand: 'opencode.launchTeam', client: { name: 'synthetic-runtime-check' } },
}))
const results: unknown[] = []
for (const launcher of ['./cli']) {
  const child = Bun.spawn([launcher, 'runtime', 'opencode-command', '--json', '--input', input], {
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: join(artifacts, 'synthetic-config') },
    stdout: 'pipe', stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  assert.equal(exitCode, 0, stderr)
  const result = JSON.parse(stdout)
  assert.equal(result.ok, true)
  assert.equal(result.requestId, 'synthetic-group-packaged-proof')
  assert.equal(result.data.server.bridgeProtocol.groupChatProtocolVersion, undefined)
  assert.equal(result.data.server.runtime.groupChatRunProof, undefined)
  assert.equal(result.data.server.runtime.groupChatProtocolVersion, undefined)
  assert.equal(result.data.server.runtime.groupChatCapabilities, undefined)
  results.push({ launcher, exitCode, handshake: result.data, correctlyWithheldUnreadyGroupCapability: true })
}
await writeFile(join(artifacts, 'packaged-runtime-proof.json'), JSON.stringify({
  observedAt: new Date().toISOString(), synthetic: true,
  bundleSha256: createHash('sha256').update(await readFile('dist/local-cli/cli.js')).digest('hex'),
  results,
}, null, 2))
process.stdout.write('Built wrapper handshake passed; unready group protocol and run proof withheld.\n')
