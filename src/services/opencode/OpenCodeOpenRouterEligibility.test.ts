import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  hasOpenCodeOpenRouterCatalogCredential,
  isOpenCodeOpenRouterFreeRouteAllowedInEnvironment,
  openCodeOpenRouterEligibilityIdentity,
  captureOpenCodeOpenRouterEnvironment,
} from './OpenCodeOpenRouterFallback.js'

test('file credentials bind usable content and secret-free identity, including deletion', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'issue446-files-'))
  try {
    const file = path.join(dir, 'key')
    const provider = { options: { apiKey: `{file:${file}}` } }
    const env = { OPENROUTER_API_KEY: 'synthetic-lower-priority' }
    const capture = async () => {
      const digests: string[] = []
      try { return { provider: await captureOpenCodeOpenRouterEnvironment(provider, env, digests) as Record<string, unknown>, digests } }
      catch { return { provider: { whitelist: [], options: 'invalid' }, digests } }
    }
    const identity = async () => { const captured = await capture(); return openCodeOpenRouterEligibilityIdentity(captured.provider, env, null, true, captured.digests) }
    const usable = async () => hasOpenCodeOpenRouterCatalogCredential((await capture()).provider, env, null, true)
    const missing = await identity()
    expect(await usable()).toBe(false)
    writeFileSync(file, '')
    const empty = await identity()
    expect(empty).not.toBe(missing)
    expect(await usable()).toBe(false)
    writeFileSync(file, 'synthetic-secret-one\n')
    const first = await identity()
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(first).not.toContain('synthetic-secret')
    expect(await usable()).toBe(true)
    writeFileSync(file, 'synthetic-secret-one')
    expect(await identity()).not.toBe(first)
    writeFileSync(file, 'synthetic-secret-two')
    expect(await identity()).not.toBe(first)
    writeFileSync(file, '{env:UNSET_SYNTHETIC_KEY}')
    expect(await usable()).toBe(true)
    writeFileSync(file, '{file:missing-synthetic-file}')
    expect(await usable()).toBe(true)
    rmSync(file)
    expect(await identity()).toBe(missing)
    expect(await usable()).toBe(false)
    mkdirSync(file)
    expect(await usable()).toBe(false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('file-backed restrictions and options use native trimming and JSON escaping', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'issue446-restrictions-'))
  try {
    const file = path.join(dir, 'route')
    writeFileSync(file, 'openrouter/free\n')
    const provider = { blacklist: [`{file:${file}}`], options: { baseURL: `{file:${file}}` } }
    const before = openCodeOpenRouterEligibilityIdentity(await captureOpenCodeOpenRouterEnvironment(provider, {}) as any, {}, null, true)
    expect(isOpenCodeOpenRouterFreeRouteAllowedInEnvironment(await captureOpenCodeOpenRouterEnvironment(provider, {}) as any, {})).toBe(false)
    writeFileSync(file, 'https://synthetic.invalid/"quoted"\n')
    expect(isOpenCodeOpenRouterFreeRouteAllowedInEnvironment(await captureOpenCodeOpenRouterEnvironment(provider, {}) as any, {})).toBe(true)
    expect(await captureOpenCodeOpenRouterEnvironment(provider.options, {})).toEqual({ baseURL: 'https://synthetic.invalid/"quoted"' })
    expect(openCodeOpenRouterEligibilityIdentity(await captureOpenCodeOpenRouterEnvironment(provider, {}) as any, {}, null, true)).not.toBe(before)
    expect(await captureOpenCodeOpenRouterEnvironment('{file:~/route}', { HOME: dir })).toBe('https://synthetic.invalid/"quoted"')
    expect(await captureOpenCodeOpenRouterEnvironment('{file:{env:FILE}}', { FILE: file })).toBe('https://synthetic.invalid/"quoted"')
    const credentialProvider = { env: [`{file:${file}}`] }
    writeFileSync(file, 'CUSTOM_ROUTER\n')
    const credentialEnv = { CUSTOM_ROUTER: 'synthetic-custom' }
    expect(hasOpenCodeOpenRouterCatalogCredential(await captureOpenCodeOpenRouterEnvironment(credentialProvider, credentialEnv) as any, credentialEnv, null, true)).toBe(true)
    const credentialIdentity = openCodeOpenRouterEligibilityIdentity(await captureOpenCodeOpenRouterEnvironment(credentialProvider, credentialEnv) as any, credentialEnv, null, true)
    writeFileSync(file, 'MISSING_ROUTER')
    expect(hasOpenCodeOpenRouterCatalogCredential(await captureOpenCodeOpenRouterEnvironment(credentialProvider, credentialEnv) as any, credentialEnv, null, true)).toBe(false)
    expect(openCodeOpenRouterEligibilityIdentity(await captureOpenCodeOpenRouterEnvironment(credentialProvider, credentialEnv) as any, credentialEnv, null, true)).not.toBe(credentialIdentity)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('inline auth and configured provider environment follow credential precedence', () => {
  const disk = { type: 'api', key: 'synthetic-disk' }
  const inline = { OPENCODE_AUTH_CONTENT: JSON.stringify({ openrouter: { type: 'api', key: 'synthetic-inline' } }) }
  expect(hasOpenCodeOpenRouterCatalogCredential({}, inline, null)).toBe(true)
  expect(hasOpenCodeOpenRouterCatalogCredential({}, { OPENCODE_AUTH_CONTENT: '{}' }, disk)).toBe(false)
  expect(hasOpenCodeOpenRouterCatalogCredential({}, { OPENCODE_AUTH_CONTENT: '{invalid' }, disk)).toBe(true)
  expect(hasOpenCodeOpenRouterCatalogCredential({}, { OPENCODE_AUTH_CONTENT: '{"openrouter":{"type":"api","key":" "}}' }, disk)).toBe(false)
  expect(hasOpenCodeOpenRouterCatalogCredential({ options: { apiKey: '' } }, inline, disk)).toBe(false)
  expect(hasOpenCodeOpenRouterCatalogCredential({ options: { apiKey: 'synthetic-option' } }, { OPENCODE_AUTH_CONTENT: 'invalid' }, null)).toBe(true)
  expect(hasOpenCodeOpenRouterCatalogCredential({ env: ['CUSTOM_ROUTER'] }, { CUSTOM_ROUTER: 'synthetic-custom' }, null)).toBe(true)
  expect(hasOpenCodeOpenRouterCatalogCredential({ env: ['CUSTOM_ROUTER'] }, { OPENROUTER_API_KEY: 'synthetic-default' }, null)).toBe(true)
  expect(hasOpenCodeOpenRouterCatalogCredential({ env: ['CUSTOM_ROUTER'] }, { CUSTOM_ROUTER: ' ' }, null)).toBe(false)
  expect(openCodeOpenRouterEligibilityIdentity({}, inline, null)).not.toBe(openCodeOpenRouterEligibilityIdentity({}, {
    OPENCODE_AUTH_CONTENT: JSON.stringify({ openrouter: { type: 'api', key: 'synthetic-rotated' } }),
  }, null))
  expect(openCodeOpenRouterEligibilityIdentity({ env: ['CUSTOM_ROUTER'] }, { CUSTOM_ROUTER: 'one' }, null))
    .not.toBe(openCodeOpenRouterEligibilityIdentity({ env: ['CUSTOM_ROUTER'] }, { CUSTOM_ROUTER: 'two' }, null))
})

// Pinned Auth.all returns parsed inline JSON without validating its shape;
// only falsy content / JSON parse failure reaches the disk read.
test.each(['', ' ', '{invalid', '[invalid'])('native inline auth falls back to disk: %j', content => {
  const env = { OPENCODE_AUTH_CONTENT: content }
  expect(hasOpenCodeOpenRouterCatalogCredential({}, env, { type: 'api', key: 'synthetic-disk' })).toBe(true)
  expect(hasOpenCodeOpenRouterCatalogCredential({}, env, null)).toBe(false)
})

test.each(['{}', 'null', '[]', 'false', '"string"'])('parsed inline auth never falls back to disk: %s', content => {
  expect(hasOpenCodeOpenRouterCatalogCredential({}, { OPENCODE_AUTH_CONTENT: content },
    { type: 'api', key: 'synthetic-disk' })).toBe(false)
})

test('native single-name key and multiple-name SDK fallback bind only supplied credentials', () => {
  const provider = { env: ['CUSTOM_ONE', 'CUSTOM_TWO'] }
  for (const env of [{ CUSTOM_ONE: 'synthetic-one' }, { CUSTOM_TWO: 'synthetic-two' },
    { CUSTOM_ONE: 'synthetic-one', CUSTOM_TWO: 'synthetic-two' }]) {
    expect(hasOpenCodeOpenRouterCatalogCredential(provider, env, null)).toBe(false)
    expect(hasOpenCodeOpenRouterCatalogCredential(provider, { ...env, OPENROUTER_API_KEY: 'synthetic-sdk' }, null)).toBe(true)
  }
  const env = { CUSTOM_ONE: 'synthetic-one', OPENROUTER_API_KEY: 'synthetic-sdk' }
  const identity = openCodeOpenRouterEligibilityIdentity(provider, env, null)
  expect(openCodeOpenRouterEligibilityIdentity(provider, { ...env, CUSTOM_ONE: 'ignored-rotation' }, null)).toBe(identity)
  expect(openCodeOpenRouterEligibilityIdentity(provider, { ...env, OPENROUTER_API_KEY: 'sdk-rotation' }, null)).not.toBe(identity)
  expect(hasOpenCodeOpenRouterCatalogCredential({ env: ['CUSTOM_ONE'] }, env, null)).toBe(true)
  expect(hasOpenCodeOpenRouterCatalogCredential({ env: ['CUSTOM_ONE'] }, { ...env, CUSTOM_ONE: ' ' }, null)).toBe(false)
  expect(openCodeOpenRouterEligibilityIdentity({ env: ['CUSTOM_ONE'] }, env, null))
    .not.toBe(openCodeOpenRouterEligibilityIdentity({ env: ['CUSTOM_ONE'] }, { ...env, CUSTOM_ONE: 'rotation' }, null))
})

const launchProvider = { api: 'https://synthetic.invalid', npm: '@synthetic/provider',
  models: { route: { id: 'upstream', name: 'Route' } }, options: { apiKey: 'synthetic-private' } }

test('complete resolved launch contract has canonical secret-free identity', () => {
  const identity = openCodeOpenRouterEligibilityIdentity(launchProvider, {}, null)
  expect(identity).toMatch(/^[a-f0-9]{64}$/)
  expect(openCodeOpenRouterEligibilityIdentity({ options: launchProvider.options,
    models: { route: { name: 'Route', id: 'upstream' } }, npm: launchProvider.npm, api: launchProvider.api }, {}, null)).toBe(identity)
  expect(openCodeOpenRouterEligibilityIdentity(launchProvider, {}, null)).toBe(identity)
})

test.each([
  ['api', { ...launchProvider, api: 'https://changed.invalid' }],
  ['npm', { ...launchProvider, npm: '@synthetic/changed' }],
  ['model mapping', { ...launchProvider, models: { route: { id: 'changed', name: 'Route' } } }],
  ['model addition', { ...launchProvider, models: { ...launchProvider.models, added: {} } }],
  ['model deletion', { ...launchProvider, models: {} }],
  ['models deletion', { ...launchProvider, models: undefined }],
  ['api deletion', { ...launchProvider, api: undefined }],
  ['npm deletion', { ...launchProvider, npm: undefined }],
])('launch identity independently binds %s', (_name, changed) => {
  expect(openCodeOpenRouterEligibilityIdentity(changed as Record<string, unknown>, {}, null))
    .not.toBe(openCodeOpenRouterEligibilityIdentity(launchProvider, {}, null))
})

test('auth evidence bounds regular files and rejects malformed, oversized and special files', async () => {
  const { readOpenCodeOpenRouterCredentialEvidence: read } = await import('./OpenCodeOpenRouterFallback.js')
  const { symlinkSync } = await import('node:fs')
  const { spawnSync } = await import('node:child_process')
  const dir = mkdtempSync(path.join(os.tmpdir(), 'issue446-auth-evidence-'))
  const file = path.join(dir, 'auth.json')
  const invalid = { type: 'api', key: '' }
  try {
    expect(await read(file)).toBeNull()
    writeFileSync(file, JSON.stringify({ openrouter: { type: 'api', key: 'synthetic-key' } }))
    expect(await read(file)).toEqual({ type: 'api', key: 'synthetic-key' })
    const link = path.join(dir, 'link')
    symlinkSync(file, link)
    expect(await read(link)).toEqual(await read(file))
    for (const content of ['{invalid', '[]', 'null', 'x'.repeat(1024 * 1024 + 1)]) {
      writeFileSync(file, content)
      expect(await read(file)).toEqual(invalid)
    }
    rmSync(file)
    mkdirSync(file)
    expect(await read(file)).toEqual(invalid)
    if (process.platform !== 'win32') {
      const fifo = path.join(dir, 'fifo')
      expect(spawnSync('mkfifo', [fifo]).status).toBe(0)
      // No writer: any blocking FIFO open would hang this regression.
      expect(await read(fifo)).toEqual(invalid)
      expect(await read('/dev/null')).toEqual(invalid)
      expect(await read('/dev/zero')).toEqual(invalid)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('auth descriptor rejects stat/open replacement without blocking or exposing evidence', async () => {
  const { spyOn } = await import('bun:test')
  const fs = await import('node:fs/promises')
  const { constants } = await import('node:fs')
  const { readOpenCodeOpenRouterCredentialEvidence: read } = await import('./OpenCodeOpenRouterFallback.js')
  const dir = mkdtempSync(path.join(os.tmpdir(), 'issue446-auth-race-'))
  const file = path.join(dir, 'auth.json')
  const replacement = path.join(dir, 'replacement')
  writeFileSync(file, '{"openrouter":{"type":"api","key":"synthetic-before"}}')
  writeFileSync(replacement, '{"openrouter":{"type":"api","key":"synthetic-after"}}')
  const original = fs.open
  let replaced = false
  const opened = spyOn(fs, 'open').mockImplementation((async (target, flags, mode) => {
    if (target === file) {
      expect(Number(flags) & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK)
      await fs.rename(replacement, file)
      replaced = true
    }
    return original(target, flags, mode)
  }) as typeof fs.open)
  try {
    expect(await read(file)).toEqual({ type: 'api', key: '' })
    expect(replaced).toBe(true)
  } finally { opened.mockRestore(); rmSync(dir, { recursive: true, force: true }) }
})
