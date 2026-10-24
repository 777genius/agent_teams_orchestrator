import { openCodeBunVersion } from '../constants/openCodeBunVersion.js'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { constants } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type PackagedOpenCodeDeliveryIdentity = Readonly<{
  schema: 1; platform: string; arch: string; bunVersion: '1.3.11' | '1.4.3'
  bunSha256: string; entrySha256: string
}>

export function isPackagedOpenCodeCommand(args: readonly string[]): boolean {
  return args[0] === 'runtime' || (args[0] === 'model' && args[1] === 'list')
}

export function validatePackagedOpenCodeIdentity(value: unknown): PackagedOpenCodeDeliveryIdentity {
  if (!value || typeof value !== 'object') throw new Error('packaged_opencode_delivery_identity_invalid')
  const row = value as Record<string, unknown>
  if (row.schema !== 1 || row.bunVersion !== openCodeBunVersion(String(row.platform)) || typeof row.platform !== 'string' ||
    typeof row.arch !== 'string' || ![row.bunSha256, row.entrySha256].every(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v))) {
    throw new Error('packaged_opencode_delivery_identity_invalid')
  }
  return value as PackagedOpenCodeDeliveryIdentity
}

async function verifiedSidecar(file: string, sha256: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || await realpath(file) !== file ||
    createHash('sha256').update(await readFile(file)).digest('hex') !== sha256) {
    throw new Error('packaged_opencode_delivery_changed')
  }
  signal.throwIfAborted()
}

/** Team ID from codesign, or null when the file is unsigned, ad-hoc, or the output is unexpected. */
async function codesignTeamId(target: string, signal: AbortSignal): Promise<string | null> {
  const { stderr } = await execFileAsync('codesign', ['-dv', '--verbose=2', target], { signal })
  const team = /^TeamIdentifier=(.+)$/m.exec(stderr)?.[1]?.trim()
  return team && team !== 'not set' ? team : null
}

/** macOS release bundles sign bun with the app identity after this runtime was compiled, so the
 * unsigned digest in the identity no longer matches. Accept a bun only when codesign verifies it
 * strictly and it carries the same Team ID as this runtime executable. */
async function signedBySameTeam(file: string, runtimeExe: string, signal: AbortSignal): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  try {
    await execFileAsync('codesign', ['--verify', '--strict', file], { signal })
    const [fileTeam, runtimeTeam] = [await codesignTeamId(file, signal), await codesignTeamId(runtimeExe, signal)]
    return fileTeam !== null && fileTeam === runtimeTeam
  } catch {
    signal.throwIfAborted()
    return false
  }
}

/** bun may match the exact unsigned bytes from the release identity, or be a bun signed by the same team. */
async function verifiedBunSidecar(file: string, sha256: string, runtimeExe: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || await realpath(file) !== file) {
    throw new Error('packaged_opencode_delivery_changed')
  }
  if (createHash('sha256').update(await readFile(file)).digest('hex') === sha256) return
  if (await signedBySameTeam(file, runtimeExe, signal)) return
  throw new Error('packaged_opencode_delivery_changed')
}

/** Only the release build supplies this identity. No environment/PATH/source fallback.
 * Existing child commands own their hosts, leases, deadlines and UNKNOWN outcomes. */
export async function runPackagedOpenCodeDelivery(args: string[], embedded: PackagedOpenCodeDeliveryIdentity): Promise<number> {
  const controller = new AbortController()
  let child: ChildProcess | undefined, cancellation: 'SIGTERM' | 'SIGINT' | undefined
  let watchdog: ReturnType<typeof setTimeout> | undefined
  const cancel = (signal: 'SIGTERM' | 'SIGINT') => {
    if (cancellation) return
    cancellation = signal; controller.abort()
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill(signal)
      // The existing command cleanup has a five-second watchdog. Escalation
      // targets only our retained child handle and cannot qualify lease cleanup.
      watchdog = setTimeout(() => { if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 5500)
      watchdog.unref()
    }
  }
  const onTerm = () => cancel('SIGTERM'), onInt = () => cancel('SIGINT')
  process.once('SIGTERM', onTerm); process.once('SIGINT', onInt)
  try {
    const identity = validatePackagedOpenCodeIdentity(embedded)
    if (identity.platform !== process.platform || identity.arch !== process.arch || !isPackagedOpenCodeCommand(args)) {
      throw new Error('packaged_opencode_delivery_identity_invalid')
    }
    const runtimeExe = await realpath(process.execPath)
    const root = path.dirname(runtimeExe)
    const bun = path.join(root, 'bun', process.platform === 'win32' ? 'bun.exe' : 'bun')
    const entry = path.join(root, 'local-cli', 'cli.js')
    await verifiedBunSidecar(bun, identity.bunSha256, runtimeExe, controller.signal)
    await verifiedSidecar(entry, identity.entrySha256, controller.signal)
    controller.signal.throwIfAborted()
    child = spawn(bun, [entry, ...args], { cwd: process.cwd(), env: { ...process.env }, stdio: [0, 1, 2], shell: false, windowsHide: true })
    const result = await new Promise<{code: number | null; signal: NodeJS.Signals | null}>((resolve, reject) => {
      child!.once('error', reject)
      child!.once('close', (code, signal) => resolve({ code, signal }))
    })
    return cancellation ? 128 + constants.signals[cancellation] :
      result.code ?? (result.signal ? 128 + constants.signals[result.signal] : 1)
  } catch (error) {
    if (cancellation) return 128 + constants.signals[cancellation]
    else throw error
  } finally {
    if (watchdog) clearTimeout(watchdog)
    process.off('SIGTERM', onTerm); process.off('SIGINT', onInt)
  }
}
