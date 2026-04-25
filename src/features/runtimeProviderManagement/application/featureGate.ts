export function isRuntimeProviderManagementEnabled(): boolean {
  return process.env.CLAUDE_ENABLE_RUNTIME_PROVIDER_MANAGEMENT === '1'
    && process.env.CLAUDE_DISABLE_RUNTIME_PROVIDER_MANAGEMENT !== '1'
}

export function getRuntimeProviderManagementDisabledReason(): string | null {
  if (process.env.CLAUDE_DISABLE_RUNTIME_PROVIDER_MANAGEMENT === '1') {
    return 'runtime provider management is disabled by kill switch'
  }
  return process.env.CLAUDE_ENABLE_RUNTIME_PROVIDER_MANAGEMENT === '1'
    ? null
    : 'runtime provider management requires CLAUDE_ENABLE_RUNTIME_PROVIDER_MANAGEMENT=1'
}
