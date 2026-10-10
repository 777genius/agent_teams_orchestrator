import path from 'node:path'
import { realpath } from 'node:fs/promises'
import { buildOpenCodeExecutionProof } from '../OpenCodeExecutionProof.js'
import { hashOpenCodeFile } from '../compatibility/OpenCodeNativeIdentity.js'
import { readOriginalTerminal, requireOriginalTerminalCut } from '../execution/OpenCodeV2TerminalSettlement.js'
import { executionAssert, executionHash, executionRecord, type AdmissionRecord, type SessionAuthority } from '../execution/OpenCodeV2ExecutionContracts.js'
import { requireExecutionEndpoint } from '../host/OpenCodeV2ExecutionHost.js'
import { resolveOpenCodeBinaryHostIdentity } from '../OpenCodeHostManager.js'
import type { OpenCodePreparedProfile, OpenCodeProvisioningSnapshot } from '../types.js'
import type { ExecutionBridgeClient, ExecutionJson } from '../transport/OpenCodeV2ExecutionClientFactory.js'
import type { QueueIntent } from '../execution/OpenCodeV2AdmissionService.js'

export type ProbeAuthority = Readonly<{ profile: OpenCodePreparedProfile; configFingerprint: string; authFingerprint: string }>
const captures = new WeakSet<object>()
function selectedDocument(entries: ExecutionJson[], profile: OpenCodePreparedProfile): void {
  executionAssert(entries.some(entry => {
    const row = executionRecord(entry)
    return row.type === 'document' && executionHash(row.info) === executionHash(profile.managedConfig)
  }), 'probe_selected_config_not_observed')
}
/** Captured only from the registered owning client and its private production profile. */
export async function captureOwnedV2ProbeAuthority(client: ExecutionBridgeClient, profile: OpenCodePreparedProfile): Promise<ProbeAuthority> {
  requireExecutionEndpoint(client.authority)
  executionAssert(client.config && profile.profileRootPath === client.authority.profileRoot &&
    profile.canonicalProjectPath === client.authority.directory &&
    profile.managedAuthPath === path.join(client.authority.profileRoot, 'data/opencode/auth.json') &&
    await realpath(profile.profileRootPath) === profile.profileRootPath, 'probe_profile_authority_changed')
  const config = await client.config(); selectedDocument(config, profile)
  const authFingerprint = await hashOpenCodeFile(profile.managedAuthPath)
  executionAssert(authFingerprint === profile.managedAuthFingerprint, 'probe_selected_auth_changed')
  const capture = Object.freeze({ profile: structuredClone(profile), configFingerprint: executionHash(config), authFingerprint })
  captures.add(capture); return capture
}

/** An accepted queue receipt is insufficient: mint only from the original USER,
 * actual terminal lineage, actual selected assistant and unchanged live config/auth. */
export async function buildOwnedV2ProbeProof(input: { client: ExecutionBridgeClient; authority: SessionAuthority;
  captured: ProbeAuthority; intent: QueueIntent; admission: AdmissionRecord; expectedText: string; capabilitySnapshotId: string }) {
  const { client, authority, captured, intent } = input
  executionAssert(captures.has(captured), 'probe_capture_not_owned')
  const terminal = await readOriginalTerminal(client, authority, intent, input.admission)
  if (!terminal || terminal.state !== 'succeeded') return null
  const cut = requireOriginalTerminalCut(terminal)
  const after = cut.log
  executionAssert(after.watermark === terminal.cursor && executionHash({ messages: { data: cut.messages, previous: null, next: null }, log: after }) === terminal.cutHash, 'probe_terminal_cut_changed')
  const assistantIDs = new Set(after.events.filter(event => event.type === 'session.step.started' &&
    event.seq > (input.admission.beforeCursor ?? -1)).map(event => event.data.assistantMessageID))
  const assistants = cut.messages.filter(row => row.type === 'assistant' && assistantIDs.has(row.id))
  executionAssert(assistants.length > 0 && assistants.every(row => {
    const data = executionRecord(row.data), model = executionRecord(data.model)
    return data.agent === authority.agent && executionHash(model) === executionHash(authority.model)
  }), 'probe_observed_model_variant_changed')
  const text = assistants.flatMap(row => {
    const content = row.data.content
    executionAssert(Array.isArray(content), 'probe_assistant_content_unknown')
    return content.flatMap(part => { const value = executionRecord(part)
      executionAssert(value.type === 'text' || value.type === 'reasoning', 'probe_unexpected_tool_effect')
      return value.type === 'text' && typeof value.text === 'string' ? [value.text] : [] })
  }).join('').trim()
  executionAssert(text === input.expectedText, 'probe_expected_output_not_observed')
  executionAssert(client.config, 'probe_config_readback_unavailable')
  const config = await client.config(); selectedDocument(config, captured.profile)
  executionAssert(executionHash(config) === captured.configFingerprint &&
    await hashOpenCodeFile(captured.profile.managedAuthPath) === captured.authFingerprint, 'probe_selected_authority_changed')
  const endpoint = requireExecutionEndpoint(client.authority)
  const host = { hostKey: authority.host.hostInstanceId, profileRootKey: captured.profile.profileRootKey,
    projectPath: authority.host.directory, projectBehaviorFingerprint: captured.profile.projectBehaviorFingerprint,
    baseUrl: endpoint.baseUrl, port: Number(new URL(endpoint.baseUrl).port), pid: endpoint.nativePID,
    version: authority.host.pin, state: 'healthy' as const, profile: captured.profile,
    resolvedConfigFingerprint: captured.configFingerprint, diagnostics: [] }
  const snapshot: OpenCodeProvisioningSnapshot = { detected: true, hostHealthy: true,
    projectPath: authority.host.directory, profile: captured.profile, host,
    config: null, configProviders: null, providers: null, providerAuth: null, agents: [], mcp: null, appMcp: null,
    probeError: null, diagnostics: [] }
  // This proof stays private until the owning run's actual branded kernel
  // retirement and original owner process retirement have both succeeded.
  return buildOpenCodeExecutionProof({ selectedModel: `${authority.model.providerID}/${authority.model.id}`,
    snapshot, capabilitySnapshotId: input.capabilitySnapshotId, verifiedAt: new Date().toISOString() }, {
      resolveBinaryPath: () => authority.host.selectedCli.path, resolveBinaryIdentity: resolveOpenCodeBinaryHostIdentity,
    })
}
