import type { CodexNativeExecCapabilityProfile } from './normalizedEvents.js'

export const CODEX_NATIVE_PHASE0_EXEC_CAPABILITY_PROFILE: CodexNativeExecCapabilityProfile =
  'headless-limited'

export function getCodexNativeCapabilityReason(
  capability:
    | 'plugins'
    | 'mcp'
    | 'skills'
    | 'approvals'
    | 'interactive-requests',
): string {
  switch (capability) {
    case 'plugins':
      return 'codex-native phase 0 keeps plugin execution disabled until a later rollout.'
    case 'mcp':
      return 'codex-native phase 0 does not claim app-server-grade MCP interactivity yet.'
    case 'skills':
      return 'codex-native phase 0 does not claim richer skill invocation parity yet.'
    case 'approvals':
      return 'codex-native phase 0 uses the raw exec seam and does not expose approval flows.'
    case 'interactive-requests':
      return 'codex-native phase 0 does not expose request_user_input or generic elicitation flows.'
  }
}
