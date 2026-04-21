import { describe, expect, test } from 'bun:test'

import {
  parseOpenCodeAgentListOutput,
  parseOpenCodeModelsOutput,
  parseOpenCodeProvidersOutput,
} from './OpenCodeInventoryService.js'

describe('OpenCodeInventoryService parsers', () => {
  test('parses provider credentials from boxed CLI output', () => {
    const output = `
┌  Credentials /tmp/opencode/auth.json
│
●  OpenAI oauth
│
└  1 credentials

┌  Environment
│
●  OpenAI OPENAI_API_KEY
│
└  1 environment variable
`

    const parsed = parseOpenCodeProvidersOutput(output)

    expect(parsed.authStorePath).toBe('/tmp/opencode/auth.json')
    expect(parsed.connectedProviders).toEqual([
      {
        id: 'openai',
        authHint: 'oauth',
        source: 'credentials',
      },
      {
        id: 'openai',
        authHint: 'openai_api_key',
        source: 'environment',
      },
    ])
  })

  test('parses model and agent output', () => {
    expect(
      parseOpenCodeModelsOutput('openai/gpt-5.4\nopencode/qwen3.6-plus-free\n'),
    ).toEqual(['openai/gpt-5.4', 'opencode/qwen3.6-plus-free'])

    expect(parseOpenCodeAgentListOutput('build (primary)\nexplore (subagent)\n')).toEqual([
      { id: 'build', mode: 'primary' },
      { id: 'explore', mode: 'subagent' },
    ])
  })
})
