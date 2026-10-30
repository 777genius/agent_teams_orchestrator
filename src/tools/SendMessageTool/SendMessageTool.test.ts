import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { resetStateForTests } from '../../bootstrap/state.js'
import { getInboxPath, readMailbox } from '../../utils/teammateMailbox.js'
import { SendMessageTool } from './SendMessageTool.js'

const context = {
  getAppState: () => ({ teamContext: { teamName: 'my-team', teammates: {} }, agentNameRegistry: new Map(), tasks: {} }),
} as any

describe('SendMessageTool direct message', () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  let dir: string
  beforeEach(async () => {
    resetStateForTests()
    dir = await mkdtemp(join(tmpdir(), 'send-message-tool-'))
    process.env.CLAUDE_CONFIG_DIR = dir
  })
  afterEach(async () => {
    resetStateForTests()
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    await rm(dir, { recursive: true, force: true })
  })

  it('writes exactly one unread row', async () => {
    const result = await SendMessageTool.call({ to: 'alice', summary: 's', message: 'hi' } as any, context, (async () => ({})) as any, undefined as any)
    expect((result as any).data.success).toBe(true)
    const rows = await readMailbox('alice', 'my-team')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ from: 'team-lead', text: 'hi', read: false })
  })

  it("writes to the member's own spelling of the name", async () => {
    const configPath = join(getInboxPath('Alice', 'my-team'), '..', '..', 'config.json')
    await mkdir(join(configPath, '..'), { recursive: true })
    await writeFile(configPath, JSON.stringify({ name: 'my-team', leadAgentId: 'team-lead@my-team', members: [{ agentId: 'Alice@my-team', name: 'Alice' }] }))
    await SendMessageTool.call({ to: 'alice', summary: 's', message: 'hi' } as any, context, (async () => ({})) as any, undefined as any)
    expect(await readdir(join(configPath, '..', 'inboxes'))).toEqual(['Alice.json'])
  })

  it('fails loudly when the write cannot be verified', async () => {
    const path = getInboxPath('alice', 'my-team')
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, '{}')
    await expect(SendMessageTool.call({ to: 'alice', summary: 's', message: 'hi' } as any, context, (async () => ({})) as any, undefined as any)).rejects.toThrow(/Verified mailbox write failed/)
  })
})

describe('SendMessageTool without team context', () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  let dir: string
  beforeEach(async () => {
    resetStateForTests()
    dir = await mkdtemp(join(tmpdir(), 'send-message-tool-noteam-'))
    process.env.CLAUDE_CONFIG_DIR = dir
  })
  afterEach(async () => {
    resetStateForTests()
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    await rm(dir, { recursive: true, force: true })
  })
  it('refuses instead of writing to the default team', async () => {
    const noTeam = { getAppState: () => ({ teamContext: undefined, agentNameRegistry: new Map(), tasks: {} }) } as any
    await expect(SendMessageTool.call({ to: 'alice', summary: 's', message: 'hi' } as any, noTeam, (async () => ({})) as any, undefined as any)).rejects.toThrow(/Not in a team context/)
  })
})
