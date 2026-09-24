/** Offline replay of the credential-free official ZAI 401 captured 2026-09-07.
 * Run: bun scripts/opencode-zai-auth-failure-fixture.ts /absolute/path/to/opencode
 * This exercises the execution probe directly; it does not bypass application auth gates.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const responseBody = '{"error":{"code":"1001","message":"Authentication parameter not received in Header, unable to authenticate"}}'
const expectedBinarySha = '2f24593f1b8e578d0b7ed7ca399440d4b6c125330eece20a69ad8d380190d669'

async function reconcileOwnedHosts(projectPath: string): Promise<void> {
  const { openCodeHostManager } = await import('../src/services/opencode/OpenCodeHostManager.js')
  const cleanup = await openCodeHostManager.reconcilePersistentHosts({
    mode: 'force', reason: 'zai_auth_fixture_cleanup', projectPath,
    staleAgeMs: 0, leaseStaleAgeMs: 0, preflightLeaseStaleAgeMs: 0,
  })
  console.log(JSON.stringify({ kind: 'owned-host-cleanup', cleanup }))
  assert.equal(cleanup.remaining, 0, 'Owned host cleanup must be proven before deleting registry')
  assert.deepEqual(cleanup.diagnostics, [], 'Cleanup diagnostics require inspection')
}

if (process.argv[2] === '--cleanup-child') {
  await reconcileOwnedHosts(path.join(process.argv[3]!, 'project'))
} else if (process.argv[2] !== '--isolated-child') {
  const binary = path.resolve(process.argv[2] ?? '')
  assert.equal(createHash('sha256').update(await readFile(binary)).digest('hex'), expectedBinarySha,
    'Use the pinned darwin-arm64 OpenCode 1.18.29 binary')
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-zai-auth-fixture-TEST-'))
  let cleanupProven = false
  let mainExitedSuccessfully = false
  const env = {
    HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_STATE_HOME: path.join(root, 'state'), TMPDIR: path.join(root, 'tmp'),
    TMP: path.join(root, 'tmp'), TEMP: path.join(root, 'tmp'),
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', OPENCODE_BIN_PATH: binary,
    OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_AUTOUPDATE: 'true',
  }
  async function runChild(mode: string, deadlineMs: number): Promise<void> {
    const child = Bun.spawn([process.execPath, import.meta.path, mode, root], {
      cwd: path.join(root, 'project'), env, stdout: 'inherit', stderr: 'inherit',
    })
    // This handle owns only the Bun child. Detached hosts are reconciled separately
    // using persisted process identity, never by blindly signalling recorded PIDs.
    const timeout = setTimeout(() => child.kill('SIGKILL'), deadlineMs)
    try { assert.equal(await child.exited, 0, `${mode} failed or exceeded its deadline`) }
    finally { clearTimeout(timeout) }
  }
  try {
    for (const dir of ['home', 'config', 'data', 'cache', 'state', 'tmp', 'project']) {
      await mkdir(path.join(root, dir))
    }
    try {
      await runChild('--isolated-child', 45_000)
      mainExitedSuccessfully = true
    } finally {
      // Independent bounded recovery also runs after timeout, assertion, or import failure.
      await runChild('--cleanup-child', 20_000)
      // An abnormal main exit may interrupt detached spawn before registry write.
      // An empty registry alone cannot establish that such a process is gone.
      cleanupProven = mainExitedSuccessfully
    }
  } finally {
    if (cleanupProven) await rm(root, { recursive: true, force: true })
    else console.error(`Cleanup unproven (main or cleanup did not complete successfully); preserved fixture root and host registry: ${root}`)
  }
} else {
  const root = process.argv[3]!
  const projectPath = path.join(root, 'project')
  const requests: string[] = []
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain request */ }
    requests.push(`${request.method} ${request.url}`)
    assert.equal(request.headers.authorization, 'Bearer fixture-token-not-a-credential')
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(responseBody)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    enabled_providers: ['zai-fixture'],
    provider: {
      'zai-fixture': {
        npm: '@ai-sdk/openai-compatible',
        options: {
          baseURL: `http://127.0.0.1:${address.port}/v1`,
          apiKey: 'fixture-token-not-a-credential',
        },
        models: { 'glm-5.2': {} },
      },
    },
  })
  const { OpenCodeExecutionProbe } = await import('../src/services/opencode/OpenCodeExecutionProbe.js')
  const { openCodeClientFactory } = await import('../src/services/opencode/OpenCodeClientFactory.js')
  const envelopes: unknown[] = []
  const probe = new OpenCodeExecutionProbe({ clientFactory: { create: (...args) => {
    const client = openCodeClientFactory.create(...args)
    return { ...client, getSessionMessages: async (...input) => {
      const messages = await client.getSessionMessages(...input)
      for (const message of messages) if (message.info?.error) envelopes.push(message.info.error)
      return messages
    } }
  } } })
  try {
    const result = await probe.probeModel({
      selectedModel: 'zai-fixture/glm-5.2', projectPath,
      bypassCache: true, disposeHostOnRelease: true,
    })
    console.log(JSON.stringify({ kind: 'offline-real-zai-401-transport-replay', responseBody, requests, envelopes, result }, null, 2))
    assert.deepEqual(requests, ['POST /v1/chat/completions'], 'Exactly one loopback provider request')
    assert(envelopes.some(envelope => {
      const data = (envelope as { data?: { statusCode?: number; responseBody?: string } }).data
      return data?.statusCode === 401 && data.responseBody === responseBody
    }), 'Exact response body and status must survive the OpenCode transport')
    assert.equal(result.outcome, 'not_authenticated')
    assert.equal(result.verifiedAt, undefined, 'Unauthorized response cannot produce execution proof')
    assert.equal(result.latestAssistantText ?? '', '')
    assert(result.reason?.includes('Authentication parameter not received in Header'))
  } finally {
    await reconcileOwnedHosts(projectPath)
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      server.closeAllConnections()
    })
  }
}
