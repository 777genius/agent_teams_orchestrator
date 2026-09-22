import { describe, expect, test } from 'bun:test'

import { sanitizePath } from './sessionStoragePortable.js'

describe('sanitizePath', () => {
  test('normalizes Windows drive path case and separators for storage keys', () => {
    expect(sanitizePath('C:/Users/Alice/Repo')).toBe(
      sanitizePath('c:\\users\\alice\\repo'),
    )
    expect(sanitizePath('C:/Users/Alice/Repo')).toBe('c--users-alice-repo')
  })

  test('matches UI fallback case for underscore and Cyrillic Windows project paths', () => {
    expect(sanitizePath('C:\\Users\\User\\PROJECT_IT\\сlaude_team')).toBe(
      'c--users-user-project-it--laude-team',
    )
  })

  test('preserves case for non-Windows path-like names', () => {
    expect(sanitizePath('/Users/Alice/Repo')).toBe('-Users-Alice-Repo')
  })
})
