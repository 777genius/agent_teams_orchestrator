import { afterEach, describe, expect, test } from 'bun:test'
import { closeSync, fstatSync, lstatSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { renamePathWithRetry, scavengeAtomicWriteTombstones, writeFileAtomic, writeFileAtomicSync, writeJsonFileAtomic } from './atomicWrite.js'

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true })),
  )
  tempDirs = []
})

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-write-'))
  tempDirs.push(dir)
  return dir
}

function errno(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string }
  error.code = code
  return error
}

test('async and sync writes fsync both renamed directories before acknowledging, and surface sync failure', async () => {
  const dir = await createTempDir()
  const asyncPath = path.join(dir, 'durable-async.json')
  const asyncDirectories: string[] = []
  await writeFileAtomic(asyncPath, 'async', { deps: { syncDirectory: directory => { asyncDirectories.push(directory) } } })
  expect(asyncDirectories).toEqual([path.join(dir, '.atomic-write-tombstones'), dir])

  const syncPath = path.join(dir, 'durable-sync.json')
  const syncDirectories: string[] = []
  writeFileAtomicSync(syncPath, 'sync', { deps: { syncDirectory: directory => { syncDirectories.push(directory) } } })
  expect(syncDirectories).toEqual([path.join(dir, '.atomic-write-tombstones'), dir])

  const failedPath = path.join(dir, 'durability-failure.json')
  await expect(writeFileAtomic(failedPath, 'committed-before-sync-failure', {
    deps: { syncDirectory: () => { throw errno('EIO') } },
  })).rejects.toMatchObject({ code: 'EIO' })
  expect(await fs.readFile(failedPath, 'utf8')).toBe('committed-before-sync-failure')
})

test('Windows skips unsupported directory fsync after rename while retaining the commit receipt', async () => {
  const dir = await createTempDir()
  const target = path.join(dir, 'windows-durable.json')
  const receipt = await writeFileAtomic(target, 'published', {
    deps: { platform: 'win32' },
  })
  expect(receipt).toMatchObject({ committed: true, identity: { destination: target } })
  expect(await fs.readFile(target, 'utf8')).toBe('published')
})

test('Windows accepts synthesized permissive namespace mode bits', async () => {
  const dir = await createTempDir()
  const target = path.join(dir, 'windows-synthesized-mode.json')
  const synthesizeWindowsMode = ((source: Parameters<typeof lstatSync>[0], options?: Parameters<typeof lstatSync>[1]) => {
    const stats = lstatSync(source, options as { bigint?: boolean })
    if (String(source).endsWith('.atomic-write-tombstones')) {
      return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
        mode: typeof stats.mode === 'bigint' ? 0o777n : 0o777,
      })
    }
    return stats
  }) as typeof lstatSync
  await writeFileAtomic(target, 'published', {
    deps: { platform: 'win32', lstatSync: synthesizeWindowsMode },
  })
  expect(await fs.readFile(target, 'utf8')).toBe('published')
  const syncTarget = path.join(dir, 'windows-synthesized-mode-sync.json')
  writeFileAtomicSync(syncTarget, 'published', {
    deps: { platform: 'win32', lstatSync: synthesizeWindowsMode },
  })
  expect(await fs.readFile(syncTarget, 'utf8')).toBe('published')
})

test('Windows atomic publication refuses a namespace without an owner-only ACL receipt', async () => {
  const dir = await createTempDir()
  const target = path.join(dir, 'windows-hostile-acl.json')
  const receipt = () => false
  await expect(writeFileAtomic(target, 'published', {
    deps: { platform: 'win32', secureWindowsNamespace: receipt },
  })).rejects.toThrow('tombstone namespace is not private')
  expect(() => writeFileAtomicSync(target, 'published', {
    deps: { platform: 'win32', secureWindowsNamespace: receipt },
  })).toThrow('tombstone namespace is not private')
  await expect(fs.readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
})

test('Windows establishes an ACL only for its newly-created namespace, then validates it without repair', async () => {
  const dir = await createTempDir()
  const calls: Array<{ directory: string, establish: boolean }> = []
  const secureWindowsNamespace = (directory: string, establish: boolean) => {
    calls.push({ directory, establish })
    return true
  }
  const first = path.join(dir, 'windows-owned-first.json')
  await writeFileAtomic(first, 'first', {
    deps: { platform: 'win32', secureWindowsNamespace },
  })
  const namespace = path.join(dir, '.atomic-write-tombstones')
  expect(calls).toEqual([
    { directory: namespace, establish: true },
    { directory: namespace, establish: false },
    { directory: namespace, establish: false },
  ])

  calls.length = 0
  await writeFileAtomic(path.join(dir, 'windows-owned-second.json'), 'second', {
    deps: { platform: 'win32', secureWindowsNamespace },
  })
  expect(calls).toEqual([
    { directory: namespace, establish: false },
    { directory: namespace, establish: false },
    { directory: namespace, establish: false },
  ])
})

test('Windows rejects a reparse tombstone namespace before any ACL establishment', async () => {
  const dir = await createTempDir()
  const namespace = path.join(dir, '.atomic-write-tombstones')
  const redirected = path.join(dir, 'redirected')
  await fs.mkdir(redirected, { mode: 0o700 })
  await fs.symlink(redirected, namespace, 'dir')
  await expect(writeFileAtomic(path.join(dir, 'windows-reparse.json'), 'published', {
    deps: {
      platform: 'win32',
      secureWindowsNamespace: () => { throw new Error('ACL setup must not follow a reparse point') },
    },
  })).rejects.toThrow('tombstone namespace is not private')
})

test('Windows rejects an existing public namespace instead of repairing it', async () => {
  const dir = await createTempDir()
  const namespace = path.join(dir, '.atomic-write-tombstones')
  await fs.mkdir(namespace, { mode: 0o777 })
  let establish: boolean | undefined
  await expect(writeFileAtomic(path.join(dir, 'windows-public.json'), 'published', {
    deps: {
      platform: 'win32',
      secureWindowsNamespace: (_directory, created) => {
        establish = created
        return false
      },
    },
  })).rejects.toThrow('tombstone namespace is not private')
  expect(establish).toBe(false)
})

test.skipIf(process.platform === 'win32')('POSIX rejects synthesized permissive namespace mode bits', async () => {
  const dir = await createTempDir()
  const synthesizeWindowsMode = ((source: Parameters<typeof lstatSync>[0], options?: Parameters<typeof lstatSync>[1]) => {
    const stats = lstatSync(source, options as { bigint?: boolean })
    if (String(source).endsWith('.atomic-write-tombstones')) {
      return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
        mode: typeof stats.mode === 'bigint' ? 0o777n : 0o777,
      })
    }
    return stats
  }) as typeof lstatSync
  await expect(writeFileAtomic(path.join(dir, 'posix-mode.json'), 'published', {
    deps: { platform: process.platform, lstatSync: synthesizeWindowsMode },
  })).rejects.toThrow('tombstone namespace is not private')
  expect(() => writeFileAtomicSync(path.join(dir, 'posix-mode-sync.json'), 'published', {
    deps: { platform: process.platform, lstatSync: synthesizeWindowsMode },
  })).toThrow('tombstone namespace is not private')
})

function withIdentity(
  stats: ReturnType<typeof lstatSync>,
  dev: bigint,
  ino: bigint,
): ReturnType<typeof lstatSync> {
  return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { dev, ino }) as ReturnType<typeof lstatSync>
}

