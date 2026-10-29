import { lstat, readFile, realpath, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquire, ANCHORS } from '../opencode-generation-spikes/artifacts.js'
import { Sandbox } from '../opencode-generation-spikes/sandbox.js'
import { verifyLinuxCustodyArtifact } from '../lib/opencode-custody-artifact.js'
import { parsePackagedSecurityCapabilities } from './verify-packaged-delivery.js'

// CI only: exact accepted V1 pins, fresh TEST roots and the existing official SRI/tar/ELF boundary.
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Physical Linux x64 vendor qualification required')
const [directory, runtimeRoot] = process.argv.slice(2)
const sourceSha = process.env.OPENCODE_NATIVE_CUSTODY_SOURCE_SHA
if (!directory || !runtimeRoot || !sourceSha || !/^[a-f0-9]{40}$/.test(sourceSha)
  || !path.isAbsolute(directory) || await realpath(directory) !== directory
  || !path.isAbsolute(runtimeRoot) || await realpath(runtimeRoot) !== runtimeRoot) throw new Error('Invalid native vendor fixture paths')
const parent = await lstat(directory)
if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid!() || (parent.mode & 0o777) !== 0o700)
  throw new Error('Native vendor fixtures require an owned private TEST directory')
if ((await readFile(path.join(runtimeRoot, 'COMMIT_SHA'), 'utf8')).trim() !== sourceSha)
  throw new Error('Native custody candidate source mismatch')
const capability = JSON.parse(await readFile(path.join(runtimeRoot, 'security-capabilities.json'), 'utf8'))
if (capability.sourceSha !== sourceSha || capability.platform !== 'linux' || capability.arch !== 'x64'
  || ![capability.compiled?.sha256, capability.shippedJs?.entrySha256, capability.shippedJs?.bunSha256]
    .every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)))
  throw new Error('Native custody candidate identity missing')
const compiledCapability = parsePackagedSecurityCapabilities(JSON.stringify(capability.compiled.capabilities))
const shippedCapability = parsePackagedSecurityCapabilities(JSON.stringify(capability.shippedJs.capabilities))
const abiReportSha256 = createHash('sha256').update(await readFile(path.join(runtimeRoot, 'linux-elf-abi.txt'))).digest('hex')
const native = verifyLinuxCustodyArtifact(path.join(runtimeRoot, 'native'), 'linux-x64',
  fileURLToPath(new URL('../../native/opencode-custody/linux.c', import.meta.url)))
const vendors: Array<{ version: string; binaryPath: string; sha256: string }> = []
const receipts = []
for (const version of ['1.16.0', '1.18.34'] as const) {
  const anchor = ANCHORS.find(row => row.generation === 'v1' && row.version === version)
  if (!anchor) throw new Error('Approved native vendor anchor missing')
  const sandbox = await Sandbox.create(path.join(directory, `TEST-v1-${version}`),
    path.join(directory, `evidence-v1-${version}`), `native-custody-ingress-${version}`)
  const artifact = await acquire(sandbox, anchor)
  vendors.push({ version, binaryPath: artifact.binary, sha256: artifact.sha256 })
  receipts.push({ version, sha256: artifact.sha256, packages: artifact.packages })
}
await writeFile(path.join(directory, 'vendors.json'), JSON.stringify({ schemaVersion: 1, vendors }) + '\n',
  { flag: 'wx', mode: 0o600 })
await writeFile(path.join(directory, 'acquisition.json'), JSON.stringify({
  schemaVersion: 1, sourceSha, candidate: {
    compiledSha256: capability.compiled.sha256, entrySha256: capability.shippedJs.entrySha256,
    bunSha256: capability.shippedJs.bunSha256, compiledCapability, shippedCapability,
    abiReportSha256, portabilityQualification: 'pending',
  }, nativeCustody: native, vendors: receipts,
}, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
console.log('Prepared exact integrity-verified V1 ingress fixtures: 1.16.0, 1.18.34')
