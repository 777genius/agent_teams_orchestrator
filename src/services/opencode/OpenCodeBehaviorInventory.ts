import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, type BigIntStats } from 'node:fs'
import path from 'node:path'
import { PROJECT_BEHAVIOR_DIRS, PROJECT_BEHAVIOR_FILES } from './OpenCodeProjectBehaviorPaths.js'

const check = (value: unknown) => { if (!value) throw new Error('opencode_behavior_entry_unsupported') }
const same = (a: BigIntStats, b: BigIntStats, contents: boolean) =>
  a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid &&
  (!contents || (a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs))
type Entry = { fd: number; stat: BigIntStats; parent: Entry | null; name: string; target: string; inventory: boolean; names?: string[]; digest?: string }
export type BehaviorNamespaceCheck = (fd: number, target: string, stat: BigIntStats) => void

/** Retain every selected name, including excluded entries and missing parents.
 * Linux consumption and preparation use the same descriptor-relative traversal.
 * Desktop platforms without procfs still validate retained identity and membership;
 * only native admission may supply the enforced immutable namespace check. */
export function retainOpenCodeBehaviorInventory(root: string, namespaceCheck?: BehaviorNamespaceCheck) {
  const entries = new Map<string, Entry>()
  const absent: { parent: Entry; name: string }[] = []
  const digests: string[] = []
  let bytesRead = 0, closed = false
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  const member = (parent: Entry, name: string) => process.platform === 'linux'
    ? `/proc/self/fd/${parent.fd}/${name}` : path.join(parent.target, name)
  const close = () => {
    if (closed) return
    closed = true
    for (const entry of [...entries.values()].reverse()) { try { closeSync(entry.fd) } catch {} }
    entries.clear()
  }
  const retain = (target: string): Entry | null => {
    if (entries.has(target)) return entries.get(target)!
    check(entries.size < 8192)
    const parentPath = path.dirname(target)
    const parent = parentPath === target ? null : retain(parentPath)
    if (parentPath !== target && !parent) return null
    check(!parent || parent.stat.isDirectory())
    const name = path.basename(target), selected = parent ? member(parent, name) : target
    let before: BigIntStats
    try { before = lstatSync(selected, { bigint: true }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !parent) throw error
      absent.push({ parent, name }); return null
    }
    check(before.isFile() || before.isDirectory())
    const fd = openSync(selected, flags | (before.isDirectory() ? constants.O_DIRECTORY : 0))
    try {
      const stat = fstatSync(fd, { bigint: true })
      check(same(before, stat, true))
      const entry: Entry = { fd, stat, parent, name, target, inventory: false }
      entries.set(target, entry)
      namespaceCheck?.(fd, target, stat)
      return entry
    } catch (error) { entries.delete(target); closeSync(fd); throw error }
  }
  const add = (relative: string) => {
    const entry = retain(path.join(root, relative))
    if (!entry) return
    const stat = entry.stat
    check(stat.isFile() && stat.nlink === 1n && stat.size <= 16n * 1024n * 1024n && !(stat.mode & 0o022n))
    bytesRead += Number(stat.size); check(bytesRead <= 64 * 1024 * 1024 && digests.length < 4096)
    const bytes = Buffer.alloc(Number(stat.size))
    try {
      let offset = 0
      while (offset < bytes.length) {
        const count = readSync(entry.fd, bytes, offset, bytes.length - offset, offset)
        check(count > 0); offset += count
      }
      check(same(stat, fstatSync(entry.fd, { bigint: true }), true))
      entry.digest = createHash('sha256').update(bytes).digest('hex')
      digests.push(`${relative}:${entry.digest}`)
    } finally { bytes.fill(0) }
  }
  const walk = (relative: string, depth: number) => {
    check(depth <= 64)
    const entry = retain(path.join(root, relative))
    if (!entry) return
    check(entry.stat.isDirectory()); entry.inventory = true
    const names = readdirSync(process.platform === 'linux' ? `/proc/self/fd/${entry.fd}` : entry.target).sort()
    entry.names = names
    check(names.length <= 4096)
    for (const name of names) {
      const next = path.join(relative, name), child = retain(path.join(root, next))
      check(child) // disappearing members are changes, not newly absent inputs
      if (['.DS_Store', '.git', 'node_modules'].includes(name)) continue
      if (child!.stat.isDirectory()) walk(next, depth + 1)
      else add(next)
    }
    check(same(entry.stat, fstatSync(entry.fd, { bigint: true }), true))
  }
  const assertCurrent = (readContents = true) => {
    check(!closed)
    for (const entry of entries.values()) {
      namespaceCheck?.(entry.fd, entry.target, entry.stat)
      const contents = entry.inventory || entry.stat.isFile()
      if (readContents && entry.names) {
        const names = readdirSync(process.platform === 'linux' ? `/proc/self/fd/${entry.fd}` : entry.target).sort()
        check(JSON.stringify(names) === JSON.stringify(entry.names))
      }
      if (readContents && entry.digest) {
        const bytes = Buffer.alloc(Number(entry.stat.size))
        try {
          let offset = 0
          while (offset < bytes.length) {
            const count = readSync(entry.fd, bytes, offset, bytes.length - offset, offset)
            check(count > 0); offset += count
          }
          check(createHash('sha256').update(bytes).digest('hex') === entry.digest)
        } finally { bytes.fill(0) }
      }
      check(same(entry.stat, fstatSync(entry.fd, { bigint: true }), contents))
      const selected = entry.parent ? member(entry.parent, entry.name) : entry.target
      const linked = lstatSync(selected, { bigint: true })
      check(!linked.isSymbolicLink() && same(entry.stat, linked, contents))
      // Reopen membership: lstat alone cannot detect a same-inode bind mount.
      const fd = openSync(selected, flags | (entry.stat.isDirectory() ? constants.O_DIRECTORY : 0))
      try {
        check(same(entry.stat, fstatSync(fd, { bigint: true }), contents))
        namespaceCheck?.(fd, entry.target, entry.stat)
        namespaceCheck?.(entry.fd, entry.target, entry.stat)
      } finally { closeSync(fd) }
    }
    // Bracket the entire enumeration, including changes after a parent's own
    // turn in the loop. Mutable cache ancestors are deliberately not timestamped.
    for (const entry of entries.values()) {
      if (entry.inventory) check(same(entry.stat, fstatSync(entry.fd, { bigint: true }), true))
    }
    for (const { parent, name } of absent) {
      try { lstatSync(member(parent, name)); check(false) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  }
  try {
    check(path.isAbsolute(root) && path.normalize(root) === root && retain(root)?.stat.isDirectory())
    for (const relative of PROJECT_BEHAVIOR_FILES) add(relative)
    for (const relative of PROJECT_BEHAVIOR_DIRS) walk(relative, 0)
    assertCurrent(false); digests.sort()
    const metadata = Object.freeze({
      projectBehaviorFingerprint: createHash('sha256').update(digests.join('\n')).digest('hex'),
      behaviorSources: [...new Set(digests.map(entry => entry.slice(0, entry.indexOf(':'))))].sort(),
    })
    return Object.freeze({ metadata, assertCurrent, close, byteLength: bytesRead,
      directoryCount: [...entries.values()].filter(entry => entry.stat.isDirectory()).length,
      fileCount: [...entries.values()].filter(entry => entry.stat.isFile()).length,
    })
  } catch (error) { close(); throw error }
}
