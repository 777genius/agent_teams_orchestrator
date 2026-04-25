import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import { getCommandNameFromFile } from './loadPluginCommands.js'

describe('getCommandNameFromFile', () => {
  test('normalizes nested command namespaces across path separators', () => {
    const baseDir = join('C:\\plugin', 'commands')
    const filePath = join(baseDir, 'foo', 'bar.md')

    expect(getCommandNameFromFile(filePath, baseDir, 'plugin')).toBe(
      'plugin:foo:bar',
    )
  })

  test('normalizes nested skill namespaces across path separators', () => {
    const baseDir = join('C:\\plugin', 'skills')
    const filePath = join(baseDir, 'foo', 'bar', 'SKILL.md')

    expect(getCommandNameFromFile(filePath, baseDir, 'plugin')).toBe(
      'plugin:foo:bar',
    )
  })
})
