import { describe, expect, test } from 'bun:test'
import {
  runHostedControlFromDescriptors,
  runHostedControlFromDescriptorsWithDependencies,
  type HostedControlMainDependencies,
} from './HostedControlMain.js'
import type { HostedControlBootstrapAdmission } from './HostedControlBootstrap.js'

const digest = `sha256:${'a'.repeat(64)}` as const
const admission = {} as HostedControlBootstrapAdmission

describe('hosted control production descriptor fast path', () => {
  test('source execution rejects a forged build-pin global before bootstrap', async () => {
    const globals = globalThis as typeof globalThis & {
      HOSTED_CONTROL_BUILD_OWNER_ARTIFACT_DIGEST?: string
    }
    globals.HOSTED_CONTROL_BUILD_OWNER_ARTIFACT_DIGEST = digest
    try {
      await expect(runHostedControlFromDescriptors()).rejects.toThrow(
        'Hosted control owner artifact digest pin was rejected',
      )
    } finally {
      delete globals.HOSTED_CONTROL_BUILD_OWNER_ARTIFACT_DIGEST
    }
  })

  test('passes the independently pinned owner artifact digest to bootstrap', async () => {
    const calls: unknown[] = []
    await runHostedControlFromDescriptorsWithDependencies(dependencies({
      expectedOwnerArtifactDigest: digest,
      readBootstrap: async options => { calls.push(options); return admission },
      runAdmission: async value => { calls.push(value) },
    }))

    expect(calls).toEqual([{ expectedOwnerArtifactDigest: digest }, admission])
  })

  test('rejects a missing independent pin before bootstrap', async () => {
    let called = false
    await expect(runHostedControlFromDescriptorsWithDependencies(dependencies({
      expectedOwnerArtifactDigest: undefined,
      readBootstrap: async () => { called = true; return admission },
    }))).rejects.toThrow('Hosted control owner artifact digest pin was rejected')
    expect(called).toBe(false)
  })

  test('rejects wrong pin encodings before bootstrap', async () => {
    for (const wrong of [
      'a'.repeat(64), `sha256:${'A'.repeat(64)}`, `sha256:${'a'.repeat(63)}`,
      `sha512:${'a'.repeat(64)}`, `sha256:${'a'.repeat(64)}\n`,
    ]) {
      let called = false
      await expect(runHostedControlFromDescriptorsWithDependencies(dependencies({
        expectedOwnerArtifactDigest: wrong,
        readBootstrap: async () => { called = true; return admission },
      }))).rejects.toThrow('Hosted control owner artifact digest pin was rejected')
      expect(called).toBe(false)
    }
  })

  test('does not replace a well-formed wrong pin with an in-band fallback', async () => {
    const wrong = `sha256:${'b'.repeat(64)}` as `sha256:${string}`
    let ranAdmission = false
    await expect(runHostedControlFromDescriptorsWithDependencies(dependencies({
      expectedOwnerArtifactDigest: wrong,
      readBootstrap: async options => {
        expect(options).toEqual({ expectedOwnerArtifactDigest: wrong })
        throw new Error('bootstrap pin mismatch')
      },
      runAdmission: async () => { ranAdmission = true },
    }))).rejects.toThrow('bootstrap pin mismatch')
    expect(ranAdmission).toBe(false)
  })
})

function dependencies(
  overrides: Partial<HostedControlMainDependencies>,
): HostedControlMainDependencies {
  return {
    expectedOwnerArtifactDigest: undefined,
    readBootstrap: async () => admission,
    runAdmission: async () => undefined,
    ...overrides,
  }
}
