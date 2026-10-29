import filesystem from 'node:fs/promises'
import path from 'node:path'
import { hashOpenCodeFile, readOpenCodePackageManifest } from '../compatibility/OpenCodeNativeIdentity.js'
import { isOpenCodeV2Pin, openCodeV2GraphPackages, type OpenCodeV2Pin } from '../compatibility/OpenCodeV2Registry.js'
import { readRecord } from '../catalog/OpenCodeV2ReadStatus.js'
import { openCodeReadAssert } from '../transport/OpenCodeBoundedFetch.js'
import { resolveOpenCodeV2Delivery, verifyOpenCodeV2DeliveryFile, type OpenCodeV2DeliveryBinding } from './OpenCodeV2DeliveryManifest.js'

/** Official server packages pinned to the graph version, with an entry each subpath exports. */
export const OPENCODE_V2_SERVER_GRAPH_ENTRIES = [['core', 'bus'], ['protocol', 'groups/pty'],
  ['schema', 'installation-event'], ['util', 'effect/layer-node'], ['simulation', 'backend']] as const
export const OPENCODE_V2_CLIENT_GRAPH_ENTRIES = [['schema', 'installation-event'], ['protocol', 'groups/pty']] as const
export const OPENCODE_V2_EFFECT_PLATFORM_ENTRIES = [['@effect/platform-node', 'NodeHttpServer'],
  ['@effect/platform-node-shared', 'NodeStream']] as const
const EXACT_RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/

export type OpenCodeV2ServerGraph = Readonly<{
  pin: OpenCodeV2Pin; modulePath: string; moduleSha256: string
  effectPath: string; effectVersion: string; clientPath: string
}>

/** Resolve one version-derived graph alias; an unstaged version is a coded refusal. */
export async function resolveOpenCodeV2GraphEntry(pin: OpenCodeV2Pin, kind: 'server' | 'client',
  subpath?: string, from: string = import.meta.dir, binding?: OpenCodeV2DeliveryBinding): Promise<string> {
  openCodeReadAssert(isOpenCodeV2Pin(pin), 'opencode_v2_version_out_of_range')
  const name = openCodeV2GraphPackages(pin)[kind]
  let entry: string
  if (!binding && !import.meta.url.endsWith('/OpenCodeV2ServerGraph.ts')) throw new Error('opencode_v2_support_required')
  const delivery = binding ? await resolveOpenCodeV2Delivery(binding) : undefined
  if (delivery) openCodeReadAssert(delivery.manifest.engineVersions.includes(pin), 'opencode_v2_version_unqualified')
  try { entry = Bun.resolveSync(subpath ? `${name}/${subpath}` : name, delivery?.root ?? from) }
  catch { throw new Error('opencode_v2_graph_unavailable') }
  const file = await filesystem.realpath(entry)
  if (delivery) await verifyOpenCodeV2DeliveryFile(delivery, file)
  return file
}

/** The selected server declares the exact Effect release its whole graph must share. */
export async function readOpenCodeV2ServerEffectVersion(modulePath: string): Promise<string> {
  const info = await readOpenCodePackageAt(modulePath)
  openCodeReadAssert(info.name === '@opencode/server', 'identity_mismatch')
  const dependencies = readRecord(info.dependencies)
  const version = dependencies.effect
  openCodeReadAssert(typeof version === 'string' && EXACT_RELEASE.test(version), 'identity_mismatch')
  return version
}

