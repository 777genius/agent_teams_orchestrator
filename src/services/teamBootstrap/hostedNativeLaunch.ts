import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, realpath, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { HostedInputHandle } from 'src/cli/structuredIO.js'
import type { ToolUseContext } from 'src/Tool.js'
import { getSessionId } from 'src/bootstrap/state.js'
import { writeFileAtomic } from 'src/utils/atomicWrite.js'
import { jsonParse } from 'src/utils/slowOperations.js'
import { TEAM_LEAD_NAME } from 'src/utils/swarm/constants.js'
import {
  readTeamFileAtCanonicalRoot,
  sanitizeAgentName,
  sanitizeName,
  withTeamFileLockAtCanonicalRoot,
  writeTeamFileAtCanonicalRoot,
  type TeamFile,
} from 'src/utils/swarm/teamHelpers.js'
import {
  captureProcessTreeIdentity,
  readProcessStartTimeMs,
} from 'src/utils/processKill.js'
import { isRawMailboxMessage, normalizeTeammateMessage } from 'src/utils/teammateMailboxRecord.js'
import * as lockfile from 'src/utils/lockfile.js'
import type { HostedCanonicalAuthorityRegistrationReference } from './hostedCanonicalAuthorityStartup.js'

const MAX_ENVELOPE_BYTES = 256 * 1024
const MAX_ACK_BYTES = 64 * 1024
const MAX_PATH_BYTES = 8 * 1024
const MAX_TEXT_BYTES = 16 * 1024
const DEFAULT_MAILBOX_POLL_MS = 250

export type HostedNativeProvider = 'anthropic' | 'codex' | 'gemini'

export type HostedNativeLaunchEnvelope = {
  version: 1
  role: 'native-lead'
  publicTeamId: string
  legacyKey: string
  canonicalDataRoot: string
  canonicalTeamRoot: string
  canonicalTasksRoot: string
  canonicalCwd: string
  dataRootIdentity: string
  teamRootIdentity: string
  tasksRootIdentity: string
  runId: string
  primary: {
    displayName: string
    agentId: string
    provider: HostedNativeProvider
    model: string
    effort?: string
  }
  primaryAlias: typeof TEAM_LEAD_NAME
  launchIdentityToken: string
  materialDigest: string
  profileDigest: string
  settingsDigest: string
  mcpDigest: string
  settingsPath: string
  mcpConfigPath: string
  bootstrapSpecPath: string
  bootstrapSpecDigest: string
  userPromptFilePath: string
  userPromptDigest: string
  permissionMode: 'bypassPermissions'
  readyAckPath: string
  mailboxPollMs?: number
  canonicalAuthority: HostedCanonicalAuthorityRegistrationReference
  envelopeDigest: string
}

export type HostedNativeReadyAcknowledgement = {
  version: 1
  state: 'ready'
  role: 'native-lead'
  publicTeamId: string
  legacyKey: string
  runId: string
  primaryAgentId: string
  primaryDisplayName: string
  primaryAlias: typeof TEAM_LEAD_NAME
  sessionId: string
  pid: number
  processStartedAtMs: number
  processOsIdentity: string
  launchIdentityToken: string
  envelopeDigest: string
  materialDigest: string
  profileDigest: string
  settingsDigest: string
  mcpDigest: string
  permissionMode: 'bypassPermissions'
  canonicalDataRoot: string
  canonicalTeamRoot: string
  canonicalTasksRoot: string
  canonicalCwd: string
  mailboxCustody: 'hosted-lead-pump'
  acknowledgedAt: string
}

