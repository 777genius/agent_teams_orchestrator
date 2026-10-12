import { test, expect } from 'bun:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { recordOpenCodeV2ProviderFailure, retainOpenCodeV2InitializationPhase, type RunInitializationPhase } from './OpenCodeV2Diagnostics.js'

test('startup diagnostics retain only finite native fields and reject payload-bearing or invalid frames', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'TEST-v2-startup-diagnostics-'))
  const previous = process.env.CLAUDE_MULTIMODEL_DATA_HOME
  process.env.CLAUDE_MULTIMODEL_DATA_HOME = root
  const secret = 'TEST-PRIVATE-PAYLOAD'
  const valid = { event: 'opencode-v2-startup', reason: 'timeout', stage: 'graph-validation', elapsedMs: 30_123 }
  const history = [{ stage: 'waiting-for-prepare', elapsedMs: 0 },
    { stage: 'graph-validation', elapsedMs: 1200 }]
  const historical = { ...valid, history }
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
  const frames = [valid, historical, { ...valid, graph }, { ...historical, graph: closure },
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
    ]))
    expect(rows.filter(row => row.startup)).toHaveLength(4)
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
    expect(Object.keys(row).sort()).toEqual(['category', 'phase', 'recordedAt', 'retainedOriginal', 'schemaVersion', 'startup'])
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
