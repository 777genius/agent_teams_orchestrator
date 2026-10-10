import { execFileSync } from 'node:child_process'
import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, symlink, rm, chmod } from 'node:fs/promises'
import path from 'node:path'
import { executionHash } from '../execution/OpenCodeV2ExecutionContracts.js'
import type { SelectedExecutionProfile } from '../host/OpenCodeV2ExecutionHost.js'
import { readOwnedControllerInbox, type ControllerToolProof } from './OpenCodeV2ControllerTools.js'

test('selected local canonical inbox reader binds exact config, schema and bounded owned regular bytes', async () => {
  const root = await mkdtemp(path.join(process.env.TMPDIR!, 'TEST-controller-inbox-'))
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
