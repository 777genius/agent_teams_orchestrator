import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTeamBootstrapSpec } from './teamBootstrapSpec.js'
import { withOwnedTeamBootstrapSpec } from './teamBootstrapOwnedSpec.js'

const roots: string[] = []
const markerName = '.agent-teams-bootstrap-owner.json'

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await fs.mkdtemp(join(tmpdir(), 'agent-teams-bootstrap-test-'))
  roots.push(directory)
  await fs.chmod(directory, 0o700)
  const specPath = join(directory, 'bootstrap.json')
  const ownerPath = join(directory, markerName)
  await fs.writeFile(ownerPath, JSON.stringify({
    version: 1,
    kind: 'agent-teams-bootstrap',
    ownerPid: process.pid,
    specFile: 'bootstrap.json',
  }), { mode: 0o600 })
  await fs.writeFile(specPath, JSON.stringify({
    version: 1,
    runId: 'owned-bootstrap-test',
    mode: 'create',
    initiator: { kind: 'app', source: 'claude_team_agent_teams_orchestrator' },
    team: { name: 'owned-bootstrap-test', cwd: directory },
    lead: {},
    members: [{ name: 'alice', prompt: 'test', env: { CODEX_API_KEY: 'test-secret' } }],
  }), { mode: 0o600 })
  return { directory, specPath, ownerPath }
}

describe('one-shot app-owned bootstrap spec consumption', () => {
  test('leases the consumer before reading and removes the secret before bootstrap continues', async () => {
    const { directory, specPath, ownerPath } = await fixture()
    const request = await withOwnedTeamBootstrapSpec(specPath, async () => {
      expect(JSON.parse(await fs.readFile(ownerPath, 'utf8')).consumerPid).toBe(process.pid)
      return readTeamBootstrapSpec(specPath)
    })
    expect(request.members[0]?.env?.CODEX_API_KEY).toBe('test-secret')
    expect(await fs.exists(directory)).toBe(false)
  })

  test('removes owned secrets after malformed JSON, schema errors, and normalization errors', async () => {
    for (const content of ['{malformed', '{"members":[]}', JSON.stringify({
      version: 1, runId: 'bad-cwd', mode: 'create',
      initiator: { kind: 'app', source: 'claude_team_agent_teams_orchestrator' },
      team: { name: 'test', cwd: '/nonexistent-owned-bootstrap-test' },
      lead: {}, members: [{ name: 'alice', env: { CODEX_API_KEY: 'test-secret' } }],
    })]) {
      const { directory, specPath } = await fixture()
      await fs.writeFile(specPath, content)
      await expect(withOwnedTeamBootstrapSpec(specPath, () => readTeamBootstrapSpec(specPath))).rejects.toThrow()
      expect(await fs.exists(directory)).toBe(false)
    }
  })

  test('preserves user-supplied specs on successful and failed reads', async () => {
    const { directory, specPath, ownerPath } = await fixture()
    await fs.unlink(ownerPath)
    await withOwnedTeamBootstrapSpec(specPath, () => readTeamBootstrapSpec(specPath))
    expect(await fs.exists(specPath)).toBe(true)
    await fs.writeFile(specPath, '{malformed')
    await expect(withOwnedTeamBootstrapSpec(specPath, () => readTeamBootstrapSpec(specPath))).rejects.toThrow()
    expect(await fs.exists(directory)).toBe(true)
    expect(await fs.readFile(specPath, 'utf8')).toBe('{malformed')
  })

  test('does not consume symlink specs, markers, or directories', async () => {
    for (const target of ['spec', 'marker', 'directory']) {
      const { directory, specPath, ownerPath } = await fixture()
      const original = target === 'spec' ? specPath : target === 'marker' ? ownerPath : directory
      const moved = `${original}-original`
      if (target === 'directory') roots.push(moved)
      await fs.rename(original, moved)
      await fs.symlink(moved, original)
      if (target === 'spec') {
        await expect(withOwnedTeamBootstrapSpec(specPath, () => readTeamBootstrapSpec(specPath))).rejects.toThrow(/symlink/)
      } else {
        await withOwnedTeamBootstrapSpec(specPath, () => readTeamBootstrapSpec(specPath))
      }
      expect((await fs.lstat(original)).isSymbolicLink()).toBe(true)
      expect(await fs.exists(moved)).toBe(true)
    }
  })

  test('preserves a replacement file instead of unlinking a changed identity', async () => {
    const { specPath } = await fixture()
    await expect(withOwnedTeamBootstrapSpec(specPath, async () => {
      const request = await readTeamBootstrapSpec(specPath)
      await fs.rename(specPath, `${specPath}.old`)
      await fs.writeFile(specPath, 'replacement', { mode: 0o600 })
      return request
    })).rejects.toThrow(/changed/)
    expect(await fs.readFile(specPath, 'utf8')).toBe('replacement')
  })
})
