import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { validatePackagedOpenCodeIdentity } from '../../src/cli/packagedOpenCodeDelivery.js'
import { validateOpenCodeV2DeliveryDescriptor, verifyOpenCodeV2DeliveryBinding } from '../../src/services/opencode/host/OpenCodeV2DeliveryManifest.js'

/** Separate relocated archives from one verified build; no source-node_modules or copied-back graph. */
export async function loadPackagedOpenCodeV2Support(baseArgument: string, supportArgument: string) {
  const base = await realpath(baseArgument), support = await realpath(supportArgument)
  assert.notEqual(base, support)
  const descriptor = validateOpenCodeV2DeliveryDescriptor(JSON.parse(await readFile(path.join(base, 'opencode-v2-delivery.json'), 'utf8')))
  assert.equal(descriptor.runtimeVersion, (await readFile(path.join(base, 'VERSION'), 'utf8')).trim())
  assert.equal(descriptor.sourceCommit, (await readFile(path.join(base, 'COMMIT_SHA'), 'utf8')).trim())
  const identity = validatePackagedOpenCodeIdentity(JSON.parse(await readFile(path.join(base, 'opencode-delivery.json'), 'utf8')))
  assert.equal(identity.platform, descriptor.platform); assert.equal(identity.arch, descriptor.arch)
  assert.equal(identity.bunVersion, descriptor.requiredBunVersion)
  const bun = await realpath(path.join(base, 'bun', process.platform === 'win32' ? 'bun.exe' : 'bun'))
  const entry = await realpath(path.join(base, 'local-cli/cli.js'))
  const sha = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex')
  assert.equal(await sha(bun), identity.bunSha256); assert.equal(await sha(entry), identity.entrySha256)
  assert.equal(await realpath(process.execPath), bun, 'Smoke must execute the shipped physical Bun')
  for (const name of ['node_modules', 'opencodeV2Server.js', 'opencodeV2ExecutionServer.js', 'opencodeV2RunOwner.js', 'opencode-v2-graphs.json']) {
    const found = await lstat(path.join(base, 'local-cli', name)).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    assert.equal(found, null, `Optional V2 bytes leaked into base: ${name}`)
  }
  const delivery = await verifyOpenCodeV2DeliveryBinding({ root: support, manifestSha256: descriptor.manifest.sha256 }, descriptor)
  return { base, support, descriptor, delivery, identity, bun, entry }
}
