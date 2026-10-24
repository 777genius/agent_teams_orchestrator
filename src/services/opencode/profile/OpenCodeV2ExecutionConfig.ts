import { Schema } from 'effect'
import { Info as NativeProviderInfo } from '@opencode/schema/config/provider'
import { Capabilities as NativeCapabilities } from '@opencode/schema/model'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { isOpenCodeV2Pin, type OpenCodeV2Pin } from '../compatibility/OpenCodeV2Registry.js'
import type { CurrentConfigEntry as CurrentEntry, FloorConfigEntry as FloorEntry } from '../compatibility/OpenCodeV2WireTypes.js'
import type { ExecutionSelection } from '../host/OpenCodeV2ExecutionBinding.js'
import type { ExecutionMcpConfig } from '../transport/OpenCodeV2ExecutionClientFactory.js'

export type ExecutionConfigInfo = Extract<FloorEntry, { type: 'document' }>['info'] &
  Extract<CurrentEntry, { type: 'document' }>['info']
export type ExecutionProviderModels = NonNullable<NonNullable<ExecutionConfigInfo['providers']>[string]['models']>
export type ExecutionConfigInput = {
  pin: OpenCodeV2Pin
  selection: ExecutionSelection
  /** Autonomous team profiles cannot wait for an interactive form response. */
  unattendedTeam?: boolean
  controller: { server: string; config: ExecutionMcpConfig }
  provider?: Readonly<{ package?: string; baseURL?: string; models?: ExecutionProviderModels }>
}

/** Selected profile overrides, never ambient HOME/config/auth discovery. The profile owner
 * persists this document before acquiring its lease. Readiness verifies the selected rules. */
