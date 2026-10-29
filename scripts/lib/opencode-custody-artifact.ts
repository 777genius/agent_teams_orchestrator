import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'

/** Delivery verification only; physical custody qualification remains a real Linux test. */
export function verifyLinuxCustodyArtifact(directory: string, target: string, sourceFile: string) {
  if (!['linux-x64', 'linux-arm64'].includes(target)) throw new Error('Unsupported native custody artifact target')
  const file = path.join(directory, 'opencode-custody', target, 'custodian')
  const metadata = lstatSync(file), manifestMetadata = lstatSync(`${file}.json`), sourceMetadata = lstatSync(sourceFile)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o555
    || metadata.size < 64 || metadata.size > 16 * 1024 * 1024
    || !manifestMetadata.isFile() || manifestMetadata.isSymbolicLink() || manifestMetadata.size > 16384
    || !sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) throw new Error('Invalid native custody artifact files')
  const binary = readFileSync(file), source = readFileSync(sourceFile)
  const sha256 = createHash('sha256').update(binary).digest('hex')
  const sourceSha256 = createHash('sha256').update(source).digest('hex')
  const arch = target.slice('linux-'.length)
  const manifest: unknown = JSON.parse(readFileSync(`${file}.json`, 'utf8'))
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Invalid native custody manifest')
  const row = manifest as Record<string, unknown>
  // Refuse renamed cross-target binaries even if a sidecar claims the requested architecture.
  if (!binary.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || binary[4] !== 2 || binary[5] !== 1
    || ![2, 3].includes(binary.readUInt16LE(16)) || binary.readUInt16LE(18) !== (arch === 'x64' ? 62 : 183)
    || row.schemaVersion !== 1 || row.platform !== 'linux' || row.arch !== arch || row.size !== binary.length
    || row.sha256 !== sha256 || row.sourceSha256 !== sourceSha256) throw new Error('Native custody source or binary identity mismatch')
  return { schemaVersion: 1 as const, platform: 'linux' as const, arch, size: binary.length, sha256, sourceSha256 }
}
