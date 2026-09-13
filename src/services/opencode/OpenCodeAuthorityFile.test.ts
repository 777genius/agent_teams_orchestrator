import { expect, test, spyOn } from 'bun:test'
import * as fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readOpenCodeAuthorityFile } from './OpenCodeAuthorityFile.js'
import { readOpenCodeAuthStore } from './OpenCodeAuthStore.js'
import { collectProjectBehaviorMetadata } from './OpenCodeProfileManager.js'

test('authority I/O yields to deadlines and closes a descriptor acquired after timeout', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'issue446-async-open-'))
  const file = path.join(root, 'file')
  await fs.writeFile(file, 'fixture')
  const original = fs.open
  let resume!: () => void
  const barrier = new Promise<void>(resolve => { resume = resolve })
  let opened!: () => void
  const entered = new Promise<void>(resolve => { opened = resolve })
  let closes = 0, reads = 0
  const mock = spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args)
    const close = handle.close.bind(handle)
    const read = handle.read.bind(handle)
    handle.close = async () => { closes++; return close() }
    handle.read = ((...input: any[]) => { reads++; return (read as Function)(...input) }) as typeof handle.read
    opened()
    await barrier
    return handle
  })
  try {
    const pending = readOpenCodeAuthorityFile(file, { timeoutMs: 20 })
    expect(pending).toBeInstanceOf(Promise)
    await entered
    await expect(pending).rejects.toThrow('timed out')
    expect(reads).toBe(0)
    resume()
    for (let i = 0; i < 100 && closes === 0; i++) await new Promise(resolve => setTimeout(resolve, 1))
    expect(closes).toBe(1)
  } finally { resume(); mock.mockRestore(); await fs.rm(root, { recursive: true, force: true }) }
})

test.each(['read', 'stat', 'close'])('stalled descriptor %s keeps caller bounded and observes late rejection', async stage => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'issue446-async-descriptor-'))
  const file = path.join(root, 'file')
  await fs.writeFile(file, 'fixture')
  const original = fs.open
  let rejectLate!: (error: Error) => void
  const barrier = new Promise<never>((_, reject) => { rejectLate = reject })
  void barrier.catch(() => {})
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  let closes = 0
  const mock = spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args)
    const close = handle.close.bind(handle)
    handle.close = async () => { closes++; await close(); if (stage === 'close') { entered(); await barrier } }
    if (stage !== 'close') (handle as any)[stage] = () => { entered(); return barrier }
    return handle
  })
  try {
    const pending = readOpenCodeAuthorityFile(file, { timeoutMs: 20 })
    expect(pending).toBeInstanceOf(Promise)
    await started
    await expect(pending).rejects.toThrow('timed out')
    rejectLate(new Error('synthetic-late-error'))
    for (let i = 0; i < 100 && closes === 0; i++) await new Promise(resolve => setTimeout(resolve, 1))
    expect(closes).toBe(1)
  } finally { rejectLate(new Error('synthetic-late-error')); mock.mockRestore(); await fs.rm(root, { recursive: true, force: true }) }
})

test('production auth and behavior readers reject special and sparse oversized files', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'issue446-production-readers-'))
  const config = path.join(root, 'opencode.json')
  const auth = path.join(root, 'auth.json')
  const tool = path.join(root, '.opencode/tools/tool.ts')
  await fs.mkdir(path.dirname(tool), { recursive: true })
  expect(await readOpenCodeAuthStore(auth)).toEqual({})
  await collectProjectBehaviorMetadata(root, {})
  let unsafeReads = 0
  const originalRead = fs.readFile
  const unsafe = spyOn(fs, 'readFile').mockImplementation(((file: unknown, ...args: unknown[]) => {
    if ([config, auth, tool].includes(String(file))) {
      unsafeReads++
      return Promise.reject(new Error('unbounded production authority read'))
    }
    return (originalRead as Function)(file, ...args)
  }) as typeof fs.readFile)
  try {
    for (const file of [config, auth, tool]) {
      for (const kind of ['fifo', 'device', 'sparse']) {
        if (kind === 'fifo') execFileSync('mkfifo', [file])
        if (kind === 'device') await fs.symlink('/dev/zero', file)
        if (kind === 'sparse') { await fs.writeFile(file, ''); await fs.truncate(file, 1024 * 1024 + 1) }
        const read = file === auth ? () => readOpenCodeAuthStore(file) : () => collectProjectBehaviorMetadata(root, {})
        await expect(read()).rejects.toThrow()
        await fs.rm(file)
      }
    }
    expect(unsafeReads).toBe(0)
  } finally { unsafe.mockRestore(); await fs.rm(root, { recursive: true, force: true }) }
})

