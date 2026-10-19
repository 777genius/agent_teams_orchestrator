import { types } from 'node:util'
import type { ConfigEntry } from '@opencode/client'
import { projectOpenCodeV2LocationCause, readOpenCodeV2ServerFailure, type OpenCodeV2ServerFailure } from '../../src/services/opencode/execution/OpenCodeV2ServerFailure.js'
import { readWindowsCommandResolveFailure, windowsCommandResolvePhases, type WindowsCommandResolveFailure } from '../../src/services/opencode/host/windows/OpenCodeV2WindowsRuntime.js'
import { executionProfileGuards } from '../../src/services/opencode/host/OpenCodeV2ExecutionBinding.js'
import { readWindowsRealpathFailure, type WindowsRealpathFailure } from '../../src/services/opencode/host/windows/OpenCodeV2WindowsRealpath.js'

export const shellProbePermissions = [{ action: '*', resource: '*', effect: 'deny' },
  { action: 'shell', resource: '*', effect: 'allow' }] as const
// Actual selected Config.Info decodes this document in the portable contract
// test, before any Windows runtime is launched. No provider request is made.
const shellProbeConfig = {
  update: 'disable', share: 'disabled', snapshots: false, warming: false, plugins: [],
  model: 'TEST-provider/TEST-model', default_agent: 'TEST-shell-agent',
  providers: { 'TEST-provider': { name: 'TEST no-model provider', env: [], package: 'aisdk:@ai-sdk/openai-compatible',
    settings: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'TEST-never-used' }, models: {
      'TEST-model': { modelID: 'TEST-never-requested', name: 'TEST model', capabilities: { tools: true, input: ['text'], output: ['text'] },
        limit: { context: 8192, output: 512 } } } } },
  agents: { 'TEST-shell-agent': { mode: 'primary', model: 'TEST-provider/TEST-model', permissions: [...shellProbePermissions] } },
} satisfies Extract<ConfigEntry, { type: 'document' }>['info']

export function createShellProbeConfig(controllerRoot: string, bun: string) {
  return { ...shellProbeConfig, mcp: { servers: { 'agent-teams': {
    type: 'local', command: [bun, '--version'], disabled: true,
    environment: { AGENT_TEAMS_MCP_CLAUDE_DIR: controllerRoot },
  } } } } satisfies Extract<ConfigEntry, { type: 'document' }>['info']
}

// TEST-only observations. Neither strings nor Error objects cross the child
// pipe; the parent receives only these source-owned finite values.
export const shellProbeStages = ['prepare', 'profile-validation', 'profile-cwd', 'project-name', 'entry-digest',
  'bun-digest', 'profile-environment', 'node-realpath', 'node-parent', 'program-realpath', 'program-parent',
  'node-digest', 'program-digest', 'marker', 'graph', 'runtime', 'services', 'session', 'instance', 'instance-body', 'plugin-activation', 'agent-service', 'agent-get', 'agent-identity',
  'shell-select', 'tool-snapshot', 'tool-execute', 'complete'] as const
export const shellProbeMethods = ['close', 'endStdin', 'identity', 'kill', 'outputLimit', 'readOutput', 'resolve',
  'retire', 'spawn', 'status', 'stdinAlreadyBound', 'unsupportedCommand', 'unsupportedDescriptor',
  'unsupportedSignal', 'unsupportedUnref', 'validateOutput', 'writeStdin'] as const
