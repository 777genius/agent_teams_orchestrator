import { expect, test } from 'bun:test'

import { isProcessInstanceActive, processInstance } from './processInstanceOwnership.js'

test.skipIf(process.platform !== 'linux')('production process incarnation reads /proc through fs/promises and rejects PID reuse', async () => {
  const instance = await processInstance(process.pid)
  expect(instance).toMatch(/^\d+$/)
  expect(await isProcessInstanceActive({ pid: process.pid, instance, active: true })).toBe(true)
  expect(await isProcessInstanceActive({ pid: process.pid, instance: `${instance}-reused`, active: true })).toBe(false)
})
