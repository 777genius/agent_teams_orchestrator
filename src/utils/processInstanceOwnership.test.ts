import { expect, test } from 'bun:test'

import { spawn } from 'node:child_process'
import { isProcessInstanceActive, isProcessInstanceActiveSync, processInstance, processInstanceSync } from './processInstanceOwnership.js'

test.skipIf(process.platform !== 'linux')('production process incarnation reads /proc through fs/promises and rejects PID reuse', async () => {
  const instance = await processInstance(process.pid)
  expect(instance).toMatch(/^\d+$/)
  expect(await isProcessInstanceActive({ pid: process.pid, instance, active: true })).toBe(true)
  expect(await isProcessInstanceActive({ pid: process.pid, instance: `${instance}-reused`, active: true })).toBe(false)
})

test.skipIf(process.platform !== 'win32')('Windows uses the native process creation-time incarnation', async () => {
  const instance = await processInstance(process.pid)
  expect(instance).toMatch(/^\d+$/)
  expect(await isProcessInstanceActive({ pid: process.pid, instance, active: true })).toBe(true)
  expect(await isProcessInstanceActive({ pid: process.pid, instance: `${instance}-reused`, active: true })).toBe(false)
})

test.skipIf(process.platform !== 'linux' && process.platform !== 'win32')('async and sync incarnation probes follow a real child lifecycle', async () => {
  const child = spawn(process.execPath, ['-e', "process.stdout.write(String(process.pid)); setTimeout(() => process.exit(0), 2000)"], {
    stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  })
  if (!child.stdout) throw new Error('child stdout was not available')
  const pid = await new Promise<number>((resolve, reject) => {
    let output = ''
    child.stdout.on('data', chunk => { output += String(chunk); if (/^\d+$/.test(output)) resolve(Number(output)) })
    child.once('error', reject)
  })
  const asynchronous = await processInstance(pid)
  const synchronous = processInstanceSync(pid)
  expect(asynchronous).not.toBeNull()
  expect(synchronous).not.toBeNull()
  expect(await isProcessInstanceActive({ pid, instance: asynchronous, active: true })).toBe(true)
  expect(isProcessInstanceActiveSync({ pid, instance: synchronous, active: true })).toBe(true)
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', () => resolve())
  })
  expect(await isProcessInstanceActive({ pid, instance: asynchronous, active: true })).toBe(false)
  expect(isProcessInstanceActiveSync({ pid, instance: synchronous, active: true })).toBe(false)
})
