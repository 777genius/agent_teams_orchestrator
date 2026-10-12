import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Packaging consumes sealed MSVC /MT producer assets. No end-user compiler,
 * source fallback or network download is part of native startup. */
export async function stageWindowsHelper(producerDirectory: string, deliveryRoot: string, arch: 'x64' | 'arm64'): Promise<void> {
  const source = path.join(await realpath(producerDirectory), `win32-${arch}`, 'opencode-v2-windows-helper.exe')
  const info = await lstat(source)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await realpath(source) !== source) throw new Error('Invalid Windows helper producer')
  const bytes = await readFile(source)
  if (bytes.length < 64) throw new Error('Invalid Windows helper PE header')
  const peOffset = bytes.readUInt32LE(0x3c)
  if (bytes.length < peOffset + 24 || bytes.subarray(0, 2).toString() !== 'MZ' || bytes.subarray(peOffset, peOffset + 4).toString() !== 'PE\0\0' || bytes.readUInt16LE(peOffset + 4) !== (arch === 'x64' ? 0x8664 : 0xaa64)) throw new Error('Invalid Windows helper architecture')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const supplied = JSON.parse(await readFile(path.join(path.dirname(source), 'windows-helper.json'), 'utf8'))
  if (supplied.format !== 1 || supplied.platform !== 'win32' || supplied.arch !== arch || supplied.name !== path.basename(source) || supplied.sha256 !== sha256) throw new Error('Invalid Windows helper producer manifest')
  const destination = path.join(deliveryRoot, 'native', `win32-${arch}`)
  await mkdir(destination, { recursive: true })
  await copyFile(source, path.join(destination, path.basename(source)))
  await writeFile(path.join(destination, 'windows-helper.json'), JSON.stringify(supplied) + '\n')
}