async function listTempFiles(dir: string, finalName: string): Promise<string[]> {
  const namespace = path.join(dir, '.atomic-write-tombstones')
  try {
    return (await fs.readdir(namespace)).filter(name => name.startsWith(`${finalName}.tmp.`) && !name.endsWith('.identity.json'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

describe('writeJsonFileAtomic', () => {
  test('cancellation before the synchronous commit point never publishes', async () => {
    const dir = await createTempDir()
    const finalPath = path.join(dir, 'cancel-before-commit.json')
    const controller = new AbortController()
    const originalOpen = fs.open

    await expect(writeJsonFileAtomic(finalPath, { published: true }, {
      context: { signal: controller.signal },
      deps: {
        open: (async (...args: Parameters<typeof fs.open>) => {
          const handle = await originalOpen(...args)
          const sync = handle.sync.bind(handle)
          handle.sync = async () => {
            await sync()
            controller.abort(new Error('cancelled before commit'))
          }
          return handle
        }) as typeof fs.open,
      },
    })).rejects.toThrow('cancelled before commit')

    await expect(fs.stat(finalPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('cancellation at the rename boundary reports an irrevocable committed receipt', async () => {
    const dir = await createTempDir()
    const finalPath = path.join(dir, 'cancel-at-commit.json')
    const controller = new AbortController()

    const receipt = await writeJsonFileAtomic(finalPath, { published: true }, {
      context: { signal: controller.signal },
      deps: {
        renameSync: (from, to) => {
          renameSync(from, to)
          // This is after the kernel commit and before control returns.
          controller.abort(new Error('cancelled at commit boundary'))
        },
      },
    })

    expect(receipt).toMatchObject({
      committed: true,
      authorityExpiredAfterCommit: true,
      identity: { destination: finalPath },
    })
    expect(receipt.identity.inode).toBeGreaterThan(0n)
    expect(JSON.parse(await fs.readFile(finalPath, 'utf8'))).toEqual({ published: true })
  })

  test('cancellation after commit preserves the exact committed identity', async () => {
    const dir = await createTempDir()
    const finalPath = path.join(dir, 'cancel-after-commit.json')
    const controller = new AbortController()
    const originalOpen = fs.open
    let statCalls = 0
    const receipt = await writeJsonFileAtomic(finalPath, { published: true }, {
      context: { signal: controller.signal },
      deps: {
        open: (async (...args: Parameters<typeof fs.open>) => {
          const handle = await originalOpen(...args)
          const stat = handle.stat.bind(handle)
          handle.stat = async () => {
            const observed = await stat()
            // Ownership is now captured before body I/O, so wait for the
            // descriptor observation after the rename commit.
            if (++statCalls === 3) controller.abort(new Error('cancelled after commit'))
            return observed
          }
          return handle
        }) as typeof fs.open,
      },
    })

    expect(receipt.authorityExpiredAfterCommit).toBe(true)
    expect(receipt.identity.destination).toBe(finalPath)
    expect(receipt.identity.inode).toBe(BigInt((await fs.stat(finalPath)).ino))
  })

  test('committed receipt remains pinned to its inode when the destination is replaced after rename', async () => {
    const dir = await createTempDir()
    const finalPath = path.join(dir, 'replacement-race.json')
    const replacementPath = path.join(dir, 'replacement.json')
    writeFileSync(replacementPath, 'outside writer')

    const receipt = await writeFileAtomic(finalPath, 'ours', {
      deps: {
        renameSync: (from, to) => {
          renameSync(from, to)
          renameSync(replacementPath, to)
        },
      },
    })

    expect(receipt.committed).toBe(true)
    expect(receipt.identity.inode).not.toBe(BigInt((await fs.stat(finalPath)).ino))
    expect(receipt.identity.size).toBe(Buffer.byteLength('ours'))
    expect(await fs.readFile(finalPath, 'utf8')).toBe('outside writer')
  })

  test('publishes an unchanged descriptor identity above Number.MAX_SAFE_INTEGER without rounding it', async () => {
    const dir = await createTempDir()
    const finalPath = path.join(dir, 'large-descriptor-identity.json')
    const identity = { dev: 9_007_199_254_740_993n, ino: 9_007_199_254_740_995n }
    const originalOpen = fs.open
    const statOptions: unknown[] = []

    const receipt = await writeFileAtomic(finalPath, 'ours', {
      deps: {
        open: (async (...args: Parameters<typeof fs.open>) => {
          const handle = await originalOpen(...args)
          const descriptorStat = handle.stat.bind(handle)
          handle.stat = async options => {
            statOptions.push(options)
            return withIdentity(await descriptorStat({ bigint: true }), identity.dev, identity.ino)
          }
          return handle
        }) as typeof fs.open,
        lstatSync: source => {
          const stats = lstatSync(source)
          return String(source).includes('.tmp.')
            ? withIdentity(stats, identity.dev, identity.ino)
            : stats
        },
      },
    })

    expect(receipt.identity).toMatchObject({ device: identity.dev, inode: identity.ino })
    expect(statOptions).toEqual([{ bigint: true }, { bigint: true }, { bigint: true }])
    expect(await fs.readFile(finalPath, 'utf8')).toBe('ours')
  })

  test('rejects a changed descriptor identity above Number.MAX_SAFE_INTEGER before rename', async () => {
    const dir = await createTempDir()
    const finalPath = path.join(dir, 'changed-large-descriptor-identity.json')
    const originalOpen = fs.open
    const first = { dev: 9_007_199_254_740_993n, ino: 9_007_199_254_740_992n }
    // These values collapse to the same IEEE-754 number, but remain distinct
    // bigint identities and must therefore reject publication.
    const changed = { dev: 9_007_199_254_740_993n, ino: 9_007_199_254_740_993n }
    let statCalls = 0
    let renameCalls = 0

    await expect(writeFileAtomic(finalPath, 'ours', {
      deps: {
        open: (async (...args: Parameters<typeof fs.open>) => {
          const handle = await originalOpen(...args)
          const descriptorStat = handle.stat.bind(handle)
          handle.stat = async () => {
            const identity = statCalls++ === 0 ? first : changed
            return withIdentity(await descriptorStat({ bigint: true }), identity.dev, identity.ino)
          }
          return handle
        }) as typeof fs.open,
        renameSync: () => { renameCalls += 1 },
      },
    })).rejects.toThrow('atomic publication descriptor changed before rename')

    expect(renameCalls).toBe(0)
    await expect(fs.stat(finalPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test.skipIf(process.platform === 'win32')('publishes from a private source namespace, not a shared stat-then-rename pathname', async () => {
    const dir = await createTempDir()
    const finalPath = path.join(dir, 'protected-source.json')
    await writeFileAtomic(finalPath, 'ours', {
      deps: {
        renameSync: (from, to) => {
          expect(statSync(path.dirname(String(from))).mode & 0o077).toBe(0)
          renameSync(from, to)
        },
      },
    })
    expect(await fs.readFile(finalPath, 'utf8')).toBe('ours')
  })

  test('rejects an adversarial source replacement before rename and does not publish it', async () => {
    const dir = await createTempDir()
    const finalPath = path.join(dir, 'adversarial-source.json')
    await expect(writeFileAtomic(finalPath, 'ours', {
      deps: {
        lstatSync: source => {
          if (String(source).includes('.tmp.')) {
            rmSync(source)
            writeFileSync(source, 'replacement')
          }
          return statSync(source)
        },
      },
    })).rejects.toThrow('temporary source was replaced before rename')
    await expect(fs.stat(finalPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('a cancelled writer cannot remove a concurrent replacement', async () => {
    const dir = await createTempDir()
    const finalPath = path.join(dir, 'concurrent-replacement.json')
    const controller = new AbortController()
    let releaseFirstWrite!: () => void
    const firstWriteBlocked = new Promise<void>(resolve => { releaseFirstWrite = resolve })

    const stale = writeFileAtomic(finalPath, 'stale', {
      context: { signal: controller.signal },
      deps: {
        open: (async (...args: Parameters<typeof fs.open>) => {
          const handle = await fs.open(...args)
          if (String(args[0]).includes('.tmp.')) {
            const write = handle.writeFile.bind(handle)
            handle.writeFile = async (...writeArgs) => {
              await firstWriteBlocked
              return write(...writeArgs)
            }
          }
          return handle
        }) as typeof fs.open,
      },
    })
    const replacement = writeFileAtomic(finalPath, 'replacement')
    await Promise.resolve()
    controller.abort(new Error('stale authority expired'))
    releaseFirstWrite()

    await expect(stale).rejects.toThrow('stale authority expired')
    await replacement
    expect(await fs.readFile(finalPath, 'utf8')).toBe('replacement')
  })

  test('a partial cancelled descriptor write retains a durably-owned collectible tombstone', async () => {
    const dir = await createTempDir()
    const finalPath = path.join(dir, 'partial-cancel.json')
    const controller = new AbortController()
    await expect(writeFileAtomic(finalPath, 'complete generation', {
      context: { signal: controller.signal },
      deps: {
        open: (async (...args: Parameters<typeof fs.open>) => {
          const handle = await fs.open(...args)
          if (String(args[0]).includes('.tmp.')) {
            const write = handle.writeFile.bind(handle)
            handle.writeFile = async () => {
              await write('partial', 'utf8')
              controller.abort(new Error('cancelled during partial write'))
              throw controller.signal.reason
            }
          }
          return handle
        }) as typeof fs.open,
      },
    })).rejects.toThrow('cancelled during partial write')
    await expect(fs.stat(finalPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await listTempFiles(dir, 'partial-cancel.json')).toHaveLength(1)
    const report = await scavengeAtomicWriteTombstones(finalPath, { now: () => Date.now() + 25 * 60 * 60 * 1_000 })
    expect(report.removed).toBe(2)
    expect(await listTempFiles(dir, 'partial-cancel.json')).toEqual([])
  })

  test('writes the ownership sidecar once, before body I/O', async () => {
    const dir = await createTempDir()
    const finalPath = path.join(dir, 'single-sidecar-write.json')
    const originalWriteFile = fs.writeFile
    let sidecarWrites = 0
    await writeFileAtomic(finalPath, 'body', {
      deps: {
        writeFile: (async (...args: Parameters<typeof fs.writeFile>) => {
          if (String(args[0]).endsWith('.identity.json')) sidecarWrites += 1
          return originalWriteFile(...args)
        }) as typeof fs.writeFile,
      },
    })
    expect(sidecarWrites).toBe(1)
    expect(await fs.readFile(finalPath, 'utf8')).toBe('body')
  })

  test('an initial sidecar failure marks this live process inactive so its tombstone is bounded', async () => {
    const dir = await createTempDir()
    const target = path.join(dir, 'sidecar-first-failure.json')
    let failFirstSidecar = true
    await expect(writeFileAtomic(target, 'body', {
      deps: {
        writeFile: (async (...args: Parameters<typeof fs.writeFile>) => {
          if (String(args[0]).endsWith('.identity.json') && failFirstSidecar) {
            failFirstSidecar = false
            throw errno('EIO')
          }
          return fs.writeFile(...args)
        }) as typeof fs.writeFile,
      },
    })).rejects.toMatchObject({ code: 'EIO' })
    const [temporary] = await listTempFiles(dir, 'sidecar-first-failure.json')
    expect(temporary).toBeDefined()
    const report = await scavengeAtomicWriteTombstones(target, {
      now: () => Date.now() + 25 * 60 * 60 * 1_000,
    })
    expect(report.removed).toBe(2)
    expect(await listTempFiles(dir, 'sidecar-first-failure.json')).toEqual([])
  })

  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    test(`retries transient ${code} rename failures`, async () => {
      const dir = await createTempDir()
      const finalPath = path.join(dir, 'bootstrap-state.json')
      const sleeps: number[] = []
      let renameAttempts = 0

      await writeJsonFileAtomic(
        finalPath,
        { ok: true },
        {
          indent: 2,
          mode: 0o600,
          deps: {
            now: () => 123,
            randomId: () => `id-${code.toLowerCase()}`,
            getRetryDelayMs: () => 1,
            sleepSync: ms => {
              sleeps.push(ms)
            },
            renameSync: ((from, to) => {
              renameAttempts += 1
              if (renameAttempts < 4) {
                throw errno(code)
              }
              renameSync(from, to)
            }) as typeof renameSync,
          },
        },
      )

      expect(renameAttempts).toBe(4)
      expect(sleeps).toEqual([1, 1, 1])
      expect(JSON.parse(await fs.readFile(finalPath, 'utf8'))).toEqual({ ok: true })
      expect(await listTempFiles(dir, 'bootstrap-state.json')).toEqual([])
    })
  }

  test('continues retrying beyond short antivirus-style locks', async () => {
    const dir = await createTempDir()
    const finalPath = path.join(dir, 'config.json')
    const sleeps: number[] = []
    let renameAttempts = 0

    await writeJsonFileAtomic(
      finalPath,
      { ok: true },
      {
        indent: 2,
        deps: {
          now: () => 127,
          randomId: () => 'id-long-lock',
          getRetryDelayMs: () => 1,
          sleepSync: ms => {
            sleeps.push(ms)
          },
          renameSync: ((from, to) => {
            renameAttempts += 1
            if (renameAttempts < 12) {
              throw errno('EPERM')
            }
            renameSync(from, to)
          }) as typeof renameSync,
        },
      },
    )

    expect(renameAttempts).toBe(12)
    expect(sleeps).toHaveLength(11)
    expect(JSON.parse(await fs.readFile(finalPath, 'utf8'))).toEqual({ ok: true })
    expect(await listTempFiles(dir, 'config.json')).toEqual([])
  })

  test('does not retry missing temp rename failures', async () => {
    const dir = await createTempDir()
    const finalPath = path.join(dir, 'bootstrap-state.json')
    const sleeps: number[] = []
    let renameAttempts = 0

    await expect(
      writeJsonFileAtomic(
        finalPath,
        { ok: true },
        {
          deps: {
            now: () => 124,
            randomId: () => 'id-enoent',
            getRetryDelayMs: () => 1,
            sleepSync: ms => {
              sleeps.push(ms)
            },
            renameSync: (() => {
              renameAttempts += 1
              throw errno('ENOENT')
            }) as typeof renameSync,
          },
        },
      ),
    ).rejects.toThrow('ENOENT')

    expect(renameAttempts).toBe(1)
    expect(sleeps).toEqual([])
    expect(await listTempFiles(dir, 'bootstrap-state.json')).toHaveLength(1)
  })

  test('cleans up temp file after exhausted transient rename failures', async () => {
    const dir = await createTempDir()
    const finalPath = path.join(dir, 'bootstrap-state.json')
    const sleeps: number[] = []
    let renameAttempts = 0

    await expect(
      writeJsonFileAtomic(
        finalPath,
        { ok: true },
        {
          deps: {
            now: () => 125,
            randomId: () => 'id-exhausted',
            getRetryDelayMs: () => 1,
            sleepSync: ms => {
              sleeps.push(ms)
            },
            renameSync: (() => {
              renameAttempts += 1
              throw errno('EPERM')
            }) as typeof renameSync,
          },
        },
      ),
    ).rejects.toThrow('EPERM')

    expect(renameAttempts).toBe(20)
    expect(sleeps).toEqual(Array.from({ length: 19 }, () => 1))
    expect(await listTempFiles(dir, 'bootstrap-state.json')).toHaveLength(1)
  })

  test('repeated synchronous rename failures are bounded by exact-inode retention caps', async () => {
    const dir = await createTempDir()
    const finalPath = path.join(dir, 'sync-retention.json')
    for (let index = 0; index < 35; index += 1) {
      expect(() => writeFileAtomicSync(finalPath, `generation-${index}`, {
        deps: {
          now: () => index,
          randomId: () => `sync-${index}`,
          renameSync: (() => { throw errno('EIO') }) as typeof renameSync,
        },
      })).toThrow('EIO')
    }
    // Retention counts each body and its ownership receipt independently.
    expect(await listTempFiles(dir, 'sync-retention.json')).toHaveLength(16)
  })

  test('rejects cross-device rename because a copy fallback is not atomic', async () => {
    const dir = await createTempDir()
    const finalPath = path.join(dir, 'bootstrap-state.json')
    let renameAttempts = 0

    await expect(writeJsonFileAtomic(
      finalPath,
      { ok: true },
      {
        deps: {
          now: () => 126,
          randomId: () => 'id-exdev',
          renameSync: (() => {
            renameAttempts += 1
            throw errno('EXDEV')
          }) as typeof renameSync,
        },
      },
    )).rejects.toThrow('EXDEV')

    expect(renameAttempts).toBe(1)
    await expect(fs.stat(finalPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await listTempFiles(dir, 'bootstrap-state.json')).toHaveLength(1)
  })

  test('failed cleanup leaves a replacement of the temporary pathname intact', async () => {
    const dir = await createTempDir()
    const finalPath = path.join(dir, 'replacement-safe.json')
    await expect(writeFileAtomic(finalPath, 'ours', {
      deps: {
        now: () => 128,
        randomId: () => 'replacement-safe',
        renameSync: from => {
          rmSync(from)
          writeFileSync(from, 'outside replacement')
          throw errno('EIO')
        },
      },
    })).rejects.toThrow('EIO')

    const [temporary] = await listTempFiles(dir, 'replacement-safe.json')
    expect(temporary).toBeDefined()
    expect(await fs.readFile(path.join(dir, '.atomic-write-tombstones', temporary!), 'utf8')).toBe('outside replacement')
  })

  test('scavenges expired exact-inode tombstones while preserving a replacement', async () => {
    const dir = await createTempDir()
    const finalPath = path.join(dir, 'scavenge.json')
    await expect(writeFileAtomic(finalPath, 'ours', {
      deps: { renameSync: (() => { throw errno('EIO') }) as typeof renameSync },
    })).rejects.toThrow('EIO')
    const [temporary] = await listTempFiles(dir, 'scavenge.json')
    expect(temporary).toBeDefined()
    const temporaryPath = path.join(dir, '.atomic-write-tombstones', temporary!)
    const staleStats = await fs.lstat(temporaryPath, { bigint: true })
    await fs.writeFile(`${temporaryPath}.identity.json`, JSON.stringify({
      dev: staleStats.dev.toString(), ino: staleStats.ino.toString(), owner: { pid: 999_999, instance: null, active: false },
    }))
    const report = await scavengeAtomicWriteTombstones(finalPath, {
      now: () => Date.now() + (25 * 60 * 60 * 1_000),
    })
    expect(report.removed).toBe(2)
    expect(await listTempFiles(dir, 'scavenge.json')).toEqual([])

    await expect(writeFileAtomic(finalPath, 'ours', {
      deps: {
        renameSync: from => {
          rmSync(from)
          writeFileSync(from, 'replacement')
          throw errno('EIO')
        },
      },
    })).rejects.toThrow('EIO')
    const retained = await scavengeAtomicWriteTombstones(finalPath, {
      now: () => Date.now() + (25 * 60 * 60 * 1_000),
    })
    expect(retained.skippedReplacements).toBeGreaterThan(0)
    const [replacement] = await listTempFiles(dir, 'scavenge.json')
    expect(await fs.readFile(path.join(dir, '.atomic-write-tombstones', replacement!), 'utf8')).toBe('replacement')
  })

  test('reclaims a real bigint-stat owned tombstone', async () => {
    const dir = await createTempDir()
    const finalPath = path.join(dir, 'bigint-reclaim.json')
    await expect(writeFileAtomic(finalPath, 'ours', {
      deps: {
        lstatSync: source => lstatSync(source, { bigint: true }),
        renameSync: (() => { throw errno('EIO') }) as typeof renameSync,
      },
    })).rejects.toThrow('EIO')
    const [temporary] = await listTempFiles(dir, 'bigint-reclaim.json')
    const temporaryPath = path.join(dir, '.atomic-write-tombstones', temporary!)
    const staleStats = await fs.lstat(temporaryPath, { bigint: true })
    await fs.writeFile(`${temporaryPath}.identity.json`, JSON.stringify({
      dev: staleStats.dev.toString(), ino: staleStats.ino.toString(), owner: { pid: 999_999, instance: null, active: false },
    }))
    const report = await scavengeAtomicWriteTombstones(finalPath, {
      lstatSync: source => lstatSync(source, { bigint: true }),
      now: () => Date.now() + (25 * 60 * 60 * 1_000),
    })
    expect(report.removed).toBe(2)
    expect(await listTempFiles(dir, 'bigint-reclaim.json')).toEqual([])
  })

  test('accounts a sidecar once across deterministic first and second body-stat failures', async () => {
    const dir = await createTempDir()
    const finalPath = path.join(dir, 'stat-transition.json')
    const namespace = path.join(dir, '.atomic-write-tombstones')
    await fs.mkdir(namespace, { mode: 0o700 })
    const bodyPath = path.join(namespace, 'stat-transition.json.tmp.stale')
    await fs.writeFile(bodyPath, 'body')
    const bodyStats = await fs.lstat(bodyPath, { bigint: true })
    const sidecarPath = `${bodyPath}.identity.json`
    await fs.writeFile(sidecarPath, JSON.stringify({
      dev: bodyStats.dev.toString(), ino: bodyStats.ino.toString(), owner: { pid: 999_999, instance: null, active: false },
    }))
    const sidecarBytes = Number((await fs.lstat(sidecarPath)).size)

    // The candidate stat fails, but the orphan pass sees the live body. The
    // independently observed sidecar remains one retained object, not zero.
    let firstBodyStats = 0
    const first = await scavengeAtomicWriteTombstones(finalPath, {
      lstatSync: source => {
        if (String(source) === bodyPath && ++firstBodyStats === 1) throw errno('EIO')
        return lstatSync(source, { bigint: true })
      },
    })
    expect(first).toMatchObject({ retained: 1, retainedBytes: sidecarBytes, cleanupDebt: { paths: [bodyPath] } })

    // The candidate stat succeeds but the later sidecar-source re-stat
    // fails. The sidecar is already attached to that candidate and must not
    // be counted a second time.
    let laterBodyStats = 0
    const second = await scavengeAtomicWriteTombstones(finalPath, {
      lstatSync: source => {
        if (String(source) === bodyPath && ++laterBodyStats === 2) throw errno('EIO')
        return lstatSync(source, { bigint: true })
      },
    })
    expect(second).toMatchObject({ retained: 2, retainedBytes: Number(bodyStats.size) + sidecarBytes })
    expect(second.cleanupDebt?.paths).toEqual([bodyPath])
  })

  test('keeps a young below-limit live publisher tombstone without classifying a replacement', async () => {
    const dir = await createTempDir()
    const finalPath = path.join(dir, 'young-live-publisher.json')
    const namespace = path.join(dir, '.atomic-write-tombstones')
    await fs.mkdir(namespace, { mode: 0o700 })
    const bodyPath = path.join(namespace, 'young-live-publisher.json.tmp.active')
    await fs.writeFile(bodyPath, 'still being published')
    const bodyStats = await fs.lstat(bodyPath, { bigint: true })
    await fs.writeFile(`${bodyPath}.identity.json`, JSON.stringify({
      dev: bodyStats.dev.toString(), ino: bodyStats.ino.toString(), owner: { pid: process.pid, instance: null, active: true },
    }))

    const report = await scavengeAtomicWriteTombstones(finalPath)
    expect(report).toMatchObject({ retained: 2, removed: 0, skippedReplacements: 0 })
    expect(await fs.readFile(bodyPath, 'utf8')).toBe('still being published')
  })

  test('never unlinks an expired live publisher tombstone under retention pressure', async () => {
    const dir = await createTempDir()
    const finalPath = path.join(dir, 'live-publisher.json')
    const namespace = path.join(dir, '.atomic-write-tombstones')
    await fs.mkdir(namespace, { mode: 0o700 })
    const bodyPath = path.join(namespace, 'live-publisher.json.tmp.active')
    await fs.writeFile(bodyPath, 'still being published')
    const bodyStats = await fs.lstat(bodyPath, { bigint: true })
    await fs.writeFile(`${bodyPath}.identity.json`, JSON.stringify({
      dev: bodyStats.dev.toString(), ino: bodyStats.ino.toString(), owner: { pid: process.pid, instance: null, active: true },
    }))

    const report = await scavengeAtomicWriteTombstones(finalPath, {
      now: () => Date.now() + 25 * 60 * 60 * 1_000,
    })
    expect(report).toMatchObject({ retained: 2, removed: 0, skippedReplacements: 1 })
    expect(await fs.readFile(bodyPath, 'utf8')).toBe('still being published')
  })

  test('retains unknown ownership separately from a live-process protected tombstone', async () => {
    const dir = await createTempDir()
    const finalPath = path.join(dir, 'unknown-owner.json')
    const namespace = path.join(dir, '.atomic-write-tombstones')
    await fs.mkdir(namespace, { mode: 0o700 })
    const bodyPath = path.join(namespace, 'unknown-owner.json.tmp.legacy')
    await fs.writeFile(bodyPath, 'ownership cannot be established')
    await fs.writeFile(`${bodyPath}.identity.json`, '{torn')

    const report = await scavengeAtomicWriteTombstones(finalPath, {
      now: () => Date.now() + 25 * 60 * 60 * 1_000,
    })
    expect(report).toMatchObject({ retained: 2, removed: 0, skippedReplacements: 1 })
    expect(await fs.readFile(bodyPath, 'utf8')).toBe('ownership cannot be established')
  })

  for (const code of ['EACCES', 'EPERM', 'EIO']) {
    test(`async and sync ${code} sidecar cleanup retain committed receipts`, async () => {
      const dir = await createTempDir()
      const asyncPath = path.join(dir, `async-${code}.json`)
      const syncPath = path.join(dir, `sync-${code}.json`)
      const denySidecar = (source: Parameters<typeof rmSync>[0]) => {
        if (String(source).endsWith('.identity.json')) throw errno(code)
      }
      const asyncReceipt = await writeFileAtomic(asyncPath, 'async', {
        deps: { rmSync: source => { denySidecar(source); return rmSync(source, { force: true }) } },
      })
      const syncReceipt = writeFileAtomicSync(syncPath, 'sync', {
        deps: { rmSync: source => { denySidecar(source); return rmSync(source, { force: true }) } },
      })
      expect(asyncReceipt.cleanupDebt?.paths).toEqual([expect.stringMatching(/\.identity\.json$/)])
      expect(syncReceipt.cleanupDebt?.paths).toEqual([expect.stringMatching(/\.identity\.json$/)])
      expect(await fs.readFile(asyncPath, 'utf8')).toBe('async')
      expect(await fs.readFile(syncPath, 'utf8')).toBe('sync')
    })
  }

  for (const failure of [errno('EBUSY'), errno('ENOSPC'), new Error('unexpected cleanup failure')]) {
    test(`all post-commit cleanup failures retain async and sync receipts: ${failure.message}`, async () => {
      const dir = await createTempDir()
      for (const mode of ['async', 'sync'] as const) {
        const finalPath = path.join(dir, `${mode}-${failure.message.replace(/[^a-z]/gi, '')}.json`)
        const receipt = mode === 'async'
          ? await writeFileAtomic(finalPath, mode, {
            deps: { rmSync: source => {
              if (String(source).endsWith('.identity.json')) throw failure
              return rmSync(source, { force: true })
            } },
          })
          : writeFileAtomicSync(finalPath, mode, {
            deps: { rmSync: source => {
              if (String(source).endsWith('.identity.json')) throw failure
              return rmSync(source, { force: true })
            } },
          })
        expect(receipt).toMatchObject({ committed: true, cleanupDebt: { paths: [expect.stringMatching(/\.identity\.json$/)] } })
        expect(await fs.readFile(finalPath, 'utf8')).toBe(mode)
      }
    })
  }

  for (const code of ['EACCES', 'EIO']) {
    test(`operational ${code} ownership-receipt reads remain debt through scan and both publication paths`, async () => {
      const dir = await createTempDir()
      const finalPath = path.join(dir, `receipt-read-${code}.json`)
      const namespace = path.join(dir, '.atomic-write-tombstones')
      await fs.mkdir(namespace, { mode: 0o700 })
      const bodyPath = path.join(namespace, `receipt-read-${code}.json.tmp.interrupted`)
      const sidecarPath = `${bodyPath}.identity.json`
      await fs.writeFile(bodyPath, 'interrupted')
      await fs.writeFile(sidecarPath, JSON.stringify({ dev: '1', ino: '1' }))
      const deps = {
        readFileSync: ((source: Parameters<typeof readFileSync>[0]) => {
          if (String(source) === sidecarPath) throw errno(code)
          return readFileSync(source, 'utf8')
        }) as typeof readFileSync,
      }

      expect((await scavengeAtomicWriteTombstones(finalPath, deps)).cleanupDebt?.paths).toEqual([sidecarPath])
      expect((await writeFileAtomic(finalPath, 'async', { deps })).cleanupDebt?.paths).toContain(sidecarPath)
      expect(writeFileAtomicSync(finalPath, 'sync', { deps }).cleanupDebt?.paths).toContain(sidecarPath)
      expect(await fs.readFile(finalPath, 'utf8')).toBe('sync')
      expect(await fs.readFile(bodyPath, 'utf8')).toBe('interrupted')
    })
  }

  test('retains missing and malformed interrupted-receipt bodies until abandonment is provable', async () => {
    const dir = await createTempDir()
    const finalPath = path.join(dir, 'interrupted-body-quarantine.json')
    const namespace = path.join(dir, '.atomic-write-tombstones')
    await fs.mkdir(namespace, { mode: 0o700 })
    for (let index = 0; index < 33; index += 1) {
      await fs.writeFile(path.join(namespace, `interrupted-body-quarantine.json.tmp.missing-${index}`), 'evidence')
    }
    const malformedBody = path.join(namespace, 'interrupted-body-quarantine.json.tmp.malformed')
    await fs.writeFile(malformedBody, Buffer.alloc(11 * 1024 * 1024, 1))
    await fs.writeFile(`${malformedBody}.identity.json`, '{torn')

    const bounded = await scavengeAtomicWriteTombstones(finalPath)
    expect(bounded.retained).toBeGreaterThan(32)
    expect(bounded.retainedBytes).toBeGreaterThan(10 * 1024 * 1024)
    expect(bounded.skippedReplacements).toBeGreaterThan(0)
    expect(await fs.stat(malformedBody)).toBeDefined()

    for (const name of await fs.readdir(namespace)) {
      await fs.utimes(path.join(namespace, name), new Date(0), new Date(0))
    }
    const expired = await scavengeAtomicWriteTombstones(finalPath, { now: () => 25 * 60 * 60 * 1_000 })
    expect(expired.retained).toBeGreaterThan(0)
    await expect(writeFileAtomic(finalPath, 'published')).resolves.toMatchObject({ committed: true })
  })

  test('post-commit async and sync scavenging stat failures return cleanup debt', async () => {
    const dir = await createTempDir()
    const asyncPath = path.join(dir, 'async-scavenge-debt.json')
    const syncPath = path.join(dir, 'sync-scavenge-debt.json')
    let asyncNamespaceStats = 0
    const asyncReceipt = await writeFileAtomic(asyncPath, 'async', {
      deps: {
        lstatSync: source => {
          if (String(source).endsWith('.atomic-write-tombstones') && ++asyncNamespaceStats === 3) throw errno('EACCES')
          return lstatSync(source)
        },
      },
    })
    let syncNamespaceStats = 0
    const syncReceipt = writeFileAtomicSync(syncPath, 'sync', {
      deps: {
        lstatSync: source => {
          if (String(source).endsWith('.atomic-write-tombstones') && ++syncNamespaceStats === 3) throw errno('EACCES')
          return lstatSync(source)
        },
      },
    })
    expect(asyncReceipt.cleanupDebt?.paths).toContain(path.join(dir, '.atomic-write-tombstones'))
    expect(syncReceipt.cleanupDebt?.paths).toContain(path.join(dir, '.atomic-write-tombstones'))
    expect(await fs.readFile(asyncPath, 'utf8')).toBe('async')
    expect(await fs.readFile(syncPath, 'utf8')).toBe('sync')
  })

  test('reconciles bounded orphan sidecars only after their exact source names are absent', async () => {
    const dir = await createTempDir()
    const finalPath = path.join(dir, 'orphan-sidecar.json')
    const namespace = path.join(dir, '.atomic-write-tombstones')
    await fs.mkdir(namespace, { mode: 0o700 })
    for (let index = 0; index < 34; index += 1) {
      const source = path.join(namespace, `orphan-sidecar.json.tmp.${index}`)
      await fs.writeFile(`${source}.identity.json`, JSON.stringify({
        dev: '1', ino: String(index + 1), owner: { pid: process.pid, instance: null, active: true },
      }), { mode: 0o600 })
    }
    const report = await scavengeAtomicWriteTombstones(finalPath, { now: () => Date.now() + 25 * 60 * 60 * 1_000 })
    expect(report.removed).toBe(34)
    expect(report.retained).toBe(0)
    expect(await fs.readdir(namespace)).toEqual([])

    const foreignSource = path.join(namespace, 'orphan-sidecar.json.tmp.foreign')
    await fs.writeFile(foreignSource, 'foreign')
    const foreignStats = await fs.lstat(foreignSource, { bigint: true })
    await fs.writeFile(`${foreignSource}.identity.json`, JSON.stringify({
      dev: foreignStats.dev.toString(), ino: foreignStats.ino.toString(), owner: { pid: process.pid, instance: null, active: true },
    }), { mode: 0o600 })
    const foreignReport = await scavengeAtomicWriteTombstones(finalPath, { now: () => Date.now() + 25 * 60 * 60 * 1_000 })
    expect(foreignReport).toMatchObject({ retained: 2, removed: 0, skippedReplacements: 1 })
    expect(await fs.readFile(foreignSource, 'utf8')).toBe('foreign')
    expect(await fs.stat(`${foreignSource}.identity.json`)).toBeDefined()
  })

  test('quarantines malformed orphan receipt evidence within count, byte, and age bounds without blocking publication', async () => {
    const dir = await createTempDir()
    const finalPath = path.join(dir, 'malformed-orphan.json')
    const namespace = path.join(dir, '.atomic-write-tombstones')
    await fs.mkdir(namespace, { mode: 0o700 })
    const receipts = Array.from({ length: 10 }, (_, index) => index === 0 ? '' : `{truncated-${index}`)
    for (const [index, receipt] of receipts.entries()) {
      await fs.writeFile(
        path.join(namespace, `malformed-orphan.json.tmp.${index}.identity.json`),
        receipt,
        { mode: 0o600 },
      )
    }

    const report = await scavengeAtomicWriteTombstones(finalPath, {
      now: () => Date.now(),
    })
    expect(report.retained).toBeLessThanOrEqual(8)
    expect(report.retainedBytes).toBeLessThanOrEqual(64 * 1024)
    expect(report.removed).toBeGreaterThanOrEqual(2)
    await expect(writeFileAtomic(finalPath, 'published')).resolves.toMatchObject({ committed: true })
    expect(await fs.readFile(finalPath, 'utf8')).toBe('published')

    for (const name of await fs.readdir(namespace)) {
      await fs.utimes(path.join(namespace, name), new Date(0), new Date(0))
    }
    const expired = await scavengeAtomicWriteTombstones(finalPath, {
      now: () => 25 * 60 * 60 * 1_000,
    })
    expect(expired).toMatchObject({ retained: 0 })
  })

  test('failed malformed orphan quarantine is explicit cleanup debt and reaches a publication receipt', async () => {
    const dir = await createTempDir()
    const finalPath = path.join(dir, 'malformed-orphan-debt.json')
    const namespace = path.join(dir, '.atomic-write-tombstones')
    await fs.mkdir(namespace, { mode: 0o700 })
    const sidecarPath = path.join(namespace, 'malformed-orphan-debt.json.tmp.torn.identity.json')
    await fs.writeFile(sidecarPath, '{truncated', { mode: 0o600 })
    const deps = {
      now: () => Date.now() + 25 * 60 * 60 * 1_000,
      rmSync: (source: Parameters<typeof rmSync>[0]) => {
        if (String(source) === sidecarPath) throw errno('EACCES')
        return rmSync(source, { force: true })
      },
    }

    const report = await scavengeAtomicWriteTombstones(finalPath, deps)
    expect(report.cleanupDebt?.paths).toEqual([sidecarPath])
    expect(report).toMatchObject({ retained: 1, removed: 0 })
    const receipt = await writeFileAtomic(finalPath, 'published', { deps })
    expect(receipt.cleanupDebt?.paths).toContain(sidecarPath)
    expect(await fs.readFile(finalPath, 'utf8')).toBe('published')
  })

  test('unreadable orphan receipts retain trusted count and bytes while surfacing read debt', async () => {
    const dir = await createTempDir()
    const finalPath = path.join(dir, 'unreadable-orphan.json')
    const namespace = path.join(dir, '.atomic-write-tombstones')
    await fs.mkdir(namespace, { mode: 0o700 })
    const sidecarPath = path.join(namespace, 'unreadable-orphan.json.tmp.interrupted.identity.json')
    await fs.writeFile(sidecarPath, '{opaque')
    const bytes = Number((await fs.lstat(sidecarPath)).size)
    const report = await scavengeAtomicWriteTombstones(finalPath, {
      readFileSync: ((source: Parameters<typeof readFileSync>[0]) => {
        if (String(source) === sidecarPath) throw errno('EIO')
        return readFileSync(source, 'utf8')
      }) as typeof readFileSync,
    })
    expect(report).toMatchObject({ retained: 1, retainedBytes: bytes, cleanupDebt: { paths: [sidecarPath] } })
  })

  for (const code of ['EACCES', 'EIO']) {
    test(`orphan paired-body ${code} inspection preserves sidecar evidence and does not block publication`, async () => {
      const dir = await createTempDir()
      const finalPath = path.join(dir, `orphan-paired-body-${code}.json`)
      const namespace = path.join(dir, '.atomic-write-tombstones')
      await fs.mkdir(namespace, { mode: 0o700 })
      const bodyPath = path.join(namespace, `orphan-paired-body-${code}.json.tmp.interrupted`)
      const sidecarPath = `${bodyPath}.identity.json`
      await fs.writeFile(sidecarPath, '{opaque', { mode: 0o600 })
      const bytes = Number((await fs.lstat(sidecarPath)).size)
      const deps = {
        lstatSync: (source: Parameters<typeof lstatSync>[0]) => {
          if (String(source) === bodyPath) throw errno(code)
          return lstatSync(source, { bigint: true })
        },
      }

      const report = await scavengeAtomicWriteTombstones(finalPath, deps)
      expect(report).toMatchObject({
        retained: 1,
        retainedBytes: bytes,
        removed: 0,
        cleanupDebt: { paths: [bodyPath] },
      })
      expect(report.skippedReplacements).toBe(1)
      const receipt = await writeFileAtomic(finalPath, 'published', { deps })
      expect(receipt).toMatchObject({ committed: true, cleanupDebt: { paths: expect.arrayContaining([bodyPath]) } })
      expect(await fs.readFile(finalPath, 'utf8')).toBe('published')
      expect(Number((await fs.lstat(sidecarPath)).size)).toBe(bytes)
    })

    test(`orphan sidecar ${code} inspection is exact cleanup debt without aborting publication`, async () => {
      const dir = await createTempDir()
      const finalPath = path.join(dir, `orphan-sidecar-stat-${code}.json`)
      const namespace = path.join(dir, '.atomic-write-tombstones')
      await fs.mkdir(namespace, { mode: 0o700 })
      const sidecarPath = path.join(namespace, `orphan-sidecar-stat-${code}.json.tmp.interrupted.identity.json`)
      await fs.writeFile(sidecarPath, '{opaque', { mode: 0o600 })
      const deps = {
        lstatSync: (source: Parameters<typeof lstatSync>[0]) => {
          if (String(source) === sidecarPath) throw errno(code)
          return lstatSync(source, { bigint: true })
        },
      }

      await expect(scavengeAtomicWriteTombstones(finalPath, deps)).resolves.toMatchObject({
        retained: 0,
        retainedBytes: 0,
        cleanupDebt: { paths: [sidecarPath] },
      })
      const receipt = await writeFileAtomic(finalPath, 'published', { deps })
      expect(receipt).toMatchObject({ committed: true, cleanupDebt: { paths: expect.arrayContaining([sidecarPath]) } })
      expect(await fs.readFile(finalPath, 'utf8')).toBe('published')
      expect(await fs.lstat(sidecarPath)).toBeDefined()
    })
  }

  test('concurrent orphan-sidecar disappearance is non-operational and does not block publication', async () => {
    const dir = await createTempDir()
    const finalPath = path.join(dir, 'orphan-sidecar-disappears.json')
    const namespace = path.join(dir, '.atomic-write-tombstones')
    await fs.mkdir(namespace, { mode: 0o700 })
    const sidecarPath = path.join(namespace, 'orphan-sidecar-disappears.json.tmp.interrupted.identity.json')
    await fs.writeFile(sidecarPath, '{opaque', { mode: 0o600 })
    const deps = {
      lstatSync: (source: Parameters<typeof lstatSync>[0]) => {
        if (String(source) === sidecarPath) throw errno('ENOENT')
        return lstatSync(source, { bigint: true })
      },
    }
    await expect(scavengeAtomicWriteTombstones(finalPath, deps)).resolves.toMatchObject({
      retained: 0, retainedBytes: 0, removed: 0, skippedReplacements: 0,
    })
    expect((await writeFileAtomic(finalPath, 'published', { deps })).cleanupDebt).toBeUndefined()
    expect(await fs.readFile(finalPath, 'utf8')).toBe('published')
  })

  test('an operational final orphan absence check is debt, not a replacement', async () => {
    const dir = await createTempDir()
    const finalPath = path.join(dir, 'final-absence-debt.json')
    const namespace = path.join(dir, '.atomic-write-tombstones')
    await fs.mkdir(namespace, { mode: 0o700 })
    const bodyPath = path.join(namespace, 'final-absence-debt.json.tmp.interrupted')
    const sidecarPath = `${bodyPath}.identity.json`
    await fs.writeFile(sidecarPath, '{torn')
    let bodyChecks = 0
    const report = await scavengeAtomicWriteTombstones(finalPath, {
      now: () => Date.now() + 25 * 60 * 60 * 1_000,
      lstatSync: source => {
        if (String(source) === bodyPath && ++bodyChecks > 1) throw errno('EIO')
        return lstatSync(source)
      },
    })
    expect(report.cleanupDebt?.paths).toEqual([bodyPath])
    expect(report.skippedReplacements).toBe(1)
    expect(report.retained).toBe(1)
  })

  for (const mode of ['async', 'sync'] as const) {
    test(`${mode} publication retains sidecar cleanup debt after removing an expired body`, async () => {
      const dir = await createTempDir()
      const finalPath = path.join(dir, `${mode}-sidecar-debt.json`)
      const namespace = path.join(dir, '.atomic-write-tombstones')
      await fs.mkdir(namespace, { mode: 0o700 })
      const bodyPath = path.join(namespace, `${mode}-sidecar-debt.json.tmp.stale`)
      const sidecarPath = `${bodyPath}.identity.json`
      await fs.writeFile(bodyPath, 'stale-body')
      const bodyStats = await fs.lstat(bodyPath, { bigint: true })
      await fs.writeFile(sidecarPath, JSON.stringify({ dev: bodyStats.dev.toString(), ino: bodyStats.ino.toString(), owner: { pid: 999_999, instance: null, active: false } }))
      const sidecarBytes = Number((await fs.lstat(sidecarPath)).size)
      const deps = {
        now: () => Date.now() + 25 * 60 * 60 * 1_000,
        rmSync: (source: Parameters<typeof rmSync>[0]) => {
          if (String(source) === sidecarPath) throw errno('EACCES')
          return rmSync(source, { force: true })
        },
      }

      const report = await scavengeAtomicWriteTombstones(finalPath, deps)
      expect(report).toMatchObject({ retained: 1, retainedBytes: sidecarBytes, removed: 1 })
      expect(report.cleanupDebt?.paths).toEqual([sidecarPath])
      await expect(fs.lstat(bodyPath)).rejects.toMatchObject({ code: 'ENOENT' })

      const receipt = mode === 'async'
        ? await writeFileAtomic(finalPath, 'published', { deps })
        : writeFileAtomicSync(finalPath, 'published', { deps })
      expect(receipt.cleanupDebt?.paths).toContain(sidecarPath)
      expect(await fs.readFile(finalPath, 'utf8')).toBe('published')
      expect(Number((await fs.lstat(sidecarPath)).size)).toBe(sidecarBytes)
    })
  }

  test('post-rename descriptor observation failure retains async and sync commit receipts as debt', async () => {
    const dir = await createTempDir()
    const asyncPath = path.join(dir, 'async-post-rename-stat.json')
    const originalOpen = fs.open
    let temporaryStats = 0
    const asyncReceipt = await writeFileAtomic(asyncPath, 'async', {
      deps: {
        open: (async (...args: Parameters<typeof fs.open>) => {
          const handle = await originalOpen(...args)
          if (String(args[0]).includes('.tmp.') && args[1] === 'wx') {
            const stat = handle.stat.bind(handle)
            handle.stat = async (...statArgs: Parameters<typeof handle.stat>) => {
              if (++temporaryStats === 3) throw errno('EIO')
              return stat(...statArgs)
            }
          }
          return handle
        }) as typeof fs.open,
      },
    })
    const syncPath = path.join(dir, 'sync-post-rename-stat.json')
    let syncStats = 0
    const syncReceipt = writeFileAtomicSync(syncPath, 'sync', {
      deps: {
        fstatSync: ((...args: Parameters<typeof fstatSync>) => {
          if (++syncStats === 3) throw errno('EIO')
          return fstatSync(...args)
        }) as typeof fstatSync,
      },
    })
    expect(asyncReceipt).toMatchObject({ committed: true, cleanupDebt: { paths: [asyncPath] } })
    expect(syncReceipt).toMatchObject({ committed: true, cleanupDebt: { paths: [syncPath] } })
    expect(await fs.readFile(asyncPath, 'utf8')).toBe('async')
    expect(await fs.readFile(syncPath, 'utf8')).toBe('sync')
  })

  test('post-rename descriptor close failures are debt in async and sync receipts', async () => {
    const dir = await createTempDir()
    const asyncPath = path.join(dir, 'async-post-rename-close.json')
    const originalOpen = fs.open
    const asyncReceipt = await writeFileAtomic(asyncPath, 'async', {
      deps: {
        open: (async (...args: Parameters<typeof fs.open>) => {
          const handle = await originalOpen(...args)
          if (String(args[0]).includes('.tmp.') && args[1] === 'wx') {
            const close = handle.close.bind(handle)
            handle.close = async () => { await close(); throw errno('EIO') }
          }
          return handle
        }) as typeof fs.open,
      },
    })
    const syncPath = path.join(dir, 'sync-post-rename-close.json')
    let closes = 0
    const syncReceipt = writeFileAtomicSync(syncPath, 'sync', {
      deps: {
        closeSync: fd => {
          closeSync(fd)
          if (++closes === 2) throw errno('EIO')
        },
      },
    })
    expect(asyncReceipt).toMatchObject({ committed: true, cleanupDebt: { paths: [asyncPath] } })
    expect(syncReceipt).toMatchObject({ committed: true, cleanupDebt: { paths: [syncPath] } })
    expect(await fs.readFile(asyncPath, 'utf8')).toBe('async')
    expect(await fs.readFile(syncPath, 'utf8')).toBe('sync')
  })

  for (const mode of ['async', 'sync'] as const) {
    test(`${mode} receipt retains operational body-collection debt distinctly from an identity mismatch`, async () => {
      const dir = await createTempDir()
      const finalPath = path.join(dir, `${mode}-body-collection-debt.json`)
      const namespace = path.join(dir, '.atomic-write-tombstones')
      await fs.mkdir(namespace, { mode: 0o700 })
      const bodyPath = path.join(namespace, `${mode}-body-collection-debt.json.tmp.stale`)
      await fs.writeFile(bodyPath, 'stale-body')
      const bodyStats = await fs.lstat(bodyPath, { bigint: true })
      await fs.writeFile(`${bodyPath}.identity.json`, JSON.stringify({ dev: bodyStats.dev.toString(), ino: bodyStats.ino.toString(), owner: { pid: 999_999, instance: null, active: false } }))

      let bodyStatsCalls = 0
      const deps = {
        now: () => Date.now() + 25 * 60 * 60 * 1_000,
        lstatSync: (source: Parameters<typeof lstatSync>[0]) => {
          if (String(source) === bodyPath && ++bodyStatsCalls % 2 === 1) throw errno('EIO')
          return lstatSync(source, { bigint: true })
        },
      }
      const report = await scavengeAtomicWriteTombstones(finalPath, deps)
      expect(report).toMatchObject({ retained: 0, removed: 0 })
      expect(report.cleanupDebt?.paths).toEqual([bodyPath])
      expect(await fs.readFile(bodyPath, 'utf8')).toBe('stale-body')

      const receipt = mode === 'async'
        ? await writeFileAtomic(finalPath, 'published', { deps })
        : writeFileAtomicSync(finalPath, 'published', { deps })
      expect(receipt.cleanupDebt?.paths).toContain(bodyPath)
      expect(await fs.readFile(finalPath, 'utf8')).toBe('published')
      expect(await fs.readFile(bodyPath, 'utf8')).toBe('stale-body')
    })
  }
})

describe('renamePathWithRetry', () => {
  test('retries transient managed path rename failures', async () => {
    const sleeps: number[] = []
    let renameAttempts = 0

    await renamePathWithRetry('/tmp/source', '/tmp/target', {
      getRetryDelayMs: () => 1,
      sleep: async ms => {
        sleeps.push(ms)
      },
      rename: (async () => {
        renameAttempts += 1
        if (renameAttempts < 3) {
          throw errno('EPERM')
        }
      }) as typeof fs.rename,
    })

    expect(renameAttempts).toBe(3)
    expect(sleeps).toEqual([1, 1])
  })

  test('does not treat cross-device managed path renames as file-copy atomic writes', async () => {
    let renameAttempts = 0

    await expect(
      renamePathWithRetry('/tmp/source-dir', '/tmp/target-dir', {
        rename: (async () => {
          renameAttempts += 1
          throw errno('EXDEV')
        }) as typeof fs.rename,
      }),
    ).rejects.toThrow('EXDEV')

    expect(renameAttempts).toBe(1)
  })
})
