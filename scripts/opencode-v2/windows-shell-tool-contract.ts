import { types } from 'node:util'
import type { ConfigEntry } from '@opencode/client'

export const shellProbePermissions = [{ action: '*', resource: '*', effect: 'deny' },
  { action: 'shell', resource: '*', effect: 'allow' }] as const
// Actual selected Config.Info decodes this document in the portable contract
// test, before any Windows runtime is launched. No provider request is made.
export const shellProbeConfig = {
  update: 'disable', share: 'disabled', snapshots: false, warming: false, plugins: [],
  model: 'TEST-provider/TEST-model', default_agent: 'TEST-shell-agent',
  providers: { 'TEST-provider': { name: 'TEST no-model provider', env: [], package: 'aisdk:@ai-sdk/openai-compatible',
    settings: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'TEST-never-used' }, models: {
      'TEST-model': { modelID: 'TEST-never-requested', name: 'TEST model', capabilities: { tools: true, input: ['text'], output: ['text'] },
        limit: { context: 8192, output: 512 } } } } },
  agents: { 'TEST-shell-agent': { mode: 'primary', model: 'TEST-provider/TEST-model', permissions: [...shellProbePermissions] } },
} satisfies Extract<ConfigEntry, { type: 'document' }>['info']

// TEST-only observations. Neither strings nor Error objects cross the child
// pipe; the parent receives only these source-owned finite values.
export const shellProbeStages = ['prepare', 'profile', 'graph', 'runtime', 'services', 'session', 'instance',
  'shell-select', 'tool-snapshot', 'tool-execute', 'complete'] as const
export const shellProbeMethods = ['close', 'endStdin', 'identity', 'kill', 'outputLimit', 'readOutput', 'resolve',
  'retire', 'spawn', 'status', 'stdinAlreadyBound', 'unsupportedCommand', 'unsupportedDescriptor',
  'unsupportedSignal', 'unsupportedUnref', 'validateOutput', 'writeStdin'] as const
export type ShellProbeFailure = Readonly<{ kind: 'Fail' | 'Die' | 'Interrupt' | 'unknown';
  method: typeof shellProbeMethods[number] | null }>
export type ShellProbeResult = Readonly<{
  stage: typeof shellProbeStages[number]; succeeded: boolean; sessionCreated: boolean
  registeredShell: boolean; shell: 'cmd' | 'powershell' | 'pwsh' | 'bash' | 'other' | null
  markerPresent: boolean; failure: ShellProbeFailure | null
}>
const data = (value: unknown, key: string): unknown => value !== null && typeof value === 'object' && !types.isProxy(value)
  ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined

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
        if (method) return Object.freeze({ kind, method })
      }
      error = [reason, data(error, 'error'), data(error, 'cause')].find(value => value !== null && typeof value === 'object')
    }
    return Object.freeze({ kind, method: null })
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
      failure = Object.freeze({ kind, method }) as ShellProbeFailure
    }
    if (succeeded && (stage !== 'complete' || !sessionCreated || !registeredShell || !markerPresent || failure !== null)) return undefined
    return Object.freeze({ stage, succeeded, sessionCreated, registeredShell, shell, markerPresent, failure }) as ShellProbeResult
  } catch { return undefined }
}
