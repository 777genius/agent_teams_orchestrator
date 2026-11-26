import type { OpenCodeHostManager } from '../../OpenCodeHostManager.js'
import { OpenCodeAuthorityVetoError, isKnownHostRegistry, readOpenCodeAuthority } from '../../OpenCodeAuthorityStoreRead.js'
import type { NativeCustody } from '../OpenCodeNativeCustody.js'

type NativeIngressCleanupInput = {
  registryPath: string
  hostKey: string
  manager: Pick<OpenCodeHostManager, 'disposeHost' | 'drainPendingLifecycleCleanups'>
  custody: Pick<NativeCustody, 'stopExact'>
  assertDead: () => Promise<void>
}

/** TEST-only cleanup shared with the physical pinned ingress qualification. */
export async function cleanupNativeIngressHost(input: NativeIngressCleanupInput): Promise<boolean> {
  let stopped = false, failed = false, failure: unknown
  try {
    // Only this read precedes manager admission. A later registry error could
    // follow an already dispatched Stop and must never authorize another one.
    const registry = await readOpenCodeAuthority(input.registryPath, isKnownHostRegistry)
    if (registry.kind === 'preserved_unknown') {
      const veto = new OpenCodeAuthorityVetoError('host', registry.reason)
      try { await input.custody.stopExact() }
      catch (error) { throw new AggregateError([veto, error], 'TEST_native_ingress_captured_cleanup_failed') }
      throw veto // Physical cleanup does not turn a failed authority read into PASS.
    }
    stopped = await input.manager.disposeHost(input.hostKey)
    if (stopped) await input.assertDead()
  } catch (error) { failed = true; failure = error }
  // Always drain, but do not let a late observer satisfy the immediate receipt
  // assertion or replace the original failure.
  try { await input.manager.drainPendingLifecycleCleanups() }
  catch (error) {
    if (failed) throw new AggregateError([failure, error], 'TEST_native_ingress_lifecycle_cleanup_failed')
    throw error
  }
  if (failed) throw failure
  return stopped
}
