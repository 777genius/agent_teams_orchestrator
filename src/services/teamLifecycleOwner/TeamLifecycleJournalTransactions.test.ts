import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import * as nodeFs from 'node:fs'
import { chmod, mkdtemp, readFile, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProcessOwnershipStoreContext } from '@agent-teams/owner-anchor-library'
import * as lockfile from '../../utils/lockfile.js'
import { createInitialDurableState } from './TeamLifecycleDurableState.js'
import { TeamLifecycleJournalTransactions } from './TeamLifecycleJournalTransactions.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

function context(input: { now?: () => number; cancelled?: () => boolean; failClosedPersistence?: true } = {}): ProcessOwnershipStoreContext {
  return {
    deadline: { startedAt: 0, expiresAt: 100 },
    clock: { now: input.now ?? (() => 1) },
    cancellation: { cancellationId: 'cancel-fixture', isCancellationRequested: input.cancelled ?? (() => false) },
    ...(input.failClosedPersistence ? { failClosedPersistence: true as const } : {}),
  } as ProcessOwnershipStoreContext
}

async function fixture(): Promise<{ root: string; path: string; transactions: TeamLifecycleJournalTransactions }> {
  const root = await mkdtemp(join(tmpdir(), 'team-transactions-'))
  roots.push(root)
  const path = join(root, 'execution.json')
  const transactions = new TeamLifecycleJournalTransactions(path)
  await transactions.initialize(createInitialDurableState('a'.repeat(64), 'auto'))
  return { root, path, transactions }
}

