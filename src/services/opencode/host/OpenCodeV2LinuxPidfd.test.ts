import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { linuxBirth, linuxPidfdHasExited } from './OpenCodeV2ExecutionLauncher.js'

const qualified = process.platform === 'linux' && process.versions.bun === '1.3.11'

describe('Linux held pidfd retirement observation', () => {
  test.skipIf(!qualified)('a live owned process stays unretired; the same held descriptor observes its exit', async () => {
    const { dlopen, FFIType } = await import('bun:ffi')
    const api = dlopen('libc.so.6', {
      pidfd_open: { args: [FFIType.i32, FFIType.u32], returns: FFIType.i32 },
      close: { args: [FFIType.i32], returns: FFIType.i32 },
    })
    // The fixture self-exits even if the assertion fails; no numeric-PID kills.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 2000); process.stdin.resume(); process.stdin.on("end", () => process.exit(0))'],
      { stdio: ['pipe', 'ignore', 'ignore'], env: {} })
    const closed = new Promise<void>((resolve, reject) => { child.once('close', () => resolve()); child.once('error', reject) })
    let fd: number | undefined
    try {
      expect(child.pid).toBeDefined()
      fd = api.symbols.pidfd_open(child.pid!, 0)
      expect(fd).toBeGreaterThanOrEqual(0)
      expect(await linuxBirth(child.pid!)).not.toBeNull()
      expect(await linuxPidfdHasExited(fd)).toBe(false)
      child.stdin!.end()
      await closed
      expect(await linuxPidfdHasExited(fd)).toBe(true)
    } finally {
      try {
        child.stdin?.end()
        await closed.catch(() => undefined)
      } finally {
        try {
          if (fd !== undefined && fd >= 0) {
            const closing = fd; fd = undefined
            expect(api.symbols.close(closing)).toBe(0)
          }
        } finally { api.close() }
      }
    }
  })

  test.skipIf(!qualified)('readable non-pidfds remain UNKNOWN after a pidfd is closed', async () => {
    const { dlopen, FFIType } = await import('bun:ffi')
    const api = dlopen('libc.so.6', {
      pidfd_open: { args: [FFIType.i32, FFIType.u32], returns: FFIType.i32 },
      close: { args: [FFIType.i32], returns: FFIType.i32 },
    })
    let fd: number | undefined
    let readable: number | undefined
    try {
      const opened = api.symbols.pidfd_open(process.pid, 0)
      expect(opened).toBeGreaterThanOrEqual(0)
      fd = opened
      expect(await linuxPidfdHasExited(fd)).toBe(false)
      const closed = fd
      fd = undefined
      expect(api.symbols.close(closed)).toBe(0)
      readable = openSync('/dev/null', 'r')
      // Only inspect the descriptor we just opened; never overwrite a released slot.
      // openSync may naturally reuse the closed pidfd number.
      await expect(linuxPidfdHasExited(readable)).rejects.toThrow('cleanup_unknown')
    } finally {
      try {
        if (fd !== undefined) { const closing = fd; fd = undefined; expect(api.symbols.close(closing)).toBe(0) }
      } finally {
        try { if (readable !== undefined) { const closing = readable; readable = undefined; closeSync(closing) } }
        finally { api.close() }
      }
    }
  })

  test.skipIf(!qualified)('invalid and closed descriptors remain UNKNOWN', async () => {
    await expect(linuxPidfdHasExited(-1)).rejects.toThrow('cleanup_unknown')
    await expect(linuxPidfdHasExited(1_000_000_000)).rejects.toThrow('cleanup_unknown')
    const { dlopen, FFIType } = await import('bun:ffi')
    const api = dlopen('libc.so.6', {
      pidfd_open: { args: [FFIType.i32, FFIType.u32], returns: FFIType.i32 },
      close: { args: [FFIType.i32], returns: FFIType.i32 },
    })
    try {
      const fd = api.symbols.pidfd_open(process.pid, 0)
      expect(fd).toBeGreaterThanOrEqual(0)
      try { expect(await linuxPidfdHasExited(fd)).toBe(false) }
      finally { expect(api.symbols.close(fd)).toBe(0) }
      // The warmed helper observes the closed fd before yielding to other opens.
      const observation = linuxPidfdHasExited(fd)
      await expect(observation).rejects.toThrow('cleanup_unknown')
    } finally { api.close() }
  })
})
