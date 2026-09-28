import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync,
  realpathSync, writeSync } from 'node:fs'
import path from 'node:path'

import type { RootOpenCodeWriteClaims as ClaimsPort } from './RootOpenCodeHttpProxy.js'

const ID = /^[a-z0-9][a-z0-9_-]{7,95}$/
const SHA = /^[0-9a-f]{64}$/
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

/** Root-owned exact one-shot claims. A claim survives uncertain HTTP responses and process restart. */
export class RootOpenCodeWriteClaims implements ClaimsPort {
  private readonly identity: { dev: number; ino: number }
  private readonly uid: number

  constructor(private readonly directory: string, testOnlyAllowNonRoot = false) {
    const test = testOnlyAllowNonRoot && process.env.NODE_ENV === 'test'
    if (!test &&
      (process.platform !== 'linux' || process.getuid?.() !== 0) ||
      !path.isAbsolute(directory) || path.normalize(directory) !== directory) {
      throw new Error('root-opencode-claims-policy-invalid')
    }
    if (!test) {
      let ancestor = path.dirname(directory)
      for (;;) {
        const parent = lstatSync(ancestor)
        if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0 ||
          (parent.mode & 0o022) !== 0 || realpathSync(ancestor) !== ancestor) {
          throw new Error('root-opencode-claims-ancestor-invalid')
        }
        const next = path.dirname(ancestor)
        if (next === ancestor) break
        ancestor = next
      }
    }
    const stat = lstatSync(directory)
    this.uid = process.getuid?.() ?? -1
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.uid ||
      (stat.mode & 0o777) !== 0o700 || realpathSync(directory) !== directory) {
      throw new Error('root-opencode-claims-directory-invalid')
    }
    this.identity = { dev: stat.dev, ino: stat.ino }
  }

  claim(operationId: string, fingerprint: string): 'created' | 'already_claimed' | 'claim_conflict' {
    if (typeof operationId !== 'string' || !ID.test(operationId) ||
      typeof fingerprint !== 'string' || !SHA.test(fingerprint)) {
      throw new Error('root-opencode-claim-invalid')
    }
    const stat = lstatSync(this.directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.uid ||
      stat.dev !== this.identity.dev || stat.ino !== this.identity.ino || (stat.mode & 0o777) !== 0o700) {
      throw new Error('root-opencode-claims-directory-substituted')
    }
    const filename = path.join(this.directory, `${sha(operationId)}.claim`)
    const serialized = `${operationId}\n${fingerprint}\n`
    let fd: number
    try {
      fd = openSync(filename, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600)
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
      const prior = lstatSync(filename)
      if (!prior.isFile() || prior.isSymbolicLink() || prior.uid !== this.uid ||
        (prior.mode & 0o777) !== 0o600 || prior.size > 256) {
        throw new Error('root-opencode-claim-substituted')
      }
      const priorFd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
      let existing: string
      try {
        const pinned = fstatSync(priorFd)
        if (!pinned.isFile() || pinned.dev !== prior.dev || pinned.ino !== prior.ino ||
          pinned.uid !== this.uid || (pinned.mode & 0o777) !== 0o600) {
          throw new Error('root-opencode-claim-substituted')
        }
        existing = readFileSync(priorFd, 'utf8')
      } finally { closeSync(priorFd) }
      return existing === serialized ? 'already_claimed' : 'claim_conflict'
    }
    try {
      const bytes = Buffer.from(serialized)
      let offset = 0
      while (offset < bytes.length) {
        const count = writeSync(fd, bytes, offset, bytes.length - offset)
        if (count <= 0) throw new Error('root-opencode-claim-write-failed')
        offset += count
      }
      const opened = fstatSync(fd)
      if (!opened.isFile() || opened.uid !== this.uid || (opened.mode & 0o777) !== 0o600) {
        throw new Error('root-opencode-claim-substituted')
      }
      fsyncSync(fd)
      const dirFd = openSync(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const pinned = fstatSync(dirFd)
        if (pinned.dev !== this.identity.dev || pinned.ino !== this.identity.ino) {
          throw new Error('root-opencode-claims-directory-substituted')
        }
        fsyncSync(dirFd)
      } finally { closeSync(dirFd) }
      return 'created'
    } finally { closeSync(fd) }
  }
}
