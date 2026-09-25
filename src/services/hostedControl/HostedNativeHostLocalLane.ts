import type { ResolvedAppMcpLaunchConfig } from '../opencode/OpenCodeMcpManager.js'
import {
  createNativeHostLocalTeamLifecycleLane,
  type NativeHostLocalLaneMcpServer,
} from '../teamLifecycleOwner/NativeHostLocalTeamLifecycleLane.js'
import type { HostedHostLocalLaneFactory } from './HostedPersonalHostLocalComposition.js'

/** Operator-pinned native provider access; only the signed personal-host bootstrap may supply it. */
export type HostedNativeHostLocalConfig = Readonly<{
  anthropic?: Readonly<{ oauthTokenFile: string }>
  codex?: Readonly<{ codexHome: string; codexCliPath: string }>
}>

/**
 * Native Claude Code / Codex lane for the personal host-local composition.
 * It reuses the bootstrap-verified agent-teams MCP artifact and stays
 * capability-false without it, exactly like the host-local OpenCode lane.
 */
export function createHostLocalNativeLaneFactory(native: HostedNativeHostLocalConfig): HostedHostLocalLaneFactory {
  return (context, host) => {
    const mcpServer = host.appMcp ? nativeMcpServer(host.appMcp) : null
    return createNativeHostLocalTeamLifecycleLane(
      { claudeRoot: context.claudeRoot, teamRoot: context.teamRoot, legacyKey: context.legacyKey },
      {
        ...(native.anthropic ? { anthropic: native.anthropic } : {}),
        ...(native.codex ? { codex: native.codex } : {}),
        resolveMcpServer: mcpServer ? async () => mcpServer : null,
      },
    )
  }
}

/** Codex translates only stdio servers, so the verified local command becomes one stdio server. */
function nativeMcpServer(resolved: ResolvedAppMcpLaunchConfig): NativeHostLocalLaneMcpServer | null {
  const [command, ...args] = resolved.config.command ?? []
  if (resolved.config.type !== 'local' || !command) return null
  return Object.freeze({ command, args, env: { ...(resolved.config.environment ?? {}) } })
}
