import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Packaging consumes sealed MSVC /MT producer assets. No end-user compiler,
 * source fallback or network download is part of native startup. */
export async function stageWindowsHelper(producerDirectory: string, deliveryRoot: string, arch: 'x64' | 'arm64'): Promise<void> {
  const producerRoot = path.join(await realpath(producerDirectory), `win32-${arch}`)
  const assets = await Promise.all([
    readProducerAsset(producerRoot, arch, 'opencode-v2-windows-helper.exe', 'windows-helper.json', false),
    readProducerAsset(producerRoot, arch, 'opencode-v2-windows-realpath.dll', 'windows-realpath.json', true),
  ])
  const destination = path.join(deliveryRoot, 'native', `win32-${arch}`)
  await mkdir(destination, { recursive: true })
  for (const asset of assets) {
    await copyFile(asset.source, path.join(destination, asset.name))
    const delivered = await readFile(path.join(destination, asset.name))
    if (createHash('sha256').update(delivered).digest('hex') !== asset.sha256) throw new Error('Windows native producer changed during staging')
    await writeFile(path.join(destination, asset.manifestName), JSON.stringify(asset.manifest) + '\n')
  }
}

async function readProducerAsset(producerRoot: string, arch: 'x64' | 'arm64', name: string, manifestName: string, dll: boolean) {
  const source = path.join(producerRoot, name)
  const info = await lstat(source)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await realpath(source) !== source) throw new Error('Invalid Windows helper producer')
  const bytes = await readFile(source)
  if (bytes.length < 64) throw new Error('Invalid Windows helper PE header')
  const peOffset = bytes.readUInt32LE(0x3c)
  if (bytes.length < peOffset + 24 || bytes.subarray(0, 2).toString() !== 'MZ' || bytes.subarray(peOffset, peOffset + 4).toString() !== 'PE\0\0' || bytes.readUInt16LE(peOffset + 4) !== (arch === 'x64' ? 0x8664 : 0xaa64) || Boolean(bytes.readUInt16LE(peOffset + 22) & 0x2000) !== dll) throw new Error('Invalid Windows native architecture or kind')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const supplied = JSON.parse(await readFile(path.join(producerRoot, manifestName), 'utf8'))
  if (supplied.format !== 1 || supplied.platform !== 'win32' || supplied.arch !== arch || supplied.name !== path.basename(source) || supplied.sha256 !== sha256) throw new Error('Invalid Windows helper producer manifest')
  return { source, name, manifestName, manifest: supplied, sha256 }
}
