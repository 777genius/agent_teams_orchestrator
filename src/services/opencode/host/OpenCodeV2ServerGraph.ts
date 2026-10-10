import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { hashOpenCodeFile, readOpenCodePackageManifest } from '../compatibility/OpenCodeNativeIdentity.js'
import type { OpenCodeV2Pin } from '../compatibility/OpenCodeGenerationPolicy.js'
import { readRecord } from '../catalog/OpenCodeV2ReadStatus.js'
import { openCodeReadAssert } from '../transport/OpenCodeBoundedFetch.js'

export async function verifyOpenCodeV2ServerGraph(pin: OpenCodeV2Pin) {
  const name = pin === '2.0.0' ? '@opencode/server-v2-floor' : '@opencode/server'
  const modulePath = await realpath(Bun.resolveSync(`${name}/process`, import.meta.dir))
  const metadata = readRecord(await readOpenCodePackageManifest(path.join(path.dirname(modulePath), '..', 'package.json')))
  openCodeReadAssert(metadata.name === '@opencode/server' && metadata.version === pin, 'identity_mismatch')
  for (const [dependency, subpath] of [['core', 'bus'], ['protocol', 'groups/pty'],
    ['schema', 'installation-event'], ['util', 'effect/layer-node'], ['simulation', 'backend']]) {
    const entry = await realpath(Bun.resolveSync(`@opencode/${dependency}/${subpath}`, path.dirname(modulePath)))
    await verifyOpenCodePackage(entry, `@opencode/${dependency}`, pin)
  }
  const effectPath = await realpath(Bun.resolveSync('effect', path.dirname(modulePath)))
  const effectInfo = readRecord(await readOpenCodePackageManifest(path.join(path.dirname(effectPath), '..', 'package.json')))
  openCodeReadAssert(effectInfo.name === 'effect' && effectInfo.version === '4.0.0-rc.112', 'identity_mismatch')
  return { modulePath, effectPath, moduleSha256: await hashOpenCodeFile(modulePath) }
}

export async function verifyOpenCodePackage(entry: string, name: string, version: string): Promise<void> {
  let dir = path.dirname(entry)
  for (let depth = 0; depth < 5; depth++, dir = path.dirname(dir)) {
    let metadata: unknown
    try { metadata = await readOpenCodePackageManifest(path.join(dir, 'package.json')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    const info = readRecord(metadata)
    openCodeReadAssert(info.name === name && info.version === version, 'identity_mismatch')
    return
  }
  throw new Error('identity_mismatch')
}