export type HostedNativeLaunchInputSnapshot = {
  envelope: HostedNativeLaunchEnvelope
  bootstrapSpecText: string
  userPromptText: string
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function computeHostedNativeEnvelopeDigest(
  envelope: Omit<HostedNativeLaunchEnvelope, 'envelopeDigest'>,
): string {
  return sha256(canonicalJson(envelope))
}

function assertBoundedText(value: unknown, label: string, max = MAX_TEXT_BYTES): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > max ||
    value.includes('\0')
  ) {
    throw new Error(`Invalid hosted native ${label}`)
  }
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Invalid hosted native ${label}`)
  }
}

async function assertCanonicalPath(pathValue: unknown, label: string): Promise<string> {
  assertBoundedText(pathValue, label, MAX_PATH_BYTES)
  if (!isAbsolute(pathValue) || resolve(pathValue) !== pathValue) {
    throw new Error(`Hosted native ${label} must be an absolute normalized path`)
  }
  const canonical = await realpath(pathValue)
  if (canonical !== pathValue) throw new Error(`Hosted native ${label} is not canonical`)
  return canonical
}

type PrivateDirectoryIdentity = { dev: number; ino: number }

async function assertPrivateDirectory(
  pathValue: string,
): Promise<PrivateDirectoryIdentity> {
  const handle = await open(
    pathValue,
    constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0),
  )
  try {
    const [opened, current, canonical] = await Promise.all([
      handle.stat(),
      lstat(pathValue),
      realpath(pathValue),
    ])
    if (
      !opened.isDirectory() ||
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino ||
      canonical !== pathValue ||
      (opened.mode & 0o022) !== 0 ||
      (process.getuid?.() !== undefined && opened.uid !== process.getuid())
    ) {
      throw new Error(`Hosted native directory is not private and stable: ${pathValue}`)
    }
    return { dev: opened.dev, ino: opened.ino }
  } finally {
    await handle.close()
  }
}

async function readBoundPrivateJson(pathValue: string, maxBytes: number): Promise<unknown> {
  return jsonParse((await readBoundPrivateBytes(pathValue, maxBytes)).toString('utf8'))
}

async function readBoundPrivateBytes(pathValue: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(pathValue, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const [opened, current] = await Promise.all([handle.stat(), lstat(pathValue)])
    if (
      !opened.isFile() ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino ||
      opened.size > maxBytes ||
      (opened.mode & 0o077) !== 0 ||
      (process.getuid?.() !== undefined && opened.uid !== process.getuid())
    ) throw new Error('Hosted native private file is unsafe')
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

export async function readHostedNativeLaunchInputSnapshot(
  envelopePath: string,
): Promise<HostedNativeLaunchInputSnapshot> {
  await assertCanonicalPath(envelopePath, 'envelope path')
  const value = await readBoundPrivateJson(envelopePath, MAX_ENVELOPE_BYTES)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Hosted native launch envelope must be an object')
  }
  const envelope = value as HostedNativeLaunchEnvelope
  if (envelope.version !== 1 || envelope.role !== 'native-lead') {
    throw new Error('Unsupported hosted native launch envelope')
  }
  for (const [key, text] of Object.entries({
    publicTeamId: envelope.publicTeamId,
    legacyKey: envelope.legacyKey,
    runId: envelope.runId,
    launchIdentityToken: envelope.launchIdentityToken,
    dataRootIdentity: envelope.dataRootIdentity,
    teamRootIdentity: envelope.teamRootIdentity,
    tasksRootIdentity: envelope.tasksRootIdentity,
  })) assertBoundedText(text, key)
  if (sanitizeName(envelope.legacyKey) !== envelope.legacyKey) {
    throw new Error('Hosted native legacy key is not canonical')
  }
  if (envelope.primaryAlias !== TEAM_LEAD_NAME) {
    throw new Error('Hosted native primary alias must be team-lead')
  }
  assertBoundedText(envelope.primary?.displayName, 'primary display name')
  assertBoundedText(envelope.primary?.agentId, 'primary agent id')
  assertBoundedText(envelope.primary?.model, 'primary model')
  if (!['anthropic', 'codex', 'gemini'].includes(envelope.primary?.provider)) {
    throw new Error('Hosted native primary provider is unsupported')
  }
  if (
    envelope.primary.displayName === TEAM_LEAD_NAME ||
    envelope.primary.displayName === 'user' ||
    sanitizeAgentName(envelope.primary.displayName) !== envelope.primary.displayName
  ) throw new Error('Hosted native primary display name collides with a reserved identity')
  if (envelope.permissionMode !== 'bypassPermissions') {
    throw new Error('Hosted native launch requires automatic bypass permissions')
  }
  for (const [key, digest] of Object.entries({
    materialDigest: envelope.materialDigest,
    profileDigest: envelope.profileDigest,
    settingsDigest: envelope.settingsDigest,
    mcpDigest: envelope.mcpDigest,
    envelopeDigest: envelope.envelopeDigest,
    bootstrapSpecDigest: envelope.bootstrapSpecDigest,
    userPromptDigest: envelope.userPromptDigest,
  })) assertDigest(digest, key)
  await assertCanonicalPath(dirname(envelope.settingsPath), 'settings parent')
  await assertCanonicalPath(dirname(envelope.mcpConfigPath), 'MCP config parent')
  await assertCanonicalPath(dirname(envelope.bootstrapSpecPath), 'bootstrap spec parent')
  await assertCanonicalPath(dirname(envelope.userPromptFilePath), 'user prompt parent')
  const [settingsBytes, mcpBytes] = await Promise.all([
    readBoundPrivateBytes(envelope.settingsPath, 4 * 1024 * 1024),
    readBoundPrivateBytes(envelope.mcpConfigPath, 4 * 1024 * 1024),
  ])
  jsonParse(settingsBytes.toString('utf8'))
  jsonParse(mcpBytes.toString('utf8'))
  if (sha256(settingsBytes) !== envelope.settingsDigest || sha256(mcpBytes) !== envelope.mcpDigest) {
    throw new Error('Hosted native settings or MCP bytes changed after admission')
  }
  const [specBytes, promptBytes] = await Promise.all([
    readBoundPrivateBytes(envelope.bootstrapSpecPath, MAX_ENVELOPE_BYTES),
    readBoundPrivateBytes(envelope.userPromptFilePath, 256 * 1024),
  ])
  if (sha256(specBytes) !== envelope.bootstrapSpecDigest || sha256(promptBytes) !== envelope.userPromptDigest) {
    throw new Error('Hosted native bootstrap bytes changed after admission')
  }
  const bootstrapSpecText = specBytes.toString('utf8')
  const userPromptText = promptBytes.toString('utf8')
  if (
    sha256(Buffer.from(bootstrapSpecText, 'utf8')) !== envelope.bootstrapSpecDigest ||
    sha256(Buffer.from(userPromptText, 'utf8')) !== envelope.userPromptDigest
  ) {
    throw new Error('Hosted native bootstrap inputs must be valid UTF-8')
  }
  const canonicalDataRoot = await assertCanonicalPath(envelope.canonicalDataRoot, 'data root')
  const canonicalTeamRoot = await assertCanonicalPath(envelope.canonicalTeamRoot, 'team root')
  const canonicalTasksRoot = await assertCanonicalPath(envelope.canonicalTasksRoot, 'tasks root')
  const [dataIdentity, teamIdentity, tasksIdentity] = await Promise.all([
    assertPrivateDirectory(canonicalDataRoot),
    assertPrivateDirectory(canonicalTeamRoot),
    assertPrivateDirectory(canonicalTasksRoot),
  ])
  if (`${dataIdentity.dev}:${dataIdentity.ino}` !== envelope.dataRootIdentity ||
    `${teamIdentity.dev}:${teamIdentity.ino}` !== envelope.teamRootIdentity ||
    `${tasksIdentity.dev}:${tasksIdentity.ino}` !== envelope.tasksRootIdentity) {
    throw new Error('Hosted native directory identity changed after admission')
  }
  await assertCanonicalPath(envelope.canonicalCwd, 'cwd')
  await assertCanonicalPath(dirname(envelope.readyAckPath), 'ack parent')
  if (!isAbsolute(envelope.readyAckPath) || basename(envelope.readyAckPath).length === 0) {
    throw new Error('Hosted native acknowledgement path is invalid')
  }
  if (canonicalTeamRoot !== join(canonicalDataRoot, 'teams', envelope.legacyKey)) {
    throw new Error('Hosted native team root does not match native layout')
  }
  if (canonicalTasksRoot !== join(canonicalDataRoot, 'tasks', envelope.legacyKey)) {
    throw new Error('Hosted native tasks root does not match native layout')
  }
  const { envelopeDigest: _digest, ...unsigned } = envelope
  if (computeHostedNativeEnvelopeDigest(unsigned) !== envelope.envelopeDigest) {
    throw new Error('Hosted native launch envelope digest mismatch')
  }
  const retainedEnvelope = Object.freeze({
    ...envelope,
    primary: Object.freeze({ ...envelope.primary }),
  })
  return Object.freeze({
    envelope: retainedEnvelope,
    bootstrapSpecText,
    userPromptText,
  })
}

export async function readHostedNativeLaunchEnvelope(
  envelopePath: string,
): Promise<HostedNativeLaunchEnvelope> {
  return (await readHostedNativeLaunchInputSnapshot(envelopePath)).envelope
}

function hostedBindingMatches(team: TeamFile, envelope: HostedNativeLaunchEnvelope): boolean {
  const binding = team.hostedNative
  return Boolean(
    binding &&
    binding.publicTeamId === envelope.publicTeamId &&
    binding.legacyKey === envelope.legacyKey &&
    binding.primaryDisplayName === envelope.primary.displayName &&
    binding.primaryAgentId === envelope.primary.agentId &&
    binding.launchIdentityToken === envelope.launchIdentityToken &&
    binding.envelopeDigest === envelope.envelopeDigest &&
    binding.materialDigest === envelope.materialDigest &&
    binding.profileDigest === envelope.profileDigest &&
    binding.canonicalDataRoot === envelope.canonicalDataRoot &&
    binding.canonicalTeamRoot === envelope.canonicalTeamRoot &&
    binding.canonicalTasksRoot === envelope.canonicalTasksRoot &&
    binding.runId === envelope.runId &&
    binding.role === 'native-lead',
  )
}

export async function attachExactHostedNativeLead(params: {
  envelope: HostedNativeLaunchEnvelope
  context: ToolUseContext
  description?: string
}): Promise<{ reused: boolean; team: TeamFile }> {
  const { envelope } = params
  return withTeamFileLockAtCanonicalRoot(
    envelope.canonicalTeamRoot,
    envelope.legacyKey,
    async () => {
      const existing = await readTeamFileAtCanonicalRoot(
        envelope.canonicalTeamRoot,
        envelope.legacyKey,
      )
      if (existing && !hostedBindingMatches(existing, envelope)) {
        throw new Error('Existing team lacks exact hosted native ownership proof')
      }
      const conflicting = existing?.members.find(member =>
        member.agentId !== envelope.primary.agentId &&
        (member.name === envelope.primary.displayName ||
          member.name === TEAM_LEAD_NAME || member.name === 'user'),
      )
      if (conflicting) throw new Error('Hosted native primary identity collides with existing roster')
      const joinedAt = Date.now()
      const primary = {
        agentId: envelope.primary.agentId,
        name: envelope.primary.displayName,
        model: envelope.primary.model,
        provider: envelope.primary.provider,
        ...(envelope.primary.effort ? { effort: envelope.primary.effort as 'low' | 'medium' | 'high' | 'max' } : {}),
        joinedAt,
        tmuxPaneId: `process:${process.pid}`,
        cwd: envelope.canonicalCwd,
        sessionId: getSessionId(),
        processOwnerToken: envelope.launchIdentityToken,
        processRunId: envelope.runId,
        subscriptions: [],
        backendType: 'process' as const,
      }
      const team: TeamFile = {
        name: envelope.legacyKey,
        description: existing?.description ?? params.description,
        createdAt: existing?.createdAt ?? joinedAt,
        leadAgentId: envelope.primary.agentId,
        leadSessionId: getSessionId(),
        members: [primary, ...(existing?.members.filter(member => member.agentId !== primary.agentId) ?? [])],
        hostedNative: {
          version: 1,
          publicTeamId: envelope.publicTeamId,
          legacyKey: envelope.legacyKey,
          primaryDisplayName: envelope.primary.displayName,
          primaryAgentId: envelope.primary.agentId,
          primaryAlias: TEAM_LEAD_NAME,
          launchIdentityToken: envelope.launchIdentityToken,
          envelopeDigest: envelope.envelopeDigest,
          materialDigest: envelope.materialDigest,
          profileDigest: envelope.profileDigest,
          permissionMode: 'bypassPermissions',
          canonicalDataRoot: envelope.canonicalDataRoot,
          canonicalTeamRoot: envelope.canonicalTeamRoot,
          canonicalTasksRoot: envelope.canonicalTasksRoot,
          runId: envelope.runId,
          role: 'native-lead',
          readyAckPath: envelope.readyAckPath,
          mailboxCustody: 'hosted-lead-pump',
        },
      }
      await writeTeamFileAtCanonicalRoot(envelope.canonicalTeamRoot, envelope.legacyKey, team)
      params.context.setAppState(previous => ({
        ...previous,
        teamContext: {
          teamName: envelope.legacyKey,
          teamFilePath: join(envelope.canonicalTeamRoot, 'config.json'),
          leadAgentId: envelope.primary.agentId,
          teammates: {},
        },
      }))
      return { reused: Boolean(existing), team }
    },
  )
}

export async function registerExactHostedExternalLead(params: {
  publicTeamId: string
  legacyKey: string
  canonicalDataRoot: string
  canonicalTeamRoot: string
  canonicalTasksRoot: string
  canonicalCwd: string
  runId: string
  primaryDisplayName: string
  primaryAgentId: string
  sessionId: string
  externalIdentityToken: string
  materialDigest: string
  profileDigest: string
  description?: string
}): Promise<{ reused: boolean; team: TeamFile }> {
  if (sanitizeName(params.legacyKey) !== params.legacyKey ||
    ['team-lead', 'user'].includes(params.primaryDisplayName.toLocaleLowerCase('en-US')) ||
    join(params.canonicalDataRoot, 'teams', params.legacyKey) !== params.canonicalTeamRoot ||
    join(params.canonicalDataRoot, 'tasks', params.legacyKey) !== params.canonicalTasksRoot) {
    throw new Error('External lead metadata does not match the admitted native layout')
  }
  for (const value of [params.materialDigest, params.profileDigest]) assertDigest(value, 'external lead digest')
  return withTeamFileLockAtCanonicalRoot(params.canonicalTeamRoot, params.legacyKey, async () => {
    const existing = await readTeamFileAtCanonicalRoot(params.canonicalTeamRoot, params.legacyKey)
    const exactExisting = existing?.hostedNative?.role === 'external-lead' &&
      existing.hostedNative.publicTeamId === params.publicTeamId &&
      existing.hostedNative.materialDigest === params.materialDigest &&
      existing.hostedNative.profileDigest === params.profileDigest &&
      existing.hostedNative.launchIdentityToken === params.externalIdentityToken &&
      existing.leadAgentId === params.primaryAgentId &&
      existing.leadSessionId === params.sessionId
    if (existing && !exactExisting) {
      throw new Error('Existing team lacks exact external lead ownership proof')
    }
    const now = Date.now()
    const team: TeamFile = existing ?? {
      name: params.legacyKey,
      description: params.description,
      createdAt: now,
      leadAgentId: params.primaryAgentId,
      leadSessionId: params.sessionId,
      members: [{
        agentId: params.primaryAgentId,
        name: params.primaryDisplayName,
        joinedAt: now,
        tmuxPaneId: '',
        cwd: params.canonicalCwd,
        sessionId: params.sessionId,
        subscriptions: [],
        backendType: 'in-process',
      }],
      hostedNative: {
        version: 1,
        publicTeamId: params.publicTeamId,
        legacyKey: params.legacyKey,
        primaryDisplayName: params.primaryDisplayName,
        primaryAgentId: params.primaryAgentId,
        primaryAlias: TEAM_LEAD_NAME,
        launchIdentityToken: params.externalIdentityToken,
        envelopeDigest: params.materialDigest,
        materialDigest: params.materialDigest,
        profileDigest: params.profileDigest,
        permissionMode: 'bypassPermissions',
        canonicalDataRoot: params.canonicalDataRoot,
        canonicalTeamRoot: params.canonicalTeamRoot,
        canonicalTasksRoot: params.canonicalTasksRoot,
        runId: params.runId,
        role: 'external-lead',
        mailboxCustody: 'external-session',
      },
    }
    await writeTeamFileAtCanonicalRoot(params.canonicalTeamRoot, params.legacyKey, team)
    return { reused: Boolean(existing), team }
  })
}

export async function writeHostedNativeReadyAcknowledgement(
  envelope: HostedNativeLaunchEnvelope,
): Promise<HostedNativeReadyAcknowledgement> {
  const startedAt = await readProcessStartTimeMs(process.pid)
  const osIdentity = await captureProcessTreeIdentity(process.pid)
  if (startedAt === null || !osIdentity) {
    throw new Error('Hosted native lead could not capture exact process identity')
  }
  const team = await readTeamFileAtCanonicalRoot(envelope.canonicalTeamRoot, envelope.legacyKey)
  if (!team || !hostedBindingMatches(team, envelope) || team.leadSessionId !== getSessionId()) {
    throw new Error('Hosted native lead attachment changed before acknowledgement')
  }
  const acknowledgement: HostedNativeReadyAcknowledgement = {
    version: 1,
    state: 'ready',
    role: 'native-lead',
    publicTeamId: envelope.publicTeamId,
    legacyKey: envelope.legacyKey,
    runId: envelope.runId,
    primaryAgentId: envelope.primary.agentId,
    primaryDisplayName: envelope.primary.displayName,
    primaryAlias: TEAM_LEAD_NAME,
    sessionId: getSessionId(),
    pid: process.pid,
    processStartedAtMs: startedAt,
    processOsIdentity: osIdentity,
    launchIdentityToken: envelope.launchIdentityToken,
    envelopeDigest: envelope.envelopeDigest,
    materialDigest: envelope.materialDigest,
    profileDigest: envelope.profileDigest,
    settingsDigest: envelope.settingsDigest,
    mcpDigest: envelope.mcpDigest,
    permissionMode: envelope.permissionMode,
    canonicalDataRoot: envelope.canonicalDataRoot,
    canonicalTeamRoot: envelope.canonicalTeamRoot,
    canonicalTasksRoot: envelope.canonicalTasksRoot,
    canonicalCwd: envelope.canonicalCwd,
    mailboxCustody: 'hosted-lead-pump',
    acknowledgedAt: new Date().toISOString(),
  }
  const serialized = `${JSON.stringify(acknowledgement, null, 2)}\n`
  if (Buffer.byteLength(serialized) > MAX_ACK_BYTES) throw new Error('Hosted native acknowledgement is too large')
  await writeFileAtomic(envelope.readyAckPath, serialized, { mode: 0o600 })
  return acknowledgement
}

export async function readHostedNativeReadyAcknowledgement(
  pathValue: string,
): Promise<HostedNativeReadyAcknowledgement> {
  return await readBoundPrivateJson(pathValue, MAX_ACK_BYTES) as HostedNativeReadyAcknowledgement
}

export type HostedNativeMailboxPumpEffects = {
  lstat: typeof lstat
  readFile: typeof readFile
  lock: typeof lockfile.lock
  writeFileAtomic: typeof writeFileAtomic
}

export type HostedNativeMailboxProtocolHandler = (message: {
  from: string
  text: string
}) => Promise<boolean>

const defaultMailboxPumpEffects: HostedNativeMailboxPumpEffects = {
  lstat,
  readFile,
  lock: lockfile.lock,
  writeFileAtomic,
}

class HostedNativePumpStoppedError extends Error {}

async function pumpMailboxOnce(params: {
  envelope: HostedNativeLaunchEnvelope
  hostedInput: HostedInputHandle
  isActive(): boolean
  effects: HostedNativeMailboxPumpEffects
  processProtocolMessage?: HostedNativeMailboxProtocolHandler
}): Promise<void> {
  const assertActive = () => {
    if (!params.isActive() || params.hostedInput.closed) {
      throw new HostedNativePumpStoppedError('Hosted native mailbox pump stopped')
    }
  }
  const inboxPath = join(params.envelope.canonicalTeamRoot, 'inboxes', `${TEAM_LEAD_NAME}.json`)
  assertActive()
  const exists = await params.effects.lstat(inboxPath).then(value => value.isFile() && !value.isSymbolicLink()).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  })
  assertActive()
  if (exists !== true) return
  const release = await params.effects.lock(inboxPath, {
    lockfilePath: `${inboxPath}.lock`, realpath: false,
    retries: { retries: 10, minTimeout: 5, maxTimeout: 100 },
  })
  let mailboxFailed = false
  let mailboxError: unknown
  try {
    assertActive()
    const parsed = jsonParse(await params.effects.readFile(inboxPath, 'utf8'))
    assertActive()
    if (!Array.isArray(parsed) || parsed.some(row => !isRawMailboxMessage(row))) {
      throw new Error('Hosted native lead mailbox is invalid')
    }
    const messages = parsed.map(normalizeTeammateMessage)
    let changed = false
    for (const message of messages) {
      if (message.read || message.claimedBySessionId) continue
      const handled = await params.processProtocolMessage?.({
        from: message.from,
        text: message.text,
      }) ?? false
      assertActive()
      if (!handled) {
        const accepted = params.hostedInput.enqueueUserMessage(
          `<teammate-message teammate_id="${message.from}">${message.text}</teammate-message>`,
        )
        if (!accepted) {
          throw new Error('Hosted native input closed before mailbox enqueue was accepted')
        }
      }
      message.read = true
      message.claimedBySessionId = getSessionId()
      message.claimedAt = new Date().toISOString()
      changed = true
    }
    if (changed) {
      // Enqueue and acknowledgement cannot be transactional. Once enqueue has
      // returned true, this write is the settlement of that accepted custody,
      // not a new poll effect. stop() joins it and reports any failure instead
      // of pretending the accepted turn was never delivered.
      try {
        await params.effects.writeFileAtomic(
          inboxPath,
          `${JSON.stringify(messages, null, 2)}\n`,
          { mode: 0o600 },
        )
      } catch (error) {
        throw new Error(
          'Hosted native mailbox turn was accepted but its acknowledgement is uncertain',
          { cause: error },
        )
      }
    }
  } catch (error) {
    mailboxFailed = true
    mailboxError = error
  }
  try {
    await release()
  } catch (releaseError) {
    if (mailboxFailed) {
      throw new AggregateError(
        [mailboxError, releaseError],
        'Hosted native mailbox processing and lock release both failed',
      )
    }
    throw releaseError
  }
  if (mailboxFailed) throw mailboxError
}

export type HostedNativeLeadMailboxPump = {
  stop(): Promise<void>
}

export function createHostedNativeDispatchSettlementTracker() {
  const active = new Set<Promise<void>>()
  const failures: unknown[] = []
  let onFailure: ((error: unknown) => void) | undefined
  return {
    onFailure(callback: (error: unknown) => void): void {
      onFailure = callback
    },
    dispatch(run: () => Promise<void>): void {
      let settlement: Promise<void>
      try {
        settlement = run()
      } catch (error) {
        settlement = Promise.reject(error)
      }
      active.add(settlement)
      void settlement.then(
        () => active.delete(settlement),
        error => {
          active.delete(settlement)
          failures.push(error)
          try {
            onFailure?.(error)
          } catch (reportingError) {
            failures.push(reportingError)
          }
        },
      )
    },
    async settle(): Promise<void> {
      while (active.size > 0) {
        await Promise.allSettled([...active])
      }
      const retained = failures.splice(0)
      if (retained.length === 1) throw retained[0]
      if (retained.length > 1) {
        throw new AggregateError(retained, 'Hosted native print dispatches failed during settlement')
      }
    },
  }
}

export async function settleHostedNativeConsumerShutdown(params: {
  disposal: Promise<unknown>
  consumer: Promise<unknown>
  settleDispatches: () => Promise<void>
}): Promise<void> {
  let dispatchSettlement: Promise<void>
  try {
    dispatchSettlement = params.settleDispatches()
  } catch (error) {
    dispatchSettlement = Promise.reject(error)
  }
  const settlements = await Promise.allSettled([
    params.disposal,
    params.consumer,
    dispatchSettlement,
  ])
  const failures = settlements.flatMap(settlement =>
    settlement.status === 'rejected' ? [settlement.reason] : [],
  )
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      'Hosted native input disposal, consumer, and dispatch settlement failed',
    )
  }
}

export function shouldContinueHostedNativeDrain(params: {
  isStopping: boolean
  hasRunningBackground: boolean
  hasQueuedCommand: boolean
}): boolean {
  return !params.isStopping && (
    params.hasRunningBackground || params.hasQueuedCommand
  )
}

const liveMailboxPumps = new Map<string, HostedNativeLeadMailboxPump>()

export async function dispatchAfterHostedNativeBarrier<T>(params: {
  isStopping: () => boolean
  prepare: () => Promise<T>
  dispatch: (value: T) => void
}): Promise<boolean> {
  if (params.isStopping()) return false
  const value = await params.prepare()
  // dispatch is synchronous with the final predicate check, so teardown can
  // never interleave between admission and the pending-turn enqueue.
  if (params.isStopping()) return false
  params.dispatch(value)
  return true
}

export async function startHostedNativeLeadMailboxPump(params: {
  envelope: HostedNativeLaunchEnvelope
  hostedInput: HostedInputHandle
  onFatalError(error: Error): void
  isStopping?: () => boolean
  effects?: Partial<HostedNativeMailboxPumpEffects>
  processProtocolMessage?: HostedNativeMailboxProtocolHandler
}): Promise<HostedNativeLeadMailboxPump> {
  const key = params.envelope.launchIdentityToken
  if (liveMailboxPumps.has(key)) {
    throw new Error('Hosted native mailbox pump is already active')
  }

  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<void> | undefined
  let stopPromise: Promise<void> | undefined
  let terminalError: Error | undefined
  const effects = { ...defaultMailboxPumpEffects, ...params.effects }
  const isActive = () => !stopped && !params.isStopping?.()
  let pump!: HostedNativeLeadMailboxPump
  const deregister = () => {
    if (liveMailboxPumps.get(key) === pump) liveMailboxPumps.delete(key)
    process.off('exit', stopOnExit)
  }
  const stop = (): Promise<void> => {
    stopped = true
    if (timer) clearTimeout(timer)
    timer = undefined
    if (!stopPromise) {
      const pending = inFlight
      stopPromise = (pending
        ? pending.catch(error => { throw error })
        : terminalError
          ? Promise.reject(terminalError)
          : Promise.resolve())
        .finally(deregister)
    }
    return stopPromise
  }
  const stopOnExit = () => { void stop().catch(() => {}) }
  pump = { stop }

  // The map entry is the reservation. Publish it before the first await so
  // simultaneous starts cannot both acquire custody for the same token.
  liveMailboxPumps.set(key, pump)
  process.once('exit', stopOnExit)

  const delay = Math.max(
    50,
    Math.min(
      5_000,
      params.envelope.mailboxPollMs ?? DEFAULT_MAILBOX_POLL_MS,
    ),
  )
  const runPass = async (startup: boolean): Promise<void> => {
    if (!isActive() || params.hostedInput.closed) {
      if (startup) {
        throw new Error('Hosted native input closed before mailbox pump startup')
      }
      stopped = true
      if (timer) clearTimeout(timer)
      timer = undefined
      deregister()
      return
    }
    const operation = pumpMailboxOnce({
      envelope: params.envelope,
      hostedInput: params.hostedInput,
      isActive,
      effects,
      processProtocolMessage: params.processProtocolMessage,
    })
    // Cancellation is expected settlement. Preserve genuine read/write/
    // release failures, including accepted-but-unacknowledged write failure.
    const pass = operation.catch(error => {
      if (error instanceof HostedNativePumpStoppedError && !isActive()) return
      throw error
    })
    inFlight = pass
    try {
      await pass
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error))
      if (startup) throw normalized
      if (stopped) throw normalized
      terminalError = normalized
      stopped = true
      if (timer) clearTimeout(timer)
      timer = undefined
      deregister()
      params.onFatalError(normalized)
    } finally {
      if (inFlight === pass) inFlight = undefined
    }
  }
  const scheduleNext = () => {
    if (!isActive()) return
    // Recursive timeout scheduling makes the entire runtime single-flight:
    // the next timer is not created until the preceding poll has settled.
    timer = setTimeout(() => {
      timer = undefined
      const scheduled = runPass(false).finally(scheduleNext)
      // The pass itself is retained by stop(). Observe the completion chain as
      // well so its finally descendant cannot become an unhandled rejection.
      void scheduled.catch(error => {
        if (!stopPromise && !terminalError) {
          const normalized = error instanceof Error ? error : new Error(String(error))
          terminalError = normalized
          stopped = true
          deregister()
          params.onFatalError(normalized)
        }
      })
    }, delay)
  }

  try {
    await runPass(true)
    if (!isActive()) throw new Error('Hosted native mailbox pump stopped during startup')
    scheduleNext()
    return pump
  } catch (error) {
    try {
      await stop()
    } catch (stopError) {
      throw new AggregateError(
        [error, stopError],
        'Hosted native mailbox pump startup and stop settlement both failed',
      )
    }
    throw error
  }
}

export async function publishHostedNativeReady(params: {
  envelope: HostedNativeLaunchEnvelope
  pump: HostedNativeLeadMailboxPump
  isStopping: () => boolean
  write?: typeof writeHostedNativeReadyAcknowledgement
  remove?: typeof rm
}): Promise<HostedNativeReadyAcknowledgement> {
  const remove = params.remove ?? rm
  let cancellationError: Error | undefined
  const assertLive = () => {
    if (params.isStopping()) {
      cancellationError = new Error('Hosted native startup stopped before readiness')
      throw cancellationError
    }
  }
  try {
    assertLive()
    const acknowledgement = await (params.write ?? writeHostedNativeReadyAcknowledgement)(params.envelope)
    if (params.isStopping()) {
      cancellationError = new Error(
        'Hosted native startup stopped during readiness publication',
      )
      // Atomic publication may already have crossed its rename boundary. Do
      // not allow that transient file to survive the cancellation handshake.
      await remove(params.envelope.readyAckPath, { force: true })
      throw cancellationError
    }
    return acknowledgement
  } catch (error) {
    const failures: unknown[] = [error]
    if (params.isStopping()) {
      cancellationError ??= new Error(
        'Hosted native startup stopped during readiness publication',
      )
      if (error !== cancellationError) failures.push(cancellationError)
      let removalAttempt: Promise<unknown>
      try {
        removalAttempt = remove(params.envelope.readyAckPath, { force: true })
      } catch (removalError) {
        removalAttempt = Promise.reject(removalError)
      }
      const removal = await Promise.allSettled([removalAttempt])
      if (removal[0]?.status === 'rejected') failures.push(removal[0].reason)
    }
    let stopAttempt: Promise<unknown>
    try {
      stopAttempt = params.pump.stop()
    } catch (stopError) {
      stopAttempt = Promise.reject(stopError)
    }
    const stopped = await Promise.allSettled([stopAttempt])
    if (stopped[0]?.status === 'rejected') failures.push(stopped[0].reason)
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        'Hosted native readiness publication and cancellation cleanup did not fully settle',
      )
    }
    throw failures[0]
  }
}

export function assertHostedNativeRuntimeSelection(params: {
  envelope: HostedNativeLaunchEnvelope
  provider: HostedNativeProvider
  model: string
  permissionMode: string
}): void {
  if (
    params.provider !== params.envelope.primary.provider ||
    params.model !== params.envelope.primary.model ||
    params.permissionMode !== params.envelope.permissionMode
  ) throw new Error('Hosted native effective runtime does not match admitted launch material')
}
