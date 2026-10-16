import { runInNewContext } from 'node:vm'
import { test, expect, spyOn } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm, lstat } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import * as privateDirectories from '../profile/OpenCodePrivateDirectories.js'
import { recordOpenCodeV2ProviderFailure, retainOpenCodeV2CleanupPhase, retainOpenCodeV2InitializationPhase, type RunInitializationPhase } from './OpenCodeV2Diagnostics.js'

test('startup failures preserve finite original error facts and local Windows guard stages', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'TEST-v2-original-startup-failure-'))
  const previous = process.env.CLAUDE_MULTIMODEL_DATA_HOME
  process.env.CLAUDE_MULTIMODEL_DATA_HOME = root
  const secret = 'TEST-PRIVATE-ERROR-PAYLOAD'
  const original = Object.assign(new TypeError(secret), { code: 'EACCES', syscall: 'open', path: secret })
  const descriptors = Object.getOwnPropertyDescriptors(original)
  try {
    await recordOpenCodeV2ProviderFailure('execution-host-startup', new Error('cleanup_unknown', { cause: original }), true)
    for (const stage of ['assert_mapping', 'assert_stopped', 'assert_broker'])
      await recordOpenCodeV2ProviderFailure('execution-host-startup', new Error(`execution_containment_unqualified:${stage}:0`), true)
    await recordOpenCodeV2ProviderFailure('execution-host-startup', new Error('execution_host_unavailable'), true)
    await recordOpenCodeV2ProviderFailure('execution-host-startup', new Error('execution_owner_record_invalid'), true)
    await recordOpenCodeV2ProviderFailure('execution-host-startup', Object.assign(new Error(secret), {
      name: secret, code: secret, syscall: secret,
    }), true)
    const rows = await Promise.all((await readdir(path.join(root, 'opencode/v2/provider-diagnostics'))).map(async name => {
      const bytes = await readFile(path.join(root, 'opencode/v2/provider-diagnostics', name), 'utf8')
      expect(bytes).not.toContain(secret)
      return JSON.parse(bytes)
    }))
    expect(Object.getOwnPropertyDescriptors(original)).toEqual(descriptors)
    expect(rows).toHaveLength(7)
    expect(rows.find(row => row.category === 'cleanup_unknown').failure).toEqual({ name: 'TypeError', errno: 'EACCES', operation: 'open' })
    expect(rows.filter(row => row.category === 'execution_containment_unqualified').map(row => row.native))
      .toEqual(expect.arrayContaining(['assert_mapping', 'assert_stopped', 'assert_broker'].map(stage => ({ stage, nativeCode: 0 }))))
    expect(rows.find(row => row.category === 'execution_host_unavailable').failure).toEqual({ name: 'Error' })
    expect(rows.find(row => row.category === 'execution_owner_record_invalid').failure).toEqual({ name: 'Error' })
    expect(rows.find(row => row.category === 'provider_operation_unknown').failure).toBeUndefined()
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_DATA_HOME
    else process.env.CLAUDE_MULTIMODEL_DATA_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('startup diagnostics retain only finite native fields and reject payload-bearing or invalid frames', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'TEST-v2-startup-diagnostics-'))
  const previous = process.env.CLAUDE_MULTIMODEL_DATA_HOME
  process.env.CLAUDE_MULTIMODEL_DATA_HOME = root
  const secret = 'TEST-PRIVATE-PAYLOAD'
  const valid = { event: 'opencode-v2-startup', reason: 'timeout', stage: 'graph-validation', elapsedMs: 30_123 }
  const history = [{ stage: 'waiting-for-prepare', elapsedMs: 0 },
    { stage: 'graph-validation', elapsedMs: 1200 }]
  const historical = { ...valid, history }
  const windowsHistory = ['windows-cohort', 'windows-profile', 'windows-roots', 'windows-dll',
    'windows-process', 'windows-owned-pair', 'windows-published', 'windows-connected',
    'windows-prepare', 'windows-assert'].map((stage, elapsedMs) => ({ stage, elapsedMs }))
  const windowsFrame = { event: 'opencode-v2-startup', reason: 'failed', stage: 'windows-assert',
    elapsedMs: 10, history: windowsHistory }
  const invalidHistory = [[], Array(11).fill(history[0]),
    [{ ...history[0], body: secret }], [{ stage: secret, elapsedMs: 0 }],
    [{ stage: ['graph-validation'], elapsedMs: 0 }], [{ stage: 'graph-validation', elapsedMs: -1 }],
    [{ stage: 'graph-validation', elapsedMs: 0.5 }], [{ stage: 'graph-validation', elapsedMs: 30_124 }],
    [{ stage: 'graph-validation', elapsedMs: Number.MAX_SAFE_INTEGER + 1 }],
    [{ stage: 'profile-validation', elapsedMs: 1200 }, { stage: 'graph-validation', elapsedMs: 1199 }],
    [{ stage: 'graph-validation', elapsedMs: 0 }, { stage: 'graph-validation', elapsedMs: 1 }],
    [{ stage: 'runtime-import', elapsedMs: 1 }]]
  const graph = { phase: 'hash', completed: 16, total: 100 }
  const closure = { phase: 'closure', completed: 100, total: 100 }
  const invalidGraph = [null, [graph], { ...graph, phase: secret }, { ...graph, phase: ['hash'] },
    { ...graph, path: secret }, { ...graph, completed: -1 }, { ...graph, completed: 0.5 },
    { ...graph, completed: 101 }, { ...graph, total: 0 }, { ...graph, total: 65_537 },
    { ...graph, completed: Number.MAX_SAFE_INTEGER + 1 }, { ...closure, completed: 99 }]
  const frames = [valid, historical, windowsFrame, { ...windowsFrame, nativeExitCode: 1, nativeStderrKind: 'module_resolution' },
    { ...windowsFrame, nativeStderrKind: secret }, { ...windowsFrame, nativeStderrKind: ['empty'] }, { ...windowsFrame, nativeExitCode: 0xc0000135 },
    { ...windowsFrame, nativeExitCode: secret }, { ...windowsFrame, nativeExitCode: -1 }, { ...valid, graph }, { ...historical, graph: closure },
    ...invalidGraph.map(graph => ({ ...historical, graph })), ...invalidHistory.map(history => ({ ...valid, history })),
    { ...historical, body: secret },
    { ...valid, body: secret }, { ...valid, stage: secret },
      { ...valid, elapsedMs: -1 }, { ...valid, reason: secret }, { ...valid, reason: ['timeout'] }]
  const acquisition = { elapsedMs: 90_123, history: [{ phase: 'preparing', elapsedMs: 0 },
    { phase: 'graph-validated', elapsedMs: 40_000 }, { phase: 'child-bound', elapsedMs: 52_000 }] }
  const invalidAcquisition = [null, [acquisition], { ...acquisition, body: secret },
    { ...acquisition, elapsedMs: -1 }, { ...acquisition, elapsedMs: 86_400_001 },
    { ...acquisition, elapsedMs: 1.5 }, { ...acquisition, history: [] },
    { ...acquisition, history: Array(16).fill(acquisition.history[0]) },
    ...[{ phase: secret, elapsedMs: 1 }, { phase: ['child-bound'], elapsedMs: 1 },
      { phase: 'mapping', elapsedMs: 1, path: secret }, { phase: 'mapping', elapsedMs: -1 },
      { phase: 'mapping', elapsedMs: 0.5 }, { phase: 'mapping', elapsedMs: 90_124 },
      { phase: 'mapping', elapsedMs: Number.MAX_SAFE_INTEGER + 1 }].map(entry =>
      ({ ...acquisition, history: [acquisition.history[0], entry] })),
    { ...acquisition, history: [{ phase: 'mapping', elapsedMs: 0 }] },
    { ...acquisition, history: [{ phase: 'preparing', elapsedMs: 1 }] },
    { ...acquisition, history: [acquisition.history[0], { phase: 'child-bound', elapsedMs: 3 },
      { phase: 'mapping', elapsedMs: 2 }] },
    { ...acquisition, history: [acquisition.history[0], acquisition.history[0]] }]
  try {
    for (const timing of [acquisition, ...invalidAcquisition])
      await recordOpenCodeV2ProviderFailure('execution-host-startup', new Error(secret), true, undefined, timing)
    for (const frame of frames)
      await recordOpenCodeV2ProviderFailure('execution-host-startup', new Error('execution_host_unavailable'), true,
        secret + '\n' + JSON.stringify(frame) + '\n')
    const directory = path.join(root, 'opencode/v2/provider-diagnostics')
    const rows = await Promise.all((await readdir(directory)).map(async name => {
      const content = await readFile(path.join(directory, name), 'utf8')
      expect(content).not.toContain(secret)
      return JSON.parse(content)
    }))
    expect(rows).toHaveLength(frames.length + invalidAcquisition.length + 1)
    expect(rows.filter(row => row.acquisition).map(row => row.acquisition)).toEqual([acquisition])
    expect(rows.filter(row => row.startup).map(row => row.startup)).toEqual(expect.arrayContaining([
      { reason: 'timeout', stage: 'graph-validation', elapsedMs: 30_123 },
      { reason: 'timeout', stage: 'graph-validation', elapsedMs: 30_123, history },
      { reason: 'timeout', stage: 'graph-validation', elapsedMs: 30_123, graph },
      { reason: 'timeout', stage: 'graph-validation', elapsedMs: 30_123, history, graph: closure },
      { reason: 'failed', stage: 'windows-assert', elapsedMs: 10, history: windowsHistory },
      { reason: 'failed', stage: 'windows-assert', elapsedMs: 10, history: windowsHistory, nativeExitCode: 0xc0000135 },
      { reason: 'failed', stage: 'windows-assert', elapsedMs: 10, history: windowsHistory, nativeExitCode: 1, nativeStderrKind: 'module_resolution' },
    ]))
    expect(rows.filter(row => row.startup)).toHaveLength(7)
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_DATA_HOME
    else process.env.CLAUDE_MULTIMODEL_DATA_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})

