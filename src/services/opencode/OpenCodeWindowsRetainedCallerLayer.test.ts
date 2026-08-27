import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { OpenCodeSafePublicationDirectory } from './OpenCodeSafePublication.js'

describe('OpenCode Windows retained caller layer', () => {
  test('production Windows passive reads use only the in-process retained authority', async () => {
    const [safe, store] = await Promise.all([
      readFile(new URL('./OpenCodeSafePublication.ts', import.meta.url), 'utf8'),
      readFile(new URL('./OpenCodePassiveSnapshotStore.ts', import.meta.url), 'utf8'),
    ])
    expect(store).toContain('OpenCodeSafePublicationDirectory.openReadOnly')
    expect(safe).toContain('OpenCodeWindowsPassiveReadAuthority.open(resolved')
    expect(safe).toContain('this.#windowsPassiveAuthority.childNames()')
    expect(safe).toContain('this.#windowsPassiveAuthority.pinRegular(childName(name))')
    expect(safe).toContain('this.#windowsPassiveAuthority.readBounded(')
    expect(safe).toContain('new OpenCodeWindowsPublicationAuthorityClient(input)')
    expect(safe).not.toContain('bun:ffi')
  })

  test('passive retained ancestor cannot switch bytes or names after a replacement attempt', async () => {
    if (process.platform !== 'win32') return
    const parent = await mkdtemp(path.join(process.cwd(), '.opencode-passive-retained-parent-'))
    const root = path.join(parent, 'owned')
    const displaced = path.join(parent, 'displaced')
    const replacement = path.join(parent, 'replacement')
    await Promise.all([mkdir(root), mkdir(replacement)])
    await writeFile(path.join(root, 'snapshot.json'), 'trusted')
    await writeFile(path.join(replacement, 'snapshot.json'), 'attacker')
    const authority = await OpenCodeSafePublicationDirectory.openReadOnly(root)
    try {
      // The retained root intentionally denies delete sharing. If a future
      // implementation permits the rename, subsequent operations still have
      // to use its retained handle and therefore must observe the old object.
      await rename(root, displaced).then(
        () => rename(replacement, root),
        () => undefined,
      )
      expect(await authority.readBoundedRegularFile('snapshot.json', 64)).toBe('trusted')
      expect(await authority.childNames()).toContain('snapshot.json')
    } finally {
      await authority.close()
      await rm(parent, { recursive: true, force: true })
    }
  })

  test('active mutations, recovery enumeration, cleanup, immutable publication and locks expose no pathname fallback', async () => {
    const [safe, manager] = await Promise.all([
      readFile(new URL('./OpenCodeSafePublication.ts', import.meta.url), 'utf8'),
      readFile(new URL('./OpenCodeProfileManager.ts', import.meta.url), 'utf8'),
    ])
    expect(safe).toContain('OpenCodeWindowsRetainedNamespacePort')
    expect(safe).toContain('namespaceList(this.#windowsKey)')
    expect(safe).toContain("namespaceModifiedAt(this.#relative(name), 'file')")
    expect(safe).toContain('.namespaceRecoverAtomic(this.#relative(finalName), recoveryPrefix)')
    expect(safe).toContain('testHooks?.expectedPriorSha256, this.#windowsKey')
    expect(safe).toContain("namespaceOpen(relative, 'read')")
    expect(safe).toContain('namespacePublishImmutable(this.#relative(finalName)')
    expect(safe).toContain('namespaceRemoveTree(this.#relative(retiredName))')
    expect(safe).toContain('namespaceAcquireLock(this.#relative(name)')
    expect(manager).toContain("process.platform === 'win32'\n      ? earlyLockDirectory.acquireRetainedLock")
    expect(manager).toContain("process.platform === 'win32'\n        ? scopedLockDirectory.acquireRetainedLock")
    expect(manager).toContain('acquireOpenCodeProfilePathLock(lockPath)')
    expect(manager).toContain('acquireOpenCodeProfilePathLock(migrationLockPath)')
    expect(manager).toContain('verifyWindowsRetainedSnapshotTree(')
    expect(manager).toContain('createRetainedDescendantDirectory(')
    expect(manager).toContain('writeRetainedDescendantFile(')
    expect(manager).toContain('renameRetainedChildDirectory(temporaryLeaf, targetLeaf)')
    expect(manager).toContain('rollbackRetainedChildDirectory(temporaryLeaf)')
    expect(manager).toContain('retained snapshot root is a replacement or junction')
    expect(manager).toContain('abortSignal, deadline: deadlineAtMs')
    expect(manager).not.toContain('deadline: performance.now() + 10_000')
  })

  test('active caller dispatches namespace work through one retained authority port', async () => {
    const operations: string[] = []
    const authority = {
      validateRoot: async () => { operations.push('validate') },
      namespaceList: async (key: string) => { operations.push(`list:${key}`); return ['owned'] },
      namespaceModifiedAt: async (key: string, kind: string) => {
        operations.push(`modified:${key}:${kind}`); return 123
      },
      namespaceRecoverAtomic: async () => 'none' as const,
      namespacePublishImmutable: async (key: string, bytes: Uint8Array) => {
        operations.push(`immutable:${key}:${new TextDecoder().decode(bytes)}`)
      },
      namespaceRemoveTree: async (key: string) => { operations.push(`remove-tree:${key}`) },
      namespaceAcquireLock: async (key: string) => {
        operations.push(`lock:${key}`)
        return async () => { operations.push(`unlock:${key}`) }
      },
      pinRegular: async (name: string, denyWrites: boolean) => {
        operations.push(`pin:${name}:${denyWrites}`)
      },
      namespaceRename: async (from: string, to: string) => { operations.push(`rename:${from}:${to}`) },
      namespaceSyncDirectory: async (key: string) => { operations.push(`sync:${key}`) },
      close: async () => { operations.push('close') },
    }
    const directory = new OpenCodeSafePublicationDirectory(
      null, 'C:\\path-that-must-not-be-opened', { dev: 1n, ino: 2n }, authority as never,
    )
    expect(await directory.childNames()).toEqual(['owned'])
    expect(await directory.regularFileModifiedAt('owned')).toBe(123)
    await directory.pinRegularFile('writer.sqlite3')
    await directory.pinRegularFile('reader.sqlite3', true)
    await directory.publishImmutableFile('bridge.exe', 'complete', 0o500)
    await directory.retireChildDirectory('old', '.retired')
    const release = await directory.acquireRetainedLock('profile.lock', {
      stale: 30_000, update: 5_000, retries: { retries: 1, minTimeout: 1, maxTimeout: 1 },
    })
    await release()
    await directory.close()
    expect(operations).toEqual([
      'list:.', 'validate', 'modified:owned:file',
      'pin:writer.sqlite3:false', 'pin:reader.sqlite3:true', 'validate',
      'immutable:bridge.exe:complete', 'sync:.',
      'rename:old:.retired', 'remove-tree:.retired', 'sync:.',
      'lock:profile.lock', 'unlock:profile.lock', 'close',
    ])
  })
})