export function createOpenCodeV2ExecutionConfig(input: ExecutionConfigInput): {
  info: ExecutionConfigInfo; content: string; sha256: string
} {
  const { pin, selection, controller } = input
  if (!isOpenCodeV2Pin(pin) || !/^[A-Za-z0-9_-]{1,256}$/.test(selection.agent) ||
    controller.server !== 'agent-teams' || !selection.model.providerID || !selection.model.id ||
    selection.permissions.length === 0) throw new Error('v2_execution_selection_invalid')
  if (selection.model.variant !== undefined && !selection.model.variant) throw new Error('v2_execution_selection_invalid')
  const permissions = selection.permissions.map(rule => {
    if (!rule.action || !rule.resource || !['allow', 'deny', 'ask'].includes(rule.effect)) throw new Error('v2_execution_permission_invalid')
    return { action: rule.action, resource: rule.resource, effect: rule.effect }
  })
  // Agent and document receive exactly the selected policy. The current native browser
  // plugin appends its safety deny; readiness verifies that suffix independently.
  const mcp = controller.config
  if (mcp.disabled === true) throw new Error('v2_execution_mcp_disabled')
  if (mcp.type === 'local') {
    if (!mcp.command.length || mcp.command.some(value => !value || /\0/.test(value)) ||
      (mcp.cwd !== undefined && !path.isAbsolute(mcp.cwd))) throw new Error('v2_execution_mcp_invalid')
  } else {
    const url = new URL(mcp.url)
    if (mcp.oauth !== false || !['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('v2_execution_mcp_invalid')
  }
  const selectedModel = { providerID: selection.model.providerID, model: selection.model.id,
    ...(selection.model.variant === undefined ? {} : { variant: selection.model.variant }) }
  const nativeMcp = mcp.type === 'local'
    ? { ...mcp, command: [...mcp.command], ...(process.platform === 'win32' ? { disabled: true } : {}) }
    : { ...mcp, ...(process.platform === 'win32' ? { disabled: true } : {}) }
  const info = {
    update: 'disable', share: 'disabled', snapshots: false, warming: false,
    plugins: input.unattendedTeam === true ? ['-opencode.tool.question'] : [],
    model: selectedModel, default_agent: selection.agent, permissions,
    agents: { [selection.agent]: { model: selectedModel, permissions, mode: 'primary' } },
    mcp: { servers: { [controller.server]: nativeMcp } },
    ...(input.provider && Object.keys(input.provider).length ? { providers: { [selection.model.providerID]: {
      ...(input.provider.package ? { package: input.provider.package } : {}),
      ...(input.provider.baseURL ? { settings: { baseURL: input.provider.baseURL } } : {}),
      ...(input.provider.models ? { models: input.provider.models } : {}) } } } : {}),
  } satisfies ExecutionConfigInfo
  const content = JSON.stringify(info)
  return { info, content, sha256: createHash('sha256').update(content).digest('hex') }
}


/** V1 npm modules implement the AI SDK API; V2 bare package names use its native model API. */
export function mapLegacyOpenCodeV2Package(npm: unknown): string {
  if (typeof npm !== 'string' || !npm) throw new Error('v2_selected_model_package_invalid')
  return npm.startsWith('aisdk:') ? npm : `aisdk:${npm}`
}

/** Import only the selected declared custom model. Empty descriptors retain
 * the genuine native catalog defaults; no catalog/limits are invented here. */
export function mapSelectedOpenCodeV2Model(modelID: string, legacy: unknown): ExecutionProviderModels {
  if (!modelID || legacy === null || typeof legacy !== 'object' || Array.isArray(legacy)) throw new Error('v2_selected_model_config_invalid')
  const source = Object.fromEntries(Object.entries(legacy)), native: Record<string, unknown> = {}
  const supported = new Set(['id', 'modelID', 'npm', 'package', 'name', 'family', 'compatibility', 'settings', 'headers', 'body', 'capabilities', 'limit', 'variants', 'cost', 'disabled', 'tool_call', 'modalities'])
  for (const [key, value] of Object.entries(source)) {
    if (!supported.has(key)) throw new Error(`v2_selected_model_field_unsupported:${key}`)
    if (!['id', 'npm', 'tool_call', 'modalities'].includes(key)) native[key] = value
  }
  for (const [legacyKey, nativeKey] of [['id', 'modelID'], ['npm', 'package']] as const) {
    if (source[legacyKey] === undefined) continue
    const value = legacyKey === 'npm' ? mapLegacyOpenCodeV2Package(source[legacyKey]) : source[legacyKey]
    if (source[nativeKey] !== undefined && source[nativeKey] !== value) throw new Error('v2_selected_model_alias_conflict')
    native[nativeKey] = value
  }
  if (source.tool_call !== undefined || source.modalities !== undefined) {
    if (source.tool_call !== undefined && typeof source.tool_call !== 'boolean') throw new Error('v2_selected_model_capabilities_invalid')
    const capabilities = source.capabilities === undefined ? {} : source.capabilities
    if (capabilities === null || typeof capabilities !== 'object' || Array.isArray(capabilities)) throw new Error('v2_selected_model_capabilities_invalid')
    const merged: Record<string, unknown> = { ...NativeCapabilities.default(), ...capabilities }
    if (source.tool_call !== undefined) {
      if ('tools' in capabilities && capabilities.tools !== source.tool_call) throw new Error('v2_selected_model_capabilities_conflict')
      merged.tools = source.tool_call
    }
    if (source.modalities !== undefined) {
      const modalities = source.modalities
      if (modalities === null || typeof modalities !== 'object' || Array.isArray(modalities) || Object.keys(modalities).some(key => !['input', 'output'].includes(key))) throw new Error('v2_selected_model_modalities_invalid')
      Object.assign(merged, modalities)
    }
    native.capabilities = merged
  }
  if (source.variants !== undefined && !Array.isArray(source.variants)) {
    const variants = source.variants
    if (variants === null || typeof variants !== 'object') throw new Error('v2_selected_model_variants_invalid')
    native.variants = Object.entries(variants).map(([id, settings]) => {
      if (settings === null || typeof settings !== 'object' || Array.isArray(settings) || 'disabled' in settings) throw new Error('v2_selected_model_variant_unsupported')
      return { id, settings }
    })
  }
  // Public current schema plus the Floor/Current generated-type intersection
  // above validate the common declared contract. Excess fields fail explicitly.
  const decoded = Schema.decodeUnknownSync(NativeProviderInfo, { onExcessProperty: 'error' })({ models: { [modelID]: native } })
  const encoded = encodeNativeProviderInfo(decoded)
  const models: ExecutionProviderModels = {}
  for (const [id, definition] of Object.entries(encoded.models ?? {})) {
    const { settings, variants, body, capabilities, cost, ...rest } = definition
    models[id] = { ...rest, ...(cost === undefined ? {} : { cost: 'input' in cost ? cost : cost.map(entry => ({ ...entry })) }), ...(capabilities === undefined ? {} : { capabilities: commonCapabilities(capabilities) }), ...(body === undefined ? {} : { body: mutableJsonRecord(body) }), ...(settings === undefined ? {} : { settings: definedSettings(settings) }),
      ...(variants === undefined ? {} : { variants: variants.map(variant => {
        const { settings: variantSettings, body: variantBody, ...variantRest } = variant
        return { ...variantRest, ...(variantBody === undefined ? {} : { body: mutableJsonRecord(variantBody) }), ...(variantSettings === undefined ? {} : { settings: definedSettings(variantSettings) }) }
      }) }) }
  }
  return models
}


const encodeNativeProviderInfo = Schema.encodeSync(NativeProviderInfo)
type NativeModels = NonNullable<ReturnType<typeof encodeNativeProviderInfo>['models']>
// Explicit native descriptors retain the existing complete capability contract.
// Filling the new partial schema's absent fields would override base model values.
function commonCapabilities(value: NonNullable<NativeModels[string]['capabilities']>) {
  const { tools, input, output, reasoning, ...rest } = value
  if (typeof tools !== 'boolean' || input === undefined || output === undefined)
    throw new Error('v2_selected_model_capabilities_invalid')
  return { ...rest, tools, input: [...input], output: [...output],
    ...(reasoning === undefined ? {} : { reasoning: reasoning.supported === false ? { supported: false as const } : {
      supported: true as const,
      ...(reasoning.toggle === undefined ? {} : { toggle: reasoning.toggle }),
      ...(reasoning.effort === undefined ? {} : { effort: [...reasoning.effort] }),
      ...(reasoning.budget === undefined ? {} : { budget: { ...reasoning.budget } }),
    } }),
  }
}
type MutableJson = NonNullable<ExecutionProviderModels[string]['body']>[string]

function mutableJson(value: Schema.Json): MutableJson {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(mutableJson)
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mutableJson(item)]))
}

function mutableJsonRecord(value: Readonly<Record<string, Schema.Json>>): Record<string, MutableJson> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mutableJson(item)]))
}

function definedSettings(value: NonNullable<NativeModels[string]['settings']>) {
  const output: Record<string, MutableJson> = {}
  for (const [key, item] of Object.entries(value)) if (item !== undefined) output[key] = mutableJson(item)
  // JSON omits undefined entries and materializes readonly encoded arrays.
  // Preserve the structured compaction field in the generated common contract.
  return { ...output, ...(value.compaction === undefined ? {} : { compaction: value.compaction }) }
}
