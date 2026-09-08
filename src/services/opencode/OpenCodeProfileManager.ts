import { boundedPeerAuthPaths, validateOpenCodeBoundedPaths, type OpenCodeBoundedExecutionPaths } from './OpenCodeBoundedPaths.js'
import os from 'node:os'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { raceOpenCodeAbortSignal, throwOpenCodeAbortReason } from './OpenCodeRuntimeDeadline.js'
import { getCwd } from '../../utils/cwd.js'
import { resolveClaudeMultimodelPaths } from './OpenCodeManagedPaths.js'
import { resolveOpenCodeAppMcpLaunchConfig } from './OpenCodeMcpManager.js'
import { fanOutOpenCodeOAuthCredential } from './OpenCodeAuthStore.js'
import { prepareOpenCodeProfileUnderLock, listPreparedAuthPaths, withOpenCodeProfilePreparationLock } from './OpenCodeProfilePreparation.js'
import type { OpenCodePrepareProfileOptions, OpenCodePreparedProfile } from './types.js'
export { OPEN_CODE_TEAMMATE_AGENT_NAME, OPEN_CODE_TEAMMATE_BOOTSTRAP_AGENT_NAME, OPEN_CODE_MODEL_PROBE_AGENT_NAME, collectProjectBehaviorMetadata, buildManagedConfig, applyOpenCodeModelLimitOverrides, applyOpenCodeManagedSubscriptionPlugins, repairEmptyOpenCodeManagedPluginCaches, areOpenCodeManagedPluginCachesReady, isKiroCliWhoamiAuthenticated, ensureOpenCodeCursorPluginAuthCredential, ensureOpenCodeKiroPluginAuthCredential, ensureOpenCodeNativeCliCredentialBridge, buildManagedConfigFingerprint, orderOpenCodeAuthSyncSources } from './OpenCodeProfilePreparation.js'

export class OpenCodeProfileManager {
  private readonly paths = resolveClaudeMultimodelPaths()
  private getSourceAuthPaths(): string[] {
    const xdgDataHome =
      process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share')
    return Array.from(new Set([
      path.join(xdgDataHome, 'opencode', 'auth.json'),
      // Bridge/live-test processes can intentionally set XDG_DATA_HOME to an
      // isolated runtime directory. Always include the canonical user OpenCode
      // auth store as the highest-priority source so a fresh `opencode auth`
      // login can override stale app-global OAuth credentials.
      path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json'),
    ]))
  }

  getGlobalAuthPath(): string {
    return path.join(this.paths.data, 'opencode', 'auth.json')
  }

  async listManagedAuthPaths(): Promise<string[]> { return listPreparedAuthPaths(this.paths.data) }
  async fanOutOAuthCredential(providerId: string, sourceAuthPath: string, boundedPaths?: OpenCodeBoundedExecutionPaths): Promise<void> {
    if (boundedPaths) boundedPaths = validateOpenCodeBoundedPaths(boundedPaths)
    await fanOutOpenCodeOAuthCredential({
      boundedPaths,
      providerId,
      sourceAuthPath,
      targetAuthPaths: boundedPaths ? [boundedPaths.globalAuthPath,...boundedPeerAuthPaths(boundedPaths)] : [this.getGlobalAuthPath(), ...(await this.listManagedAuthPaths())],
    })
  }

  private withProfilePreparationLock<T>(profileRootKey: string, operation: () => Promise<T>, abortSignal?: AbortSignal): Promise<T> {
    return withOpenCodeProfilePreparationLock(profileRootKey, operation, abortSignal)
  }

  async prepareProfile(projectPath?: string | null, options: OpenCodePrepareProfileOptions = {}): Promise<OpenCodePreparedProfile> {
    if (options.abortSignal?.aborted) throwOpenCodeAbortReason(options.abortSignal)
    const workingDirectory = process.cwd()
    const resolvedProjectPath = path.resolve(workingDirectory, projectPath?.trim() || getCwd())
    const profileRootKey = createHash('sha256').update(resolvedProjectPath).digest('hex').slice(0, 16)
    const input = {
      projectPath: resolvedProjectPath, paths: this.paths,
      sourceHomePath: os.homedir(), workingDirectory, sourceAuthPaths: this.getSourceAuthPaths(),
      globalAuthPath: this.getGlobalAuthPath(), environment: { ...process.env },
      platform: process.platform, options,
    }
    return this.withProfilePreparationLock(profileRootKey, async () => {
      const appMcpConfig = options.includeAppMcp === false ? null
        : await raceOpenCodeAbortSignal(
          resolveOpenCodeAppMcpLaunchConfig().then(result => result.config).catch(() => null),
          options.abortSignal,
        )
      if (options.abortSignal?.aborted) throwOpenCodeAbortReason(options.abortSignal)
      return prepareOpenCodeProfileUnderLock({ ...input, appMcpConfig })
    }, options.abortSignal)
  }
}
export const openCodeProfileManager = new OpenCodeProfileManager()
