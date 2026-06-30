import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { renamePathWithRetry, writeJsonFileAtomic } from './atomicWrite.js'

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

async function listTempFiles(dir: string, finalName: string): Promise<string[]> {
  return (await fs.readdir(dir)).filter(name => name.startsWith(`${finalName}.tmp.`))
}

describe('writeJsonFileAtomic', () => {
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
            sleep: async ms => {
              sleeps.push(ms)
            },
            rename: (async (from, to) => {
              renameAttempts += 1
              if (renameAttempts < 4) {
                throw errno(code)
              }
              await fs.rename(from, to)
            }) as typeof fs.rename,
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
          sleep: async ms => {
            sleeps.push(ms)
          },
          rename: (async (from, to) => {
            renameAttempts += 1
            if (renameAttempts < 12) {
              throw errno('EPERM')
            }
            await fs.rename(from, to)
          }) as typeof fs.rename,
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
            sleep: async ms => {
              sleeps.push(ms)
            },
            rename: (async () => {
              renameAttempts += 1
              throw errno('ENOENT')
            }) as typeof fs.rename,
          },
        },
      ),
    ).rejects.toThrow('ENOENT')

    expect(renameAttempts).toBe(1)
    expect(sleeps).toEqual([])
    expect(await listTempFiles(dir, 'bootstrap-state.json')).toEqual([])
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
            sleep: async ms => {
              sleeps.push(ms)
            },
            rename: (async () => {
              renameAttempts += 1
              throw errno('EPERM')
            }) as typeof fs.rename,
          },
        },
      ),
    ).rejects.toThrow('EPERM')

    expect(renameAttempts).toBe(20)
    expect(sleeps).toEqual(Array.from({ length: 19 }, () => 1))
    expect(await listTempFiles(dir, 'bootstrap-state.json')).toEqual([])
  })

  test('falls back to copy and unlink on cross-device rename', async () => {
    const dir = await createTempDir()
    const finalPath = path.join(dir, 'bootstrap-state.json')
    let renameAttempts = 0

    await writeJsonFileAtomic(
      finalPath,
      { ok: true },
      {
        deps: {
          now: () => 126,
          randomId: () => 'id-exdev',
          rename: (async () => {
            renameAttempts += 1
            throw errno('EXDEV')
          }) as typeof fs.rename,
        },
      },
    )

    expect(renameAttempts).toBe(1)
    expect(JSON.parse(await fs.readFile(finalPath, 'utf8'))).toEqual({ ok: true })
    expect(await listTempFiles(dir, 'bootstrap-state.json')).toEqual([])
  })
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
