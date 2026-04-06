export function getDeterministicBootstrapKillSwitchReason(): string | null {
  return process.env.CLAUDE_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP === '1'
    ? 'deterministic team bootstrap is disabled by kill switch'
    : null
}

export function assertDeterministicBootstrapNotDisabled(): void {
  const reason = getDeterministicBootstrapKillSwitchReason()
  if (reason) {
    throw new Error(reason)
  }
}
