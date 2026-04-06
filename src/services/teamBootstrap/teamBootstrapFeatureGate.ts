export function getDeterministicBootstrapDisabledReason(): string | null {
  return process.env.CLAUDE_ENABLE_DETERMINISTIC_TEAM_BOOTSTRAP === '1'
    ? null
    : 'deterministic team bootstrap requires CLAUDE_ENABLE_DETERMINISTIC_TEAM_BOOTSTRAP=1'
}

export function getDeterministicBootstrapKillSwitchReason(): string | null {
  return process.env.CLAUDE_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP === '1'
    ? 'deterministic team bootstrap is disabled by kill switch'
    : null
}

export function getDeterministicBootstrapAvailabilityReason(): string | null {
  return (
    getDeterministicBootstrapKillSwitchReason() ??
    getDeterministicBootstrapDisabledReason()
  )
}

export function assertDeterministicBootstrapNotDisabled(): void {
  const reason = getDeterministicBootstrapAvailabilityReason()
  if (reason) {
    throw new Error(reason)
  }
}
