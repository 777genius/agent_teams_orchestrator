import { describe, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRuntimeTranscriptCommand, runRuntimeTranscriptCommand } from './runtimeTranscriptCommand.js'
import * as command from './handlers/runtimeOpenCodeCommand.js'
import * as runtime from './handlers/runtime.js'

const args = ['--json', '--provider', 'opencode', '--team', 'TEST-team', '--member', 'TEST-worker',
  '--lane', 'TEST-lane', '--session-id', 'ses_TESTmissing', '--run-id', 'TEST-run', '--projection-only', '--limit', '200']

describe('lean runtime transcript command', () => {
  test('parses the existing transcript flags and preserves exact original binding', async () => {
    let received: unknown
    await createRuntimeTranscriptCommand(async value => { received = value }).parseAsync(args, { from: 'user' })
    expect(received).toEqual({ json: true, provider: 'opencode', team: 'TEST-team', member: 'TEST-worker',
      lane: 'TEST-lane', sessionId: 'ses_TESTmissing', runId: 'TEST-run', projectionOnly: true, limit: 200 })
  })
  for (const fail of [false, true]) test(`owns keepalive until the awaited read settles (${fail ? 'refusal' : 'completed unit read'})`, async () => {
    const events: string[] = [], refusal = new Error('TEST read refusal')
    const keepAlive = spyOn(command, 'startRuntimeCommandKeepAlive').mockImplementation(() => {
      events.push('start'); return () => { events.push('clear') }
    })
    const read = spyOn(runtime, 'runtimeTranscript').mockImplementation(async (_opts, deps) => {
      events.push('read'); expect(deps?.exit).toBeFunction()
      expect(deps?.exit?.(0)).toBeUndefined()
      if (fail) throw refusal
    })
    try {
      if (fail) await expect(runRuntimeTranscriptCommand(args)).rejects.toBe(refusal)
      else await runRuntimeTranscriptCommand(args)
      expect(events).toEqual(['start', 'read', 'clear'])
    } finally { read.mockRestore(); keepAlive.mockRestore() }
  })
})

// These are real CLI subprocess refusals, with no fabricated native owner,
// qualification or model input. Windows also covers invalid binding before any
// native admission; missing-owner discovery itself is Unix-only here.
for (const kind of (process.platform === 'win32' ? ['invalid-binding', 'missing-legacy'] : ['missing-owner', 'invalid-binding', 'missing-legacy'])) test(`actual source entry exits with a closed ${kind} refusal without main/init`, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-runtime-transcript-cli-')))
  const project = path.join(root, 'TEST-project'), facts = path.join(root, 'facts.json'), output = path.join(root, 'transcript.json')
  const source = path.resolve(import.meta.dir, '..'), entry = path.join(source, 'entrypoints', 'cli.tsx')
  await Promise.all(['TEST-project', 'home', 'config', 'data', 'cache', 'tmp'].map(name => mkdir(path.join(root, name), { mode: 0o700 })))
  const preload = path.join(root, 'TEST-read-refusals.ts')
  await writeFile(preload, `import { writeFileSync } from 'node:fs'
import { mock, spyOn } from 'bun:test'
const counters: Record<string,number> = {}
const retain = (name:string) => { counters[name]=(counters[name]??0)+1;writeFileSync(${JSON.stringify(facts)},JSON.stringify({counters,cwd:process.cwd()}),{mode:0o600}) }
globalThis.fetch = async () => {retain('network');throw Error('TEST network forbidden')}
mock.module(${JSON.stringify(path.join(source, 'main.tsx'))},()=>({main:async()=>{retain('main');throw Error('TEST full main forbidden')}}))
const { openCodeSessionStore } = await import(${JSON.stringify(path.join(source, 'services/opencode/OpenCodeSessionStore.ts'))})
const originalGet = openCodeSessionStore.get.bind(openCodeSessionStore)
spyOn(openCodeSessionStore,'get').mockImplementation(async (...input: Parameters<typeof originalGet>) => {
 retain('legacy_read_started'); const value=await originalGet(...input)
 await new Promise<void>(resolve=>{const timer=setTimeout(resolve,30);timer.unref()})
 retain('legacy_read_completed');return value
})
for(const [file,key,method] of [
 [${JSON.stringify(path.join(source, 'services/opencode/OpenCodeHostManager.ts'))},'openCodeHostManager','ensureHost'],
 [${JSON.stringify(path.join(source, 'services/opencode/OpenCodeProfileManager.ts'))},'openCodeProfileManager','prepareProfile'],
] as const){const module=await import(file);spyOn(module[key],method).mockImplementation(async()=>{retain(method);throw Error('TEST forbidden runtime effect')})}
for(const [file,method] of [
 [${JSON.stringify(path.join(source, 'services/opencode/bridge/OpenCodeRuntimeAdapterFactory.ts'))},'inspectOpenCodeRuntimeAdapterSelection'],
 [${JSON.stringify(path.join(source, 'services/opencode/bridge/OpenCodeV2LaunchPlan.ts'))},'inspectOpenCodeV2SourceAvailability'],
 [${JSON.stringify(path.join(source, 'services/opencode/bridge/OpenCodeV2ExecutionProbe.ts'))},'resolveOpenCodeV2ExecutionProbe'],
] as const){const module=await import(file);spyOn(module,method).mockImplementation(async()=>{retain(method);throw Error('TEST forbidden runtime effect')})}
retain('preload_ready')
`, { mode: 0o600 })
  const env = { PATH: process.env.PATH ?? '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), CLAUDE_CONFIG_DIR: path.join(root, 'config'),
    CLAUDE_MULTIMODEL_DATA_HOME: path.join(root, 'data'), CLAUDE_MULTIMODEL_CACHE_HOME: path.join(root, 'cache'),
    TMPDIR: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), TEMP: path.join(root, 'tmp'), NODE_ENV: 'development' }
  const omitted = kind === 'invalid-binding' ? '--lane' : kind === 'missing-legacy' ? '--run-id' : null
  const selected = omitted ? args.filter((_, i) => i !== args.indexOf(omitted) && i !== args.indexOf(omitted) + 1) : args
  const child = Bun.spawn([process.execPath, '--preload', preload, entry, 'runtime', 'transcript', ...selected, '--output', output],
    { cwd: project, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  // A cold Windows runner scanning the fresh clone takes far longer than a
  // warm local spawn; only a genuinely hung child may be killed here.
  const timeout = setTimeout(() => { child.kill() }, 30_000)
  try {
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(exit).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain(kind === 'missing-owner' ? 'v2_transcript_original_owner_unavailable'
      : kind === 'missing-legacy' ? 'No stored OpenCode session record' : 'v2_transcript_identity_invalid')
    const saved = JSON.parse(await readFile(facts, 'utf8'))
    expect(saved.cwd).toBe(project)
    expect(saved.counters).toEqual(kind !== 'invalid-binding'
      ? { preload_ready: 1, legacy_read_started: 1, legacy_read_completed: 1 }
      : { preload_ready: 1 })
    expect(await readdir(path.join(root, 'data'))).toEqual([])
    expect(await readFile(output, 'utf8').catch(() => null)).toBeNull()
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null) { child.kill(); await child.exited }
    await rm(root, { recursive: true, force: true })
  }
}, 45_000)
