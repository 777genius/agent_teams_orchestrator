import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { loadPackagedOpenCodeV2Support } from './packaged-support.js'
import { resolveInstalledOpenCodeV2Delivery } from '../../src/services/opencode/host/OpenCodeV2DeliveryManifest.js'

/** CI-owned fixture only. Product acquisition/download remains the desktop installer's responsibility. */
export async function stageSupportFixture(base: string, support: string, cacheArgument: string) {
  const selected = await loadPackagedOpenCodeV2Support(base, support), descriptor = selected.descriptor
  await mkdir(cacheArgument, { recursive: true })
  const cache = await realpath(cacheArgument), instance = randomUUID()
  const parent = path.join(cache, descriptor.runtimeVersion, `${descriptor.platform}-${descriptor.arch}`, descriptor.archive.sha256)
  await mkdir(parent, { recursive: true })
  await cp(selected.support, path.join(parent, instance), { recursive: true, errorOnExist: true, force: false, dereference: false, verbatimSymlinks: true })
  await writeFile(path.join(parent, 'installed.json'), JSON.stringify({ schemaVersion: 1, runtimeVersion: descriptor.runtimeVersion,
    sourceCommit: descriptor.sourceCommit, bridgeProtocol: 1, platform: descriptor.platform, arch: descriptor.arch,
    archiveSha256: descriptor.archive.sha256, manifestSha256: descriptor.manifest.sha256, instance }))
  const installed = await resolveInstalledOpenCodeV2Delivery(descriptor, cache)
  assert.equal(await readFile(path.join(installed.binding.root, descriptor.manifest.file), 'utf8'),
    await readFile(path.join(selected.support, descriptor.manifest.file), 'utf8'))
  return installed.binding
}

if (import.meta.main) {
  const [base, support, cache] = process.argv.slice(2)
  assert(base && support && cache, 'Expected base, support and owned cache fixture arguments')
  console.log(JSON.stringify(await stageSupportFixture(base, support, cache)))
}