// Parent cancellation can precede the child watchdog; only the finite close
// stage is evidence, never arbitrary trailing stderr or physical retirement.
test('late pre-ready close frame retains its finite stage while original cleanup stays unknown', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'TEST-v2-late-startup-diagnostics-'))
  const previous = process.env.CLAUDE_MULTIMODEL_DATA_HOME
  process.env.CLAUDE_MULTIMODEL_DATA_HOME = root
  const secret = 'TEST-PRIVATE-LATE-PAYLOAD'
  const startup = { reason: 'failed', stage: 'runtime-import', elapsedMs: 19_001,
    history: [{ stage: 'waiting-for-prepare', elapsedMs: 0 }, { stage: 'runtime-import', elapsedMs: 18_000 }] }
  try {
    await recordOpenCodeV2ProviderFailure('execution-host-startup', new Error('cleanup_unknown'), true,
      secret + '\n' + JSON.stringify({ event: 'opencode-v2-startup', ...startup }) + '\n' + secret)
    const directory = path.join(root, 'opencode/v2/provider-diagnostics')
    const names = await readdir(directory)
    expect(names).toHaveLength(1)
    const bytes = await readFile(path.join(directory, names[0]!), 'utf8')
    expect(bytes).not.toContain(secret)
    const row = JSON.parse(bytes)
    expect(row.startup).toEqual(startup)
    expect(row.category).toBe('cleanup_unknown')
    expect(row.retainedOriginal).toBe(true)
    expect(row.failure).toEqual({ name: 'Error' })
    expect(Object.keys(row).sort()).toEqual(['category', 'failure', 'phase', 'recordedAt', 'retainedOriginal', 'schemaVersion', 'startup'])
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_DATA_HOME
    else process.env.CLAUDE_MULTIMODEL_DATA_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('owner initialization diagnostics retain only trusted finite sideband without changing original errors', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'TEST-v2-owner-phase-'))
  const previous = process.env.CLAUDE_MULTIMODEL_DATA_HOME
  process.env.CLAUDE_MULTIMODEL_DATA_HOME = root
  const secret = 'TEST-PRIVATE-OWNER-PAYLOAD'
  try {
    for (const phase of ['MCP-connect', 'MCP-readback', 'controller-tools', 'probe-authority'] as const) {
      const cause = new Error(secret), error = new Error('invalid_response', { cause })
      const before = Object.getOwnPropertyDescriptors(error)
      retainOpenCodeV2InitializationPhase(error, phase, 90_001)
      retainOpenCodeV2InitializationPhase(error, 'probe-authority', 90_002)
      expect(Object.getOwnPropertyDescriptors(error)).toEqual(before)
      expect(error.cause).toBe(cause)
      await recordOpenCodeV2ProviderFailure('run-owner-initialization', error, true)
    }
    for (const [phase, elapsedMs] of [[secret, 1], [['MCP-connect'], 1], ['MCP-connect', -1],
      ['MCP-connect', 1.5], ['MCP-connect', 86_400_001], ['MCP-connect', NaN]] as const) {
      const error = new Error(secret)
      retainOpenCodeV2InitializationPhase(error, phase as RunInitializationPhase, elapsedMs)
      await recordOpenCodeV2ProviderFailure('run-owner-initialization', error, true)
    }
    const elsewhere = new Error('invalid_response')
    retainOpenCodeV2InitializationPhase(elsewhere, 'MCP-connect', 1)
    await recordOpenCodeV2ProviderFailure('other-phase', elsewhere, true)
    const rows = await Promise.all((await readdir(path.join(root, 'opencode/v2/provider-diagnostics'))).map(async name => {
      const bytes = await readFile(path.join(root, 'opencode/v2/provider-diagnostics', name), 'utf8')
      expect(bytes).not.toContain(secret)
      return JSON.parse(bytes)
    }))
    expect(rows.filter(row => row.initialization).map(row => row.initialization)).toEqual(expect.arrayContaining(
      ['MCP-connect', 'MCP-readback', 'controller-tools', 'probe-authority'].map(phase => ({ phase, elapsedMs: 90_001 }))))
    expect(rows.filter(row => row.initialization)).toHaveLength(4)
    expect(rows.filter(row => row.initialization).every(row => row.category === 'invalid_response' && row.retainedOriginal)).toBe(true)
    expect(rows.filter(row => !row.initialization)).toHaveLength(7)
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_DATA_HOME
    else process.env.CLAUDE_MULTIMODEL_DATA_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})

