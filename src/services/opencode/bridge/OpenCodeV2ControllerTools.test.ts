import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createOpenCodeV2ExecutionConfig } from '../profile/OpenCodeV2ExecutionConfig.js'
import type { ExecutionBridgeClient } from '../transport/OpenCodeV2ExecutionClientFactory.js'
import { execFileSync } from 'node:child_process'
import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, symlink, rm, chmod, realpath } from 'node:fs/promises'
import path from 'node:path'
import { executionHash } from '../execution/OpenCodeV2ExecutionContracts.js'
import type { SelectedExecutionProfile } from '../host/OpenCodeV2ExecutionHost.js'
import { CONTROLLER_INBOX_MAX_BYTES, parseControllerInboxBytes, readOwnedControllerInbox,
  readOwnedControllerTools, type ControllerToolProof } from './OpenCodeV2ControllerTools.js'

const originalBinding = { teamId: 'TEST-team', runId: 'TEST-run', memberId: 'worker', sessionID: 'ses_TESToriginal' }
const message = { from: 'worker', to: 'user', text: 'TEST reply', timestamp: '2026-10-10T00:00:00Z',
  read: false, source: 'runtime_delivery', relayOfMessageId: 'TEST-inbound', messageId: 'TEST-real' }

test('shared controller inbox parser preserves messages and only the original member/session binding', () => {
  const binding = { ...originalBinding }
  const result = parseControllerInboxBytes(Buffer.from(JSON.stringify([{ ...message,
    binding: { ...binding, sessionID: 'ses_TESTforeign' }, unexpected: 'TEST-ignored' }])), binding)
  expect(result).toEqual({ binding: originalBinding, messages: [message] })
  binding.sessionID = 'ses_TESTlater'
  expect(result?.binding.sessionID).toBe('ses_TESToriginal')
  expect(Object.isFrozen(result)).toBe(true)
  expect(Object.isFrozen(result?.binding)).toBe(true)
  expect(Object.isFrozen(result?.messages)).toBe(true)
  expect(Object.isFrozen(result?.messages[0])).toBe(true)
  expect(parseControllerInboxBytes(null, originalBinding)).toBeNull()
  expect(parseControllerInboxBytes(Buffer.from('[]'), originalBinding)).toEqual({ binding: originalBinding, messages: [] })
  const { source: _, relayOfMessageId: __, ...required } = message
  expect(parseControllerInboxBytes(Buffer.from(JSON.stringify([required])), originalBinding)?.messages).toEqual([required])
})

test('shared controller inbox parser refuses malformed JSON, rows and required or optional field types', () => {
  const invalid: unknown[] = [null, {}, [null], [[]], [true], [{ ...message, read: 'false' }],
    [{ ...message, source: null }], [{ ...message, relayOfMessageId: 1 }]]
  for (const field of ['messageId', 'from', 'to', 'text', 'timestamp']) {
    const missing: Record<string, unknown> = { ...message }; delete missing[field]
    invalid.push([missing], [{ ...message, [field]: '' }], [{ ...message, [field]: 1 }])
  }
  for (const value of invalid)
    expect(() => parseControllerInboxBytes(Buffer.from(JSON.stringify(value)), originalBinding)).toThrow('run_controller_inbox_unknown')
  for (const value of ['', '{', '[{}'])
    expect(() => parseControllerInboxBytes(Buffer.from(value), originalBinding)).toThrow('run_controller_inbox_unknown')
})

test('shared controller inbox parser bounds raw bytes and message count on every platform', () => {
  const encode = (count: number) => Buffer.from(JSON.stringify(Array.from({ length: count }, () => message)))
  expect(parseControllerInboxBytes(encode(4096), originalBinding)?.messages.length).toBe(4096)
  expect(() => parseControllerInboxBytes(encode(4097), originalBinding)).toThrow('run_controller_inbox_unknown')
  const maximum = Buffer.alloc(CONTROLLER_INBOX_MAX_BYTES, ' '); maximum.write('[]')
  expect(parseControllerInboxBytes(maximum, originalBinding)?.messages).toEqual([])
  expect(() => parseControllerInboxBytes(Buffer.concat([maximum, Buffer.from(' ')]), originalBinding)).toThrow('run_controller_inbox_unknown')
})

