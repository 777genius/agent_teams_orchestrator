import { isAbsolute } from 'node:path'
import { OpenCodeClientFactory } from './OpenCodeClientFactory.js'
import { OpenCodeHostManager } from './OpenCodeHostManager.js'
import { OpenCodeMcpManager } from './OpenCodeMcpManager.js'
import { OpenCodeProvisioningProbe } from './OpenCodeProvisioningProbe.js'
import { OpenCodeExecutionProbe } from './OpenCodeExecutionProbe.js'
import { OpenCodeSessionStore, retainHostedSessionPublicationStore } from './OpenCodeSessionStore.js'
import { OpenCodeSessionBridge } from './OpenCodeSessionBridge.js'
import { OpenCodeEventTranslator } from './OpenCodeEventTranslator.js'
import { OpenCodeTranscriptProjector } from './OpenCodeTranscriptProjector.js'
import { OpenCodeLogProjector } from './OpenCodeLogProjector.js'
import { OpenCodeOfflineSessionReader } from './OpenCodeOfflineSessionReader.js'
import { OpenCodePreviewObserver } from './OpenCodePreviewObserver.js'
import { OpenCodeTurnSettledObserver } from './OpenCodeTurnSettledObserver.js'
import { retainOpenCodeLifecycleRuntime } from './OpenCodeLifecycleRuntime.js'
import { matchAppMcpTools } from './OpenCodeBridgeCommandHandler.js'
import { assertTrustedOpenCodeCustody, type TrustedOpenCodeCustody } from './OpenCodeSupervisedHostCustody.js'
import { prepareExecutingOpenCodeArtifactDigestToken } from './OpenCodeArtifactDigest.js'
import { OpenCodeHostedApprovalRuntimeAdapter } from '../hostedControl/OpenCodeHostedApprovalRuntimeAdapter.js'
import { HostedApprovalRuntimeBindingFenceRegistry } from '../hostedControl/HostedApprovalRuntimeBindingFence.js'

/** All effectful consumers are constructed here from one admitted custody.
 * Inputs select owned storage and authority, never replacement service outputs. */
export function createOpenCodeSupervisedProviderBundle(custody: TrustedOpenCodeCustody, sessionStorePath: string) {
  assertTrustedOpenCodeCustody(custody)
  if (!isAbsolute(sessionStorePath)) throw new Error('OpenCode native session store path must be absolute')
  const acquisitionPolicy = Object.freeze({ mode: 'supervisor-adopt-only' as const, custody })
  const clients = new OpenCodeClientFactory({ acquisitionPolicy })
  const hosts = new OpenCodeHostManager({ acquisitionPolicy })
  const mcp = new OpenCodeMcpManager({ acquisitionPolicy, clientFactory: clients })
  const bindingFences = new HostedApprovalRuntimeBindingFenceRegistry()
  // This callback runs in custody's synchronous revocation stack, before raw
  // drain. No stale session mutation or binding pin survives bundle loss.
  custody.retainOwnerResource(() => bindingFences.revoke())
  const sessions = new OpenCodeSessionStore(sessionStorePath, bindingFences)
  const hostedSessionPublicationStore = retainHostedSessionPublicationStore(sessions)
  const translator = new OpenCodeEventTranslator({ transcriptProjector: new OpenCodeTranscriptProjector() })
  const bridge = new OpenCodeSessionBridge({ acquisitionPolicy, hostManager: hosts, clientFactory: clients,
    sessionStore: sessions, hostedSessionPublicationStore, mcpManager: mcp, eventTranslator: translator,
    logProjector: new OpenCodeLogProjector(), offlineReader: new OpenCodeOfflineSessionReader(custody),
    previewObserver: new OpenCodePreviewObserver({ acquisitionPolicy }),
    turnSettledObserver: new OpenCodeTurnSettledObserver({ acquisitionPolicy }),
  })
  const provisioning = new OpenCodeProvisioningProbe({ acquisitionPolicy, hostManager: hosts,
    clientFactory: clients, mcpManager: mcp })
  const execution = new OpenCodeExecutionProbe({ acquisitionPolicy, hostManager: hosts,
    clientFactory: clients, eventTranslator: translator })
  const lifecycle = retainOpenCodeLifecycleRuntime({ provisioning, execution, hosts, sessions, bridge,
    async proveAppMcpTools(snapshot, context) {
      if (!snapshot.host || snapshot.host.hostKey !== custody.hostKey ||
        snapshot.host.baseUrl !== custody.expected.endpoint.baseUrl) throw new Error('OpenCode MCP proof host mismatch')
      const tools = await clients.create(custody.expected.endpoint.baseUrl, context && {
        signal: context.signal, remainingMs: context.remainingMs.bind(context),
      }).listExperimentalToolIds({ directory: custody.expected.profile.projectPath })
      return matchAppMcpTools(tools, '/experimental/tool/ids')
    },
  })
  const approvals = new OpenCodeHostedApprovalRuntimeAdapter(sessions, bridge, Date.now, {
    prepareEffectToken(digest) {
      if (digest !== `sha256:${custody.expected.executable.sha256}`) return null
      return prepareExecutingOpenCodeArtifactDigestToken(custody.expected.process.pid, digest)
    },
  })
  return Object.freeze({ lifecycle, hostedAttempts: Object.freeze({
    createContext: bridge.createHostedSessionAttemptContext.bind(bridge),
    release: bridge.releaseHostedSessionAttempt.bind(bridge),
  }), approvals: Object.freeze({
    observe: approvals.observe.bind(approvals), deliver: approvals.deliver.bind(approvals),
  }), close: custody.closeOwnerResources.bind(custody) })
}
