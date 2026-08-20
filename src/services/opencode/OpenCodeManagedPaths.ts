import path from 'node:path'
import envPaths from 'env-paths'

export const CLAUDE_MULTIMODEL_DATA_HOME_ENV = 'CLAUDE_MULTIMODEL_DATA_HOME'
export const CLAUDE_MULTIMODEL_CACHE_HOME_ENV = 'CLAUDE_MULTIMODEL_CACHE_HOME'

function resolveAbsoluteEnvPath(value: string | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed || !path.isAbsolute(trimmed)) {
    return null
  }
  return path.normalize(trimmed)
}

export function resolveClaudeMultimodelPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  const paths = envPaths('claude-multimodel')
  const dataOverride = resolveAbsoluteEnvPath(env[CLAUDE_MULTIMODEL_DATA_HOME_ENV])
  const cacheOverride = resolveAbsoluteEnvPath(env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV])
  const windowsTrustedRoot = platform === 'win32'
    ? resolveAbsoluteEnvPath(env.LOCALAPPDATA)
    : null
  const windowsAppRoot = windowsTrustedRoot
    ? path.join(windowsTrustedRoot, 'claude-multimodel-nodejs')
    : null
  const data = dataOverride
    ?? (windowsAppRoot ? path.join(windowsAppRoot, 'Data') : paths.data)
  const cache = cacheOverride
    ?? (windowsAppRoot ? path.join(windowsAppRoot, 'Cache') : paths.cache)
  return {
    ...paths,
    data,
    cache,
    // Explicit overrides are caller-owned boundaries. Default Windows
    // env-paths values are app descendants whose only guaranteed pre-existing
    // ancestor on a fresh account is LOCALAPPDATA.
    dataTrustedRoot: dataOverride ? path.dirname(data) : windowsTrustedRoot ?? path.dirname(data),
    cacheTrustedRoot: cacheOverride ? path.dirname(cache) : windowsTrustedRoot ?? path.dirname(cache),
  }
}