test.skipIf(process.platform === 'win32')('selected local canonical inbox reader binds exact config, schema and bounded owned regular bytes', async () => {
  const root = await realpath(await mkdtemp(path.join(process.env.TMPDIR!, 'TEST-controller-inbox-')))
  const directory = path.join(root, 'teams/TEST-team/inboxes')
  const binding = { teamId: 'TEST-team', runId: 'TEST-run', memberId: 'worker', sessionID: 'ses_TESToriginal' }
  const config = { type: 'local', command: ['TEST-unused'], environment: { AGENT_TEAMS_MCP_CLAUDE_DIR: root } }
  const profile = { config: { content: JSON.stringify({ mcp: { servers: { 'agent-teams': config } } }) } } as SelectedExecutionProfile
  const proof: ControllerToolProof = { server: 'agent-teams', configHash: executionHash(config),
    schemasHash: executionHash([]), tools: [], nativeNames: [] }
  const row = { from: 'worker', to: 'user', text: 'TEST reply', timestamp: '2026-10-10T00:00:00Z',
    read: false, source: 'runtime_delivery', relayOfMessageId: 'TEST-inbound', messageId: 'TEST-real' }
  const read = () => readOwnedControllerInbox(profile, proof, binding, Date.now() + 5000)
  try {
    expect((await read())?.messages).toEqual([])
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(path.join(directory, 'user.json'), JSON.stringify([row]), { mode: 0o600 })
    expect(await read()).toEqual({ binding, messages: [row] })
    await expect(readOwnedControllerInbox(profile, { ...proof, configHash: 'TEST-wrong' }, binding, Date.now() + 5000)).rejects.toThrow('run_controller_config_unknown')
    await writeFile(path.join(directory, 'user.json'), JSON.stringify([{ ...row, read: 'TEST-invalid' }]))
    await expect(read()).rejects.toThrow('run_controller_inbox_unknown')
    await writeFile(path.join(directory, 'user.json'), ' '.repeat(4 * 1024 * 1024 + 1))
    await expect(read()).rejects.toThrow('run_controller_inbox_unknown')
    await rm(path.join(directory, 'user.json'))
    execFileSync('mkfifo', [path.join(directory, 'user.json')])
    const started = Date.now()
    await expect(read()).rejects.toThrow('run_controller_inbox_unknown')
    expect(Date.now() - started).toBeLessThan(500)
    await rm(path.join(directory, 'user.json'))
    await writeFile(path.join(root, 'TEST-other.json'), JSON.stringify([row]))
    await symlink(path.join(root, 'TEST-other.json'), path.join(directory, 'user.json'))
    await expect(read()).rejects.toThrow()
    await rm(path.join(directory, 'user.json'))
    await writeFile(path.join(directory, 'user.json'), JSON.stringify([row]), { mode: 0o600 })
    await chmod(directory, 0o777)
    await expect(read()).rejects.toThrow('run_controller_inbox_unknown')
    await chmod(directory, 0o700)
    const remote = { type: 'remote', url: 'http://TEST.invalid' }
    expect(await readOwnedControllerInbox({ config: { content: JSON.stringify({ mcp: { servers: { 'agent-teams': remote } } }) } } as SelectedExecutionProfile,
      { ...proof, configHash: executionHash(remote) }, binding, Date.now() + 5000)).toBeNull()
  } finally { await rm(root, { recursive: true, force: true }) }
})


test('managed Windows deferred controller requires exact owned config and live connection before direct schema proof', async () => {
  const selection: SelectedExecutionProfile['selection'] = { agent: 'worker', model: { providerID: 'TEST', id: 'TEST' },
    permissions: [{ action: '*', resource: '*', effect: 'ask' }] }
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const windows = <T>(run: () => T): T => {
    try { Object.defineProperty(process, 'platform', { ...platform, value: 'win32' }); return run() }
    finally { Object.defineProperty(process, 'platform', platform) }
  }
  const config = windows(() => createOpenCodeV2ExecutionConfig({ pin: '2.0.21', selection,
    controller: { server: 'agent-teams', config: { type: 'local', command: [process.execPath,
      fileURLToPath(new URL('./fixtures/OpenCodeV2ControllerToolsPeer.ts', import.meta.url))] } } }))
  const profile: SelectedExecutionProfile = { epoch: 'TEST-epoch', root: '/TEST-root', directory: '/TEST-project',
    databasePath: '/TEST-db', env: {}, envSha256: 'a'.repeat(64), selection,
    config: { directory: '/TEST-config', content: config.content, sha256: config.sha256 } }
  const client = { authority: { profileRoot: profile.root, profileEpoch: profile.epoch, directory: profile.directory },
    mcp: async () => [{ name: 'agent-teams', status: 'connected' }],
    config: async () => [{ type: 'document', info: config.info }],
  } as unknown as ExecutionBridgeClient
  const read = (selected = profile, wire = client) => windows(() => readOwnedControllerTools(wire, selected,
    'agent-teams', Date.now() + 5000))
  await expect(read({ ...profile, config: { ...profile.config, sha256: 'b'.repeat(64) } })).rejects.toThrow('run_controller_config_unknown')
  await expect(read(profile, { ...client, authority: { ...client.authority, profileEpoch: 'TEST-foreign' } })).rejects.toThrow('run_controller_config_unknown')
  await expect(read(profile, { ...client, config: async () => [{ type: 'document', info: {} }] })).rejects.toThrow('run_controller_config_unknown')
  await expect(read(profile, { ...client, mcp: async () => [] })).rejects.toThrow('run_controller_mcp_unknown')
  // Same disabled document is never accepted outside the managed Windows path.
  if (process.platform !== 'win32') await expect(readOwnedControllerTools(client, profile, 'agent-teams', Date.now() + 5000)).rejects.toThrow('run_controller_config_unknown')
  const proof = await read()
  expect(proof.configHash).toBe(executionHash(config.info.mcp!.servers!['agent-teams']))
  expect(proof.nativeNames).toEqual(['agent-teams_message_send'])
  expect(createHash('sha256').update(config.content).digest('hex')).toBe(profile.config.sha256)
})
