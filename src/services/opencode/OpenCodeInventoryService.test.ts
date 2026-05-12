import { describe, expect, test } from 'bun:test'

import {
  getOpenCodeVerboseModelsArgs,
  parseOpenCodeAgentListOutput,
  isOpenCodeModelFree,
  parseOpenCodeModelsOutput,
  parseOpenCodeModelsVerboseOutput,
  parseOpenCodeProvidersOutput,
} from './OpenCodeInventoryService.js'

describe('OpenCodeInventoryService parsers', () => {
  test('queries the full OpenCode model inventory, not only the opencode provider', () => {
    expect(getOpenCodeVerboseModelsArgs()).toEqual(['models', '--verbose'])
  })

  test('parses provider credentials from boxed CLI output', () => {
    const output = `
┌  Credentials /tmp/opencode/auth.json
│
●  OpenAI oauth
│
●  OpenRouter api
│
●  Cloudflare Workers AI
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
        id: 'openrouter',
        authHint: 'api',
        source: 'credentials',
      },
      {
        id: 'cloudflare-workers-ai',
        authHint: null,
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
      parseOpenCodeModelsOutput(
        'openai/gpt-5.4\nopenrouter/moonshotai/kimi-k2\nopencode/qwen3.6-plus-free\n',
      ),
    ).toEqual([
      'openai/gpt-5.4',
      'openrouter/moonshotai/kimi-k2',
      'opencode/qwen3.6-plus-free',
    ])

    expect(parseOpenCodeAgentListOutput('build (primary)\nexplore (subagent)\n')).toEqual([
      { id: 'build', mode: 'primary' },
      { id: 'explore', mode: 'subagent' },
    ])
  })

  test('parses verbose model metadata and detects free cost', () => {
    const parsed = parseOpenCodeModelsVerboseOutput(`
opencode/big-pickle
{
  "cost": {
    "input": 0,
    "output": 0,
    "cache": { "read": 0, "write": 0 }
  },
  "limit": { "context": 200000 }
}
openai/gpt-5.4
{
  "cost": {
    "input": 0,
    "output": 0
  }
}
openrouter/openai/gpt-oss-20b:free
{
  "cost": {
    "input": 0,
    "output": 0
  }
}
`)

    expect(parsed.models).toEqual([
      'opencode/big-pickle',
      'openai/gpt-5.4',
      'openrouter/openai/gpt-oss-20b:free',
    ])
    expect(parsed.modelMetadata[0]?.context).toBe(200000)
    expect(parsed.modelMetadata[0]?.limits).toEqual({ context: 200000 })
    expect(isOpenCodeModelFree('opencode/big-pickle', parsed.modelMetadata)).toBe(true)
    expect(isOpenCodeModelFree('openai/gpt-5.4', parsed.modelMetadata)).toBe(false)
    expect(isOpenCodeModelFree('openrouter/openai/gpt-oss-20b:free', parsed.modelMetadata)).toBe(
      true,
    )
    expect(isOpenCodeModelFree('opencode/qwen3.6-plus-free', [])).toBe(false)
  })
})
