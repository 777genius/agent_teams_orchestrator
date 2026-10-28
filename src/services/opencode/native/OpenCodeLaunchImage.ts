import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

export type NativeFileIdentity = Readonly<{ dev: string; ino: string; size: string; sha256: string }>
export type NativeEpochImages = Readonly<{
  epoch: string; root: string; image: string; helper: string
  imageIdentity: NativeFileIdentity; helperIdentity: NativeFileIdentity
  directories: ReadonlyArray<Readonly<{ path: string; dev: string; ino: string; mode: number }>>
  exitReceipt: Readonly<{ file: string; dev: string; ino: string }>
  probeRoot: string
}>

function requireFact(value: unknown): asserts value {
  if (!value) throw new Error('native_custody_image_mismatch')
}

/** Only this profile's owner-controlled root can contain a new private epoch. */
export async function validateNativeProfileRoot(root: string): Promise<void> {
  requireFact(path.isAbsolute(root) && await realpath(root) === root)
  const metadata = await lstat(root)
  requireFact(metadata.isDirectory() && !metadata.isSymbolicLink() && metadata.uid === process.getuid?.() && !(metadata.mode & 0o022))
}

async function privateDirectory(directory: string): Promise<void> {
  try { await mkdir(directory, { mode: 0o700 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const metadata = await lstat(directory)
  requireFact(metadata.isDirectory() && !metadata.isSymbolicLink() && metadata.uid === process.getuid?.() && (metadata.mode & 0o777) === 0o700)
}

/** Copy a distinct object; installer hardlinks and mutable source paths are never retained images. */
async function copyImage(source: string, destination: string): Promise<NativeFileIdentity> {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
  const output = await open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try {
    const before = await input.stat({ bigint: true })
    requireFact(before.isFile() && before.size > 0 && before.size <= 250n * 1024n * 1024n)
    const hash = createHash('sha256'), buffer = Buffer.alloc(65536)
    let offset = 0
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, offset)
      if (!bytesRead) break
      offset += bytesRead
      requireFact(BigInt(offset) <= before.size)
      hash.update(buffer.subarray(0, bytesRead))
      let written = 0
      while (written < bytesRead) written += (await output.write(buffer, written, bytesRead - written)).bytesWritten
    }
    const after = await input.stat({ bigint: true }), named = await lstat(source, { bigint: true })
    requireFact(BigInt(offset) === before.size && before.dev === after.dev && before.ino === after.ino &&
      before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs &&
      named.dev === before.dev && named.ino === before.ino && !named.isSymbolicLink())
    await output.chmod(0o500); await output.sync()
    const sealed = await output.stat({ bigint: true })
    requireFact(sealed.nlink === 1n && (sealed.dev !== before.dev || sealed.ino !== before.ino))
    return Object.freeze({ dev: String(sealed.dev), ino: String(sealed.ino), size: String(sealed.size), sha256: hash.digest('hex') })
  } finally { await output.close(); await input.close() }
}

export async function verifyNativeImage(file: string, expected: NativeFileIdentity): Promise<void> {
  const named = await lstat(file, { bigint: true })
  requireFact(named.isFile() && !named.isSymbolicLink() && named.uid === BigInt(process.getuid!()) &&
    named.nlink === 1n && (named.mode & 0o777n) === 0o500n && String(named.dev) === expected.dev &&
    String(named.ino) === expected.ino && String(named.size) === expected.size)
  const opened = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const current = await opened.stat({ bigint: true })
    requireFact(current.dev === named.dev && current.ino === named.ino)
    const hash = createHash('sha256'), buffer = Buffer.alloc(65536)
    for (;;) { const { bytesRead } = await opened.read(buffer, 0, buffer.length); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)) }
    requireFact(hash.digest('hex') === expected.sha256)
    const after = await opened.stat({ bigint: true })
    requireFact(after.dev === current.dev && after.ino === current.ino && after.mtimeNs === current.mtimeNs && after.ctimeNs === current.ctimeNs)
  } finally { await opened.close() }
}

export async function verifyNativeEpochDirectories(images: NativeEpochImages): Promise<void> {
  requireFact(Array.isArray(images.directories) && images.directories.length === 5)
  for (const expected of images.directories) {
    const observed = await lstat(expected.path, { bigint: true })
    requireFact(observed.isDirectory() && !observed.isSymbolicLink() && observed.uid === BigInt(process.getuid!()) &&
      String(observed.dev) === expected.dev && String(observed.ino) === expected.ino &&
      Number(observed.mode & 0o777n) === expected.mode && !(observed.mode & 0o022n))
  }
}

export async function createNativeEpochImages(profileRoot: string, hostKey: string, selected: string, helper: string): Promise<NativeEpochImages> {
  await validateNativeProfileRoot(profileRoot)
  const authorities = path.join(profileRoot, 'host-authority')
  await privateDirectory(authorities)
  const host = path.join(authorities, createHash('sha256').update(hostKey).digest('hex'))
  await privateDirectory(host)
  const images = path.join(host, 'images'); await privateDirectory(images)
  const epoch = randomBytes(32).toString('hex'), root = path.join(images, epoch)
  await mkdir(root, { mode: 0o700 }) // Exclusive epoch; never reuse or repair old images.
  const image = path.join(root, 'opencode'), custodian = path.join(root, 'custodian')
  const imageIdentity = await copyImage(selected, image), helperIdentity = await copyImage(helper, custodian)
  const probeRoot = path.join(root, 'probe')
  await mkdir(probeRoot, { mode: 0o700 })
  for (const name of ['home', 'config', 'data', 'cache', 'state', 'tmp']) await mkdir(path.join(probeRoot, name), { mode: 0o700 })
  const exitFile = path.join(root, 'native-exit.json')
  const receipt = await open(exitFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  let exitReceipt: NativeEpochImages['exitReceipt']
  try {
    await receipt.sync(); const observed = await receipt.stat({ bigint: true })
    exitReceipt = Object.freeze({ file: exitFile, dev: String(observed.dev), ino: String(observed.ino) })
  } finally { await receipt.close() }
  const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await directory.chmod(0o500); await directory.sync() } finally { await directory.close() }
  const directories = []
  for (const directory of [profileRoot, authorities, host, images, root]) {
    const observed = await lstat(directory, { bigint: true })
    directories.push(Object.freeze({ path: directory, dev: String(observed.dev), ino: String(observed.ino), mode: Number(observed.mode & 0o777n) }))
  }
  return Object.freeze({ epoch, root, image, helper: custodian, imageIdentity, helperIdentity, directories: Object.freeze(directories), exitReceipt, probeRoot })
}
