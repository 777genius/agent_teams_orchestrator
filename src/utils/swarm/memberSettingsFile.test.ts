import { expect, test } from 'bun:test'
import { lstat, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { runCleanupFunctions } from '../cleanupRegistry.js'
import { writeOwnedMemberSettingsFile } from './memberSettingsFile.js'

test('owns private settings copies until runtime cleanup, preserving inherited secrets off argv', async () => {
  const settings = { env: { INHERITED_TEST_SECRET: 'private-fixture' }, codex: { forced_login_method: 'api' } }
  const first = writeOwnedMemberSettingsFile(settings)!
  const second = writeOwnedMemberSettingsFile(settings)!
  expect(first).toBeTruthy()
  expect(first).not.toBe(second)
  expect(first).not.toContain('private-fixture')
  expect(JSON.parse(await readFile(first, 'utf8'))).toEqual(settings)
  if (process.platform !== 'win32') {
    expect((await lstat(dirname(first))).mode & 0o777).toBe(0o700)
    expect((await lstat(first)).mode & 0o777).toBe(0o600)
  }
  await runCleanupFunctions()
  expect(await Bun.file(first).exists()).toBe(false)
  expect(await Bun.file(second).exists()).toBe(false)
  await expect(lstat(dirname(first))).rejects.toMatchObject({ code: 'ENOENT' })
})