export async function verifyOpenCodeV2ServerGraph(pin: OpenCodeV2Pin, binding?: OpenCodeV2DeliveryBinding): Promise<OpenCodeV2ServerGraph> {
  const modulePath = await resolveOpenCodeV2GraphEntry(pin, 'server', 'process', undefined, binding)
  await verifyOpenCodePackage(modulePath, '@opencode/server', pin)
  const effectVersion = await readOpenCodeV2ServerEffectVersion(modulePath)
  const effectPath = await filesystem.realpath(Bun.resolveSync('effect', path.dirname(modulePath)))
  await verifyOpenCodePackage(effectPath, 'effect', effectVersion)
  for (const [dependency, subpath] of OPENCODE_V2_SERVER_GRAPH_ENTRIES) {
    const entry = await filesystem.realpath(Bun.resolveSync(`@opencode/${dependency}/${subpath}`, path.dirname(modulePath)))
    await verifyOpenCodePackage(entry, `@opencode/${dependency}`, pin)
    await verifyOpenCodeV2GraphEffect(entry, effectPath, effectVersion)
    if (dependency === 'core') {
      // compileRequest returns Effect programs that core evaluates directly.
      const ai = await filesystem.realpath(Bun.resolveSync('@opencode/ai/route/client', path.dirname(entry)))
      await verifyOpenCodePackage(ai, '@opencode/ai', pin)
      await verifyOpenCodeV2GraphEffect(ai, effectPath, effectVersion)
      // A hoisted shared effect binder must never decode with a foreign Effect.
      const drizzle = await filesystem.realpath(Bun.resolveSync('drizzle-orm/effect-core', path.dirname(entry)))
      await verifyOpenCodePackage(drizzle, 'drizzle-orm')
      await verifyOpenCodeV2GraphEffect(drizzle, effectPath, effectVersion)
    }
  }
  for (const [dependency, subpath] of OPENCODE_V2_EFFECT_PLATFORM_ENTRIES) {
    const entry = await filesystem.realpath(Bun.resolveSync(`${dependency}/${subpath}`, path.dirname(modulePath)))
    await verifyOpenCodePackage(entry, dependency, effectVersion)
    await verifyOpenCodeV2GraphEffect(entry, effectPath, effectVersion)
  }
  const clientPath = await resolveOpenCodeV2GraphEntry(pin, 'client', undefined, undefined, binding)
  await verifyOpenCodePackage(clientPath, '@opencode/client', pin)
  // The selected Promise client exchanges JSON only; its optional Effect peer
  // is not executed. Schema/protocol imports must still retain their own pin.
  for (const [dependency, subpath] of OPENCODE_V2_CLIENT_GRAPH_ENTRIES) {
    const entry = await filesystem.realpath(Bun.resolveSync(`@opencode/${dependency}/${subpath}`, path.dirname(clientPath)))
    await verifyOpenCodePackage(entry, `@opencode/${dependency}`, pin)
    const clientEffect = await filesystem.realpath(Bun.resolveSync('effect', path.dirname(entry)))
    await verifyOpenCodePackage(clientEffect, 'effect', effectVersion)
  }
  return { pin, modulePath, effectPath, effectVersion, clientPath, moduleSha256: await hashOpenCodeFile(modulePath) }
}

/** Versions alone cannot qualify two separately installed copies of Effect. */
export async function verifyOpenCodeV2GraphEffect(entry: string, effectPath: string, effectVersion: string): Promise<void> {
  const resolved = await filesystem.realpath(Bun.resolveSync('effect', path.dirname(entry)))
  await verifyOpenCodePackage(resolved, 'effect', effectVersion)
  openCodeReadAssert(resolved === effectPath, 'identity_mismatch')
}

async function readOpenCodePackageAt(entry: string): Promise<Record<string, unknown>> {
  let dir = path.dirname(entry)
  for (let depth = 0; depth < 5; depth++, dir = path.dirname(dir)) {
    let metadata: unknown
    try { metadata = await readOpenCodePackageManifest(path.join(dir, 'package.json')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    const info = readRecord(metadata)
    if (info.name === undefined && info.version === undefined) continue
    return info
  }
  throw new Error('identity_mismatch')
}

export async function verifyOpenCodePackage(entry: string, name: string, version?: string): Promise<void> {
  const info = await readOpenCodePackageAt(entry)
  openCodeReadAssert(info.name === name && (version === undefined || info.version === version), 'identity_mismatch')
}
