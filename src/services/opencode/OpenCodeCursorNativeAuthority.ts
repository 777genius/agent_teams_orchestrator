import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/** A logged-in check alone cannot tell one account or one binary from another. */
export type CursorNativeAuthority = {
  version: 1
  /** Hashed: the account is identity, never stored or logged in the clear. */
  accountHash: string
  executableHash: string
  environmentHash?: string
  probedAt: number
}

export type CursorNativeAuthorityOutcome = {
  authority: CursorNativeAuthority | null
  state: 'refreshed' | 'account-changed' | 'executable-changed' | 'signed-out'
}

export type CursorAccountProbe = (
  executablePath: string,
  platform: NodeJS.Platform,
  abortSignal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
) => Promise<string | null>

const digest = (value: string) => createHash('sha256').update(value).digest('hex')

/**
 * Bind the real target and its bytes, including same-size timestamp-preserving
 * replacements. No native command or credential file is read here.
 */
export async function resolveCursorExecutableIdentity(executablePath: string): Promise<string> {
  const resolved = await realpath(executablePath)
  return digest(`${resolved}\n${createHash('sha256').update(await readFile(resolved)).digest('hex')}`)
}

/** Reads only the account line `status` prints; never any credential material. */
export const probeCursorAccountIdentity: CursorAccountProbe = async (
  executablePath, platform, abortSignal, env = process.env,
) => await new Promise<string | null>(resolve => {
  execFile(executablePath, ['status'], {
    env, signal: abortSignal, timeout: 15_000, windowsHide: true, shell: platform === 'win32',
  }, (error, stdout, stderr) => {
    const output = `${stdout}\n${stderr}`
    // "Not logged in" also contains "logged in": a signed-out CLI must not pass.
    if (error || !/\blogged in\b/i.test(output) || /\bnot logged in\b|"authenticated"\s*:\s*false/i.test(output)) {
      resolve(null)
      return
    }
    const account = /logged in as\s+(\S+)/i.exec(output)?.[1]
    resolve(account ? digest(account.toLowerCase()) : null)
  })
})

/**
 * Cursor authentication lives in the native CLI, not in an OpenCode credential,
 * so the only honest proof that a launch is authorized is a live account probe.
 */
/**
 * A desktop app inherits the launch services PATH, which on macOS is a short
 * system list and not the user's shell PATH. Cursor installs its CLI into
 * ~/.local/bin, so a PATH-only lookup reports "no Cursor CLI" on a machine where
 * the user has been using it all day, and the launch fails as unauthenticated.
 */
export async function resolveCursorAgentExecutable(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const configured = env.CURSOR_AGENT_EXECUTABLE?.trim()
  const resolveCandidate = async (candidate: string): Promise<string | null> => {
    try {
      const resolved = await realpath(candidate)
      await access(resolved, constants.X_OK)
      return (await stat(resolved)).isFile() ? resolved : null
    } catch { return null }
  }
  const search = async (command: string): Promise<string | null> => {
    for (const directory of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
      const resolved = await resolveCandidate(path.resolve(directory, command))
      if (resolved) return resolved
    }
    return null
  }
  if (configured) return path.isAbsolute(configured) || configured.includes(path.sep)
    ? resolveCandidate(path.resolve(configured)) : search(configured)
  const onPath = await search('cursor-agent')
  if (onPath) return onPath
  const home = env.HOME?.trim() || homedir()
  for (const candidate of [path.join(home, '.local/bin/cursor-agent'),
    '/opt/homebrew/bin/cursor-agent', '/usr/local/bin/cursor-agent']) {
    const resolved = await resolveCandidate(candidate)
    if (resolved) return resolved
  }
  return null
}

export async function isCursorNativeAccountAuthorized(input: {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  probe?: CursorAccountProbe
  abortSignal?: AbortSignal
} = {}): Promise<boolean> {
  const env = input.env ?? process.env
  const executable = await resolveCursorAgentExecutable(env)
  if (!executable) return false
  const account = await (input.probe ?? probeCursorAccountIdentity)(
    executable, input.platform ?? process.platform, input.abortSignal, env,
  ).catch(() => null)
  return account !== null
}

/**
 * A stale record is not a signed-out one: only an actual probe may conclude that.
 * A changed account or executable invalidates readiness immediately, because the
 * agent would otherwise keep running under an identity the app no longer believes.
 */
/**
 * Deduplicates bursts inside one launch sequence only, and bounds how stale an
 * answer can be to this window measured from the probe. Anything longer, or a
 * window that slides on access, hides exactly what this check exists to catch.
 */
export const CURSOR_NATIVE_AUTHORITY_DEDUPE_MS = 5_000
let recentProbe: { at: number; key: string; accountHash: string | null } | null = null

