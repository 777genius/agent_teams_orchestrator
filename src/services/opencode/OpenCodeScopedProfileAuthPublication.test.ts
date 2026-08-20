import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { commitOpenCodeScopedProfileAuth } from './OpenCodeScopedProfileAuthPublication.js'

test('profile auth commit has no abort-rejecting awaited post-write phase', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-profile-auth-transaction-'))
  const authPath = path.join(root, 'auth.json')
  const controller = new AbortController()
  const preparedProfile = Object.freeze({ identity: 'prepared-profile' })
  try {
    const result = await commitOpenCodeScopedProfileAuth({
      managedAuthPath: authPath,
      managedAuthBytes: Buffer.from('{"provider":"selected"}'),
      preparedProfile,
      abortSignal: controller.signal,
      publish: async (_directory, _name, bytes) => {
        await writeFile(authPath, bytes)
        controller.abort(new Error('deadline after visibility'))
      },
    })
    expect(result).toBe(preparedProfile)
    expect(await readFile(authPath, 'utf8')).toBe('{"provider":"selected"}')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('profile auth commit rejects an abort before visibility', async () => {
  const controller = new AbortController()
  const reason = new Error('deadline before visibility')
  controller.abort(reason)
  let publishes = 0
  await expect(commitOpenCodeScopedProfileAuth({
    managedAuthPath: path.join(os.tmpdir(), 'must-not-publish-auth.json'),
    managedAuthBytes: Buffer.from('{}'),
    preparedProfile: {},
    abortSignal: controller.signal,
    publish: async () => { publishes += 1 },
  })).rejects.toBe(reason)
  expect(publishes).toBe(0)
})
