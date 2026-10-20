import filesystem from 'node:fs/promises'
import path from 'node:path'
import { hashOpenCodeFile, readOpenCodePackageManifest } from '../compatibility/OpenCodeNativeIdentity.js'
import { openCodeV2EffectVersion, type OpenCodeV2Pin } from '../compatibility/OpenCodeGenerationPolicy.js'
import { readRecord } from '../catalog/OpenCodeV2ReadStatus.js'
import { openCodeReadAssert } from '../transport/OpenCodeBoundedFetch.js'

export async function verifyOpenCodeV2ServerGraph(pin: OpenCodeV2Pin) {
  const name = pin === '2.0.0' ? '@opencode/server-v2-floor' : '@opencode/server'
  const modulePath = await filesystem.realpath(Bun.resolveSync(`${name}/process`, import.meta.dir))
  await verifyOpenCodePackage(modulePath, '@opencode/server', pin)
  const effectPath = await filesystem.realpath(Bun.resolveSync('effect', path.dirname(modulePath)))
  await verifyOpenCodePackage(effectPath, 'effect', openCodeV2EffectVersion(pin))
  for (const [dependency, subpath] of [['core', 'bus'], ['protocol', 'groups/pty'],
    ['schema', 'installation-event'], ['util', 'effect/layer-node'], ['simulation', 'backend']]) {
    const entry = await filesystem.realpath(Bun.resolveSync(`@opencode/${dependency}/${subpath}`, path.dirname(modulePath)))
    await verifyOpenCodePackage(entry, `@opencode/${dependency}`, pin)
    await verifyOpenCodeV2GraphEffect(entry, effectPath, pin)
    if (dependency === 'core') {
      // compileRequest returns Effect programs that core evaluates directly.
      const ai = await filesystem.realpath(Bun.resolveSync('@opencode/ai/route/client', path.dirname(entry)))
      await verifyOpenCodePackage(ai, '@opencode/ai', pin)
      await verifyOpenCodeV2GraphEffect(ai, effectPath, pin)
      // A hoisted shared effect binder must never decode with a foreign Effect.
      const drizzle = await filesystem.realpath(Bun.resolveSync('drizzle-orm/effect-core', path.dirname(entry)))
      await verifyOpenCodePackage(drizzle, 'drizzle-orm')
      await verifyOpenCodeV2GraphEffect(drizzle, effectPath, pin)
    }
  }
  for (const [dependency, subpath] of [['@effect/platform-node', 'NodeHttpServer'], ['@effect/platform-node-shared', 'NodeStream']]) {
    const entry = await filesystem.realpath(Bun.resolveSync(`${dependency}/${subpath}`, path.dirname(modulePath)))
    await verifyOpenCodePackage(entry, dependency!, openCodeV2EffectVersion(pin))
    await verifyOpenCodeV2GraphEffect(entry, effectPath, pin)
  }
  const client = await filesystem.realpath(Bun.resolveSync(pin === '2.0.0' ? '@opencode/client-v2-floor' : '@opencode/client', import.meta.dir))
  await verifyOpenCodePackage(client, '@opencode/client', pin)
  // The selected Promise client exchanges JSON only; its optional Effect peer
  // is not executed. Schema/protocol imports must still retain their own pin.
  for (const [dependency, subpath] of [['schema', 'installation-event'], ['protocol', 'groups/pty']]) {
    const entry = await filesystem.realpath(Bun.resolveSync(`@opencode/${dependency}/${subpath}`, path.dirname(client)))
    await verifyOpenCodePackage(entry, `@opencode/${dependency}`, pin)
    const clientEffect = await filesystem.realpath(Bun.resolveSync('effect', path.dirname(entry)))
    await verifyOpenCodePackage(clientEffect, 'effect', openCodeV2EffectVersion(pin))
  }
  return { modulePath, effectPath, moduleSha256: await hashOpenCodeFile(modulePath) }
}

/** Versions alone cannot qualify two separately installed copies of Effect. */
export async function verifyOpenCodeV2GraphEffect(entry: string, effectPath: string, pin: OpenCodeV2Pin): Promise<void> {
  const resolved = await filesystem.realpath(Bun.resolveSync('effect', path.dirname(entry)))
  await verifyOpenCodePackage(resolved, 'effect', openCodeV2EffectVersion(pin))
  openCodeReadAssert(resolved === effectPath, 'identity_mismatch')
}

export async function verifyOpenCodePackage(entry: string, name: string, version?: string): Promise<void> {
  let dir = path.dirname(entry)
  for (let depth = 0; depth < 5; depth++, dir = path.dirname(dir)) {
    let metadata: unknown
    try { metadata = await readOpenCodePackageManifest(path.join(dir, 'package.json')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    const info = readRecord(metadata)
    if (info.name === undefined && info.version === undefined) continue
    openCodeReadAssert(info.name === name && (version === undefined || info.version === version), 'identity_mismatch')
    return
  }
  throw new Error('identity_mismatch')
}
