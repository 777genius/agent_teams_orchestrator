import { cp, lstat, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

const REQUIRED_ENTRIES = new Set(['accounts', 'auth.json'])
const PRIVATE_ENTRIES = new Set([
  'config.toml', 'sessions', 'archived_sessions', 'session_index.json',
  'session_index.jsonl', 'history.jsonl', 'log', 'logs', 'tmp', '.tmp',
])

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

export type CodexNativeHomeOverlay = {
  env: NodeJS.ProcessEnv
  /** Append after caller overrides: config sqlite_home precedes its env alias. */
  configOverrides: string[]
  cleanup: () => Promise<void>
}

/** Keep launch config/auth separate from the one explicitly owned rollout store. */
export async function createCodexNativeHomeOverlay(options: {
  env: NodeJS.ProcessEnv
  sessionsDirectory?: string
  includeUserConfig?: boolean
  loopbackOverlayToml?: string | null
}): Promise<CodexNativeHomeOverlay> {
  const sourceHome = options.env.CODEX_HOME?.trim() || path.join(homedir(), '.codex')
  const overlayHome = await mkdtemp(path.join(tmpdir(), 'codex-native-home-'))
  let sessionsMounted = false
  const cleanup = async () => {
    if (sessionsMounted) {
      // Remove the link/junction explicitly before any recursive cleanup. Its
      // persistent target is owned by the conversation, not this temporary home.
      await unlink(path.join(overlayHome, 'sessions')).catch(error => {
        if (!missing(error)) throw error
      })
      sessionsMounted = false
    }
    await rm(overlayHome, { recursive: true, force: true })
  }
  try {
    const entries = await readdir(sourceHome, { withFileTypes: true }).catch(error => {
      if (!missing(error)) throw error
      return []
    })
    for (const entry of entries) {
      if (PRIVATE_ENTRIES.has(entry.name) || /\.sqlite(?:-(?:wal|shm|journal))?$/.test(entry.name)) continue
      const source = path.join(sourceHome, entry.name)
      const target = path.join(overlayHome, entry.name)
      const stats = await lstat(source)
      try {
        await symlink(source, target, stats.isDirectory() ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file')
      } catch (linkError) {
        try {
          await cp(source, target, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true })
        } catch {
          if (REQUIRED_ENTRIES.has(entry.name)) throw linkError
        }
      }
    }
    let userConfig: Buffer | null = null
    if (options.includeUserConfig) {
      userConfig = await readFile(path.join(sourceHome, 'config.toml')).catch(error => {
        if (!missing(error)) throw error
        return null
      })
    }
    // The derived loopback snippet already comes from this source config. An
    // explicit opt-in retains the original config intact, including its secrets.
    const config = userConfig ?? options.loopbackOverlayToml
    if (config !== null && config !== undefined) {
      // Never link config.toml: writing a secret overlay must not mutate a profile.
      await writeFile(path.join(overlayHome, 'config.toml'), config, { mode: 0o600 })
    }
    if (options.sessionsDirectory) {
      if (!path.isAbsolute(options.sessionsDirectory) || !(await lstat(options.sessionsDirectory)).isDirectory()) {
        throw new Error('Codex native sessionsDirectory must be an existing owned absolute directory.')
      }
      // No copy fallback: a copied rollout would silently split conversation state.
      await symlink(options.sessionsDirectory, path.join(overlayHome, 'sessions'),
        process.platform === 'win32' ? 'junction' : 'dir')
      sessionsMounted = true
    }
    return {
      env: { ...options.env, CODEX_HOME: overlayHome, CODEX_SQLITE_HOME: overlayHome },
      configOverrides: [`sqlite_home=${JSON.stringify(overlayHome)}`],
      cleanup,
    }
  } catch (error) {
    await cleanup().catch(() => undefined)
    throw error
  }
}
