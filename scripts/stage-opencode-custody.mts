import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'

// Qualification builds the host's actual native seam. Cross-platform publication
// must carry an independently compiled/qualified artifact, never a renamed binary.
if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch))
  throw new Error('The Linux custody helper requires its physical Linux build lane')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'dist', 'native', 'opencode-custody', `linux-${process.arch}`, 'custodian')
const source = path.join(root, 'native', 'opencode-custody', 'linux.c')
const sourceBytes = await readFile(source)
const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex')
await mkdir(path.dirname(output), { recursive: true })
const temporary = await mkdtemp(path.join(path.dirname(output), '.custody-source-'))
try {
  const captured = path.join(temporary, 'linux.c'), executable = path.join(temporary, 'custodian')
  await writeFile(captured, sourceBytes, { mode: 0o600, flag: 'wx' })
  await promisify(execFile)('/usr/bin/cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
    captured, '-o', executable], { timeout: 60000 })
  if (createHash('sha256').update(await readFile(source)).digest('hex') !== sourceSha256)
    throw new Error('Native custody source changed during compilation')
  await chmod(executable, 0o555)
  const bytes = await readFile(executable)
  const machine = process.arch === 'x64' ? 62 : 183
  if (bytes.length < 64 || bytes.subarray(0, 6).toString('hex') !== '7f454c460201' || bytes.readUInt16LE(18) !== machine)
    throw new Error('Native custody compiler produced a different OS/ABI image')
  const manifest = path.join(temporary, 'custodian.json')
  await writeFile(manifest, JSON.stringify({ schemaVersion: 1, platform: 'linux', arch: process.arch,
    size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), sourceSha256 }) + '\n', { mode: 0o600, flag: 'wx' })
  await rename(executable, output)
  await rename(manifest, `${output}.json`)
} finally { await rm(temporary, { recursive: true, force: true }) }
