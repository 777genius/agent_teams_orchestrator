/** Executes the pinned engine against a loopback scripted model, only in owned TEST roots.
 * bun scripts/opencode-permission-conformance.ts /absolute/opencode 1.18.29 SHA256
 * No provider inference. Permission-engine evidence is not curated/ZAI E2E evidence.
 */
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

class ProbeError extends Error {}
let phase = 'arguments'
function check(value: unknown, message: string): asserts value { if (!value) throw new ProbeError(message) }
const command = 'printf permission-engine-fixture > sentinel'
export const permissionCases = [
  { name: 'deny', rules: { '*': 'allow', 'printf *': 'deny' }, allowed: false },
  { name: 'allow', rules: { '*': 'deny', 'printf *': 'allow' }, allowed: true },
  { name: 'conflict-last-deny', rules: { '*': 'allow', 'printf *': 'allow', 'printf permission-*': 'deny' }, allowed: false },
  { name: 'conflict-last-allow', rules: { '*': 'allow', 'printf permission-*': 'deny', 'printf *': 'allow' }, allowed: true },
] as const

async function main() {
  const [input, version, sha] = process.argv.slice(2)
  check(input && path.isAbsolute(input), 'Absolute pinned binary required')
  check(process.platform === 'linux' || process.platform === 'darwin', 'Only Linux and macOS supported')
  check(version === '1.18.4' || version === '1.18.29', 'Only pinned 1.18.4 and 1.18.29 supported')
  check(/^[a-f0-9]{64}$/.test(sha ?? ''), 'Expected SHA256 required')
  const binary = await realpath(input)
  check(createHash('sha256').update(await readFile(binary)).digest('hex') === sha, 'Binary digest mismatch')
  const evidence = []
  let reportedVersion: string | undefined
  for (const test of permissionCases) {
    phase = `${test.name}:setup`
    const root = await mkdtemp(path.join(tmpdir(), 'opencode-permission-conformance-TEST-'))
    let child: ReturnType<typeof Bun.spawn> | undefined
    let fixture: ReturnType<typeof Bun.serve> | undefined
    try {
      const dirs = Object.fromEntries(['project', 'home', 'config', 'cache', 'data', 'state', 'tmp', 'runtime', 'appdata', 'localappdata'].map(key => [key, path.join(root, key)]))
      await Promise.all(Object.values(dirs).map(dir => mkdir(dir, { recursive: true })))
      let requests = 0
      let toolRequests = 0
      let observedToolResult = false
      let toolResultText = ''
      fixture = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
        check(new URL(request.url).pathname === '/v1/chat/completions', 'Unexpected fixture route')
        const body = await request.json() as any
        requests++
        if (requests > 5) return new Response('Request budget exceeded', { status: 429 })
        if (body.tools?.length) toolRequests++
        observedToolResult ||= body.messages.some((message: any) => message.role === 'tool')
        toolResultText += body.messages.filter((message: any) => message.role === 'tool').map((message: any) => JSON.stringify(message.content)).join('')
        const delta = body.tools?.length && toolRequests === 1
          ? { role: 'assistant', tool_calls: [{ index: 0, id: 'fixture_bash', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command, description: 'Write owned temporary fixture sentinel' }) } }] }
          : { role: 'assistant', content: 'Fixture complete.' }
        const chunk = (value: any) => `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, ...value }] })}\n\n`
        return new Response(chunk({ delta, finish_reason: null }) + chunk({ delta: {}, finish_reason: body.tools?.length && toolRequests === 1 ? 'tool_calls' : 'stop' }) + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
      } })
      await writeFile(path.join(dirs.project!, 'opencode.json'), JSON.stringify({
        autoupdate: false, snapshot: false, share: 'disabled', plugin: [], enabled_providers: ['fixture'],
        model: 'fixture/model', default_agent: 'fixture',
        agent: { fixture: { mode: 'primary', permission: { '*': 'deny', bash: test.rules } } },
        provider: { fixture: { npm: '@ai-sdk/openai-compatible', options: { baseURL: `http://127.0.0.1:${fixture.port}/v1`, apiKey: 'local-fixture-only' }, models: { model: { name: 'Fixture', limit: { context: 8192, output: 512 }, tool_call: true } } } },
      }))
      const env = { HOME: dirs.home!, USERPROFILE: dirs.home!, XDG_CONFIG_HOME: dirs.config!, XDG_CACHE_HOME: dirs.cache!, XDG_DATA_HOME: dirs.data!, XDG_STATE_HOME: dirs.state!, XDG_RUNTIME_DIR: dirs.runtime!, TMPDIR: dirs.tmp!, TMP: dirs.tmp!, TEMP: dirs.tmp!, APPDATA: dirs.appdata!, LOCALAPPDATA: dirs.localappdata!,
        PATH: `${path.dirname(binary)}:/usr/bin:/bin`, SHELL: '/bin/sh', LANG: 'C.UTF-8', CI: '1',
        OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1' }
      if (reportedVersion === undefined) {
        phase = 'version'
        child = Bun.spawn([binary, '--version'], { cwd: dirs.project, env, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
        check(child.stdout instanceof ReadableStream, 'Version probe stdout must be piped')
        const versionOutput = new Response(child.stdout).text()
        const versionCode = await Promise.race([child.exited, Bun.sleep(5000).then(() => { throw new ProbeError('Version probe deadline exceeded') })])
        check(versionCode === 0, 'Version probe failed')
        reportedVersion = (await versionOutput).trim()
        check(reportedVersion === version, 'Binary version mismatch')
      }
      phase = `${test.name}:execution`
      child = Bun.spawn([binary, 'run', '--format', 'json', 'Perform the fixture bash call then finish.'], { cwd: dirs.project, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
      check(child.stdout instanceof ReadableStream, 'Execution stdout must be piped')
      check(child.stderr instanceof ReadableStream, 'Execution stderr must be piped')
      const output = new Response(child.stdout).text()
      const errors = new Response(child.stderr).text()
      const code = await Promise.race([child.exited, Bun.sleep(30000).then(() => { throw new ProbeError(`${test.name}: execution deadline exceeded`) })])
      phase = `${test.name}:assertions`
      const text = await output
      const stderr = await errors
      check(!/installing|bun install|npm install/i.test(stderr), `${test.name}: unexpected dependency installation`)
      check(code === 0, `${test.name}: process failed`)
      let exists = false
      try { await access(path.join(dirs.project!, 'sentinel')); exists = true } catch {}
      check(toolRequests === 2 && observedToolResult, `${test.name}: expected one tool call and subsequent model completion; requests=${requests}`)
      if (!test.allowed) check(/permission|rule.*deny|denied/i.test(toolResultText), `${test.name}: missing explicit permission denial`)
      check(exists === test.allowed, `${test.name}: incorrect sentinel side effect`)
      if (exists) check(await readFile(path.join(dirs.project!, 'sentinel'), 'utf8') === 'permission-engine-fixture', 'Sentinel content mismatch')
      check(text.includes('step_finish'), `${test.name}: missing completion event`)
      evidence.push({ case: test.name, rules: test.rules, sentinelExists: exists, requests, observedToolResult })
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await Promise.race([child.exited, Bun.sleep(1000)])
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await Promise.race([child.exited, Bun.sleep(1500)])
        check(child.exitCode !== null || child.signalCode !== null, 'Child teardown deadline exceeded')
      }
      await fixture?.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  }
  console.log(JSON.stringify({ status: 'passed', binary: { version, reportedVersion, sha256: sha }, evidence,
    limitations: ['Local scripted model only; not curated/ZAI provider inference or launch E2E.', 'Host system settings are not isolated; use a disposable runner for full isolation.'] }, null, 2))
}
if (import.meta.main) main().then(() => process.exit(0), error => { console.error(JSON.stringify({ status: 'failed', phase, reason: error instanceof ProbeError ? error.message : 'Probe operation failed; raw diagnostics withheld' })); process.exit(1) })
