import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'

/** Inspect file bytes only: a static PIE must not require the build host's loader/libc. */
export function verifyStaticPieCustodyElf(binary: Buffer, target: string): void {
  const refuse = (): never => { throw new Error('Native custody requires a bounded static PIE ELF without external dependencies') }
  if (!['linux-x64', 'linux-arm64'].includes(target) || binary.length < 64 || binary.length > 16 * 1024 * 1024
    || binary.subarray(0, 7).toString('hex') !== '7f454c46020101'
    || binary.readUInt16LE(16) !== 3 || binary.readUInt16LE(18) !== (target === 'linux-x64' ? 62 : 183)
    || binary.readUInt32LE(20) !== 1 || binary.readUInt16LE(52) !== 64) refuse()
  const range = (offset: bigint, size: bigint): number => {
    if (offset > BigInt(binary.length) || size > BigInt(binary.length) - offset) refuse()
    return Number(offset)
  }
  const table = (offset: bigint, entrySize: number, count: number, expected: number, maximum: number): number => {
    if (offset < 64n || entrySize !== expected || count < 1 || count > maximum) refuse()
    return range(offset, BigInt(entrySize) * BigInt(count))
  }
  const phnum = binary.readUInt16LE(56)
  const phoff = table(binary.readBigUInt64LE(32), binary.readUInt16LE(54), phnum, 56, 128)
  const loads: Array<{ offset: bigint; size: bigint; address: bigint; memory: bigint; flags: number }> = []
  let dynamic: { offset: bigint; size: bigint; address: bigint } | undefined
  for (let i = 0; i < phnum; i++) {
    const at = phoff + i * 56, kind = binary.readUInt32LE(at), flags = binary.readUInt32LE(at + 4)
    const offset = binary.readBigUInt64LE(at + 8), address = binary.readBigUInt64LE(at + 16)
    const size = binary.readBigUInt64LE(at + 32), memory = binary.readBigUInt64LE(at + 40)
    const alignment = binary.readBigUInt64LE(at + 48)
    range(offset, size)
    if (memory > 0xffffffffffffffffn - address || kind === 3) refuse() // PT_INTERP
    if (kind === 1) {
      if (memory < size || (alignment > 1n && ((alignment & (alignment - 1n)) !== 0n
        || address % alignment !== offset % alignment))) refuse()
      loads.push({ offset, size, address, memory, flags })
    }
    if (kind === 2) {
      if (dynamic || size < 16n || size % 16n !== 0n || size > 65536n) refuse()
      dynamic = { offset, size, address }
    }
  }
  const entry = binary.readBigUInt64LE(24)
  if (!loads.some(load => (load.flags & 1) !== 0 && entry >= load.address && entry - load.address < load.memory)) refuse()
  // Static PIE still has PT_DYNAMIC for its own relocations. It is not a loader dependency.
  const relocation = dynamic
  if (!relocation) return refuse()
  if (!loads.some(load => relocation.offset >= load.offset && relocation.size <= load.size
    && relocation.offset - load.offset <= load.size - relocation.size
    && relocation.address === load.address + relocation.offset - load.offset)) refuse()
  const start = range(relocation.offset, relocation.size)
  let terminated = false, pie = false
  for (let at = start; at < start + Number(relocation.size); at += 16) {
    const tag = binary.readBigInt64LE(at), value = binary.readBigUInt64LE(at + 8)
    if (terminated) { if (tag !== 0n || value !== 0n) refuse(); continue }
    if (tag === 0n) { terminated = true; continue }
    if (tag === 0x6ffffffbn) {
      if (pie || (value & 0x8000000n) === 0n) refuse() // DF_1_PIE, not an arbitrary shared object.
      pie = true
    }
    // NEEDED, RPATH/RUNPATH, version requirements, audit/filter dependencies.
    if ([1n, 15n, 29n, 0x6ffffffen, 0x6fffffffn, 0x6ffffefbn, 0x6ffffefcn, 0x7ffffffdn, 0x7fffffffn].includes(tag)) refuse()
  }
  if (!terminated || !pie) refuse()
  const shoff = binary.readBigUInt64LE(40), shnum = binary.readUInt16LE(60), names = binary.readUInt16LE(62)
  if (shoff === 0n) { if (shnum !== 0 || names !== 0) refuse(); return }
  const startSections = table(shoff, binary.readUInt16LE(58), shnum, 64, 8192)
  if (names >= shnum) refuse()
  for (let i = 0; i < shnum; i++) {
    const at = startSections + i * 64, kind = binary.readUInt32LE(at + 4)
    const offset = binary.readBigUInt64LE(at + 24), size = binary.readBigUInt64LE(at + 32)
    if (kind !== 8) range(offset, size) // SHT_NOBITS has no file payload.
    if (kind === 0x6ffffffe && size !== 0n) refuse() // SHT_GNU_verneed, including GLIBC requirements.
  }
}

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
  verifyStaticPieCustodyElf(binary, target)
  return { schemaVersion: 1 as const, platform: 'linux' as const, arch, size: binary.length, sha256, sourceSha256 }
}
