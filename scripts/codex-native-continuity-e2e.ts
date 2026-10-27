#!/usr/bin/env bun
/**
 * Real source-runtime/native-CLI continuity test against a deterministic local
 * Responses server. Requires installed runtime dependencies and Codex 0.135.0.
 *
 * bun scripts/codex-native-continuity-e2e.ts --codex /path/to/codex
 *   [--evidence-file /path/to/fixture-evidence.json]
 *
 * Exercises print -> QueryEngine -> native runner, actual host --resume, and
 * ordinary inbox prompt composition -> REPL native bridge. It does not launch
 * Electron, mount the React inbox poller, or claim live-model recall. All model
 * requests go to this loopback fixture; assertions inspect their actual input.
 * Run on a clean Linux CI worker. Managed system configuration is not bypassed.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'

const REPO = path.resolve(import.meta.dir, '..')
const TURN_TIMEOUT_MS = 90_000
const EXPECTED_VERSION = '0.135.0'
const OWNED_MARKER = '.continuity-e2e-owned'
const SETTINGS = { codex: { forced_login_method: 'api' } }

function requireThat(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function isolatedEnv(fixtureRoot: string): NodeJS.ProcessEnv {
  // Do not inherit API keys, proxy credentials, provider selection, hooks, or
  // user settings. System-managed native configuration remains authoritative.
  return {
    PATH: process.env.PATH,
    LANG: 'C.UTF-8',
    HOME: path.join(fixtureRoot, 'home'),
    TMPDIR: process.env.TMPDIR,
    NODE_ENV: 'development',
    CLAUDE_CODE_SIMPLE: '1',
    CLAUDE_CONFIG_DIR: path.join(fixtureRoot, 'claude'),
    CODEX_HOME: path.join(fixtureRoot, 'codex'),
    CODEX_SQLITE_HOME: path.join(fixtureRoot, 'codex'),
    CODEX_API_KEY: 'TEST-local-continuity-fixture-only',
    CLAUDE_CODE_ENTRY_PROVIDER: 'codex',
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
    CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD: 'api',
    CLAUDE_CODE_CODEX_NATIVE_IGNORE_USER_CONFIG: '1',
    CLAUDE_CODE_CODEX_NATIVE_DIRECT_IDLE_TIMEOUT_MS: '30000',
    CLAUDE_CODE_CODEX_NATIVE_DIRECT_ABSOLUTE_TIMEOUT_MS: '60000',
    CLAUDE_CODE_CODEX_NATIVE_MAILBOX_IDLE_TIMEOUT_MS: '30000',
    CLAUDE_CODE_CODEX_NATIVE_MAILBOX_ABSOLUTE_TIMEOUT_MS: '60000',
    CLAUDE_CODE_CODEX_NATIVE_TRACE_WRITE_ENABLED: '0',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    RUST_LOG: 'error',
  }
}

type CapturedRequest = Record<string, unknown>

function responsesFixture() {
  let requests: CapturedRequest[] = []
  let replies: string[] = []
  let errors: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0, maxRequestBodySize: 4 * 1024 * 1024,
    async fetch(request) {
      try {
        requireThat(request.method === 'POST' && new URL(request.url).pathname === '/v1/responses', 'Unexpected fixture endpoint')
        let bytes = new Uint8Array(await request.arrayBuffer())
        if (request.headers.get('content-encoding') === 'gzip') bytes = Bun.gunzipSync(bytes)
        requireThat(bytes.length > 0 && bytes.length <= 4 * 1024 * 1024, 'Unexpected model request size')
        const body = JSON.parse(new TextDecoder().decode(bytes)) as CapturedRequest
        requireThat(Array.isArray(body.input) && body.stream === true, 'Expected streaming Responses input')
        const answer = replies.shift()
        requireThat(answer !== undefined, 'Unplanned/repeated native model submission')
        requests.push(body)
        const number = requests.length
        const item = {
          type: 'message', id: `msg_continuity_${number}`, role: 'assistant',
          status: 'completed', phase: 'final_answer',
          content: [{ type: 'output_text', text: answer, annotations: [] }],
        }
        const response = {
          id: `resp_continuity_${number}`, object: 'response', status: 'completed',
          model: 'gpt-5.4', output: [item],
          usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25,
            input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
        }
        const events = [
          { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
          { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
          { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: answer },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response },
        ]
        return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
          headers: { 'Content-Type': 'text/event-stream' },
        })
      } catch (error) {
        errors.push(String(error))
        return new Response('Continuity fixture rejected request', { status: 400 })
      }
    },
  })
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    prepare(nextReplies: string[]) { requests = []; errors = []; replies = [...nextReplies] },
    finish(expected: number) {
      requireThat(errors.length === 0, `Fixture protocol errors: ${errors.join('; ')}`)
      requireThat(requests.length === expected && replies.length === 0, `Expected ${expected} model submissions, received ${requests.length}`)
      return [...requests]
    },
    close() { server.stop(true) },
  }
}

const children = new Set<ManagedChild>()

class ManagedChild {
  child: ChildProcessWithoutNullStreams
  stderr = ''
  private failure: Error | undefined
  private results: Record<string, unknown>[] = []
  private wake: (() => void) | undefined
  private closed = false
  private exitCode: number | null = null
  private exitPromise: Promise<void>
  private nativeLaunches: string
  private ownerMarker: string

  constructor(args: string[], cwd: string, env: NodeJS.ProcessEnv, nativeLaunches: string) {
    this.nativeLaunches = nativeLaunches
    this.ownerMarker = `TEST_CODEX_CONTINUITY_OWNER=${env.TEST_CODEX_CONTINUITY_OWNER}\0`
    this.child = spawn(process.execPath, args, { cwd, env, stdio: 'pipe', detached: true })
    children.add(this)
    this.child.stderr.on('data', data => { this.stderr = (this.stderr + data.toString()).slice(-32_768) })
    const lines = createInterface({ input: this.child.stdout })
    let outputBytes = 0
    lines.on('line', line => {
      if (!line.trim()) return
      outputBytes += line.length
      try {
        requireThat(outputBytes <= 4 * 1024 * 1024, 'Child output budget exceeded')
        const message = JSON.parse(line) as Record<string, unknown>
        if (message.type === 'result') this.results.push(message)
        if (message.type === 'control_request') throw new Error('Unexpected tool/approval request in text-only fixture')
      } catch (error) {
        this.failure = new Error(`Unexpected source child output: ${String(error)}; ${line.slice(0, 500)}`)
      }
      this.wake?.()
    })
    this.child.on('error', error => { this.failure = error; this.wake?.() })
    this.child.stdin.on('error', error => { this.failure = error; this.wake?.() })
    this.exitPromise = new Promise(resolve => {
      this.child.on('close', code => {
        this.closed = true; this.exitCode = code; this.wake?.(); resolve()
      })
    })
  }

  async result(expected: string): Promise<void> {
    const deadline = Date.now() + TURN_TIMEOUT_MS
    while (!this.results.length) {
      if (this.failure || this.closed) throw this.error('Child ended before a turn result')
      requireThat(Date.now() < deadline, this.error('Timed out waiting for native turn').message)
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { this.wake = undefined; resolve() }, Math.min(1000, deadline - Date.now()))
        this.wake = () => { clearTimeout(timer); this.wake = undefined; resolve() }
      })
    }
    if (this.failure) throw this.error('Invalid source child output')
    const result = this.results.shift()!
    requireThat(result.subtype === 'success' && result.is_error !== true && result.result === expected,
      this.error(`Unexpected turn result: ${JSON.stringify(result)}`).message)
  }

  async send(prompt: string, sessionId: string, expected: string): Promise<void> {
    this.child.stdin.write(JSON.stringify({ type: 'user', session_id: sessionId,
      uuid: randomUUID(), parent_tool_use_id: null, message: { role: 'user', content: prompt } }) + '\n')
    // Never queue multiple inputs before observing the previous SDK result.
    await this.result(expected)
  }

  private error(message: string): Error {
    return new Error(`${message}${this.failure ? `; ${this.failure.message}` : ''}\n${this.stderr}`)
  }

  async finish(): Promise<void> {
    this.child.stdin.end()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([this.exitPromise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(this.error('Child did not shut down')), 15_000)
      })])
    } finally {
      clearTimeout(timer)
    }
    requireThat(this.exitCode === 0 && !this.failure, this.error(`Child exited ${this.exitCode}`).message)
    requireThat(this.results.length === 0, 'Unexpected extra turn result')
    children.delete(this)
  }

  async terminate(): Promise<void> {
    if (this.child.pid) {
      try { process.kill(-this.child.pid, 'SIGKILL') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
      await this.exitPromise
    }
    // Native runners create separate process groups. Only kill recorded groups
    // whose current process still carries this fixture's unique ownership token;
    // an exited/reused PID must not authorize terminating another process.
    const launches = await readFile(this.nativeLaunches, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw error
    })
    for (const line of launches.trim().split('\n')) {
      const [verb, rawPid] = line.split(' ')
      if (verb !== 'exec' && verb !== 'app-server') continue
      const pid = Number(rawPid)
      requireThat(Number.isInteger(pid) && pid > 1, 'Invalid observed native PID')
      try {
        const environment = await readFile(`/proc/${pid}/environ`, 'utf8')
        if (environment.split('\0').some(value => `${value}\0` === this.ownerMarker)) process.kill(-pid, 'SIGKILL')
      } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      }
    }
    children.delete(this)
  }
}

type FixtureCase = Awaited<ReturnType<typeof createCase>>

async function createCase(root: string, name: string, binary: string, baseUrl: string) {
  const directory = path.join(root, name)
  const project = path.join(directory, 'project')
  const env = isolatedEnv(directory)
  for (const folder of [project, env.HOME!, env.CLAUDE_CONFIG_DIR!, env.CODEX_HOME!]) await mkdir(folder, { recursive: true })
  await writeFile(path.join(project, 'TEST-fixture.txt'), 'Disposable native continuity E2E project.\n')
  const nativeLaunches = path.join(directory, 'native-launches.log')
  const nativeProxy = path.join(directory, 'observe-native')
  // This observer execs the actual pinned binary without altering arguments or
  // protocol. Logging the verb proves exec/app-server selection independently.
  await writeFile(nativeProxy, `#!/bin/sh\nprintf '%s %s\\n' "$1" "$$" >> ${shellQuote(nativeLaunches)}\nexec ${shellQuote(binary)} "$@"\n`, { mode: 0o700 })
  await chmod(nativeProxy, 0o700)
  env.CODEX_CLI_PATH = nativeProxy
  await writeFile(path.join(env.CODEX_HOME!, 'config.toml'), [
    'model = "gpt-5.4"', 'model_provider = "continuity_fixture"',
    '[model_providers.continuity_fixture]', 'name = "Local Continuity Fixture"',
    `base_url = ${JSON.stringify(baseUrl)}`, 'wire_api = "responses"',
    'requires_openai_auth = false', 'supports_websockets = false',
    'request_max_retries = 0', 'stream_idle_timeout_ms = 10000', '',
  ].join('\n'), { mode: 0o600 })
  const id = randomUUID()
  env.TEST_CODEX_CONTINUITY_OWNER = id
  const sessionId = randomUUID()
  const memberName = name === 'teammate' ? 'nova' : name
  const context = `TEST_STARTUP_${name}_${id}`
  const privateProof = `TEST_PRIVATE_PROOF_${name}_${id}`
  const contextFile = path.join(directory, 'startup-context.json')
  await writeFile(contextFile, JSON.stringify({
    schemaVersion: 1, kind: 'native_app_managed_bootstrap', mode: 'startup_context_file',
    teamName: `TEST-continuity-${name}`, memberName,
    agentId: `${memberName}@TEST-continuity-${name}`, runId: id, provider: 'codex',
    contextText: context, contextHash: createHash('sha256').update(context).digest('hex'),
    briefingHash: `TEST-briefing-${id}`, generatedAt: new Date().toISOString(), bootstrapProofToken: privateProof,
  }), { mode: 0o600 })
  env.CLAUDE_CODE_NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_PATH = contextFile
  return { directory, project, env, nativeLaunches, id, sessionId, context, privateProof }
}

function cliArgs(test: FixtureCase, resume: boolean, manual: boolean): string[] {
  return [path.join(REPO, 'src/entrypoints/cli.tsx'), '--bare', '--print',
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--model', 'gpt-5.4', '--settings', JSON.stringify(SETTINGS), '--setting-sources', '',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '',
    ...(manual ? ['--permission-mode', 'default', '--permission-prompt-tool', 'stdio']
      : ['--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions']),
    ...(resume ? ['--resume', test.sessionId] : ['--session-id', test.sessionId]),
  ]
}

function inputText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(inputText).join('\n')
  if (value && typeof value === 'object') return Object.values(value).map(inputText).join('\n')
  return ''
}

function assertCount(request: CapturedRequest, marker: string, expected: number, label: string): void {
  const actual = inputText(request.input).split(marker).length - 1
  requireThat(actual === expected, `${label}: expected ${expected} copies of ${marker}, found ${actual}`)
}

function assertPublicContext(request: CapturedRequest, test: FixtureCase, label: string): void {
  assertCount(request, test.context, 1, label)
  for (const privateText of [test.privateProof, '<agent_teams_native_bootstrap_control>', '<agent_teams_native_app_managed_bootstrap_check>', 'Startup context loaded.']) {
    assertCount(request, privateText, 0, label)
  }
}

async function findTranscript(directory: string, sessionId: string): Promise<string> {
  const found: string[] = []
  async function visit(parent: string, depth: number): Promise<void> {
    requireThat(depth <= 8, 'Unexpected fixture transcript directory depth')
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      const file = path.join(parent, entry.name)
      if (entry.isDirectory()) await visit(file, depth + 1)
      else if (entry.isFile() && entry.name === `${sessionId}.jsonl`) found.push(file)
    }
  }
  await visit(directory, 0)
  requireThat(found.length === 1, `Expected one authoritative host transcript, found ${found.length}`)
  return found[0]!
}

async function assertNativeEvidence(test: FixtureCase, transports: string[], policies: string[]) {
  const actualTransports = (await readFile(test.nativeLaunches, 'utf8')).trim().split('\n').map(line => line.split(' ')[0]).filter(verb => verb !== '--version')
  requireThat(JSON.stringify(actualTransports) === JSON.stringify(transports), `Unexpected native transports: ${actualTransports}`)
  const transcriptPath = await findTranscript(path.join(test.env.CLAUDE_CONFIG_DIR!, 'projects'), test.sessionId)
  const rows = (await readFile(transcriptPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
  const summaries = [...new Map(rows.filter(row => row.subtype === 'codex_native_execution_summary').map(row => [row.uuid, row])).values()]
  requireThat(summaries.length === policies.length, `Expected ${policies.length} persisted native summaries, found ${summaries.length}`)
  requireThat(JSON.stringify(summaries.map(row => row.codexNativeCompletionPolicy)) === JSON.stringify(policies), 'Native persistent/ephemeral policy did not match delivery scope')
  const directIds = new Set(summaries.filter(row => row.codexNativeCompletionPolicy === 'persistent').map(row => row.codexNativeThreadId))
  requireThat(directIds.size === 1 && typeof [...directIds][0] === 'string', 'Direct conversation changed native thread identity')
  const directId = [...directIds][0]
  const ephemeralIds = summaries.filter(row => row.codexNativeCompletionPolicy === 'ephemeral').map(row => row.codexNativeThreadId)
  requireThat(ephemeralIds.every(id => typeof id === 'string' && id !== directId) && new Set(ephemeralIds).size === ephemeralIds.length, 'Bootstrap/group used the direct thread or reused each other')
  requireThat(rows.filter(row => row.type === 'codex-conversation-owner').length === 1, 'Host transcript should have exactly one native owner reference')
  return { transports: actualTransports, policies, directThreadId: directId, ephemeralThreadIds: ephemeralIds }
}

async function runLead(test: FixtureCase, fixture: ReturnType<typeof responsesFixture>) {
  const url = `https://example.invalid/${test.id}/lead-reference`
  const prompts = [`LEAD_USER_A_${test.id}: remember ${url}`, `LEAD_USER_B_${test.id}: recall the earlier reference`, `LEAD_USER_C_${test.id}: continue after host restart`]
  const answers = ['A', 'B', 'C'].map(letter => `LEAD_ASSISTANT_${letter}_${test.id}`)
  fixture.prepare(answers)
  const first = new ManagedChild(cliArgs(test, false, false), test.project, test.env, test.nativeLaunches)
  await first.send(prompts[0]!, test.sessionId, answers[0]!)
  await first.send(prompts[1]!, test.sessionId, answers[1]!)
  await first.finish()
  const resumed = new ManagedChild(cliArgs(test, true, true), test.project, test.env, test.nativeLaunches)
  await resumed.send(prompts[2]!, test.sessionId, answers[2]!)
  await resumed.finish()
  const requests = fixture.finish(3)
  for (let turn = 0; turn < requests.length; turn++) {
    const label = `lead request ${turn + 1}`
    assertPublicContext(requests[turn]!, test, label)
    assertCount(requests[turn]!, url, 1, label)
    for (let previous = 0; previous <= turn; previous++) assertCount(requests[turn]!, prompts[previous]!, 1, label)
    for (let previous = 0; previous < turn; previous++) assertCount(requests[turn]!, answers[previous]!, 1, label)
  }
  return { requests, native: await assertNativeEvidence(test, ['exec', 'exec', 'app-server'], ['persistent', 'persistent', 'persistent']) }
}

async function runTeammate(test: FixtureCase, fixture: ReturnType<typeof responsesFixture>) {
  const url = `https://example.invalid/${test.id}/teammate-reference`
  const directPrompts = [`DIRECT_USER_A_${test.id}: remember ${url}`, `DIRECT_USER_B_${test.id}: recall the earlier reference`, `DIRECT_USER_C_${test.id}: continue after host restart`]
  const directAnswers = ['A', 'B', 'C'].map(letter => `DIRECT_ASSISTANT_${letter}_${test.id}`)
  const groupPrompt = `GROUP_USER_${test.id}`
  const groupAnswer = `GROUP_ASSISTANT_${test.id}`
  const bootstrapAnswer = `Startup context loaded.\nBOOTSTRAP_ASSISTANT_${test.id}`
  const turns = [
    { scope: 'bootstrap', text: '', expected: bootstrapAnswer },
    { scope: 'direct', text: directPrompts[0], expected: directAnswers[0] },
    { scope: 'group', text: groupPrompt, expected: groupAnswer },
    { scope: 'direct', text: directPrompts[1], expected: directAnswers[1] },
    { scope: 'direct', text: directPrompts[2], expected: directAnswers[2] },
  ]
  fixture.prepare(turns.map(turn => turn.expected!))
  for (const [stage, stageTurns] of [[0, turns.slice(0, 4)], [1, turns.slice(4)]] as const) {
    const specPath = path.join(test.directory, `teammate-${stage}.json`)
    await writeFile(specPath, JSON.stringify({ project: test.project, sessionId: test.sessionId,
      teamName: 'TEST-continuity-teammate', memberName: 'nova', resume: stage === 1,
      manual: stage === 1, turns: stageTurns }), { mode: 0o600 })
    const child = new ManagedChild([path.join(REPO, 'scripts/fixtures/codex-native-continuity-child.ts'), specPath], test.project, test.env, test.nativeLaunches)
    for (const turn of stageTurns) await child.result(turn.expected!)
    await child.finish()
  }
  const requests = fixture.finish(5)
  assertCount(requests[0]!, '<agent_teams_native_app_managed_bootstrap_check>', 1, 'private bootstrap')
  assertCount(requests[0]!, test.context, 1, 'private bootstrap')
  assertCount(requests[0]!, test.privateProof, 0, 'private bootstrap')
  for (const [index, directTurn] of [[1, 0], [3, 1], [4, 2]] as const) {
    const request = requests[index]!
    const label = `teammate direct request ${directTurn + 1}`
    assertPublicContext(request, test, label)
    assertCount(request, url, 1, label)
    for (let previous = 0; previous <= directTurn; previous++) assertCount(request, directPrompts[previous]!, 1, label)
    for (let previous = 0; previous < directTurn; previous++) assertCount(request, directAnswers[previous]!, 1, label)
    for (const isolated of [groupPrompt, groupAnswer, bootstrapAnswer]) assertCount(request, isolated, 0, label)
  }
  assertPublicContext(requests[2]!, test, 'group request')
  assertCount(requests[2]!, groupPrompt, 1, 'group request')
  for (const isolated of [url, ...directPrompts, ...directAnswers, bootstrapAnswer]) assertCount(requests[2]!, isolated, 0, 'group request')
  return { requests, native: await assertNativeEvidence(test,
    ['exec', 'exec', 'exec', 'exec', 'app-server'], ['ephemeral', 'persistent', 'ephemeral', 'persistent', 'persistent']) }
}

let root: string | undefined
let fixture: ReturnType<typeof responsesFixture> | undefined
const ownership = randomUUID()
try {
  requireThat(process.platform === 'linux', 'Run this source-runtime E2E on a clean Linux CI worker')
  const args = process.argv.slice(2)
  requireThat(args.length === 2 || args.length === 4, 'Usage: bun scripts/codex-native-continuity-e2e.ts --codex PATH [--evidence-file PATH]')
  requireThat(args[0] === '--codex' && (args.length === 2 || args[2] === '--evidence-file'), 'Unexpected E2E arguments')
  const binary = await realpath(args[1]!)
  root = await mkdtemp(path.join(tmpdir(), 'TEST-codex-native-continuity-e2e-'))
  await writeFile(path.join(root, OWNED_MARKER), ownership, { mode: 0o600, flag: 'wx' })
  const version = Bun.spawnSync([binary, '--version'], { env: isolatedEnv(root), timeout: 10_000 })
  requireThat(version.exitCode === 0 && version.stdout.toString().trim() === `codex-cli ${EXPECTED_VERSION}`, `This gate requires codex-cli ${EXPECTED_VERSION}`)
  fixture = responsesFixture()
  const lead = await runLead(await createCase(root, 'lead', binary, fixture.baseUrl), fixture)
  const teammate = await runTeammate(await createCase(root, 'teammate', binary, fixture.baseUrl), fixture)
  if (args[3]) await writeFile(path.resolve(args[3]), JSON.stringify({ version: EXPECTED_VERSION, lead, teammate }, null, 2) + '\n')
  console.log(JSON.stringify({ ok: true, nativeVersion: EXPECTED_VERSION,
    coverage: 'source headless QueryEngine + full resume; inbox composition + REPL bridge; real native runners; local Responses input',
    lead: { requestCount: lead.requests.length, ...lead.native }, teammate: { requestCount: teammate.requests.length, ...teammate.native } }, null, 2))
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
} finally {
  await Promise.all([...children].map(child => child.terminate()))
  fixture?.close()
  if (root) {
    const stat = await lstat(root)
    requireThat(stat.isDirectory() && !stat.isSymbolicLink() && await readFile(path.join(root, OWNED_MARKER), 'utf8') === ownership, 'Refusing cleanup of an unowned fixture directory')
    await rm(root, { recursive: true, force: false })
  }
}