test('descriptor binds replacement and preserves ordinary symlinks', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'issue446-async-replacement-'))
  const file = path.join(root, 'file'), replacement = path.join(root, 'replacement')
  await fs.writeFile(file, 'before')
  await fs.writeFile(replacement, 'after!')
  const original = fs.open
  let closes = 0
  const mock = spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    expect(Number(args[1]) & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK)
    await fs.rename(replacement, file)
    const handle = await original(...args)
    const close = handle.close.bind(handle)
    handle.close = async () => { closes++; await close() }
    return handle
  })
  try {
    await expect(readOpenCodeAuthorityFile(file)).rejects.toThrow('unavailable')
    expect(closes).toBe(1)
    mock.mockRestore()
    await fs.symlink(file, replacement)
    expect(await readOpenCodeAuthorityFile(replacement)).toBe('after!')
  } finally { mock.mockRestore(); await fs.rm(root, { recursive: true, force: true }) }
})

test('production receipt reads share bounded I/O and sanitize malformed credential evidence', async () => {
  const { readOpenCodeSavedAuthStore, openCodeOAuthSuccessorPath } = await import('./OpenCodeAuthStore.js')
  const root = await fs.mkdtemp(path.join(tmpdir(), 'issue446-receipt-reader-'))
  const auth = path.join(root, 'auth.json')
  const receipt = openCodeOAuthSuccessorPath(auth)
  const original = fs.readFile
  let unsafeReads = 0
  const unsafe = spyOn(fs, 'readFile').mockImplementation(((file: unknown, ...args: unknown[]) => {
    if (file === receipt) { unsafeReads++; return Promise.reject(new Error('unbounded receipt read')) }
    return (original as Function)(file, ...args)
  }) as typeof fs.readFile)
  try {
    execFileSync('mkfifo', [receipt])
    await expect(readOpenCodeSavedAuthStore({ sourceAuthPaths: [], sourceStores: [], globalAuthPath: auth })).rejects.toThrow()
    expect(unsafeReads).toBe(0)
    await fs.writeFile(auth, '{"synthetic-private-credential": invalid}')
    try { await readOpenCodeAuthStore(auth); throw new Error('unexpected success') }
    catch (error) {
      expect((error as Error).message).toBe('OpenCode authentication evidence is unavailable')
      expect((error as Error).message).not.toContain(root)
      expect((error as Error).message).not.toContain('synthetic-private-credential')
    }
  } finally { unsafe.mockRestore(); await fs.rm(root, { recursive: true, force: true }) }
})

test('descriptor detects pathname replacement during read and closes exactly once', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'issue446-read-replacement-'))
  const file = path.join(root, 'file'), replacement = path.join(root, 'replacement')
  await fs.writeFile(file, 'before')
  await fs.writeFile(replacement, 'after!')
  const original = fs.open
  let closes = 0, reads = 0
  const mock = spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args)
    const close = handle.close.bind(handle), read = handle.read.bind(handle)
    handle.close = async () => { closes++; await close() }
    handle.read = (async (...input: unknown[]) => {
      if (++reads === 1) await fs.rename(replacement, file)
      return (read as Function)(...input)
    }) as typeof handle.read
    return handle
  })
  try {
    await expect(readOpenCodeAuthorityFile(file)).rejects.toThrow('unavailable')
    expect(reads).toBeGreaterThan(0)
    expect(closes).toBe(1)
  } finally { mock.mockRestore(); await fs.rm(root, { recursive: true, force: true }) }
})

test('launch preferences reject unsafe authority files without optional-default fallback', async () => {
  const { readOpenCodeManagedRuntimePreferences, readOpenCodeGlobalManagedRuntimePreferences,
    getOpenCodeManagedPreferencesPath, getOpenCodeGlobalManagedPreferencesPath } = await import('./OpenCodeManagedPreferences.js')
  const root = await fs.mkdtemp(path.join(tmpdir(), 'issue446-preferences-reader-'))
  const cases = [
    [getOpenCodeManagedPreferencesPath(root), () => readOpenCodeManagedRuntimePreferences(root)],
    [getOpenCodeGlobalManagedPreferencesPath(root), () => readOpenCodeGlobalManagedRuntimePreferences(root)],
  ] as const
  const original = fs.readFile
  let unsafeReads = 0
  const unsafe = spyOn(fs, 'readFile').mockImplementation(((file: unknown, ...args: unknown[]) => {
    if (cases.some(([candidate]) => candidate === file)) { unsafeReads++; return Promise.reject(new Error('unbounded preference read')) }
    return (original as Function)(file, ...args)
  }) as typeof fs.readFile)
  try {
    for (const [file, read] of cases) {
      await fs.mkdir(path.dirname(file), { recursive: true })
      execFileSync('mkfifo', [file])
      await expect(read()).rejects.toThrow('OpenCode runtime preferences are unavailable')
      await fs.rm(file)
      expect((await read()).defaultModelId).toBeNull()
    }
    expect(unsafeReads).toBe(0)
  } finally { unsafe.mockRestore(); await fs.rm(root, { recursive: true, force: true }) }
})
