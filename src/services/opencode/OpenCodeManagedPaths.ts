import path from 'node:path'
import os from 'node:os'

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
  const name = 'claude-multimodel-nodejs'
  const home = (process.platform === 'win32'
    ? env.USERPROFILE?.trim() || env.HOME?.trim()
    : env.HOME?.trim() || env.USERPROFILE?.trim()) || os.homedir()
  const tempRoot = env.TMPDIR?.trim() || env.TMP?.trim() || env.TEMP?.trim() || os.tmpdir()
  let paths: { data: string; config: string; cache: string; log: string; temp: string }
  if (process.platform === 'darwin') {
    const library = path.join(home, 'Library')
    paths = {
      data: path.join(library, 'Application Support', name),
      config: path.join(library, 'Preferences', name),
      cache: path.join(library, 'Caches', name),
      log: path.join(library, 'Logs', name),
      temp: path.join(tempRoot, name),
    }
  } else if (process.platform === 'win32') {
    const appData = env.APPDATA?.trim() || path.join(home, 'AppData', 'Roaming')
    const localAppData = env.LOCALAPPDATA?.trim() || path.join(home, 'AppData', 'Local')
    paths = {
      data: path.join(localAppData, name, 'Data'),
      config: path.join(appData, name, 'Config'),
      cache: path.join(localAppData, name, 'Cache'),
      log: path.join(localAppData, name, 'Log'),
      temp: path.join(tempRoot, name),
    }
  } else {
    const dataHome = env.XDG_DATA_HOME?.trim() || path.join(home, '.local', 'share')
    const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(home, '.config')
    const cacheHome = env.XDG_CACHE_HOME?.trim() || path.join(home, '.cache')
    const stateHome = env.XDG_STATE_HOME?.trim() || path.join(home, '.local', 'state')
    paths = {
      data: path.join(dataHome, name),
      config: path.join(configHome, name),
      cache: path.join(cacheHome, name),
      log: path.join(stateHome, name),
      temp: path.join(tempRoot, path.basename(home), name),
    }
  }
  return {
    ...paths,
    data: resolveAbsoluteEnvPath(env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]) ?? paths.data,
    cache: resolveAbsoluteEnvPath(env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]) ?? paths.cache,
  }
}
