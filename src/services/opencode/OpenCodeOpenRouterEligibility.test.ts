import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  hasOpenCodeOpenRouterCatalogCredential,
  isOpenCodeOpenRouterFreeRouteAllowedInEnvironment,
  openCodeOpenRouterEligibilityIdentity,
  resolveOpenCodeOpenRouterEnvironment,
} from './OpenCodeOpenRouterFallback.js'

test('file credentials bind usable content and secret-free identity, including deletion', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'issue446-files-'))
  try {
    const file = path.join(dir, 'key')
    const provider = { options: { apiKey: `{file:${file}}` } }
    const env = { OPENROUTER_API_KEY: 'synthetic-lower-priority' }
    const identity = () => openCodeOpenRouterEligibilityIdentity(provider, env, null)
    const usable = () => hasOpenCodeOpenRouterCatalogCredential(provider, env, null)
    const missing = identity()
    expect(usable()).toBe(false)
    writeFileSync(file, '')
    const empty = identity()
    expect(empty).not.toBe(missing)
    expect(usable()).toBe(false)
    writeFileSync(file, 'synthetic-secret-one\n')
    const first = identity()
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(first).not.toContain('synthetic-secret')
    expect(usable()).toBe(true)
    writeFileSync(file, 'synthetic-secret-one')
    expect(identity()).not.toBe(first)
    writeFileSync(file, 'synthetic-secret-two')
    expect(identity()).not.toBe(first)
    writeFileSync(file, '{env:UNSET_SYNTHETIC_KEY}')
    expect(usable()).toBe(true)
    writeFileSync(file, '{file:missing-synthetic-file}')
    expect(usable()).toBe(true)
    rmSync(file)
    expect(identity()).toBe(missing)
    expect(usable()).toBe(false)
    mkdirSync(file)
    expect(usable()).toBe(false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('file-backed restrictions and options use native trimming and JSON escaping', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'issue446-restrictions-'))
  try {
    const file = path.join(dir, 'route')
    writeFileSync(file, 'openrouter/free\n')
    const provider = { blacklist: [`{file:${file}}`], options: { baseURL: `{file:${file}}` } }
    const before = openCodeOpenRouterEligibilityIdentity(provider, {}, null)
    expect(isOpenCodeOpenRouterFreeRouteAllowedInEnvironment(provider, {})).toBe(false)
    writeFileSync(file, 'https://synthetic.invalid/"quoted"\n')
    expect(isOpenCodeOpenRouterFreeRouteAllowedInEnvironment(provider, {})).toBe(true)
    expect(resolveOpenCodeOpenRouterEnvironment(provider.options, {})).toEqual({ baseURL: 'https://synthetic.invalid/"quoted"' })
    expect(openCodeOpenRouterEligibilityIdentity(provider, {}, null)).not.toBe(before)
    expect(resolveOpenCodeOpenRouterEnvironment('{file:~/route}', { HOME: dir })).toBe('https://synthetic.invalid/"quoted"')
    expect(resolveOpenCodeOpenRouterEnvironment('{file:{env:FILE}}', { FILE: file })).toBe('https://synthetic.invalid/"quoted"')
    const credentialProvider = { env: [`{file:${file}}`] }
    writeFileSync(file, 'CUSTOM_ROUTER\n')
    const credentialEnv = { CUSTOM_ROUTER: 'synthetic-custom' }
    expect(hasOpenCodeOpenRouterCatalogCredential(credentialProvider, credentialEnv, null)).toBe(true)
    const credentialIdentity = openCodeOpenRouterEligibilityIdentity(credentialProvider, credentialEnv, null)
    writeFileSync(file, 'MISSING_ROUTER')
    expect(hasOpenCodeOpenRouterCatalogCredential(credentialProvider, credentialEnv, null)).toBe(false)
    expect(openCodeOpenRouterEligibilityIdentity(credentialProvider, credentialEnv, null)).not.toBe(credentialIdentity)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('inline auth and configured provider environment follow credential precedence', () => {
  const disk = { type: 'api', key: 'synthetic-disk' }
  const inline = { OPENCODE_AUTH_CONTENT: JSON.stringify({ openrouter: { type: 'api', key: 'synthetic-inline' } }) }
  expect(hasOpenCodeOpenRouterCatalogCredential({}, inline, null)).toBe(true)
  expect(hasOpenCodeOpenRouterCatalogCredential({}, { OPENCODE_AUTH_CONTENT: '{}' }, disk)).toBe(false)
  expect(hasOpenCodeOpenRouterCatalogCredential({}, { OPENCODE_AUTH_CONTENT: '{invalid' }, disk)).toBe(false)
  expect(hasOpenCodeOpenRouterCatalogCredential({}, { OPENCODE_AUTH_CONTENT: '{"openrouter":{"type":"api","key":" "}}' }, disk)).toBe(false)
  expect(hasOpenCodeOpenRouterCatalogCredential({ options: { apiKey: '' } }, inline, disk)).toBe(false)
  expect(hasOpenCodeOpenRouterCatalogCredential({ options: { apiKey: 'synthetic-option' } }, { OPENCODE_AUTH_CONTENT: 'invalid' }, null)).toBe(true)
  expect(hasOpenCodeOpenRouterCatalogCredential({ env: ['CUSTOM_ROUTER'] }, { CUSTOM_ROUTER: 'synthetic-custom' }, null)).toBe(true)
  expect(hasOpenCodeOpenRouterCatalogCredential({ env: ['CUSTOM_ROUTER'] }, { OPENROUTER_API_KEY: 'synthetic-default' }, null)).toBe(false)
  expect(hasOpenCodeOpenRouterCatalogCredential({ env: ['CUSTOM_ROUTER'] }, { CUSTOM_ROUTER: ' ' }, null)).toBe(false)
  expect(openCodeOpenRouterEligibilityIdentity({}, inline, null)).not.toBe(openCodeOpenRouterEligibilityIdentity({}, {
    OPENCODE_AUTH_CONTENT: JSON.stringify({ openrouter: { type: 'api', key: 'synthetic-rotated' } }),
  }, null))
  expect(openCodeOpenRouterEligibilityIdentity({ env: ['CUSTOM_ROUTER'] }, { CUSTOM_ROUTER: 'one' }, null))
    .not.toBe(openCodeOpenRouterEligibilityIdentity({ env: ['CUSTOM_ROUTER'] }, { CUSTOM_ROUTER: 'two' }, null))
})