const shellProbeErrnos = ['EPERM', 'EACCES', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EINVAL', 'UNKNOWN', 'EIO', 'ENOSYS'] as const
const shellProbeOperations = ['realpath', 'open', 'read', 'lstat', 'stat'] as const
type ShellProbeResolution = WindowsCommandResolveFailure & Readonly<{ realpath?: WindowsRealpathFailure }>
type ShellProbeCauseDetail = Omit<OpenCodeV2ServerFailure, 'operation' | 'kind'>
export type ShellProbeFailure = Readonly<{ kind: 'Fail' | 'Die' | 'Interrupt' | 'unknown';
  method: typeof shellProbeMethods[number] | null; profileGuard?: typeof executionProfileGuards[number]
  errno?: typeof shellProbeErrnos[number]; operation?: typeof shellProbeOperations[number]; realpath?: WindowsRealpathFailure; detail?: ShellProbeCauseDetail; resolution?: ShellProbeResolution }>
export type ShellProbeResult = Readonly<{
  stage: typeof shellProbeStages[number]; succeeded: boolean; sessionCreated: boolean
  registeredShell: boolean; shell: 'cmd' | 'powershell' | 'pwsh' | 'bash' | 'other' | null
  markerPresent: boolean; failure: ShellProbeFailure | null
}>
const data = (value: unknown, key: string): unknown => value !== null && typeof value === 'object' && !types.isProxy(value)
  ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined

/** Pregraph diagnostics describe the exact thrown error only. Native facts
 * come from the existing private WeakMap, never caller-supplied properties. */
export function shellProbeSetupFailure(error: unknown): ShellProbeFailure {
  try {
    const profileGuard = executionProfileGuards.find(value => value === data(error, 'profileGuard'))
    const errno = shellProbeErrnos.find(value => value === data(error, 'code'))
    const operation = shellProbeOperations.find(value => value === data(error, 'syscall'))
    const realpath = readWindowsRealpathFailure(error)
    return Object.freeze({ kind: 'unknown', method: null, ...(profileGuard ? { profileGuard } : {}),
      ...(errno ? { errno } : {}), ...(operation ? { operation } : {}), ...(realpath ? { realpath } : {}) })
  } catch { return Object.freeze({ kind: 'unknown', method: null }) }
}

function readRealpathFailure(value: unknown): WindowsRealpathFailure | undefined {
  const status = data(value, 'status'), operation = data(value, 'operation'), win32 = data(value, 'win32')
  const anchorCount = data(value, 'anchorCount'), matchingAnchorIndex = data(value, 'matchingAnchorIndex')
  if (![status, operation, win32, anchorCount, matchingAnchorIndex].every(Number.isSafeInteger) ||
      Number(status) < 1 || Number(status) > 4 || Number(operation) < 0 || Number(operation) > 25 ||
      Number(win32) < 0 || Number(win32) > 0xffffffff || Number(anchorCount) < 0 || Number(anchorCount) > 4096 ||
      Number(matchingAnchorIndex) < -1 || Number(matchingAnchorIndex) >= Number(anchorCount)) return undefined
  return Object.freeze({ status, operation, win32, anchorCount, matchingAnchorIndex }) as WindowsRealpathFailure
}

function readCommandResolution(value: unknown): ShellProbeResolution | undefined {
  const phase = windowsCommandResolvePhases.find(phase => phase === data(value, 'phase'))
  if (!phase) return undefined
  const errno = shellProbeErrnos.find(errno => errno === data(value, 'errno'))
  const operation = (['realpath', 'stat', 'open'] as const).find(operation => operation === data(value, 'operation'))
  const realpath = readRealpathFailure(data(value, 'realpath'))
  return Object.freeze({ phase, ...(errno ? { errno } : {}), ...(operation ? { operation } : {}), ...(realpath ? { realpath } : {}) })
}

const causeDetailFields = ['tag', 'name', 'module', 'method', 'reason', 'errno', 'sqlCode', 'realpath'] as const
function readCauseDetail(value: unknown, kind: ShellProbeFailure['kind']): ShellProbeCauseDetail | undefined {
  const fields = Object.fromEntries(causeDetailFields.map(key => [key, data(value, key)]).filter(([, value]) => value !== undefined))
  if (Object.keys(fields).length === 0) return undefined
  const checked = readOpenCodeV2ServerFailure({ operation: 'location', kind, ...fields })
  if (!checked) return undefined
  // Reuse only the closed error vocabulary; this TEST observation does not
  // claim that the failure came from an HTTP location request.
  const { operation: _operation, kind: _kind, ...detail } = checked
  return Object.freeze(detail)
}

/** One selected Effect cause leaf, then that leaf's own-data error chain.
 * Match only the exact selected PlatformError formatter used by the adapter.
 * Never retain a raw message, path, command, stack, or unrelated cause leaf. */
export function shellProbeFailure(cause: unknown): ShellProbeFailure {
  try {
    const reasons = data(cause, 'reasons')
    const leaf = Array.isArray(reasons) && !types.isProxy(reasons) ? data(reasons, '0') : undefined
    const tag = data(leaf, '_tag'), kind = tag === 'Fail' || tag === 'Die' || tag === 'Interrupt' ? tag : 'unknown'
    let error = data(leaf, kind === 'Fail' ? 'error' : 'defect')
    const seen = new Set<object>()
    for (let depth = 0; depth < 8; depth++) {
      if (error === null || typeof error !== 'object' || types.isProxy(error) || seen.has(error)) break
      seen.add(error)
      // The formatter has no path in this SDK adapter. Read source-owned data
      // fields rather than executing the PlatformError/SystemError getters.
      const reason = data(error, 'reason')
      if (data(error, '_tag') === 'PlatformError' && data(reason, '_tag') === 'Unknown' &&
          data(reason, 'module') === 'ChildProcess' && data(reason, 'pathOrDescriptor') === undefined &&
          data(reason, 'description') === 'Windows owned command operation failed') {
        const method = shellProbeMethods.find(value => value === data(reason, 'method'))
        if (method) {
          const observed = readWindowsCommandResolveFailure(error)
          const resolution = observed && readCommandResolution({ ...observed, realpath: readWindowsRealpathFailure(error) })
          return Object.freeze({ kind, method, ...(resolution ? { resolution } : {}) })
        }
      }
      error = [reason, data(error, 'error'), data(error, 'cause')].find(value => value !== null && typeof value === 'object')
    }
    // The production projector normally chooses the first noninterrupt leaf.
    // Give it only our already chosen leaf, so fields can never cross leaves.
    const projected = projectOpenCodeV2LocationCause({ reasons: leaf === undefined ? [] : [leaf] })
    const detail = readCauseDetail(projected, kind)
    return Object.freeze({ kind, method: null, ...(detail ? { detail } : {}) })
  } catch { return Object.freeze({ kind: 'unknown', method: null }) }
}

export function readShellProbeResult(value: unknown): ShellProbeResult | undefined {
  try {
    const stage = shellProbeStages.find(stage => stage === data(value, 'stage'))
    const succeeded = data(value, 'succeeded'), sessionCreated = data(value, 'sessionCreated')
    const registeredShell = data(value, 'registeredShell'), markerPresent = data(value, 'markerPresent')
    const shell = data(value, 'shell'), source = data(value, 'failure')
    if (!stage || [succeeded, sessionCreated, registeredShell, markerPresent].some(value => typeof value !== 'boolean') ||
        !(shell === null || typeof shell === 'string' && ['cmd', 'powershell', 'pwsh', 'bash', 'other'].includes(shell))) return undefined
    let failure: ShellProbeFailure | null = null
    if (source !== null) {
      const kind = data(source, 'kind'), method = data(source, 'method')
      if (!(typeof kind === 'string' && ['Fail', 'Die', 'Interrupt', 'unknown'].includes(kind)) ||
          !(method === null || shellProbeMethods.includes(method as typeof shellProbeMethods[number]))) return undefined
      const profileGuard = executionProfileGuards.find(value => value === data(source, 'profileGuard'))
      const errno = shellProbeErrnos.find(value => value === data(source, 'errno'))
      const operation = shellProbeOperations.find(value => value === data(source, 'operation'))
      const realpath = readRealpathFailure(data(source, 'realpath'))
      const detail = readCauseDetail(data(source, 'detail'), kind as ShellProbeFailure['kind'])
      const resolution = readCommandResolution(data(source, 'resolution'))
      failure = Object.freeze({ kind, method, ...(profileGuard ? { profileGuard } : {}), ...(errno ? { errno } : {}),
        ...(operation ? { operation } : {}), ...(realpath ? { realpath } : {}), ...(detail ? { detail } : {}), ...(resolution ? { resolution } : {}) }) as ShellProbeFailure
    }
    if (succeeded && (stage !== 'complete' || !sessionCreated || !registeredShell || !markerPresent || failure !== null)) return undefined
    return Object.freeze({ stage, succeeded, sessionCreated, registeredShell, shell, markerPresent, failure }) as ShellProbeResult
  } catch { return undefined }
}
