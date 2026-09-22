import type {
  HostedLifecycleAuthorityEffectPort,
  HostedLifecycleAuthorizationDecision,
  HostedLifecycleExecutionDecision,
  HostedLifecycleReleaseDecision,
  HostedLifecycleRevalidationDecision,
} from './HostedLifecycleCommandService.js'

const unavailable = (): { kind: 'unavailable'; retryAfterMs: null } => ({
  kind: 'unavailable',
  retryAfterMs: null,
})

/**
 * Explicit production-safe boundary used until the lifecycle process owner installs
 * an atomic compare-and-commit implementation. It never claims authorization or success.
 */
export class FailClosedHostedLifecycleAuthorityEffects implements HostedLifecycleAuthorityEffectPort {
  async getControlState(): Promise<Record<string, unknown>> {
    // Control-state responses use the public lifecycle schema (v1), unlike the
    // authorize/revalidate/execute gateway envelopes (v2).
    return { schemaVersion: 1, ...unavailable() }
  }

  async authorize(): Promise<HostedLifecycleAuthorizationDecision> {
    return unavailable()
  }

  async revalidate(): Promise<HostedLifecycleRevalidationDecision> {
    return unavailable()
  }

  async execute(): Promise<HostedLifecycleExecutionDecision> {
    return unavailable()
  }

  async release(): Promise<HostedLifecycleReleaseDecision> {
    return unavailable()
  }
}
