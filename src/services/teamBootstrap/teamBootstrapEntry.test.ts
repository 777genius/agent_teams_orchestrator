import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import type { CanonicalTeamLockAuthority } from 'src/utils/swarm/canonicalTeamLockAuthority.js'
import { resolveStartupTeamBootstrapInputs } from './teamBootstrapEntry.js'
import {
  computeHostedNativeEnvelopeDigest,
  type HostedNativeLaunchEnvelope,
} from './hostedNativeLaunch.js'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const digest = (value: string) => createHash('sha256').update(value).digest('hex')

async function fixture() {
  const data = await mkdtemp(join(tmpdir(), 'hosted-entry-inputs-'))
  cleanup.push(data)
  await chmod(data, 0o700)
  const legacyKey = 'exact-team'
  const team = join(data, 'teams', legacyKey)
  const tasks = join(data, 'tasks', legacyKey)
  const cwd = join(data, 'cwd')
  const privateRoot = join(data, '.hosted-native')
  await Promise.all([team, tasks, cwd, privateRoot].map(path =>
    mkdir(path, { recursive: true, mode: 0o700 })))
  const [dataStat, teamStat, tasksStat] = await Promise.all([
    stat(data), stat(team), stat(tasks),
  ])
  const specPath = join(privateRoot, 'spec.json')
  const promptPath = join(privateRoot, 'prompt.txt')
  const settingsPath = join(privateRoot, 'settings.json')
  const mcpConfigPath = join(privateRoot, 'mcp.json')
  const envelopePath = join(privateRoot, 'envelope.json')
  const spec = JSON.stringify({
    version: 1,
    runId: 'run-1',
    mode: 'create',
    initiator: { kind: 'app', source: 'claude_team_agent_teams_orchestrator' },
    team: { name: legacyKey, description: 'bound description', cwd },
    lead: {},
    members: [],
    ui: { emitStructuredEvents: false },
  })
  const prompt = 'bound prompt'
  await Promise.all([
    writeFile(specPath, spec, { mode: 0o600 }),
    writeFile(promptPath, prompt, { mode: 0o600 }),
    writeFile(settingsPath, '{}', { mode: 0o600 }),
    writeFile(mcpConfigPath, '{}', { mode: 0o600 }),
  ])
  const unsigned: Omit<HostedNativeLaunchEnvelope, 'envelopeDigest'> = {
    version: 1, role: 'native-lead', publicTeamId: 'public-1', legacyKey,
    canonicalDataRoot: data, canonicalTeamRoot: team, canonicalTasksRoot: tasks,
    canonicalCwd: cwd, dataRootIdentity: `${dataStat.dev}:${dataStat.ino}`,
    teamRootIdentity: `${teamStat.dev}:${teamStat.ino}`,
    tasksRootIdentity: `${tasksStat.dev}:${tasksStat.ino}`, runId: 'run-1',
    primary: { displayName: 'captain', agentId: 'captain@exact-team', provider: 'codex', model: 'gpt-5' },
    primaryAlias: 'team-lead', launchIdentityToken: 'launch-token',
    materialDigest: 'a'.repeat(64), profileDigest: 'b'.repeat(64),
    settingsDigest: digest('{}'), mcpDigest: digest('{}'), settingsPath, mcpConfigPath,
    bootstrapSpecPath: specPath, bootstrapSpecDigest: digest(spec),
    userPromptFilePath: promptPath, userPromptDigest: digest(prompt),
    permissionMode: 'bypassPermissions', readyAckPath: join(privateRoot, 'ready.json'),
    canonicalAuthority: {
      version: 1, registrationId: 'registration-1', storageGeneration: 'storage-1',
      admittedWriterImage: `sha256:${'c'.repeat(64)}`, registryRoot: privateRoot,
      anchorName: 'registration-1.lock', bindingRecordName: 'registration-1.json',
    },
  }
  const envelope = { ...unsigned, envelopeDigest: computeHostedNativeEnvelopeDigest(unsigned) }
  await writeFile(envelopePath, JSON.stringify(envelope), { mode: 0o600 })
  return { envelope, envelopePath, specPath, promptPath, spec, prompt }
}

const admitted = Object.freeze({}) as CanonicalTeamLockAuthority

describe('startup entry exact hosted input composition', () => {
  test('rejects alternate CLI spec and prompt selections before admission', async () => {
    const value = await fixture()
    const alternateSpec = join(value.envelope.canonicalDataRoot, '.hosted-native', 'alternate.json')
    const alternatePrompt = join(value.envelope.canonicalDataRoot, '.hosted-native', 'alternate.txt')
    await Promise.all([
      writeFile(alternateSpec, value.spec, { mode: 0o600 }),
      writeFile(alternatePrompt, value.prompt, { mode: 0o600 }),
    ])
    let admissions = 0
    const admitHostedAuthority = async () => { admissions++; return admitted }
    await expect(resolveStartupTeamBootstrapInputs({
      specPath: alternateSpec, userPromptFilePath: value.promptPath,
      hostedNativeLaunchPath: value.envelopePath,
      hostedNativeLaunchIdentity: value.envelope.launchIdentityToken,
      admitHostedAuthority,
    })).rejects.toThrow('spec selection')
    await expect(resolveStartupTeamBootstrapInputs({
      specPath: value.specPath, userPromptFilePath: alternatePrompt,
      hostedNativeLaunchPath: value.envelopePath,
      hostedNativeLaunchIdentity: value.envelope.launchIdentityToken,
      admitHostedAuthority,
    })).rejects.toThrow('prompt selection')
    expect(admissions).toBe(0)
  })

  test('omitted CLI prompt consumes retained bound bytes despite same-path mutation during admission', async () => {
    const value = await fixture()
    const resolved = await resolveStartupTeamBootstrapInputs({
      specPath: value.specPath,
      hostedNativeLaunchPath: value.envelopePath,
      hostedNativeLaunchIdentity: value.envelope.launchIdentityToken,
      admitHostedAuthority: async () => {
        await Promise.all([
          writeFile(value.specPath, JSON.stringify({ substituted: true }), { mode: 0o600 }),
          writeFile(value.promptPath, 'substituted prompt', { mode: 0o600 }),
        ])
        return admitted
      },
    })
    expect(resolved.request.description).toBe('bound description')
    expect(resolved.retainedHostedPrompt).toBe('bound prompt')
  })
})
