import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { OwnedKernelChild } from './kernel-fixture-ownership.js'
import { createNativeOwnerComposition } from './native-composition.js'
import { OWNER_V2_INVOCATION, OWNER_V2_RUNTIME_MANIFEST } from './runtime-manifest-v2.js'

// Negative real-entry execution: no in-process invocation can close the test
// runner's inherited descriptors. Root separately runs the signed sandbox path.
test.skipIf(process.platform !== 'linux')('actual top-level native entry fails descriptor admission without a desktop fallback', async () => {
  const entry = fileURLToPath(new URL('../hosted-actual-owner-owner.ts',import.meta.url))
  const child = new OwnedKernelChild(spawn(process.execPath,['run',entry,OWNER_V2_INVOCATION,
    '--runtime-manifest',OWNER_V2_RUNTIME_MANIFEST], {
    env:{PATH:'/usr/bin:/bin',NODE_ENV:'test'},stdio:'pipe',
  }))
  try {
    expect(await child.wait(20_000)).toBe(true)
    expect(child.child.exitCode).not.toBe(0)
    expect(child.stderr).toContain('hosted_owner_v2_')
    expect(child.stderr).not.toContain('Cannot find module')
    expect(child.stderr).not.toContain('composition_missing')
  } finally {await child.stop(0)}
},30_000)

test('concrete composition is one-use and cannot be restarted with injected admission callbacks', () => {
  const composition = createNativeOwnerComposition()
  composition.close()
  expect(() => composition.admitLaunch({} as never)).toThrow('composition_consumed')
  expect('acquireProviderCustody' in composition).toBe(false)
})
