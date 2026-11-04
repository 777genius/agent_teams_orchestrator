import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { copyStagedPackage, type StagedFileTotals } from './stage.js'

const darwinArm64 = { platform: 'darwin', arch: 'arm64' }
const manifest = { name: 'fixture', version: '1.0.0', exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } } }

async function write(root: string, relative: string, content = 'x') {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true })
  await writeFile(path.join(root, relative), content)
}

async function tree(root: string): Promise<string[]> {
  const entries: string[] = []
  for (const relative of await readdir(root, { recursive: true })) {
    const info = await stat(path.join(root, relative))
    entries.push(relative.split(path.sep).join('/') + (info.isDirectory() ? '/' : ''))
  }
  return entries.sort()
}

test('a staged package keeps loadable files, drops unused ones and removes only directories it emptied', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-staged-copy-')))
  try {
    const source = path.join(root, 'source')
    await write(source, 'package.json', JSON.stringify(manifest))
    await write(source, 'LICENSE')
    await write(source, 'README.md')
    await write(source, 'dist/index.js', 'export {}')
    await write(source, 'dist/index.js.map')
    await write(source, 'dist/index.d.ts')
    await write(source, 'dist/types/only.d.ts')
    await write(source, 'src/index.ts')
    await write(source, 'prebuilds/darwin-arm64/addon.node')
    await write(source, 'prebuilds/linux-x64/addon.node', 'linux')
    await write(source, 'node_modules/nested/package.json', '{}')
    await mkdir(path.join(source, 'assets/empty'), { recursive: true })
    await symlink('dist', path.join(source, 'linked'), 'dir')
    const totals: StagedFileTotals = { kept: { files: 0, bytes: 0 }, excluded: { files: 0, bytes: 0 } }
    const target = path.join(root, 'target')
    await copyStagedPackage(source, target, manifest, darwinArm64, totals)
    expect(await tree(target)).toEqual([
      'LICENSE', 'assets/', 'assets/empty/', 'dist/', 'dist/index.js', 'linked/', 'linked/index.js',
      'package.json', 'prebuilds/', 'prebuilds/darwin-arm64/', 'prebuilds/darwin-arm64/addon.node',
    ])
    // Symlinked directories are copied as physical files, never as links.
    await expect(readlink(path.join(target, 'linked'))).rejects.toThrow()
    expect(totals.kept.files).toBe(5)
    // README, map, two declarations, TS source and the linux prebuild, plus the linked copies of map and declarations.
    expect(totals.excluded.files).toBe(9)
    expect(totals.excluded.bytes).toBe(13)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a package asset that links outside its package is refused', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-staged-escape-')))
  try {
    const source = path.join(root, 'source')
    await write(source, 'package.json', JSON.stringify(manifest))
    await write(root, 'outside.js')
    await symlink(path.join(root, 'outside.js'), path.join(source, 'escape.js'))
    const totals: StagedFileTotals = { kept: { files: 0, bytes: 0 }, excluded: { files: 0, bytes: 0 } }
    await expect(copyStagedPackage(source, path.join(root, 'target'), manifest, darwinArm64, totals))
      .rejects.toThrow('Package asset escapes its package')
  } finally { await rm(root, { recursive: true, force: true }) }
})
