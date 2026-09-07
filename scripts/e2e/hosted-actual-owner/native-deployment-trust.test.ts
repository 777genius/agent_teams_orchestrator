import { expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assertNativeDroppedCredentials, retainNativeDeploymentTrust } from './native-deployment-trust.js'

// Files/descriptors are real temporary fixtures. Only the namespace pathname
// mapping and kernel custody observations are simulated. Root must separately
// qualify the independently provisioned production mount/launcher boundary.
test('deployment admission requires immutable custody before reading authority and rechecks retained descriptors', () => {
  const originals = { open: fs.openSync, lstat: fs.lstatSync, readdir: fs.readdirSync,
    readFile: fs.readFileSync, read: fs.readSync }
  for (const mutation of ['initial-writable', 'initial-saved-uid', 'saved-uid', 'remount', 'replace-leaf', 'replace-parent', 'symlink', 'mount-id', 'privilege'] as const) {
    const root = fs.mkdtempSync(join(tmpdir(), 'deployment-custody-r1114-'))
    const trust = join(root, 'run/agent-teams-lifecycle-trust')
    fs.mkdirSync(trust, { recursive: true, mode: 0o700 })
    const publicBytes = Buffer.alloc(32, 1)
    const pin = JSON.stringify({ format: 'agent-teams.hosted-lifecycle-owner-release-pin/v2',
      artifact: { artifactDigest: `sha256:${'a'.repeat(64)}`, imageReference: `example/owner@sha256:${'a'.repeat(64)}`,
        artifactVersion: '1.0.0', protocolVersion: 2 },
      launcher: { algorithm: 'ed25519', publicKey: publicBytes.toString('base64url'),
        keyId: createHash('sha256').update(publicBytes).digest('hex') } })
    fs.writeFileSync(join(trust, 'trust-anchor'), '1'.repeat(64), { mode: 0o400 })
    fs.writeFileSync(join(trust, 'release-owner-pin.json'), pin, { mode: 0o400 })
    let savedChanged = mutation === 'initial-saved-uid'
    let ro = mutation !== 'initial-writable', privileged = false, id = '42', authorityReads = 0
    const map = (value: fs.PathLike) => typeof value === 'string' && (value === '/' || value === '/run' ||
      value.startsWith('/run/agent-teams-lifecycle-trust')) ? join(root, value) : value
    const mocks = [
      spyOn(fs, 'openSync').mockImplementation((value, flags, mode) => originals.open(map(value), flags, mode)),
      spyOn(fs, 'lstatSync').mockImplementation(((value: fs.PathLike, options: any) => originals.lstat(map(value), options)) as typeof fs.lstatSync),
      spyOn(fs, 'readdirSync').mockImplementation(((value: fs.PathLike, options: any) => originals.readdir(map(value), options)) as typeof fs.readdirSync),
      spyOn(fs, 'readFileSync').mockImplementation(((value: fs.PathOrFileDescriptor, options: any) => {
        if (value === '/proc/self/status') return `Uid:\t${process.getuid!()}\t${process.getuid!()}\t${savedChanged ? process.getuid!() + 1 : process.getuid!()}\t${process.getuid!()}\nNoNewPrivs:\t1\nCapEff:\t${privileged ? '200000' : '0'}\nCapPrm:\t0\nCapAmb:\t0\n`
        if (value === '/proc/self/mountinfo') return `42 1 8:1 / / ${ro ? 'ro' : 'rw'} - ext4 /fixture rw\n`
        if (typeof value === 'string' && value.startsWith('/proc/self/fdinfo/')) return `mnt_id:\t${id}\n`
        return originals.readFile(value, options)
      }) as typeof fs.readFileSync),
      spyOn(fs, 'readSync').mockImplementation(((...args: any[]) => {
        authorityReads++
        return (originals.read as any)(...args)
      }) as typeof fs.readSync),
    ]
    let retained: ReturnType<typeof retainNativeDeploymentTrust> | undefined
    try {
      if (mutation === 'initial-writable' || mutation === 'initial-saved-uid') {
        expect(() => retainNativeDeploymentTrust()).toThrow('native_release_custody_unavailable')
        expect(authorityReads).toBe(0)
        continue
      }
      retained = retainNativeDeploymentTrust()
      expect(retained.isCurrent()).toBe(true)
      if (mutation === 'remount') ro = false
      if (mutation === 'mount-id') id = '43'
      if (mutation === 'privilege') privileged = true
      if (mutation === 'saved-uid') savedChanged = true
      if (mutation === 'replace-leaf' || mutation === 'symlink') {
        fs.renameSync(join(trust, 'release-owner-pin.json'), join(root, 'old-pin'))
        if (mutation === 'symlink') fs.symlinkSync(join(root, 'old-pin'), join(trust, 'release-owner-pin.json'))
        else fs.writeFileSync(join(trust, 'release-owner-pin.json'), pin, { mode: 0o400 })
      }
      if (mutation === 'replace-parent') {
        fs.renameSync(trust, `${trust}-old`)
        fs.mkdirSync(trust, { mode: 0o700 })
      }
      expect(retained.isCurrent()).toBe(false)
      expect(retained.isCurrent()).toBe(false)
    } finally {
      retained?.close()
      for (const mock of mocks.reverse()) mock.mockRestore()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
})

// Covers the exact saved-root trigger even when this fixture runs as root.
test('writable ancestor credentials reject saved, effective and filesystem UID authority', () => {
  const status = (uids: string) => `Uid:\t${uids}\nNoNewPrivs:\t1\nCapEff:\t0\nCapPrm:\t0\nCapAmb:\t0\n`
  expect(() => assertNativeDroppedCredentials(status('1000 1000 1000 1000'), 1000)).not.toThrow()
  for (const uids of ['1000 1000 0 1000', '1000 0 1000 1000', '1000 1000 1000 0',
    '0 1000 1000 1000', '1000 1000 1000', '1000 1000 1001 1000']) {
    expect(() => assertNativeDroppedCredentials(status(uids), 1000)).toThrow('native_release_privilege_regain')
  }
  expect(() => assertNativeDroppedCredentials(status('1000 1000 1000 1000').replace('NoNewPrivs:\t1', 'NoNewPrivs:\t0'), 1000)).toThrow()
})