// These check branch ordering and refusal only. The real native directory
// custody and Windows file publication are qualified by the Windows source gate.
test('Windows diagnostics await native directory admission before exclusive publication', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'TEST-v2-windows-diagnostics-'))
  const previous = process.env.CLAUDE_MULTIMODEL_DATA_HOME
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const getuid = Object.getOwnPropertyDescriptor(process, 'getuid')
  const directory = path.join(root, 'opencode/v2/provider-diagnostics')
  let release!: () => void, entered!: () => void
  const admission = new Promise<void>(resolve => { release = resolve })
  const requested = new Promise<void>(resolve => { entered = resolve })
  const prepare = spyOn(privateDirectories, 'ensureWindowsPrivateDirectories').mockImplementation(async directories => {
    expect(directories).toEqual([directory])
    entered()
    await admission
    await mkdir(directory, { recursive: true, mode: 0o700 })
  })
  let pending: Promise<void> | undefined
  try {
    process.env.CLAUDE_MULTIMODEL_DATA_HOME = root
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    Object.defineProperty(process, 'getuid', { configurable: true, value: undefined })
    pending = recordOpenCodeV2ProviderFailure('run-owner-initialization', new Error('execution_host_unavailable'), true)
    await requested
    expect(await lstat(directory).catch((error: NodeJS.ErrnoException) => error.code)).toBe('ENOENT')
    release()
    await pending
    expect(prepare).toHaveBeenCalledTimes(1)
    const names = await readdir(directory)
    expect(names).toHaveLength(1)
    const row = JSON.parse(await readFile(path.join(directory, names[0]!), 'utf8'))
    expect(row.category).toBe('execution_host_unavailable')
    expect(row.retainedOriginal).toBe(true)
    expect(Object.keys(row).sort()).toEqual(['category', 'phase', 'recordedAt', 'retainedOriginal', 'schemaVersion'])
  } finally {
    release()
    await pending
    prepare.mockRestore()
    Object.defineProperty(process, 'platform', platform)
    if (getuid) Object.defineProperty(process, 'getuid', getuid)
    else delete (process as { getuid?: unknown }).getuid
    if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_DATA_HOME
    else process.env.CLAUDE_MULTIMODEL_DATA_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('Windows directory admission refusal emits nothing and cannot replace the original failure', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'TEST-v2-windows-diagnostics-refused-'))
  const previous = process.env.CLAUDE_MULTIMODEL_DATA_HOME
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const original = new Error('execution_host_unavailable')
  const before = Object.getOwnPropertyDescriptors(original)
  const prepare = spyOn(privateDirectories, 'ensureWindowsPrivateDirectories').mockRejectedValue(new Error('execution_owner_not_private'))
  try {
    process.env.CLAUDE_MULTIMODEL_DATA_HOME = root
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    await expect(recordOpenCodeV2ProviderFailure('run-owner-initialization', original, true)).resolves.toBeUndefined()
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(await readdir(root)).toEqual([])
    expect(Object.getOwnPropertyDescriptors(original)).toEqual(before)
  } finally {
    prepare.mockRestore()
    Object.defineProperty(process, 'platform', platform)
    if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_DATA_HOME
    else process.env.CLAUDE_MULTIMODEL_DATA_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('native diagnostics retain only closed producer codes and stages with uint32 status', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'TEST-v2-native-diagnostics-'))
  const previous = process.env.CLAUDE_MULTIMODEL_DATA_HOME
  const secret = 'TEST_PRIVATE_NATIVE_PAYLOAD'
  const cases: { error: Error; category: string; native?: { stage: string; nativeCode: number } }[] = [
    ...['retire_broker_state', 'retire_broker_write', 'retire_job', 'retire_wait', 'retire_io_join',
      'retire_main_exit', 'retire_owned_pair', 'retire_commands', 'retire_receipt', 'retire_grants',
      'retire_grants_dll', 'retire_grants_roots', 'retire_grants_metadata']
      .map(stage => ({ error: new Error('cleanup_unknown', { cause: new Error(`execution_native_unknown:${stage}:2147483659`) }),
        category: 'execution_native_unknown', native: { stage, nativeCode: 2147483659 } })),
    { error: new Error('cleanup_unknown', { cause: new Error('cleanup_unknown:retire_wait:0') }),
      category: 'cleanup_unknown', native: { stage: 'retire_wait', nativeCode: 0 } },
    ...['shared_acl_mutex_descriptor', 'shared_acl_mutex_create', 'shared_acl_mutex_security',
      'shared_acl_mutex_encoding', 'shared_acl_mutex_authority', 'shared_acl_mutex_wait', 'shared_acl_mutex']
      .map(stage => ({ error: new Error(`execution_containment_filesystem_denied:${stage}:5`),
        category: 'execution_containment_filesystem_denied', native: { stage, nativeCode: 5 } })),
    ...['ancestor_metadata_control', 'ancestor_metadata_foreign', 'ancestor_metadata_group', 'ancestor_metadata_member', 'ancestor_metadata_open', 'ancestor_metadata_owner', 'ancestor_metadata_ace', 'ancestor_metadata_descriptor', 'ancestor_metadata_security', 'ancestor_metadata_package', 'ancestor_metadata_read', 'ancestor_metadata_changed', 'ancestor_metadata_cleanup_unproven', 'ancestor_metadata_intent', 'ancestor_metadata_acl_size', 'ancestor_metadata_acl', 'ancestor_metadata_write', 'ancestor_metadata_identity', 'ancestor_metadata_pin']
      .map(stage => ({ error: new Error(`execution_containment_filesystem_denied:${stage}:5`),
        category: 'execution_containment_filesystem_denied', native: { stage, nativeCode: 5 } })),
    { error: new Error('execution_owner_unknown:owner_canonical_open:32'), category: 'execution_owner_unknown',
      native: { stage: 'owner_canonical_open', nativeCode: 32 } },
    { error: new Error('execution_owner_not_private:private_acl_owner:0'), category: 'execution_owner_not_private',
      native: { stage: 'private_acl_owner', nativeCode: 0 } },
    { error: new Error('execution_owner_not_private:private_dll_owner:0'), category: 'execution_owner_not_private',
      native: { stage: 'private_dll_owner', nativeCode: 0 } },
    { error: new Error('cleanup_unknown', { cause: new Error('execution_owner_not_private:private_owner_acquire:5') }),
      category: 'execution_owner_not_private', native: { stage: 'private_owner_acquire', nativeCode: 5 } },
    { error: new Error('cleanup_unknown', { cause: new Error('execution_identity_unknown') }),
      category: 'execution_identity_unknown' },
    { error: new Error('execution_owner_unknown:unknown_private_stage:5'), category: 'execution_owner_unknown' },
    { error: new Error('execution_native_timeout'), category: 'execution_native_timeout' },
    { error: new Error('execution_owner_unknown:owner_canonical_open:4294967295'), category: 'execution_owner_unknown',
      native: { stage: 'owner_canonical_open', nativeCode: 0xffffffff } },
    ...['execution_owner_unknown:owner_canonical_open:4294967296',
      'execution_owner_unknown:owner_canonical_open:-1', 'execution_owner_unknown:owner_canonical_open:1.5',
      'execution_owner_unknown:owner_canonical_open:00', `execution_owner_unknown:${secret}:5`,
      `${secret}:owner_canonical_open:5`, `execution_owner_unknown:owner_canonical_open:5:${secret}`]
      .map(message => ({ error: new Error(message), category: 'provider_operation_unknown' })),
    // Only the existing exact cleanup wrappers unwrap one cause, never arbitrary chains.
    { error: new Error('unrelated', { cause: new Error('execution_owner_unknown:owner_canonical_open:32') }),
      category: 'provider_operation_unknown' },
    { error: new Error('cleanup_unknown', { cause: new Error('cleanup_unknown', {
      cause: new Error('execution_owner_unknown:owner_canonical_open:32') }) }), category: 'cleanup_unknown' },
  ]
  try {
    process.env.CLAUDE_MULTIMODEL_DATA_HOME = root
    const directory = path.join(root, 'opencode/v2/provider-diagnostics')
    for (const expected of cases) {
      const before = await readdir(directory).catch(() => [] as string[])
      await recordOpenCodeV2ProviderFailure('execution-host-startup', expected.error, true)
      const added = (await readdir(directory)).filter(name => !before.includes(name))
      expect(added).toHaveLength(1)
      const bytes = await readFile(path.join(directory, added[0]!), 'utf8')
      expect(bytes).not.toContain(secret)
      expect(bytes).not.toContain('unknown_private_stage')
      const row = JSON.parse(bytes)
      expect(row.category).toBe(expected.category)
      expect(row.native).toEqual(expected.native)
      expect(row.retainedOriginal).toBe(true)
    }
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_DATA_HOME
    else process.env.CLAUDE_MULTIMODEL_DATA_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})

