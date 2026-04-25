import { describe, expect, test } from 'bun:test'

import { buildWindowsTaskkillArgs } from './sessionRunner.js'

describe('buildWindowsTaskkillArgs', () => {
  test('kills the whole Windows process tree by pid', () => {
    expect(buildWindowsTaskkillArgs(1234)).toEqual(['/T', '/PID', '1234'])
  })

  test('adds force flag for forced shutdown', () => {
    expect(buildWindowsTaskkillArgs(1234, true)).toEqual([
      '/T',
      '/F',
      '/PID',
      '1234',
    ])
  })
})
