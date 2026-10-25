/**
 * Which files of an official package the staged V2 graphs carry.
 *
 * Bun never loads type declarations, source maps, C/C++ sources of prebuilt
 * addons, markdown documentation or another platform's prebuilt addon. Staging
 * leaves them out; every loadable byte (JavaScript, JSON, WebAssembly, native
 * libraries, grammar queries and other package assets) is copied unchanged, so
 * module digests and the graph identity checks see the same files as before.
 *
 * TypeScript sources stay when the manifest can route an import to one, and the
 * `typescript` package stays whole because the compiler reads its own lib
 * declarations at run time.
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
// prebuildify/node-gyp-build layout: prebuilds/<platform>-<arch>[+<arch>...]/
const PREBUILD = /^(aix|android|darwin|freebsd|linux|netbsd|openbsd|sunos|win32)-([a-z0-9]+(?:\+[a-z0-9]+)*)$/
const TYPE_CONDITIONS = new Set(['types', 'typings'])

function* runtimeTargets(value: unknown, condition?: string): Generator<string> {
  if (condition !== undefined && (TYPE_CONDITIONS.has(condition) || condition.startsWith('types@'))) return
  if (typeof value === 'string') yield value
  else if (Array.isArray(value)) for (const item of value) yield* runtimeTargets(item, condition)
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) yield* runtimeTargets(item, key)
  }
}

/** A manifest that routes, or may route through an extensionless pattern, to a TypeScript file. */
export function exposesTypeScript(manifest: StagedPackageManifest): boolean {
  for (const field of [manifest.main, manifest.module, manifest.browser, manifest.bin, manifest.exports, manifest.imports]) {
    for (const target of runtimeTargets(field)) {
      const leaf = target.slice(target.lastIndexOf('/') + 1)
      if ((TYPESCRIPT_SOURCE.test(target) && !DECLARATION.test(target)) || (leaf.includes('*') && !leaf.includes('.'))) return true
    }
  }
  return false
}

function foreignPrebuild(directory: string, target: StagedTarget): boolean {
  const match = PREBUILD.exec(directory)
  // Unrecognized layouts are kept.
  return match !== null && !(match[1] === target.platform && match[2]!.split('+').includes(target.arch))
}

/**
 * Returns the copy predicate for one package. `relative` is the POSIX path inside
 * the package root; nested `node_modules` are staged separately and never reach it.
 */
export function stagedPackageFilter(manifest: StagedPackageManifest, target: StagedTarget):
  (relative: string, directory: boolean) => boolean {
  if (manifest.name === 'typescript') return () => true
  const keepTypeScript = exposesTypeScript(manifest)
  return (relative, directory) => {
    const segments = relative.split('/')
    if (segments[0] === 'prebuilds' && segments.length >= 2 && foreignPrebuild(segments[1]!, target)) return false
    if (directory) return true
    const name = segments[segments.length - 1]!
    if (DECLARATION.test(name) || SOURCE_MAP.test(name) || NATIVE_SOURCE.test(name)) return false
    if (TYPESCRIPT_SOURCE.test(name)) return keepTypeScript
    return !MARKDOWN.test(name) || LEGAL.test(name)
  }
}
