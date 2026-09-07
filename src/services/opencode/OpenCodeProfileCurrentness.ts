import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, type BigIntStats } from 'node:fs'
import path from 'node:path'
import { retainOpenCodeBehaviorInventory, type BehaviorNamespaceCheck } from './OpenCodeBehaviorInventory.js'
import { canonicalPreparedProfile, restorePreparedProfile, type PreparedProfileProjection } from './OpenCodePreparedProfileContract.js'

const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | 0o2000000
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const check = (ok: unknown) => { if (!ok) throw new Error('opencode_profile_currentness_lost') }
const same = (a: BigIntStats, b: BigIntStats, file = false) =>
  a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid &&
  (!file || (a.size === b.size && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs))
type Anchor = { fd: number; stat: BigIntStats; mount: string; parent: string | null; name: string }
function mount(fd: number): string {
  const text = readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8')
  check(text.length <= 8192)
  const value = /^mnt_id:\s+([0-9]+)$/m.exec(text)?.[1]
  check(value)
  return value!
}

/** Pins no-follow parent chains, including the first absent component. Every
 * synchronous check reopens selected names and reads actual auth/behavior bytes.
 * Mutable cache directory timestamps are not identities. No preparation occurs. */
export function retainOpenCodeProfileCurrentness(projection: PreparedProfileProjection, namespaceCheck?: BehaviorNamespaceCheck) {
  let profile: ReturnType<typeof restorePreparedProfile> | undefined = restorePreparedProfile(projection)
  let identity: string | undefined = canonicalPreparedProfile(projection)
  const directories = new Map<string, Anchor>()
  const files = new Map<string, Anchor>()
  const absent = new Map<string, { parent: string; name: string }>()
  let behavior: ReturnType<typeof retainOpenCodeBehaviorInventory> | undefined
  let sealed = false, closed = false
  const proc = (fd: number, name: string) => `/proc/self/fd/${fd}/${name}`
  const close = () => {
    if (closed) return
    closed = true; profile = undefined; identity = undefined
    behavior?.close()
    for (const item of [...files.values(), ...directories.values()].reverse()) {
      try { closeSync(item.fd) } catch {}
    }
    files.clear(); directories.clear(); absent.clear()
  }
  const absentAt = (target: string, parent: string, name: string) => {
    check(!sealed || absent.has(target))
    if (!sealed) absent.set(target, { parent, name })
    return null
  }
  const directory = (target: string): Anchor | null => {
    check(path.isAbsolute(target) && path.normalize(target) === target)
    const retained = directories.get(target)
    if (retained) return retained
    if (target === '/') {
      check(!sealed)
      const fd = openSync('/', flags | constants.O_DIRECTORY)
      const anchor = { fd, stat: fstatSync(fd, { bigint: true }), mount: mount(fd), parent: null, name: '' }
      directories.set(target, anchor); return anchor
    }
    const parentPath = path.dirname(target), name = path.basename(target)
    const parent = directory(parentPath)
    if (!parent) return null
    let fd: number
    try { fd = openSync(proc(parent.fd, name), flags | constants.O_DIRECTORY) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return absentAt(target, parentPath, name)
      throw error
    }
    try {
      check(!sealed && directories.size < 8192)
      const stat = fstatSync(fd, { bigint: true })
      check(stat.isDirectory())
      const anchor = { fd, stat, mount: mount(fd), parent: parentPath, name }
      directories.set(target, anchor); return anchor
    } catch (error) { closeSync(fd); throw error }
  }
  let observedBytes = 0
  const fingerprint = (target: string): string | null => {
    const parentPath = path.dirname(target), name = path.basename(target), parent = directory(parentPath)
    if (!parent) return null
    let fd: number
    try { fd = openSync(proc(parent.fd, name), flags) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return absentAt(target, parentPath, name)
      throw error
    }
    let retained = false
    let bytes: Buffer | undefined
    try {
      const stat = fstatSync(fd, { bigint: true }), original = files.get(target)
      check(stat.isFile() && stat.nlink === 1n && stat.size <= 16n * 1024n * 1024n && !(stat.mode & 0o022n))
      check(!sealed || (original && same(stat, original.stat, true) && mount(fd) === original.mount))
      observedBytes += Number(stat.size); check(observedBytes <= 64 * 1024 * 1024)
      bytes = Buffer.alloc(Number(stat.size))
      let offset = 0
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
        check(count > 0); offset += count
      }
      const linked = lstatSync(proc(parent.fd, name), { bigint: true })
      check(same(stat, fstatSync(fd, { bigint: true }), true) && same(stat, linked, true) && !linked.isSymbolicLink())
      if (!sealed && !original) {
        check(files.size < 4161)
        files.set(target, { fd, stat, mount: mount(fd), parent: parentPath, name }); retained = true
      }
      return hash(bytes)
    } finally { bytes?.fill(0); if (!retained) closeSync(fd) }
  }
  const observe = () => {
    check(!closed && profile)
    observedBytes = 0
    for (const target of [profile!.projectPath, profile!.profileRootPath, profile!.homePath,
      profile!.tmpPath, profile!.xdgConfigHome, profile!.xdgDataHome, profile!.xdgCacheHome]) check(directory(target))
    for (const source of [...profile!.sourceAuthSources!,
      { path: profile!.managedAuthPath, fingerprint: profile!.managedAuthFingerprint }]) {
      check(fingerprint(source.path) === source.fingerprint)
    }
    behavior ??= retainOpenCodeBehaviorInventory(profile!.projectPath, namespaceCheck)
    behavior.assertCurrent()
    check(observedBytes + behavior.byteLength <= 64 * 1024 * 1024)
    check(directories.size + behavior.directoryCount <= 8192 && files.size + behavior.fileCount <= 4161)
    check(behavior.metadata.projectBehaviorFingerprint === profile!.projectBehaviorFingerprint)
    check(JSON.stringify(behavior.metadata.behaviorSources) === JSON.stringify(profile!.behaviorSources))
  }

  const assertAnchors = () => {
    for (const [target, anchor] of [...directories, ...files]) {
      check(same(fstatSync(anchor.fd, { bigint: true }), anchor.stat, files.has(target)) && mount(anchor.fd) === anchor.mount)
      const name = anchor.parent === null ? '/' : proc(directories.get(anchor.parent)!.fd, anchor.name)
      const fd = openSync(name, flags | (directories.has(target) ? constants.O_DIRECTORY : 0))
      try { check(same(fstatSync(fd, { bigint: true }), anchor.stat, files.has(target)) && mount(fd) === anchor.mount) }
      finally { closeSync(fd) }
    }
    behavior?.assertCurrent(false)
    for (const item of absent.values()) {
      try { lstatSync(proc(directories.get(item.parent)!.fd, item.name)); check(false) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  }
  const isCurrent = () => {
    if (closed) return false
    try { assertAnchors(); observe(); assertAnchors(); return true }
    catch { close(); return false }
  }
  try {
    observe(); assertAnchors(); sealed = true
    return Object.freeze({ isCurrent, close,
      readPreparedProfile() {
        check(isCurrent())
        return structuredClone(profile!)
      },
      matches(value: PreparedProfileProjection) { return isCurrent() && canonicalPreparedProfile(value) === identity },
    })
  } catch { close(); throw new Error('opencode_profile_currentness_unavailable') }
}
