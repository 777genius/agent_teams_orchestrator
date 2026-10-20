import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const failure = (): Error => new Error('OpenCode gateway credential ownership or contents changed')

async function readPrivateFile(path: string): Promise<string> {
  const before = await lstat(path)
  if (!before.isFile() || before.size > 16384 ||
      (process.platform !== 'win32' && ((before.mode & 0o077) !== 0 || before.uid !== process.getuid?.()))) {
    throw failure()
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw failure()
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (bytes.byteLength > 16384 || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw failure()
    return bytes.toString('utf8')
  } finally {
    await handle.close()
  }
}

/** Snapshot only an app-owned selected gateway key before strict authority binding.
 * The native host receives the validated value, so later file replacement cannot
 * change a running host's credentials. Arbitrary file references remain rejected.
 */
export async function snapshotOpenCodeGatewayCredential(
  config: Record<string, unknown>, providerId: string, env: NodeJS.ProcessEnv,
): Promise<void> {
  if (!/^gateway-[a-z0-9_-]+-[a-f0-9]{12}$/.test(providerId)) return
  const provider = record(record(config.provider)?.[providerId])
  const options = record(provider?.options)
  const reference = options?.apiKey
  if (typeof reference !== 'string' || !reference.startsWith('{file:')) return
  try {
    if (!reference.endsWith('}') || !env.HOME && !env.USERPROFILE) throw failure()
    const home = await realpath(env.HOME || env.USERPROFILE!)
    let directory = home
    for (const part of ['.config', 'opencode', 'agent-teams-credentials']) {
      directory = join(directory, part)
      const stat = await lstat(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure()
    }
    const credentialPath = reference.slice(6, -1)
    if (!isAbsolute(credentialPath) || dirname(credentialPath) !== directory) throw failure()
    const suffix = basename(credentialPath).slice(providerId.length + 1)
    const match = /^([a-f0-9]{16})-[a-f0-9-]{36}\.key$/.exec(suffix)
    if (!basename(credentialPath).startsWith(providerId + '-') || !match) throw failure()
    const markerPath = join(directory, `${providerId}-${match[1]}.owner.json`)
    const owner = record(JSON.parse(await readPrivateFile(markerPath)))
    if (owner?.schemaVersion !== 1 || owner.owner !== 'agent-teams-gateway' ||
        owner.providerId !== providerId || owner.credentialReference !== reference ||
        typeof owner.configPath !== 'string' ||
        !['opencode.json', 'opencode.jsonc'].some(name => resolve(owner.configPath as string) === join(home, '.config', 'opencode', name)) ||
        createHash('sha256').update(resolve(owner.configPath)).digest('hex').slice(0, 16) !== match[1] ||
        typeof owner.teamName !== 'string' || typeof owner.memberName !== 'string' || typeof owner.gatewayUsageRef !== 'string' ||
        !providerId.endsWith('-' + digest([owner.teamName, owner.memberName, owner.gatewayUsageRef]).slice(0, 12)) ||
        owner.providerDigest !== digest(provider)) throw failure()
    const apiKey = await readPrivateFile(credentialPath)
    if (!apiKey || apiKey !== apiKey.trim() || /[\r\n\0]|\{(?:env|file):/.test(apiKey) ||
        owner.inputDigest !== digest([options!.baseURL, apiKey])) throw failure()
    options!.apiKey = apiKey
  } catch {
    // Paths, key bytes and ownership contents must not enter bridge diagnostics.
    throw failure()
  }
}
