import { describe, expect, it } from 'bun:test'

import {
  eagerParseCliFlag,
  eagerParseCliFlags,
  mergeJsonObjectCliFlagValues,
} from './cliArgs.js'

describe('cliArgs', () => {
  it('keeps eagerParseCliFlag compatible by returning the first value', () => {
    expect(
      eagerParseCliFlag('--settings', [
        'node',
        'cli',
        '--settings',
        '{"fastMode":false}',
        '--settings',
        '{"codex":{"forced_login_method":"chatgpt"}}',
      ]),
    ).toBe('{"fastMode":false}')
  })

  it('collects repeated flags in argv order', () => {
    expect(
      eagerParseCliFlags('--settings', [
        'node',
        'cli',
        '--settings',
        '{"fastMode":false}',
        '--settings={"codex":{"forced_login_method":"chatgpt"}}',
      ]),
    ).toEqual(['{"fastMode":false}', '{"codex":{"forced_login_method":"chatgpt"}}'])
  })

  it('merges repeated inline JSON object flag values deeply', () => {
    expect(
      mergeJsonObjectCliFlagValues([
        '{"fastMode":false}',
        '{"codex":{"forced_login_method":"api","existing":true}}',
        '{"codex":{"forced_login_method":"chatgpt"}}',
      ]),
    ).toBe('{"fastMode":false,"codex":{"forced_login_method":"chatgpt","existing":true}}')
  })

  it('falls back to the first value when any value is not a JSON object', () => {
    expect(mergeJsonObjectCliFlagValues(['/tmp/settings.json', '{"fastMode":false}'])).toBe(
      '/tmp/settings.json',
    )
  })
})
