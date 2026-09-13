import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import type { HostedNativeProvider } from 'src/services/teamBootstrap/hostedNativeLaunch.js'
import { sanitizeAgentName, sanitizeName } from 'src/utils/swarm/teamHelpers.js'

export type NativeProcessRuntime = HostedNativeProvider | 'opencode'

export type NativeProcessMemberSelection = Readonly<{
  ordinal: number
  laneId: string
  displayName: string
  agentId: string
  provider: NativeProcessRuntime
  model: string
  effort?: string
  prompt: string
  agentType?: string
}>

export type NativeResolvedProviderProfile = Readonly<{
  provider: NativeProcessRuntime
  selectedBackendId: string | null
  resolvedBackendId: string | null
  resolvedLaunchModel: string
  endpointIdentity: string
  configurationIdentity: string
  authHandleRevision: string
  accessAdmissionId: string
  environmentRef: string
  frozenEnv: Readonly<Record<string, string>>
}>

export type NativeAdmittedFile = Readonly<{
  canonicalPath: string
  sha256: `sha256:${string}`
}>

export type NativeAdmittedExecutable = NativeAdmittedFile & Readonly<{
  executableRef: string
  binaryId: string
  binaryRevision: number
  binaryHash: `sha256:${string}`
}>

export type NativeProcessLaunchMaterialRequest = Readonly<{
  publicTeamId: string
  legacyKey: string
  canonicalDataRoot: string
  canonicalTeamRoot: string
  canonicalTasksRoot: string
  canonicalCwd: string
  runId: string
  attemptSetId: string
  ownerBootId: string
  ownerControllerInstanceId: string
  ownerPlanGeneration: string
  productPlanGeneration: number
  /** sha256 of the exact Product planRef object; the launchSpec retains the object itself. */
  productPlanRef: `sha256:${string}`
  workdirRef: string
  primaryOrdinal: number
  members: readonly NativeProcessMemberSelection[]
  cli: Readonly<{
    executable: NativeAdmittedExecutable
    argv: readonly string[]
    argvKind: 'executable-only' | 'source-entry'
    sourceEntryArgIndex?: number
    sourceModule?: NativeAdmittedFile
  }>
  settings: NativeAdmittedFile
  mcpConfig: NativeAdmittedFile
  permissionMode: 'bypassPermissions'
  disallowedTools: readonly string[]
  strictMcpConfig: true
  profiles: readonly NativeResolvedProviderProfile[]
  anchorCapability: Readonly<{ admissionId: string; version: 1; hash: `sha256:${string}` }>
}>

export type NativeDirectoryIdentity = Readonly<{ canonicalPath: string; dev: number; ino: number }>

export type NativeResolvedMemberMaterial = NativeProcessMemberSelection & Readonly<{
  profile: NativeResolvedProviderProfile
  profileDigest: string
}>

export type NativeProcessLaunchMaterial = Readonly<{
  version: 1
  publicTeamId: string
  legacyKey: string
  roots: Readonly<{ data: NativeDirectoryIdentity; team: NativeDirectoryIdentity; tasks: NativeDirectoryIdentity; cwd: NativeDirectoryIdentity }>
  runId: string
  attemptSetId: string
  ownerBootId: string
  ownerControllerInstanceId: string
  ownerPlanGeneration: string
  productPlanGeneration: number
  productPlanRef: `sha256:${string}`
  workdirRef: string
  primaryOrdinal: number
  primaryAlias: 'team-lead'
  cli: Readonly<{ executable: NativeAdmittedExecutable; argv: readonly string[]; argvKind: 'executable-only' | 'source-entry'; sourceEntryArgIndex?: number; sourceModule?: NativeAdmittedFile; identityDigest: string }>
  settings: NativeAdmittedFile
  mcpConfig: NativeAdmittedFile
  permissionMode: 'bypassPermissions'
  disallowedTools: readonly string[]
  strictMcpConfig: true
  anchorCapability: NativeProcessLaunchMaterialRequest['anchorCapability']
  members: readonly NativeResolvedMemberMaterial[]
  materialDigest: string
}>

const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_CODE_BYTES = 512 * 1024 * 1024
const CAPABILITY_HASH = 'sha256:8ef0fab620172bdb761af87fc471cb3a1abb46710f148037762cee5d403720b5'

