import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** A logged-in check alone cannot tell one account or one binary from another. */
export type CursorNativeAuthority = {
  version: 1
  /** Hashed: the account is identity, never stored or logged in the clear. */
  accountHash: string
  executableHash: string
  probedAt: number
}

export type CursorNativeAuthorityOutcome = {
  authority: CursorNativeAuthority | null
  state: 'reused' | 'refreshed' | 'account-changed' | 'executable-changed' | 'signed-out'
}

export type CursorAccountProbe = (
  executablePath: string,
  platform: NodeJS.Platform,
  abortSignal?: AbortSignal,
) => Promise<string | null>

export const CURSOR_NATIVE_AUTHORITY_TTL_MS = 30 * 60 * 1000
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

/**
 * Cheap enough to run on every preparation, so a swapped or updated binary is
 * noticed without paying for a subprocess.
 */
export async function resolveCursorExecutableIdentity(executablePath: string): Promise<string> {
  const resolved = await realpath(executablePath)
  const stats = await stat(resolved)
  return digest(`${resolved}\n${stats.size}\n${Math.trunc(stats.mtimeMs)}`)
}

/** Reads only the account line `status` prints; never any credential material. */
export const probeCursorAccountIdentity: CursorAccountProbe = async (
  executablePath, platform, abortSignal,
) => await new Promise<string | null>(resolve => {
  execFile(executablePath, ['status'], {
    signal: abortSignal, timeout: 15_000, windowsHide: true, shell: platform === 'win32',
  }, (error, stdout, stderr) => {
    const output = `${stdout}\n${stderr}`
    // "Not logged in" also contains "logged in": a signed-out CLI must not pass.
    if (error || !/\blogged in\b/i.test(output) || /\bnot logged in\b|"authenticated"\s*:\s*false/i.test(output)) {
      resolve(null)
      return
    }
    const account = /logged in as\s+(\S+)/i.exec(output)?.[1]
    resolve(digest(account ? account.toLowerCase() : output.replace(/\s+/g, ' ').trim()))
  })
})

/**
 * A stale record is not a signed-out one: only an actual probe may conclude that.
 * A changed account or executable invalidates readiness immediately, because the
 * agent would otherwise keep running under an identity the app no longer believes.
 */
export async function reconcileCursorNativeAuthority(input: {
  statePath: string
  /** The real native binary. Never a generated wrapper: those are rewritten on
   * every preparation, which would churn identity and defeat the probe window. */
  executablePath: string
  /** Wrapper to probe through, so the native CLI sees its own home. */
  probeExecutablePath?: string
  platform?: NodeJS.Platform
  ttlMs?: number
  now?: () => number
  probe?: CursorAccountProbe
  abortSignal?: AbortSignal
}): Promise<CursorNativeAuthorityOutcome> {
  const now = (input.now ?? Date.now)()
  const ttlMs = input.ttlMs ?? CURSOR_NATIVE_AUTHORITY_TTL_MS
  const executableHash = await resolveCursorExecutableIdentity(input.executablePath)
  const retained = await readAuthority(input.statePath)
  const executableChanged = Boolean(retained && retained.executableHash !== executableHash)
  if (retained && !executableChanged && retained.probedAt + ttlMs > now) {
    return { authority: retained, state: 'reused' }
  }
  const accountHash = await (input.probe ?? probeCursorAccountIdentity)(
    input.probeExecutablePath ?? input.executablePath,
    input.platform ?? process.platform, input.abortSignal,
  ).catch(() => null)
  if (!accountHash) return { authority: null, state: 'signed-out' }
  const authority: CursorNativeAuthority = { version: 1, accountHash, executableHash, probedAt: now }
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
    input.assetsFingerprint,
    input.profileScopeToken,
    input.managedConfigFingerprint.trim(),
    input.proxyPort,
  ]))
}
