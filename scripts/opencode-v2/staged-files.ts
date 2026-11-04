/**
 * Which files of an official package the staged V2 graphs carry.
 *
 * Bun never loads type declarations, source maps, C/C++ sources of prebuilt
 * addons, markdown documentation or another platform's prebuilt addon. Staging
 * leaves them out; package code, data, WebAssembly, the staged platform's native
 * libraries, grammar queries and other assets are copied unchanged, so module
 * digests and the graph identity checks see the same files as before.
 *
 * TypeScript sources stay whenever Bun could resolve an import to one. The
 * `typescript` package stays whole: @opencode/codemode loads the compiler at run
 * time, and keeping all of it avoids reasoning about which of its files it reads.
 * License texts stay, including a root README when the package has no other one.
 */

/** Manifest fields that select a run-time file. Condition values are walked recursively. */
export type StagedPackageManifest = Readonly<{
  name: string
  main?: unknown; module?: unknown; browser?: unknown; bin?: unknown; exports?: unknown; imports?: unknown
}>
export type StagedTarget = Readonly<{ platform: string; arch: string }>

const DECLARATION = /\.d\.[cm]?ts(?:\.map)?$/i
const SOURCE_MAP = /\.(?:[cm]?jsx?|[cm]?tsx?|css|wasm|min)\.map$/i
const TYPESCRIPT_SOURCE = /\.(?:[cm]?ts|tsx)$/i
const NATIVE_SOURCE = /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/i
const MARKDOWN = /\.(?:md|mdx|markdown)$/i
// License and attribution texts are kept whatever their extension.
const LEGAL = /^(?:licen[cs]e|notice|copying|copyright|authors|third[-_]?party)/i
const README = /^readme(?:\.|$)/i
// prebuildify/node-gyp-build layout: prebuilds/<platform>-<arch>[+<arch>...]/
const PREBUILD = /^(aix|android|darwin|freebsd|linux|netbsd|openbsd|sunos|win32)-([a-z0-9]+(?:\+[a-z0-9]+)*)$/
const TYPE_CONDITIONS = new Set(['types', 'typings'])
// bun-pty's pinned loader selects these exact names. Optional payloads are outside
// Electron afterPack, so remove foreign bindings before their manifest is sealed.
const BUN_PTY_BINDINGS: Readonly<Record<string, readonly [string, string]>> = {
  'librust_pty.so': ['linux', 'x64'], 'librust_pty_musl.so': ['linux', 'x64'],
  'librust_pty_arm64.so': ['linux', 'arm64'], 'librust_pty_arm64_musl.so': ['linux', 'arm64'],
  'librust_pty.dylib': ['darwin', 'x64'], 'librust_pty_arm64.dylib': ['darwin', 'arm64'],
  'rust_pty.dll': ['win32', 'x64'], 'rust_pty_arm64.dll': ['win32', 'arm64'],
}

function* runtimeTargets(value: unknown, condition?: string): Generator<string> {
  if (condition !== undefined && (TYPE_CONDITIONS.has(condition) || condition.startsWith('types@'))) return
  if (typeof value === 'string') yield value
  else if (Array.isArray(value)) for (const item of value) yield* runtimeTargets(item, condition)
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) yield* runtimeTargets(item, key)
  }
}

const routesToSource = (target: string) => TYPESCRIPT_SOURCE.test(target) && !DECLARATION.test(target)
const leafOf = (target: string) => target.slice(target.lastIndexOf('/') + 1)

/** Whether Bun could resolve an import of this package to a TypeScript file. */
export function exposesTypeScript(manifest: StagedPackageManifest): boolean {
  // Without an entry field Bun falls back to index.* lookup, which includes index.ts.
  if (manifest.exports === undefined && manifest.main === undefined && manifest.module === undefined) return true
  // Legacy fields resolve extensionless targets by probing extensions and index files.
  for (const field of [manifest.main, manifest.module, manifest.browser]) {
    for (const target of runtimeTargets(field)) if (routesToSource(target) || !leafOf(target).includes('.')) return true
  }
  // Export and import maps resolve exactly; an extensionless pattern may still map to a source file.
  for (const field of [manifest.exports, manifest.imports]) {
    for (const target of runtimeTargets(field)) {
      const leaf = leafOf(target)
      if (routesToSource(target) || (leaf.includes('*') && !leaf.includes('.'))) return true
    }
  }
  // bin names are not conditions, and an extensionless bin is a script, not a module.
  const bins = typeof manifest.bin === 'string' ? [manifest.bin]
    : manifest.bin && typeof manifest.bin === 'object' ? Object.values(manifest.bin) : []
  return bins.some(target => typeof target === 'string' && routesToSource(target))
}

function foreignPrebuild(directory: string, target: StagedTarget): boolean {
  const match = PREBUILD.exec(directory)
  // Unrecognized layouts are kept.
  return match !== null && !(match[1] === target.platform && match[2]!.split('+').includes(target.arch))
}

/**
 * Returns the copy predicate for one package. `relative` is the POSIX path inside
 * the package root and `rootEntries` the names directly in it; nested
 * `node_modules` are staged separately and never reach the predicate.
 */
export function stagedPackageFilter(manifest: StagedPackageManifest, target: StagedTarget,
  rootEntries: readonly string[]): (relative: string, directory: boolean) => boolean {
  if (manifest.name === 'typescript') return () => true
  const keepTypeScript = exposesTypeScript(manifest)
  // Some packages carry their only license text in the README.
  const readmeIsLicense = !rootEntries.some(name => LEGAL.test(name))
  return (relative, directory) => {
    const segments = relative.split('/')
    if (manifest.name === 'bun-pty' && !directory && relative.startsWith('rust-pty/target/release/')) {
      const binding = BUN_PTY_BINDINGS[relative.slice('rust-pty/target/release/'.length)]
      if (binding && (binding[0] !== target.platform || binding[1] !== target.arch)) return false
    }
    if (segments[0] === 'prebuilds' && segments.length >= 2 && foreignPrebuild(segments[1]!, target)) return false
    if (directory) return true
    const name = segments[segments.length - 1]!
    if (DECLARATION.test(name) || SOURCE_MAP.test(name) || NATIVE_SOURCE.test(name)) return false
    if (TYPESCRIPT_SOURCE.test(name)) return keepTypeScript
    if (!MARKDOWN.test(name) || LEGAL.test(name)) return true
    return readmeIsLicense && segments.length === 1 && README.test(name)
  }
}
