import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import path from 'node:path'

import {
  OpenCodeWindowsPassiveReadAuthority,
  testRetainWindowsPassiveRoot,
} from './OpenCodeWindowsPassiveReadAuthority.js'

type Identity = Readonly<{ volumeSerial: bigint; fileId: bigint; size: bigint; directory: boolean }>

function fake(input: Readonly<{
  identities?: Readonly<Record<string, Identity>>
  rejectIdentity?: string
  rejectFilesystem?: boolean
  afterRelative?: (name: string) => void
}> = {}) {
  const calls: string[] = []
  const handles = new Map<bigint, string>([[1n, 'volume']])
  let next = 2n
  const base: Record<string, Identity> = {
    volume: { volumeSerial: 7n, fileId: 1n, size: 0n, directory: true },
    owned: { volumeSerial: 7n, fileId: 2n, size: 0n, directory: true },
    nested: { volumeSerial: 7n, fileId: 3n, size: 0n, directory: true },
    ...input.identities,
  }
  return {
    calls,
    contract: {
      openAbsolute(target: string): bigint { calls.push(`absolute:${target}`); return 1n },
      openRelative(parent: bigint, name: string): bigint {
        calls.push(`relative:${handles.get(parent)}:${name}`)
        const handle = next++; handles.set(handle, name); input.afterRelative?.(name); return handle
      },
      identity(handle: bigint): Identity {
        const name = handles.get(handle)!
        calls.push(`identity:${name}`)
        if (name === input.rejectIdentity) throw new Error('reparse')
        return base[name]!
      },
      verifyFixedNtfs(): void { calls.push('filesystem'); if (input.rejectFilesystem) throw new Error('ReFS') },
      close(handle: bigint): void { calls.push(`close:${handles.get(handle)}`) },
    },
  }
}

describe('OpenCode Windows passive retained traversal contract', () => {
  test('uses handle-bound filesystem, device, identity, and no-follow APIs on x64 and ARM64', async () => {
    const source = await Bun.file(new URL('./OpenCodeWindowsPassiveReadAuthority.ts', import.meta.url)).text()
    for (const api of ['GetVolumeInformationByHandleW', 'NtQueryVolumeInformationFile',
      'GetFileInformationByHandleEx', 'NtQueryInformationFile', 'FILE_OPEN_REPARSE_POINT']) {
      expect(source).toContain(api)
    }
    expect(source).toContain('FFIType.u64')
    expect(source).not.toContain('GetVolumeInformationW')
    expect(source).not.toContain('GetDriveTypeW')
  })

  test('retains the local NTFS volume and opens each same-volume component relative to its handle', () => {
    const native = fake()
    const retained = testRetainWindowsPassiveRoot(native.contract, 'C:\\owned\\nested')
    expect(retained.rootIdentity.fileId).toBe(3n)
    expect(native.calls).toEqual([
      'absolute:C:\\', 'identity:volume', 'filesystem',
      'relative:volume:owned', 'identity:owned',
      'relative:owned:nested', 'identity:nested', 'identity:nested',
    ])
    for (const component of [...retained.components].reverse()) native.contract.close(component.handle)
    native.contract.close(retained.volume)
    expect(native.calls.slice(-3)).toEqual(['close:nested', 'close:owned', 'close:volume'])
  })

  test.each(['owned', 'nested'])('rejects a reparse point at %s without a pathname fallback', leaf => {
    const native = fake({ rejectIdentity: leaf })
    expect(() => testRetainWindowsPassiveRoot(native.contract, 'C:\\owned\\nested')).toThrow()
    expect(native.calls).not.toContain('absolute:C:\\owned\\nested')
    expect(native.calls).toContain(`close:${leaf}`)
    expect(native.calls.at(-1)).toBe('close:volume')
  })

  test('rejects a cross-volume component and UNC roots', () => {
    const native = fake({ identities: {
      nested: { volumeSerial: 8n, fileId: 3n, size: 0n, directory: true },
    } })
    expect(() => testRetainWindowsPassiveRoot(native.contract, 'C:\\owned\\nested')).toThrow()
    expect(() => testRetainWindowsPassiveRoot(native.contract, '\\\\server\\share\\owned')).toThrow()
  })

  test('rejects non-NTFS retained volumes such as ReFS', () => {
    const native = fake({ rejectFilesystem: true })
    expect(() => testRetainWindowsPassiveRoot(native.contract, 'C:\\owned')).toThrow()
    expect(native.calls).toEqual(['absolute:C:\\', 'identity:volume', 'filesystem', 'close:volume'])
  })

  test('keeps traversal anchored to handle identity if the pathname mapping is replaced', () => {
    let replaced = false
    const native = fake({ afterRelative: name => { if (name === 'owned') replaced = true } })
    testRetainWindowsPassiveRoot(native.contract, 'C:\\owned\\nested')
    expect(replaced).toBeTrue()
    expect(native.calls).toContain('relative:owned:nested')
    expect(native.calls).not.toContain('absolute:C:\\owned\\nested')
  })

  test('honors deadline and cancellation at component boundaries and closes retained handles', () => {
    const expired = fake()
    expect(() => testRetainWindowsPassiveRoot(expired.contract, 'C:\\owned', { deadline: 0 })).toThrow()
    expect(expired.calls).toEqual([])

    const controller = new AbortController()
    const cancelled = fake({ afterRelative: () => controller.abort() })
    expect(() => testRetainWindowsPassiveRoot(
      cancelled.contract, 'C:\\owned\\nested', { signal: controller.signal },
    )).toThrow()
    expect(cancelled.calls.slice(-2)).toEqual(['close:owned', 'close:volume'])
  })
})

describe('OpenCode Windows passive native integration', () => {
  test('accepts same-volume NTFS and rejects intermediate and final junctions', async () => {
    if (process.platform !== 'win32') return
    const parent = await mkdtemp(path.join(process.cwd(), '.opencode-passive-native-'))
    const owned = path.join(parent, 'owned')
    const target = path.join(parent, 'target')
    const intermediate = path.join(parent, 'intermediate')
    const final = path.join(parent, 'final')
    await Promise.all([mkdir(path.join(owned, 'nested'), { recursive: true }), mkdir(path.join(target, 'nested'), { recursive: true })])
    await Promise.all([symlink(target, intermediate, 'junction'), symlink(target, final, 'junction')])
    try {
      const authority = OpenCodeWindowsPassiveReadAuthority.open(path.join(owned, 'nested'))
      authority.validate()
      authority.close()
      expect(() => OpenCodeWindowsPassiveReadAuthority.open(path.join(intermediate, 'nested'))).toThrow()
      expect(() => OpenCodeWindowsPassiveReadAuthority.open(final)).toThrow()
    } finally { await rm(parent, { recursive: true, force: true }) }
  })

  test('rejects expired and cancelled native opens without starting traversal', () => {
    if (process.platform !== 'win32') return
    expect(() => OpenCodeWindowsPassiveReadAuthority.open('C:\\', { deadline: 0 })).toThrow()
    const controller = new AbortController(); controller.abort()
    expect(() => OpenCodeWindowsPassiveReadAuthority.open('C:\\', { signal: controller.signal })).toThrow()
  })
})