describe('TeamLifecycleJournalTransactions', () => {
  test('removes an expired queued mutation before it can write later', async () => {
    const { path } = await fixture()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let publications = 0
    const transactions = new TeamLifecycleJournalTransactions(path, { fsync: async () => { publications++; await gate } })
    const first = transactions.update(state => ({ state: { ...state, operationEpoch: 1 }, value: undefined }))
    await until(() => publications === 1)
    let now = 1
    const second = transactions.update(state => ({ state: { ...state, operationEpoch: 2 }, value: undefined }), context({ now: () => now }))
    const following = transactions.read(state => state.operationEpoch)
    let secondSettled = false
    let followingSettled = false
    void second.then(() => { secondSettled = true }, () => { secondSettled = true })
    void following.then(() => { followingSettled = true }, () => { followingSettled = true })
    now = 101
    await Promise.resolve()
    expect(secondSettled).toBeFalse()
    expect(followingSettled).toBeFalse()
    release()
    const [firstResult, secondResult, followingResult] = await Promise.allSettled([first, second, following])
    expect(firstResult.status).toBe('fulfilled')
    expect(secondResult).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('deadline') }) })
    expect(followingResult).toEqual({ status: 'fulfilled', value: 1 })
    expect(publications).toBe(1)
  })

  test('removes a cancelled queued mutation and releases the following update', async () => {
    const { path } = await fixture()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let publications = 0
    const transactions = new TeamLifecycleJournalTransactions(path, { fsync: async () => { publications++; await gate } })
    const first = transactions.update(state => ({ state: { ...state, operationEpoch: 1 }, value: undefined }))
    await until(() => publications === 1)
    let cancelled = false
    const second = transactions.update(state => ({ state: { ...state, operationEpoch: 2 }, value: undefined }), context({ cancelled: () => cancelled }))
    const following = transactions.update(state => ({ state: { ...state, operationEpoch: 3 }, value: state.operationEpoch }))
    let secondSettled = false
    let followingSettled = false
    void second.then(() => { secondSettled = true }, () => { secondSettled = true })
    void following.then(() => { followingSettled = true }, () => { followingSettled = true })
    cancelled = true
    await Promise.resolve()
    expect(secondSettled).toBeFalse()
    expect(followingSettled).toBeFalse()
    release()
    const [firstResult, secondResult, followingResult] = await Promise.allSettled([first, second, following])
    expect(firstResult.status).toBe('fulfilled')
    expect(secondResult).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('cancelled') }) })
    expect(followingResult).toEqual({ status: 'fulfilled', value: 1 })
    expect(await transactions.read(state => state.operationEpoch)).toBe(3)
    expect(publications).toBe(2)
  })

  test('fail-closed persistence ignores caller cancellation but retains the absolute deadline', async () => {
    const { transactions } = await fixture()
    const cancelled = context({ cancelled: () => true, failClosedPersistence: true })
    await expect(transactions.update(state => ({ state: { ...state, operationEpoch: 3 }, value: 'ok' }), cancelled)).resolves.toBe('ok')
    const expired = context({ now: () => 100, cancelled: () => true, failClosedPersistence: true })
    await expect(transactions.update(state => ({ state, value: undefined }), expired)).rejects.toThrow('deadline')
  })

  test('rejects expiry after final encoding and immediately before publication without changing bytes', async () => {
    const { path } = await fixture()
    const before = await readFile(path, 'utf8')
    let now = 1
    const transactions = new TeamLifecycleJournalTransactions(path, {
      beforePublication: () => { now = 100 },
    })
    await expect(transactions.update(state => ({ state: { ...state, operationEpoch: 7 }, value: 'late' }),
      context({ now: () => now }))).rejects.toThrow('deadline')
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  test('rejects cancellation after encoding immediately before publication', async () => {
    const { path } = await fixture()
    const before = await readFile(path, 'utf8')
    let cancelled = false
    const transactions = new TeamLifecycleJournalTransactions(path, {
      beforePublication: () => { cancelled = true },
    })
    await expect(transactions.update(state => ({ state: { ...state, operationEpoch: 9 }, value: undefined }),
      context({ cancelled: () => cancelled }))).rejects.toThrow('cancelled')
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  test('reports unavailable only after late durability and unlock settle while retaining committed bytes', async () => {
    const { path } = await fixture()
    let now = 1
    let releaseFsync: (() => void) | undefined
    const fsyncGate = new Promise<void>(resolve => { releaseFsync = resolve })
    let fsyncEntered = false
    const transactions = new TeamLifecycleJournalTransactions(path, {
      fsync: async fsyncPath => {
        if (fsyncPath !== path) return
        fsyncEntered = true
        now = 100
        await fsyncGate
      },
    })
    const late = transactions.update(state => ({ state: { ...state, operationEpoch: 8 }, value: 'late' }),
      context({ now: () => now }))
    await until(() => fsyncEntered)
    const following = transactions.read(state => state.operationEpoch)
    let followingSettled = false
    void following.then(() => { followingSettled = true }, () => { followingSettled = true })
    await Promise.resolve()
    expect(followingSettled).toBeFalse()
    releaseFsync?.()
    await expect(late).rejects.toThrow('deadline')
    expect(await following).toBe(8)
    expect(await new TeamLifecycleJournalTransactions(path).read(state => state.operationEpoch)).toBe(8)
  })

  test('rechecks the deadline after successful physical unlock settlement', async () => {
    const { path } = await fixture()
    const actualLock = lockfile.lock
    let now = 1
    const lockSpy = spyOn(lockfile, 'lock').mockImplementation(async (file, options) => {
      const unlock = await actualLock(file, options)
      return async () => {
        await unlock()
        now = 100
      }
    })
    try {
      const transactions = new TeamLifecycleJournalTransactions(path)
      await expect(transactions.update(state => ({ state: { ...state, operationEpoch: 10 }, value: 'late' }),
        context({ now: () => now }))).rejects.toThrow('deadline')
      expect(await new TeamLifecycleJournalTransactions(path).read(state => state.operationEpoch)).toBe(10)
    } finally {
      lockSpy.mockRestore()
    }
  })

  test('applies the same pre-publication deadline gate to initialization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-transactions-initialize-deadline-'))
    roots.push(root)
    const path = join(root, 'execution.json')
    let now = 1
    const transactions = new TeamLifecycleJournalTransactions(path, {
      beforePublication: () => { now = 100 },
    })
    await expect(transactions.initialize(createInitialDurableState('a'.repeat(64), 'auto'),
      context({ now: () => now }))).rejects.toThrow('deadline')
    expect(await transactions.exists()).toBeFalse()
    expect(await transactions.markerExists()).toBeFalse()
  })

  test('settles late initialization state and marker durability before reporting deadline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-transactions-initialize-late-'))
    roots.push(root)
    const path = join(root, 'execution.json')
    let now = 1
    const durablePaths: string[] = []
    const transactions = new TeamLifecycleJournalTransactions(path, {
      fsync: async fsyncPath => {
        durablePaths.push(fsyncPath)
        if (fsyncPath === path) now = 100
      },
    })
    await expect(transactions.initialize(createInitialDurableState('a'.repeat(64), 'auto'),
      context({ now: () => now }))).rejects.toThrow('deadline')
    expect(durablePaths).toEqual([path, `${path}.initialized`])
    expect(await transactions.exists()).toBeTrue()
    expect(await transactions.markerExists()).toBeTrue()
  })

  test('bounds all lock retries by one absolute remaining budget', async () => {
    const { path } = await fixture()
    let now = 70
    let attempts = 0
    const lockSpy = spyOn(lockfile, 'lock').mockImplementation(async () => {
      attempts += 1
      now += 10
      const locked = new Error('lock held')
      Reflect.set(locked, 'code', 'ELOCKED')
      throw locked
    })
    try {
      const transactions = new TeamLifecycleJournalTransactions(path)
      await expect(transactions.read(state => state.revision, context({ now: () => now }))).rejects.toThrow('deadline')
      expect(attempts).toBeLessThanOrEqual(3)
    } finally {
      lockSpy.mockRestore()
    }
  })

  test('settles an after-replace fsync failure before releasing serialization', async () => {
    const { path } = await fixture()
    let fsyncEntered = false
    const transactions = new TeamLifecycleJournalTransactions(path, { fsync: async () => { fsyncEntered = true; throw new Error('fsync fixture') } })
    await expect(transactions.update(state => ({ state: { ...state, operationEpoch: 4 }, value: undefined }))).rejects.toThrow('fsync fixture')
    expect(fsyncEntered).toBeTrue()
    const reopened = new TeamLifecycleJournalTransactions(path)
    expect(await reopened.read(state => state.operationEpoch)).toBe(4)
  })

  test('releases serialization when physical unlock fails while reporting the operation failure', async () => {
    const { path } = await fixture()
    const lockPath = `${path}.owner.lock`
    const blockerPath = join(lockPath, '.unlock-rejection-fixture')
    const actualLock = lockfile.lock
    let faultArmed = false
    let unlockFailureObserved = false
    let fixtureFaultRemoved = false
    const lockSpy = spyOn(lockfile, 'lock').mockImplementation(async (file, options) => {
      const lockOptions: NonNullable<Parameters<typeof actualLock>[1]> = {
        ...options,
        fs: {
        ...nodeFs,
        rmdir: ((directory: nodeFs.PathLike, callback: (error: NodeJS.ErrnoException | null) => void) => {
          if (!faultArmed || String(directory) !== lockPath) return nodeFs.rmdir(directory, callback)
          faultArmed = false
          void (async () => {
            await writeFile(blockerPath, 'unlock must reject\n', { mode: 0o600 })
            let unlockError: NodeJS.ErrnoException
            try {
              await rmdir(lockPath)
              throw new Error('unlock fixture unexpectedly removed a non-empty lock directory')
            } catch (error) {
              unlockError = error as NodeJS.ErrnoException
            }
            unlockFailureObserved = unlockError.code === 'ENOTEMPTY' || unlockError.code === 'EEXIST'
            await unlink(blockerPath)
            await rmdir(lockPath)
            fixtureFaultRemoved = true
            callback(unlockError)
          })().catch(error => callback(error as NodeJS.ErrnoException))
        }) as typeof nodeFs.rmdir,
        },
      }
      return actualLock(file, lockOptions)
    })
    let releasePublication!: () => void
    const publicationGate = new Promise<void>(resolve => { releasePublication = resolve })
    const transactions = new TeamLifecycleJournalTransactions(path, {
      fsync: async fsyncPath => {
        if (fsyncPath !== path) return
        faultArmed = true
        await publicationGate
      },
    })
    const operations: Promise<unknown>[] = []
    try {
      const update = transactions.update(state => ({ state: { ...state, operationEpoch: 5 }, value: undefined }))
      operations.push(update)
      await until(() => faultArmed)
      const following = transactions.read(state => state.operationEpoch)
      operations.push(following)
      let updateSettled = false
      let followingSettled = false
      void update.then(() => { updateSettled = true }, () => { updateSettled = true })
      void following.then(() => { followingSettled = true }, () => { followingSettled = true })
      await Promise.resolve()
      expect(updateSettled).toBeFalse()
      expect(followingSettled).toBeFalse()
      releasePublication()
      const [updateResult, followingResult] = await Promise.allSettled([update, following])
      expect(updateResult).toMatchObject({
        status: 'rejected',
        reason: expect.objectContaining({ code: expect.stringMatching(/^(?:ENOTEMPTY|EEXIST)$/) }),
      })
      expect(unlockFailureObserved).toBeTrue()
      expect(fixtureFaultRemoved).toBeTrue()
      expect(followingResult).toEqual({ status: 'fulfilled', value: 5 })
    } finally {
      releasePublication()
      await Promise.allSettled(operations)
      lockSpy.mockRestore()
    }
  })

  test('treats a missing initialized file and corrupt or public files as unavailable reads', async () => {
    const { path, transactions } = await fixture()
    await unlink(path)
    await expect(transactions.read(state => state)).rejects.toThrow('disappeared')
    await writeFile(path, '{bad json\n', { mode: 0o600 })
    await expect(transactions.read(state => state)).rejects.toThrow()
    await writeFile(path, `${JSON.stringify(createInitialDurableState('a'.repeat(64), 'auto'))}\n`, { mode: 0o600 })
    await chmod(path, 0o644)
    await expect(transactions.read(state => state)).rejects.toThrow('Unsafe')
  })

  test('rejects asynchronous transform callbacks without publishing them', async () => {
    const { path, transactions } = await fixture()
    const before = await readFile(path, 'utf8')
    const asynchronousTransform = async (state: Readonly<ReturnType<typeof createInitialDurableState>>) =>
      ({ state, value: undefined })
    await expect(Reflect.apply(transactions.update, transactions, [asynchronousTransform])).rejects.toThrow('synchronous')
    expect(await readFile(path, 'utf8')).toBe(before)
  })
})

async function until(predicate: () => boolean): Promise<void> {
  for (let count = 0; count < 100 && !predicate(); count++) await new Promise(resolve => setTimeout(resolve, 1))
  if (!predicate()) throw new Error('fixture gate was not reached')
}
