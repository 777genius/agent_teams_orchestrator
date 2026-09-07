import type { OpenCodeExecutionProbe } from './OpenCodeExecutionProbe.js'
import type { OpenCodeHostManager } from './OpenCodeHostManager.js'
import type { OpenCodeProvisioningProbe } from './OpenCodeProvisioningProbe.js'
import type { OpenCodeSessionBridge } from './OpenCodeSessionBridge.js'
import type { OpenCodeSessionStore } from './OpenCodeSessionStore.js'
import type { OpenCodePhaseContext } from './OpenCodeRuntimeDeadline.js'
import type { OpenCodeProvisioningSnapshot } from './types.js'

export type OpenCodeAppMcpToolProof = {
  ok: boolean
  observedTools: string[]
  missingTools: string[]
  diagnostics: string[]
  route: string | null
}

/** Explicit consumers for the three owned lifecycle commands and every effectful
 * helper they reach. Native composition supplies all members from one custody
 * bundle; no per-member fallback is permitted by this contract. */
export type OpenCodeLifecycleRuntime = Readonly<{
  provisioning: Pick<OpenCodeProvisioningProbe, 'probe' | 'probeRetainingHost'>
  execution: Pick<OpenCodeExecutionProbe, 'probeModel'>
  hosts: Pick<OpenCodeHostManager, 'reconcilePersistentHosts'>
  sessions: Pick<OpenCodeSessionStore, 'get' | 'list' | 'upsert' | 'markStale' | 'delete'>
  bridge: Pick<OpenCodeSessionBridge, 'ensureSession' | 'ensureSessionAppMcpReady' |
    'injectAppManagedBootstrapContext' | 'refreshSessionEnvironment' |
    'reconcileSession' | 'abort' | 'releaseSession'>
  proveAppMcpTools(snapshot: OpenCodeProvisioningSnapshot,
    phaseContext?: OpenCodePhaseContext): Promise<OpenCodeAppMcpToolProof>
}>

/** Snapshot injected methods before any command await. Replacing a caller's
 * bundle or service methods cannot reroute an admitted command into a fallback. */
export function retainOpenCodeLifecycleRuntime(source: OpenCodeLifecycleRuntime): OpenCodeLifecycleRuntime {
  const p = source.provisioning, e = source.execution, h = source.hosts
  const s = source.sessions, b = source.bridge
  return Object.freeze({
    provisioning: Object.freeze({ probe: p.probe.bind(p), probeRetainingHost: p.probeRetainingHost.bind(p) }),
    execution: Object.freeze({ probeModel: e.probeModel.bind(e) }),
    hosts: Object.freeze({ reconcilePersistentHosts: h.reconcilePersistentHosts.bind(h) }),
    sessions: Object.freeze({ get: s.get.bind(s), list: s.list.bind(s), upsert: s.upsert.bind(s),
      markStale: s.markStale.bind(s), delete: s.delete.bind(s) }),
    bridge: Object.freeze({ ensureSession: b.ensureSession.bind(b),
      ensureSessionAppMcpReady: b.ensureSessionAppMcpReady.bind(b),
      injectAppManagedBootstrapContext: b.injectAppManagedBootstrapContext.bind(b),
      refreshSessionEnvironment: b.refreshSessionEnvironment.bind(b),
      reconcileSession: b.reconcileSession.bind(b), abort: b.abort.bind(b),
      releaseSession: b.releaseSession.bind(b) }),
    proveAppMcpTools: source.proveAppMcpTools.bind(source),
  })
}
