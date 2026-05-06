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

export function resolveClaudeMultimodelPaths(env: NodeJS.ProcessEnv = process.env) {
  const paths = envPaths('claude-multimodel')
  return {
    ...paths,
    data: resolveAbsoluteEnvPath(env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]) ?? paths.data,
    cache: resolveAbsoluteEnvPath(env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]) ?? paths.cache,
  }
}
