import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const sourceDirectory = path.resolve(import.meta.dir, '../../src/services/opencode/cursor-native')
const scriptNames = ['supervisor.mjs', 'preload.cjs', 'group-cleanup.mjs', 'scope-sweep.mjs'] as const
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** Compile at build time. End-user machines never need a compiler. */
export async function buildCursorNativeAssets(destination: string): Promise<void> {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) {
    throw new Error('Cursor native ownership assets require a macOS build host')
  }
  await mkdir(destination, { recursive: true })
  const gatePath = path.join(destination, 'gate')
  const compile = Bun.spawnSync(['/usr/bin/clang', '-O2', '-Wall', '-Wextra', '-Werror',
    path.join(sourceDirectory, 'gate.c'), '-o', gatePath], { stdout: 'pipe', stderr: 'pipe' })
  if (compile.exitCode !== 0) throw new Error('Cursor ownership gate compilation failed')
  await chmod(gatePath, 0o700)
  const files: Record<string, string> = { gate: digest(await readFile(gatePath)) }
  for (const name of scriptNames) {
    await copyFile(path.join(sourceDirectory, name), path.join(destination, name))
    await chmod(path.join(destination, name), 0o600)
    files[name] = digest(await readFile(path.join(destination, name)))
  }
  await writeFile(path.join(destination, 'manifest.json'), JSON.stringify({
    schema: 1, platform: process.platform, arch: process.arch, files,
    gateSourceSha256: digest(await readFile(path.join(sourceDirectory, 'gate.c'))),
  }, null, 2) + '\n', { mode: 0o600 })
}
