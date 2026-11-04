import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'fs'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { resetStateForTests } from '../../bootstrap/state.js'
import { getTeamsDir } from '../../utils/envUtils.js'
import { getTeamDir, getTeamFilePath } from '../../utils/swarm/teamHelpers.js'
import { getInboxPath, readMailbox } from '../../utils/teammateMailbox.js'
import { SendMessageTool } from './SendMessageTool.js'

const context = {
  getAppState: () => ({ teamContext: { teamName: 'my-team', teammates: {} }, agentNameRegistry: new Map(), tasks: {} }),
} as any

const send = (input: unknown, ctx = context) => SendMessageTool.call(input as any, ctx, (async () => ({})) as any, undefined as any)

async function writeTeamConfig(memberNames: string[]) {
  await mkdir(getTeamDir('my-team'), { recursive: true })
  await writeFile(getTeamFilePath('my-team'), JSON.stringify({ name: 'my-team', leadAgentId: 'team-lead@my-team', members: memberNames.map(name => ({ agentId: `${name}@my-team`, name })) }))
}

async function writeMembersMeta(members: Array<{ name: string; removedAt?: number }>) {
  await mkdir(getTeamDir('my-team'), { recursive: true })
  await writeFile(join(getTeamDir('my-team'), 'members.meta.json'), JSON.stringify({ version: 1, members }))
}

const inboxFiles = async () => readdir(join(getTeamDir('my-team'), 'inboxes')).catch(() => [])

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
    await writeTeamConfig(['team-lead', 'alice'])
    const result = await send({ to: 'alice', summary: 's', message: 'hi' })
    expect((result as any).data.success).toBe(true)
    const rows = await readMailbox('alice', 'my-team')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ from: 'team-lead', text: 'hi', read: false })
  })

  it("writes to the member's own spelling of the name", async () => {
    await writeTeamConfig(['Alice'])
    await send({ to: 'alice', summary: 's', message: 'hi' })
    expect(await inboxFiles()).toEqual(['Alice.json'])
  })

  it('fails loudly when the write cannot be verified', async () => {
    await writeTeamConfig(['team-lead', 'alice'])
    const path = getInboxPath('alice', 'my-team')
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, '{}')
    await expect(send({ to: 'alice', summary: 's', message: 'hi' })).rejects.toThrow(/Verified mailbox write failed/)
  })

  it('refuses a recipient outside the team instead of creating a new inbox', async () => {
    await writeTeamConfig(['team-lead', 'atlas'])
    const failure = send({ to: 'atlsa', summary: 's', message: 'hi' })
    await expect(failure).rejects.toThrow(/UNKNOWN_RECIPIENT/)
    await expect(failure).rejects.toThrow(/Valid recipients: atlas, team-lead, user/)
    expect(existsSync(getInboxPath('atlsa', 'my-team'))).toBe(false)
  })

  it('delivers to the user in any spelling without a team config', async () => {
    const result = await send({ to: 'User', summary: 's', message: 'hi' })
    expect((result as any).data.success).toBe(true)
    expect(await inboxFiles()).toEqual(['user.json'])
  })

  it('accepts members listed only in members.meta.json and refuses removed ones', async () => {
    await writeTeamConfig(['team-lead', 'atlas'])
    await writeMembersMeta([{ name: 'nova' }, { name: 'atlas', removedAt: 1 }])
    await send({ to: 'nova', summary: 's', message: 'hi' })
    await expect(send({ to: 'atlas', summary: 's', message: 'hi' })).rejects.toThrow(/UNKNOWN_RECIPIENT/)
    expect(await inboxFiles()).toEqual(['nova.json'])
  })

  it('refuses a shutdown request to a recipient outside the team', async () => {
    await writeTeamConfig(['team-lead', 'atlas'])
    await expect(send({ to: 'atlsa', message: { type: 'shutdown_request' } })).rejects.toThrow(/UNKNOWN_RECIPIENT/)
    expect(existsSync(getInboxPath('atlsa', 'my-team'))).toBe(false)
  })

  it('refuses a plan approval to a recipient outside the team', async () => {
    await writeTeamConfig(['team-lead', 'atlas'])
    const lead = { getAppState: () => ({ teamContext: { teamName: 'my-team', leadAgentId: 'team-lead@my-team', teammates: {} }, toolPermissionContext: { mode: 'default' }, agentNameRegistry: new Map(), tasks: {} }) } as any
    await expect(send({ to: 'atlsa', message: { type: 'plan_approval_response', request_id: 'r1', approve: true } }, lead)).rejects.toThrow(/UNKNOWN_RECIPIENT/)
    expect(await inboxFiles()).toEqual([])
  })

  it('keeps the config.json spelling when members.meta.json spells the name differently', async () => {
    await writeTeamConfig(['team-lead', 'atlas'])
    await writeMembersMeta([{ name: 'Atlas' }])
    await send({ to: 'ATLAS', summary: 's', message: 'hi' })
    expect(await inboxFiles()).toEqual(['atlas.json'])
  })

  it('refuses when neither config.json nor members.meta.json exists', async () => {
    await expect(send({ to: 'atlas', summary: 's', message: 'hi' })).rejects.toThrow(/TEAM_CONFIG_UNAVAILABLE/)
    expect(await inboxFiles()).toEqual([])
  })

  it('does not call a name unknown while config.json is unreadable', async () => {
    await mkdir(getTeamDir('my-team'), { recursive: true })
    await writeFile(getTeamFilePath('my-team'), '{"members": [')
    await writeMembersMeta([{ name: 'nova' }])
    await expect(send({ to: 'atlas', summary: 's', message: 'hi' })).rejects.toThrow(/^TEAM_CONFIG_UNAVAILABLE/)
    await send({ to: 'nova', summary: 's', message: 'hi' })
    expect(await inboxFiles()).toEqual(['nova.json'])
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
  const noTeam = { getAppState: () => ({ teamContext: undefined, agentNameRegistry: new Map(), tasks: {} }) } as any

  it('refuses instead of writing to the default team', async () => {
    await expect(send({ to: 'alice', summary: 's', message: 'hi' }, noTeam)).rejects.toThrow(/Not in a team context/)
  })

  it('refuses a shutdown request instead of writing to the default team', async () => {
    await expect(send({ to: 'alice', message: { type: 'shutdown_request' } }, noTeam)).rejects.toThrow(/Not in a team context/)
    expect(existsSync(join(getTeamsDir(), 'default'))).toBe(false)
  })
})
