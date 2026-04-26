import { describe, expect, test } from 'bun:test'

import { diagnosticUriToPath } from './DiagnosticsDisplay.js'

describe('diagnosticUriToPath', () => {
  test('decodes file URIs before rendering relative diagnostics paths', () => {
    const result = diagnosticUriToPath('file:///C:/Repo/My%20File.ts')

    expect(result).not.toContain('file://')
    expect(result).toContain('My File.ts')
  })

  test('decodes claude fs right file URIs with the same file URL parser', () => {
    const result = diagnosticUriToPath(
      '_claude_fs_right:file:///C:/Repo/My%20File.ts',
    )

    expect(result).not.toContain('_claude_fs_right:')
    expect(result).toContain('My File.ts')
  })
})