// Cleanup diagnostics preserve only finite reasons and elapsed time, never error payloads.
test('retirement diagnostics retain bounded timing and native failure without private payload', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'TEST-v2-close-diagnostic-'))
  const previous = process.env.CLAUDE_MULTIMODEL_DATA_HOME
  process.env.CLAUDE_MULTIMODEL_DATA_HOME = root
  const secret = 'TEST-PRIVATE-CLOSE-PAYLOAD'
  try {
    const retirement = new Error('cleanup_unknown', { cause: new Error('execution_native_unknown:retire_owned_pair:2147483659') })
    retainOpenCodeV2CleanupPhase(retirement, 'kernel-retirement')
    retainOpenCodeV2CleanupPhase(retirement, secret as never)
    await recordOpenCodeV2ProviderFailure('run-member-retirement', retirement, true, undefined, undefined, { elapsedMs: 74, dataRoot: root })
    await recordOpenCodeV2ProviderFailure('run-member-retirement', new Error('timeout', { cause: new Error(secret) }), true, undefined, undefined, { elapsedMs: 22001, dataRoot: root })
    await recordOpenCodeV2ProviderFailure('run-member-retirement', new Error('run_control_process_identity:process_image_path:31'), true, undefined, undefined, { elapsedMs: 7 })
    await recordOpenCodeV2ProviderFailure('run-member-retirement', new Error(secret), true, undefined, undefined, { elapsedMs: -1 })
    const rows = await Promise.all((await readdir(path.join(root, 'opencode/v2/provider-diagnostics'))).map(async name => {
      const bytes = await readFile(path.join(root, 'opencode/v2/provider-diagnostics', name), 'utf8')
      expect(bytes).not.toContain(secret)
      return JSON.parse(bytes)
    }))
    expect(rows).toHaveLength(4)
    expect(rows.find(row => row.category === 'execution_native_unknown')).toMatchObject({
      native: { stage: 'retire_owned_pair', nativeCode: 2147483659 }, cleanup: { elapsedMs: 74, phase: 'kernel-retirement' } })
    expect(rows.find(row => row.category === 'timeout').cleanup).toEqual({ elapsedMs: 22001 })
    expect(rows.find(row => row.category === 'run_control_process_identity')).toMatchObject({ native: { stage: 'process_image_path', nativeCode: 31 }, cleanup: { elapsedMs: 7 } })
    expect(rows.find(row => row.category === 'provider_operation_unknown').cleanup).toBeUndefined()
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_DATA_HOME
    else process.env.CLAUDE_MULTIMODEL_DATA_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('graph original native packet survives persistence but unknown fields are rejected', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'TEST-v2-graph-native-facts-'))
  const previous = process.env.CLAUDE_MULTIMODEL_DATA_HOME
  process.env.CLAUDE_MULTIMODEL_DATA_HOME = root
  const graphFailure = { index: 3, total: 53237, readPhase: 'realpath', pathSha256: 'a'.repeat(64), contentSha256: 'b'.repeat(64),
    realpath: { status: 1, operation: 15, win32: 0, anchorCount: 4, matchingAnchorIndex: 2 } }
  // Execute the actual producer, not a hand-maintained approximation of its schema.
  const source = await readFile(path.resolve(import.meta.dir, '../../../entrypoints/opencodeV2ExecutionServer.ts'), 'utf8')
  const start = source.indexOf('function reportStartupFailure('), end = source.indexOf('\n// A source graph', start)
  expect(start >= 0 && end > start).toBe(true)
  const stages = ['waiting-for-prepare', ...Array.from(source.matchAll(/enterStartupStage\('([^']+)'\)/g), match => match[1]!)]
  const history = stages.slice(0, stages.indexOf('graph-validation') + 1).map((stage, elapsedMs) => ({ stage, elapsedMs }))
  expect(history.at(-1)?.stage).toBe('graph-validation')
  let emitted = ''
  const context = { Error, Date, runtimeReady: false, startupFailureReported: false, startupStage: 'graph-validation',
    startupStartedAt: Date.now() - 41, startupHistory: history, environmentMismatchKeys: [], executionProfileGuards: [],
    graphProgress: { phase: 'hash', completed: 0, total: graphFailure.total }, readExecutionGraphFailure: () => graphFailure,
    process: { stderr: { write: (value: string) => { emitted += value } } },
    original: Object.assign(new Error('DO-NOT-EMIT'), { code: 'EPERM', syscall: 'lstat' }) }
  runInNewContext(new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end)) + "\nreportStartupFailure('failed', original)", context)
  const startup = JSON.parse(emitted)
  expect(startup.errno).toBe('EPERM')
  expect(startup.history).toEqual(history)
  expect(emitted).not.toContain('DO-NOT-EMIT')
  try {
    await recordOpenCodeV2ProviderFailure('execution-host-startup', new Error('execution_host_unavailable'), true, JSON.stringify(startup))
    emitted = ''
    context.startupFailureReported = false
    runInNewContext(new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end)) + "\nreadExecutionGraphFailure = () => ({index:3,total:53237,readPhase:'realpath',pathSha256:'a'.repeat(64),contentSha256:'b'.repeat(64)}); reportStartupFailure('failed', original)", context)
    await recordOpenCodeV2ProviderFailure('execution-host-startup', new Error('execution_host_unavailable'), true, emitted)
    await recordOpenCodeV2ProviderFailure('execution-host-startup', new Error('execution_host_unavailable'), true,
      JSON.stringify({ ...startup, graphFailure: { ...graphFailure, secret: 'DO-NOT-EMIT' } }))
    await recordOpenCodeV2ProviderFailure('execution-host-startup', new Error('execution_host_unavailable'), true, JSON.stringify({ ...startup, constructor: 'DO-NOT-EMIT' }))
    const rows = await Promise.all((await readdir(path.join(root, 'opencode/v2/provider-diagnostics'))).map(async name => JSON.parse(await readFile(path.join(root, 'opencode/v2/provider-diagnostics', name), 'utf8'))))
    expect(rows.find(row => row.startup?.graphFailure?.realpath)?.startup.graphFailure).toEqual(graphFailure)
    expect(rows.find(row => row.startup)?.startup).toMatchObject({ errno: 'EPERM', operation: 'lstat', errorName: 'Error' })
    expect(startup.graphFailure.readPhase).toBe('realpath')
    expect(rows.filter(row => row.startup)).toHaveLength(2)
    expect(rows.find(row => row.startup && !row.startup.graphFailure.realpath)?.startup.graphFailure).toMatchObject({ index: 3, total: 53237, readPhase: 'realpath' })
    expect(rows.filter(row => !row.startup)).toHaveLength(2)
    expect(JSON.stringify(rows)).not.toContain('DO-NOT-EMIT')
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_DATA_HOME
    else process.env.CLAUDE_MULTIMODEL_DATA_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})