export async function reconcileCursorNativeAuthority(input: {
  statePath: string
  env?: NodeJS.ProcessEnv
  /** The real native binary. Never a generated wrapper: those are rewritten on
   * every preparation, which would churn identity on every launch. */
  executablePath: string
  /** Optional legacy probe adapter; production probes the exact binary with env. */
  probeExecutablePath?: string
  platform?: NodeJS.Platform
  dedupeMs?: number
  now?: () => number
  probe?: CursorAccountProbe
  abortSignal?: AbortSignal
}): Promise<CursorNativeAuthorityOutcome> {
  const now = (input.now ?? Date.now)()
  const executableHash = await resolveCursorExecutableIdentity(input.executablePath)
  const retained = await readAuthority(input.statePath)
  const executableChanged = Boolean(retained && retained.executableHash !== executableHash)
  // The account is always probed. The retained record only says what it was, so
  // a change can be reported; it never stands in for a fresh answer.
  const environmentHash = cursorNativeEnvironmentIdentity(input.env ?? process.env)
  const probeKey = `${input.probeExecutablePath ?? input.executablePath}|${executableHash}|${environmentHash}`
  const dedupeMs = input.dedupeMs ?? CURSOR_NATIVE_AUTHORITY_DEDUPE_MS
  // Freshness is counted from the probe itself. Counting it from the last
  // question makes the window slide: steady traffic would keep a signed-out
  // account looking valid forever.
  const reusable = recentProbe && recentProbe.key === probeKey
    && now >= recentProbe.at && now - recentProbe.at < dedupeMs
    ? recentProbe
    : null
  const accountHash = reusable
    ? reusable.accountHash
    : await (input.probe ?? probeCursorAccountIdentity)(
      input.probeExecutablePath ?? input.executablePath,
      input.platform ?? process.platform, input.abortSignal, input.env,
    ).catch(() => null)
  if (!reusable) recentProbe = { at: now, key: probeKey, accountHash }
  if (!accountHash) return { authority: null, state: 'signed-out' }
  const authority: CursorNativeAuthority = { version: 1, accountHash, executableHash, environmentHash, probedAt: now }
  await writeAuthority(input.statePath, authority)
  if (!retained) return { authority, state: 'refreshed' }
  if (retained.accountHash !== accountHash) return { authority, state: 'account-changed' }
  return { authority, state: executableChanged ? 'executable-changed' : 'refreshed' }
}

async function readAuthority(statePath: string): Promise<CursorNativeAuthority | null> {
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>
    const valid = parsed.version === 1
      && typeof parsed.accountHash === 'string' && /^[a-f0-9]{64}$/.test(parsed.accountHash)
      && typeof parsed.executableHash === 'string' && /^[a-f0-9]{64}$/.test(parsed.executableHash)
      && typeof parsed.probedAt === 'number' && Number.isFinite(parsed.probedAt)
    return valid ? (parsed as CursorNativeAuthority) : null
  } catch {
    return null
  }
}

async function writeAuthority(statePath: string, authority: CursorNativeAuthority): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 })
  await writeFile(statePath, `${JSON.stringify(authority)}\n`, { mode: 0o600 })
}

/**
 * Binds a launch to everything that must not drift underneath it. A readiness
 * answer computed for one host, model, endpoint or asset build must not be
 * replayed for another.
 */
export function buildCursorReadinessFingerprint(input: {
  authority: CursorNativeAuthority
  assetsFingerprint: string
  profileScopeToken: string
  /** Already covers the selected model, provider options and App MCP config. */
  managedConfigFingerprint: string
  proxyPort: number
}): string {
  for (const [name, value] of Object.entries({
    assetsFingerprint: input.assetsFingerprint,
    profileScopeToken: input.profileScopeToken,
    managedConfigFingerprint: input.managedConfigFingerprint,
  })) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`Cursor readiness fingerprint requires ${name}`)
    }
  }
  if (!Number.isSafeInteger(input.proxyPort) || input.proxyPort <= 1024) {
    throw new Error('Cursor readiness fingerprint requires the retained proxy port')
  }
  return digest(JSON.stringify([
    1,
    input.authority.accountHash,
    input.authority.executableHash,
    input.authority.environmentHash ?? null,
    input.assetsFingerprint,
    input.profileScopeToken,
    input.managedConfigFingerprint.trim(),
    input.proxyPort,
  ]))
}

// These are restored by the wrapper before invoking the exact native binary.
export const CURSOR_NATIVE_ENV_KEYS = [
  'HOME', 'USERPROFILE', 'PATH', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'CURSOR_CONFIG_DIR', 'CURSOR_ACP_HOME_DIR', 'NODE_OPTIONS',
] as const

export function cursorNativeEnvironmentIdentity(env: NodeJS.ProcessEnv): string {
  return digest(JSON.stringify(CURSOR_NATIVE_ENV_KEYS.map(key => [key, env[key] ?? null])))
}

export function cursorNativeSelectedIdentity(authority: CursorNativeAuthority): `known:${string}` {
  return `known:${digest(JSON.stringify(['cursor-native-v1', authority.accountHash,
    authority.executableHash, authority.environmentHash ?? null]))}`
}

/** Strict scope and final seals always probe CURRENT account state, bypassing burst dedupe. */
export async function resolveCurrentCursorNativeAuthority(env: NodeJS.ProcessEnv, abortSignal?: AbortSignal) {
  const executablePath = await resolveCursorAgentExecutable(env)
  if (!executablePath) return null
  const executableHash = await resolveCursorExecutableIdentity(executablePath)
  const accountHash = await probeCursorAccountIdentity(executablePath, process.platform, abortSignal, env)
  if (!accountHash || executableHash !== await resolveCursorExecutableIdentity(executablePath)) return null
  const authority: CursorNativeAuthority = { version: 1, accountHash, executableHash,
    environmentHash: cursorNativeEnvironmentIdentity(env), probedAt: Date.now() }
  return { executablePath, authority, identity: cursorNativeSelectedIdentity(authority) }
}
