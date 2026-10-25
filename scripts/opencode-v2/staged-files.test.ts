import { expect, test } from 'bun:test'
import { exposesTypeScript, stagedPackageFilter } from './staged-files.js'

const darwinArm64 = { platform: 'darwin', arch: 'arm64' }
const distOnly = { name: 'effect', exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } } }

test('keeps every loadable file and leaves out declarations, maps, native sources and docs', () => {
  const keep = stagedPackageFilter(distOnly, darwinArm64)
  for (const file of ['dist/index.js', 'dist/a.mjs', 'dist/b.cjs', 'package.json', 'dist/data.json',
    'tree-sitter-bash.wasm', 'queries/highlights.scm', 'build/Release/addon.node', 'lib/libpty.dylib',
    'bin/opencode-pty', 'prompt.txt', 'LICENSE', 'LICENSE.md', 'NOTICE.md', 'ThirdPartyNoticeText.txt', 'assets/font.otf']) {
    expect([file, keep(file, false)]).toEqual([file, true])
  }
  for (const file of ['dist/index.d.ts', 'dist/index.d.mts', 'dist/index.d.cts', 'dist/index.d.ts.map',
    'dist/index.js.map', 'dist/a.mjs.map', 'dist/b.cjs.map', 'web.wasm.map', 'sprintf.min.map', 'styles.css.map',
    'src/parser.c', 'src/scanner.cc', 'src/tree_sitter/parser.h', 'README.md', 'CHANGELOG.md', 'docs/guide.mdx']) {
    expect([file, keep(file, false)]).toEqual([file, false])
  }
  expect(keep('dist/types', true)).toBe(true)
})

test('TypeScript sources stay only when the manifest can route an import to one', () => {
  expect(stagedPackageFilter(distOnly, darwinArm64)('src/Effect.ts', false)).toBe(false)
  expect(stagedPackageFilter(distOnly, darwinArm64)('src/view.tsx', false)).toBe(false)
  const routed = [
    { name: 'zod', exports: { '.': { '@zod/source': './src/index.ts', import: './index.js' } } },
    { name: 'parser', exports: { '.': [{ bun: './src/index.mts' }, './dist/index.js'] } },
    { name: 'core', imports: { '#pty': { bun: './src/pty.bun.ts', default: './dist/pty.js' } } },
    { name: 'tool', main: './index.ts' },
    { name: 'cli', bin: { tool: './bin/tool.ts' } },
    { name: 'wild', exports: { './*': './src/*' } },
  ]
  for (const manifest of routed) {
    expect([manifest.name, exposesTypeScript(manifest)]).toEqual([manifest.name, true])
    expect([manifest.name, stagedPackageFilter(manifest, darwinArm64)('src/index.ts', false)]).toEqual([manifest.name, true])
  }
  // Type conditions, declarations and extension-bearing patterns never route to a source file.
  for (const manifest of [
    { name: 'typed', exports: { '.': { types: './src/index.ts', import: './dist/index.js' } } },
    { name: 'versioned', exports: { '.': { 'types@<5': './src/index.ts', default: './dist/index.js' } } },
    { name: 'declared', main: './dist/index.js', module: './dist/index.d.ts' },
    { name: 'pattern', exports: { './*': { import: './dist/*.js', types: './dist/*.d.ts' } } },
  ]) expect([manifest.name, exposesTypeScript(manifest)]).toEqual([manifest.name, false])
})

test('the TypeScript compiler keeps the lib declarations it reads at run time', () => {
  const keep = stagedPackageFilter({ name: 'typescript', main: './lib/typescript.js' }, darwinArm64)
  for (const file of ['lib/lib.es2022.d.ts', 'lib/typescript.d.ts', 'README.md', 'lib/typescript.js']) expect(keep(file, false)).toBe(true)
})

test('prebuilt addons stay for the staged platform only', () => {
  const keep = stagedPackageFilter(distOnly, darwinArm64)
  expect(keep('prebuilds/darwin-arm64', true)).toBe(true)
  expect(keep('prebuilds/darwin-arm64/tree-sitter-bash.node', false)).toBe(true)
  expect(keep('prebuilds/darwin-x64+arm64', true)).toBe(true)
  for (const foreign of ['darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64', 'win32-arm64']) {
    expect([foreign, keep(`prebuilds/${foreign}`, true)]).toEqual([foreign, false])
    expect([foreign, keep(`prebuilds/${foreign}/tree-sitter-bash.node`, false)]).toEqual([foreign, false])
  }
  // Unrecognized layouts and nested folders of the same name are not guessed at.
  expect(keep('prebuilds/linuxmusl-x64', true)).toBe(true)
  expect(keep('lib/prebuilds/linux-x64/addon.node', false)).toBe(true)
  const windows = stagedPackageFilter(distOnly, { platform: 'win32', arch: 'x64' })
  expect(windows('prebuilds/win32-x64/node.napi.node', false)).toBe(true)
  expect(windows('prebuilds/win32-arm64/node.napi.node', false)).toBe(false)
})