function sha256Tagged(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.includes('\0') || Buffer.byteLength(value) > 16 * 1024) {
    throw new Error(`Invalid native launch ${label}`)
  }
}

function digest(value: unknown, label: string): asserts value is `sha256:${string}` {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid native launch ${label}`)
}

async function directoryIdentity(pathValue: string, label: string): Promise<NativeDirectoryIdentity> {
  if (!isAbsolute(pathValue) || resolve(pathValue) !== pathValue || await realpath(pathValue) !== pathValue) {
    throw new Error(`Native launch ${label} is not absolute and canonical`)
  }
  const handle = await open(pathValue, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0))
  try {
    const [opened, current] = await Promise.all([handle.stat(), lstat(pathValue)])
    if (!opened.isDirectory() || !current.isDirectory() || current.isSymbolicLink() || opened.dev !== current.dev || opened.ino !== current.ino ||
      (opened.mode & 0o022) !== 0 || (process.getuid?.() !== undefined && opened.uid !== process.getuid())) {
      throw new Error(`Native launch ${label} is not a private stable directory`)
    }
    return Object.freeze({ canonicalPath: pathValue, dev: opened.dev, ino: opened.ino })
  } finally { await handle.close() }
}

async function verifyFile(file: NativeAdmittedFile, label: string, code: 'executable' | 'module' | false = false, json = false): Promise<NativeAdmittedFile> {
  text(file?.canonicalPath, `${label} path`); digest(file?.sha256, `${label} digest`)
  if (!isAbsolute(file.canonicalPath) || resolve(file.canonicalPath) !== file.canonicalPath || await realpath(file.canonicalPath) !== file.canonicalPath) {
    throw new Error(`Native launch ${label} is not absolute and canonical`)
  }
  const handle = await open(file.canonicalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const [opened, current] = await Promise.all([handle.stat(), lstat(file.canonicalPath)])
    const unsafeMode = code ? (opened.mode & 0o022) !== 0 || (code === 'executable' && (opened.mode & 0o111) === 0) : (opened.mode & 0o077) !== 0
    if (!opened.isFile() || !current.isFile() || current.isSymbolicLink() || opened.dev !== current.dev || opened.ino !== current.ino ||
      opened.size < 1 || opened.size > (code ? MAX_CODE_BYTES : MAX_FILE_BYTES) || unsafeMode ||
      (!code && process.getuid?.() !== undefined && opened.uid !== process.getuid())) {
      throw new Error(`Native launch ${label} is not a private stable file`)
    }
    const bytes = await handle.readFile()
    if (sha256Tagged(bytes) !== file.sha256) throw new Error(`Native launch ${label} changed after admission`)
    if (json) {
      try { JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch (error) { throw new Error(`Native launch ${label} is not admitted JSON`, { cause: error }) }
    }
    return Object.freeze({ ...file })
  } finally { await handle.close() }
}

function validateRequest(request: NativeProcessLaunchMaterialRequest): void {
  for (const [label, value] of Object.entries({ publicTeamId: request.publicTeamId, legacyKey: request.legacyKey, runId: request.runId,
    attemptSetId: request.attemptSetId, ownerBootId: request.ownerBootId, ownerControllerInstanceId: request.ownerControllerInstanceId,
    ownerPlanGeneration: request.ownerPlanGeneration, workdirRef: request.workdirRef })) text(value, label)
  digest(request.productPlanRef, 'Product plan ref')
  if (sanitizeName(request.legacyKey) !== request.legacyKey) throw new Error('Native launch legacy key is not canonical')
  if (!Number.isSafeInteger(request.productPlanGeneration) || request.productPlanGeneration < 0) throw new Error('Invalid Product plan generation')
  if (request.permissionMode !== 'bypassPermissions' || request.strictMcpConfig !== true) throw new Error('Native launch fixed permission controls are required')
  if (request.members.length === 0 || request.members.length > 256 || request.profiles.length !== request.members.length) throw new Error('Native launch requires bounded whole-roster profile evidence')
  if (request.anchorCapability?.version !== 1 || request.anchorCapability.hash !== CAPABILITY_HASH) throw new Error('Native launch admitted anchor capability mismatch')
  text(request.anchorCapability.admissionId, 'anchor admission')
  const ordinals = new Set<number>(); const names = new Set<string>(); const ids = new Set<string>()
  let previous = -1
  for (let index = 0; index < request.members.length; index += 1) {
    const member = request.members[index]!
    if (!['anthropic', 'codex', 'gemini', 'opencode'].includes(member.provider)) throw new Error('Native launch member provider is unsupported')
    if (!Number.isSafeInteger(member.ordinal) || member.ordinal < 0 || member.ordinal <= previous || ordinals.has(member.ordinal)) {
      throw new Error('Native launch roster order or ordinal is ambiguous')
    }
    previous = member.ordinal; ordinals.add(member.ordinal)
    for (const [label, value] of Object.entries({ laneId: member.laneId, displayName: member.displayName, agentId: member.agentId, model: member.model, prompt: member.prompt })) text(value, `member ${label}`)
    const folded = member.displayName.toLocaleLowerCase('en-US')
    if (sanitizeAgentName(member.displayName) !== member.displayName || folded === 'team-lead' || folded === 'user' || names.has(folded) || ids.has(member.agentId)) {
      throw new Error('Native launch roster identity is invalid or duplicated')
    }
    names.add(folded); ids.add(member.agentId)
    if (member.effort !== undefined) text(member.effort, 'member effort')
    if (member.agentType !== undefined) text(member.agentType, 'member agent type')
    const profile = request.profiles[index]!
    if (profile.provider !== member.provider || profile.resolvedLaunchModel !== member.model) throw new Error('Native launch profile selection mismatch')
    for (const [label, value] of Object.entries({ endpointIdentity: profile.endpointIdentity, configurationIdentity: profile.configurationIdentity,
      authHandleRevision: profile.authHandleRevision, accessAdmissionId: profile.accessAdmissionId, environmentRef: profile.environmentRef })) text(value, `profile ${label}`)
    const environment = Object.entries(profile.frozenEnv)
    if (environment.length > 512) throw new Error('Native launch frozen environment is too large')
    for (const [key, value] of environment) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > 64 * 1024) {
        throw new Error('Invalid frozen environment entry')
      }
    }
  }
  if (!ordinals.has(request.primaryOrdinal)) throw new Error('Native launch primary ordinal is missing')
  text(request.cli.executable.executableRef, 'executable ref'); text(request.cli.executable.binaryId, 'binary id')
  if (!Number.isSafeInteger(request.cli.executable.binaryRevision) || request.cli.executable.binaryRevision < 0) throw new Error('Invalid executable revision')
  digest(request.cli.executable.binaryHash, 'binary hash')
  if (request.cli.executable.binaryHash !== request.cli.executable.sha256) throw new Error('Executable admission hashes disagree')
  if (request.cli.argv.length > 512) throw new Error('Native launch argv is too large')
  request.cli.argv.forEach((arg, index) => text(arg, `argv ${index}`))
  const fixedFlags = new Set(['--model', '--effort', '--settings', '--mcp-config', '--strict-mcp-config', '--permission-mode', '--dangerously-skip-permissions',
    '--teammate-runtime', '--agent-id', '--agent-name', '--team-name', '--parent-session-id', '--process-owner-token', '--hosted-native-launch', '--hosted-native-launch-identity'])
  if (request.cli.argv.some(arg => fixedFlags.has(arg.split('=', 1)[0]!))) throw new Error('Admitted base argv attempts to override fixed native controls')
  if (request.cli.argvKind === 'source-entry') {
    if (!request.cli.sourceModule || !Number.isSafeInteger(request.cli.sourceEntryArgIndex) || request.cli.sourceEntryArgIndex! < 0 ||
      request.cli.argv[request.cli.sourceEntryArgIndex!] !== request.cli.sourceModule.canonicalPath) throw new Error('Native source argv lacks exact admitted module association')
  } else if (request.cli.argvKind !== 'executable-only' || request.cli.sourceModule || request.cli.sourceEntryArgIndex !== undefined) {
    throw new Error('Native executable argv kind is inconsistent')
  }
  request.disallowedTools.forEach(tool => text(tool, 'disallowed tool'))
}

export async function resolveNativeProcessLaunchMaterial(request: NativeProcessLaunchMaterialRequest): Promise<NativeProcessLaunchMaterial> {
  validateRequest(request)
  const [data, team, tasks, cwd, executable, settings, mcpConfig, sourceModule] = await Promise.all([
    directoryIdentity(request.canonicalDataRoot, 'data root'), directoryIdentity(request.canonicalTeamRoot, 'team root'),
    directoryIdentity(request.canonicalTasksRoot, 'tasks root'), directoryIdentity(request.canonicalCwd, 'cwd'),
    verifyFile(request.cli.executable, 'CLI executable', 'executable'), verifyFile(request.settings, 'settings', false, true), verifyFile(request.mcpConfig, 'MCP config', false, true),
    request.cli.sourceModule ? verifyFile(request.cli.sourceModule, 'source module', 'module') : Promise.resolve(undefined),
  ])
  if (team.canonicalPath !== join(data.canonicalPath, 'teams', request.legacyKey) || tasks.canonicalPath !== join(data.canonicalPath, 'tasks', request.legacyKey)) {
    throw new Error('Native launch roots do not match the admitted native layout')
  }
  const members = request.members.map((member, index): NativeResolvedMemberMaterial => {
    const profile = Object.freeze({ ...request.profiles[index]!, frozenEnv: Object.freeze({ ...request.profiles[index]!.frozenEnv }) })
    return Object.freeze({ ...member, profile, profileDigest: sha256(stable(profile)) })
  })
  const cli = Object.freeze({ executable: Object.freeze({ ...request.cli.executable, ...executable }), argv: Object.freeze([...request.cli.argv]), argvKind: request.cli.argvKind,
    ...(request.cli.sourceEntryArgIndex === undefined ? {} : { sourceEntryArgIndex: request.cli.sourceEntryArgIndex }),
    ...(sourceModule ? { sourceModule } : {}), identityDigest: sha256(stable({ executable, argv: request.cli.argv, argvKind: request.cli.argvKind,
      sourceEntryArgIndex: request.cli.sourceEntryArgIndex, sourceModule })) })
  const base = { version: 1 as const, publicTeamId: request.publicTeamId, legacyKey: request.legacyKey, roots: Object.freeze({ data, team, tasks, cwd }),
    runId: request.runId, attemptSetId: request.attemptSetId, ownerBootId: request.ownerBootId, ownerControllerInstanceId: request.ownerControllerInstanceId,
    ownerPlanGeneration: request.ownerPlanGeneration, productPlanGeneration: request.productPlanGeneration, productPlanRef: request.productPlanRef, workdirRef: request.workdirRef,
    primaryOrdinal: request.primaryOrdinal, primaryAlias: 'team-lead' as const, cli, settings, mcpConfig, permissionMode: request.permissionMode,
    disallowedTools: Object.freeze([...request.disallowedTools]), strictMcpConfig: request.strictMcpConfig, anchorCapability: Object.freeze({ ...request.anchorCapability }),
    members: Object.freeze(members) }
  return Object.freeze({ ...base, materialDigest: sha256(stable(base)) })
}

export async function preflightNativeProcessLaunch(material: NativeProcessLaunchMaterial): Promise<void> {
  const refreshed = await resolveNativeProcessLaunchMaterial({ publicTeamId: material.publicTeamId, legacyKey: material.legacyKey,
    canonicalDataRoot: material.roots.data.canonicalPath, canonicalTeamRoot: material.roots.team.canonicalPath, canonicalTasksRoot: material.roots.tasks.canonicalPath,
    canonicalCwd: material.roots.cwd.canonicalPath, runId: material.runId, attemptSetId: material.attemptSetId, ownerBootId: material.ownerBootId,
    ownerControllerInstanceId: material.ownerControllerInstanceId, ownerPlanGeneration: material.ownerPlanGeneration, productPlanGeneration: material.productPlanGeneration,
    productPlanRef: material.productPlanRef, workdirRef: material.workdirRef, primaryOrdinal: material.primaryOrdinal, members: material.members, cli: material.cli, settings: material.settings,
    mcpConfig: material.mcpConfig, permissionMode: material.permissionMode, disallowedTools: material.disallowedTools, strictMcpConfig: material.strictMcpConfig,
    profiles: material.members.map(member => member.profile), anchorCapability: material.anchorCapability })
  if (refreshed.materialDigest !== material.materialDigest) throw new Error('Native launch material changed after admission')
}
