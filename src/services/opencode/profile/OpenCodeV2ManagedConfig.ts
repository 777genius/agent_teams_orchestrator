import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ConfigEntry as FloorEntry } from '@opencode/client-v2-floor'
import type { ConfigEntry as CurrentEntry } from '@opencode/client'

/** Native vocabulary; these overrides authorize no session, model, or plugin work. */
export const openCodeV2ReadOverrides = {
  update: 'disable', share: 'disabled', snapshots: false, warming: false,
  plugins: [],
} satisfies Extract<FloorEntry, { type: 'document' }>['info'] &
  Extract<CurrentEntry, { type: 'document' }>['info']

export type OpenCodeV2ReadRoots = Awaited<ReturnType<typeof createOpenCodeV2ReadRoots>>

export async function createOpenCodeV2ReadRoots() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'opencode-v2-read-')))
  const roots = Object.fromEntries(['home', 'config', 'data', 'cache', 'state', 'tmp', 'appdata', 'localappdata']
    .map(key => [key, path.join(root, key)]))
  try {
    await Promise.all(Object.values(roots).map(dir => mkdir(dir, { mode: 0o700 })))
    return { root, env: privateOpenCodeReadEnvironment(root), remove: () => rm(root, { recursive: true, force: true }) }
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error }
}

export function privateOpenCodeReadEnvironment(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'),
    TMPDIR: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), TEMP: path.join(root, 'tmp'),
    APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'localappdata'),
    NODE_ENV: 'production', NO_COLOR: '1',
    PATH: process.platform === 'win32'
      ? [path.dirname(process.execPath), path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(path.delimiter)
      : [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
  }
  // Fixed loader/system-tool directories only. No inherited PATH, auth or config overrides.
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  if (process.platform === 'win32') {
    env.HOMEDRIVE = path.parse(env.USERPROFILE!).root.replace(/[\\/]$/, '')
    env.HOMEPATH = env.USERPROFILE!.slice(env.HOMEDRIVE.length)
  }
  return env
}
