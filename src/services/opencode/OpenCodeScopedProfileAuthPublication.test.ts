import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  commitOpenCodeScopedProfileAuth,
  finalizeOpenCodeScopedProfileAuth,
  OpenCodeAtomicPublicationSettlementError,
  rollbackOpenCodeScopedProfileAuth,
  rollbackOpenCodeScopedProfileAuthSignal,
} from './OpenCodeScopedProfileAuthPublication.js'

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

test('enclosing rejection restores prior auth before completing rollback', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-profile-auth-rollback-'))
  const authPath = path.join(root, 'auth.json')
  const preparedProfile = { identity: 'attempt-a', purpose: 'provider-catalog' }
  try {
    await writeFile(authPath, '{"generation":"prior"}')
    await commitOpenCodeScopedProfileAuth({
      managedAuthPath: authPath,
      managedAuthBytes: Buffer.from('{"generation":"attempt-a"}'),
      preparedProfile,
    })
    expect(await readFile(authPath, 'utf8')).toBe('{"generation":"attempt-a"}')
    await rollbackOpenCodeScopedProfileAuth(preparedProfile)
    expect(await readFile(authPath, 'utf8')).toBe('{"generation":"prior"}')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rollback A never removes or renames a newer successor B', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-profile-auth-successor-'))
  const authPath = path.join(root, 'auth.json')
  const attemptA = { identity: 'attempt-a', purpose: 'provider-catalog' }
  const successorB = { identity: 'successor-b', purpose: 'provider-catalog' }
  try {
    await commitOpenCodeScopedProfileAuth({
      managedAuthPath: authPath,
      managedAuthBytes: Buffer.from('{"generation":"attempt-a"}'),
      preparedProfile: attemptA,
    })
    await commitOpenCodeScopedProfileAuth({
      managedAuthPath: authPath,
      managedAuthBytes: Buffer.from('{"generation":"successor-b"}'),
      preparedProfile: successorB,
    })
    await rollbackOpenCodeScopedProfileAuth(attemptA)
    expect(await readFile(authPath, 'utf8')).toBe('{"generation":"successor-b"}')
    await finalizeOpenCodeScopedProfileAuth(successorB)
    expect(await readFile(authPath, 'utf8')).toBe('{"generation":"successor-b"}')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('deadline signal can roll back auth before preparation returns its profile', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-profile-auth-signal-'))
  const authPath = path.join(root, 'auth.json')
  const controller = new AbortController()
  const preparedProfile = { identity: 'stalled-cleanup', purpose: 'provider-catalog' }
  try {
    await writeFile(authPath, '{"generation":"prior"}')
    await commitOpenCodeScopedProfileAuth({
      managedAuthPath: authPath,
      managedAuthBytes: Buffer.from('{"generation":"visible-at-stall"}'),
      preparedProfile,
      abortSignal: controller.signal,
    })
    controller.abort(new Error('absolute catalog deadline'))
    await rollbackOpenCodeScopedProfileAuthSignal(controller.signal)
    expect(await readFile(authPath, 'utf8')).toBe('{"generation":"prior"}')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('failed rollback remains unsettled and retryable', async () => {
  const preparedProfile = { identity: 'retryable-rollback', purpose: 'provider-catalog' }
  let attempts = 0
  await commitOpenCodeScopedProfileAuth({
    managedAuthPath: path.join(os.tmpdir(), 'retryable-auth.json'),
    managedAuthBytes: Buffer.from('{}'),
    preparedProfile,
    publish: async () => ({
      commit: async () => {},
      rollback: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('injected durable rollback failure')
      },
    }),
  })
  await expect(rollbackOpenCodeScopedProfileAuth(preparedProfile))
    .rejects.toThrow('injected durable rollback failure')
  await rollbackOpenCodeScopedProfileAuth(preparedProfile)
  expect(attempts).toBe(2)
})

test.each([
  ['launch', 'recovery-marker deletion'],
  ['launch', 'recovery parent sync'],
  ['execution-probe', 'recovery-marker deletion'],
  ['execution-probe', 'recovery parent sync'],
] as const)('non-catalog %s auth closes exact retained authority after injected %s failure',
  async (purpose, boundary) => {
    let commitAttempts = 0; let rollbackAttempts = 0
    let closeInvocations = 0; let retainedHandles = 1
    const close = async () => {
      closeInvocations += 1
      if (retainedHandles > 0) retainedHandles -= 1
    }
    const publication = commitOpenCodeScopedProfileAuth({
      managedAuthPath: path.join(os.tmpdir(), `${purpose}-retained-auth.json`),
      managedAuthBytes: Buffer.from('{}'),
      preparedProfile: { purpose },
      publish: async () => ({
        commit: async () => {
          commitAttempts += 1
          if (commitAttempts === 1) throw new Error(`injected ${boundary} failure`)
        },
        rollback: async () => { rollbackAttempts += 1 },
        close,
      }),
    })
    await expect(publication).rejects.toBeInstanceOf(OpenCodeAtomicPublicationSettlementError)
    await expect(publication).rejects.toMatchObject({
      publicationState: 'committed_with_cleanup_error',
      retrySafe: true,
    })
    expect(commitAttempts).toBe(2)
    expect(rollbackAttempts).toBe(0)
    expect(retainedHandles).toBe(0)
    await close()
    expect(closeInvocations).toBe(2)
    expect(retainedHandles).toBe(0)
  })

test('non-catalog auth returns a settled failure and closes when commit cleanup cannot finish', async () => {
  let commits = 0; let rollbacks = 0; let closes = 0; let retainedHandles = 1
  const publication = commitOpenCodeScopedProfileAuth({
    managedAuthPath: path.join(os.tmpdir(), 'settled-retained-auth.json'),
    managedAuthBytes: Buffer.from('{}'),
    preparedProfile: { purpose: 'launch' },
    publish: async () => ({
      commit: async () => { commits += 1; throw new Error('commit cleanup unavailable') },
      rollback: async () => { rollbacks += 1 },
      close: async () => { closes += 1; retainedHandles = 0 },
    }),
  })
  await expect(publication).rejects.toMatchObject({
    publicationState: 'settled_failure',
    retrySafe: true,
  })
  expect({ commits, rollbacks, closes, retainedHandles })
    .toEqual({ commits: 2, rollbacks: 1, closes: 1, retainedHandles: 0 })
})
