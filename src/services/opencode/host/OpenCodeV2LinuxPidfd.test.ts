import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
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
      expect(await linuxBirth(child.pid!)).toBeNull()
    } finally {
      child.stdin?.end(); await closed
      if (fd !== undefined && fd >= 0) expect(api.symbols.close(fd)).toBe(0)
      api.close()
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
      expect(await linuxPidfdHasExited(fd)).toBe(false)
      expect(api.symbols.close(fd)).toBe(0)
      await expect(linuxPidfdHasExited(fd)).rejects.toThrow('cleanup_unknown')
    } finally { api.close() }
  })
})
