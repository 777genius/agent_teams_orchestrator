import { describe, expect, test } from 'bun:test'

import { runOpenCodeMutationWithFreshProof } from './OpenCodeLaunchProofMutationPolicy.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(next => { resolve = next })
  return { promise, resolve }
}

describe('OpenCode fresh-proof mutation policy', () => {
  for (const drift of ['managed auth', 'managed config', 'MCP tools', 'retained proof'] as const) {
    test(`rejects ${drift} drift while getSession is suspended without create or retry`, async () => {
      const getSession = deferred()
      let observedGeneration = 1
      let creates = 0
      let revalidations = 0
      const operation = (async () => {
        await getSession.promise
        return runOpenCodeMutationWithFreshProof(async () => {
          revalidations += 1
          if (observedGeneration !== 1) throw new Error(`fresh proof changed: ${drift}`)
        }, async () => { creates += 1; return 'created' })
      })()

      observedGeneration = 2
      getSession.resolve()
      await expect(operation).rejects.toThrow(`fresh proof changed: ${drift}`)
      expect(revalidations).toBe(1)
      expect(creates).toBe(0)
    })
  }

  test('revalidates independently at every externally observable mutation boundary', async () => {
    const order: string[] = []
    let proofGeneration = 1
    const revalidate = async () => {
      order.push('proof')
      if (proofGeneration !== 1) throw new Error('proof drift')
    }
    await runOpenCodeMutationWithFreshProof(revalidate, async () => { order.push('create') })
    await runOpenCodeMutationWithFreshProof(revalidate, async () => { order.push('lease') })
    proofGeneration = 2
    await expect(runOpenCodeMutationWithFreshProof(revalidate, async () => {
      order.push('bootstrap')
    })).rejects.toThrow('proof drift')
    expect(order).toEqual(['proof', 'create', 'proof', 'lease', 'proof'])
  })
})
