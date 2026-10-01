import { afterEach, describe, expect, test } from 'bun:test'
import { getClientVersion } from './clientVersion.js'
import { computeFingerprintFromMessages } from './fingerprint.js'
import { gt } from './semver.js'
import { getClaudeCodeUserAgent } from './userAgent.js'

const originalMacro = Object.getOwnPropertyDescriptor(globalThis, 'MACRO')
const messages = [
  { type: 'user', message: { content: 'Client identity regression fixture' } },
] as Parameters<typeof computeFingerprintFromMessages>[0]

function setVersions(version: string, clientVersion?: string): void {
  Object.defineProperty(globalThis, 'MACRO', {
    configurable: true,
    writable: true,
    value: {
      VERSION: version,
      ...(clientVersion === undefined ? {} : { CLIENT_VERSION: clientVersion }),
      BUILD_TIME: '',
    },
  })
}

afterEach(() => {
  if (originalMacro) {
    Object.defineProperty(globalThis, 'MACRO', originalMacro)
  } else {
    Reflect.deleteProperty(globalThis, 'MACRO')
  }
})

describe('Anthropic client identity', () => {
  test('keeps request identity and fingerprint separate from updater ordering', () => {
    setVersions('2.1.251', '2.777.777')
    expect(getClaudeCodeUserAgent()).toBe('claude-code/2.777.777')
    // Fixed protocol vector, computed independently of the runtime implementation.
    expect(computeFingerprintFromMessages(messages)).toBe('7d1')
    expect(gt('2.1.252', MACRO.VERSION)).toBe(true)
    expect(gt('2.1.252', getClientVersion())).toBe(false)

    setVersions('2.1.252', '2.777.777')
    expect(getClaudeCodeUserAgent()).toBe('claude-code/2.777.777')
    expect(computeFingerprintFromMessages(messages)).toBe('7d1')
  })

  test('changes request identity and fingerprint together for development clients', () => {
    setVersions('2.1.251-dev', '2.777.777-dev')
    expect(getClaudeCodeUserAgent()).toBe('claude-code/2.777.777-dev')
    expect(computeFingerprintFromMessages(messages)).toBe('194')
  })

  test('supports existing source and SDK consumers without CLIENT_VERSION', () => {
    setVersions('2.1.251')
    expect(getClientVersion()).toBe('2.1.251')
    expect(getClaudeCodeUserAgent()).toBe('claude-code/2.1.251')
    expect(computeFingerprintFromMessages(messages)).toBe('569')
  })
})
