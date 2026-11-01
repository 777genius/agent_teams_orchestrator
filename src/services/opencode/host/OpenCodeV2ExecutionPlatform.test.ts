import { expect, test } from 'bun:test'
import { assertExecutionPlatformAvailable, isExecutionPlatformAvailable } from './OpenCodeV2ExecutionPlatform.js'

test.each([['x64', true], ['arm64', true], ['ia32', false], ['arm', false]] as const)(
  'Windows %s execution availability keeps the native architecture boundary', (arch, available) => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    const archDescriptor = Object.getOwnPropertyDescriptor(process, 'arch')!
    try {
      Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' })
      Object.defineProperty(process, 'arch', { ...archDescriptor, value: arch })
      expect(isExecutionPlatformAvailable()).toBe(available)
      if (available) expect(assertExecutionPlatformAvailable).not.toThrow()
      else expect(assertExecutionPlatformAvailable).toThrow('execution_platform_unsupported')
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor)
      Object.defineProperty(process, 'arch', archDescriptor)
    }
  },
)
