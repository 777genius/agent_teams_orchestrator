import { describe, expect, test } from 'bun:test'

import {
  collectOpenCodeInventoryCommandResults,
  getOpenCodeVerboseModelsArgs,
  isOpenCodeBuiltinFreeModelId,
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

  test('collects inventory commands sequentially to avoid OpenCode profile contention', async () => {
    const calls: string[] = []
    let active = 0
    let maxActive = 0

    const result = await collectOpenCodeInventoryCommandResults({
      mode: 'full',
      execOpenCode: async args => {
        active += 1
        maxActive = Math.max(maxActive, active)
        calls.push(args.join(' '))
        await Promise.resolve()
        active -= 1
        return {
          stdout: args.join(' '),
          stderr: '',
          code: 0,
        }
      },
    })

    expect(maxActive).toBe(1)
    expect(calls).toEqual([
      '--version',
      'providers list',
      'models --verbose',
      'agent list',
    ])
    expect(result.modelsResult.stdout).toBe('models --verbose')
    expect(result.agentsResult.stdout).toBe('agent list')
  })

  test('summary inventory skips model and agent commands', async () => {
    const calls: string[] = []

    const result = await collectOpenCodeInventoryCommandResults({
      mode: 'summary',
      execOpenCode: async args => {
        calls.push(args.join(' '))
        return {
          stdout: args.join(' '),
          stderr: '',
          code: 0,
        }
      },
    })

    expect(calls).toEqual([
      '--version',
      'providers list',
    ])
    expect(result.modelsResult.stdout).toBe('')
    expect(result.agentsResult.stdout).toBe('')
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
        [
          'openai/gpt-5.4',
          'openrouter/moonshotai/kimi-k2',
          'opencode/qwen3.6-plus-free',
          'llama.cpp/qwen3-coder:a3b Local model',
          'ollama/qwen2.5-coder:0.5b 12 GB',
          'lmstudio/google/gemma-3n-e4b ready',
        ].join('\n'),
      ),
    ).toEqual([
      'openai/gpt-5.4',
      'openrouter/moonshotai/kimi-k2',
      'opencode/qwen3.6-plus-free',
      'llama.cpp/qwen3-coder:a3b',
      'ollama/qwen2.5-coder:0.5b',
      'lmstudio/google/gemma-3n-e4b',
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
llama.cpp/qwen3-coder:a3b local
{
  "cost": {
    "input": 0,
    "output": 0
  },
  "limits": { "context": 32768 }
}
`)

    expect(parsed.models).toEqual([
      'opencode/big-pickle',
      'openai/gpt-5.4',
      'openrouter/openai/gpt-oss-20b:free',
      'llama.cpp/qwen3-coder:a3b',
    ])
    expect(parsed.modelMetadata[0]?.context).toBe(200000)
    expect(parsed.modelMetadata[0]?.limits).toEqual({ context: 200000 })
    expect(isOpenCodeBuiltinFreeModelId('opencode/big-pickle', parsed.modelMetadata)).toBe(true)
    expect(isOpenCodeBuiltinFreeModelId(' openai/gpt-5.4 ', parsed.modelMetadata)).toBe(false)
    expect(isOpenCodeModelFree('opencode/big-pickle', parsed.modelMetadata)).toBe(true)
    expect(isOpenCodeModelFree('openai/gpt-5.4', parsed.modelMetadata)).toBe(false)
    expect(isOpenCodeModelFree('openrouter/openai/gpt-oss-20b:free', parsed.modelMetadata)).toBe(
      true,
    )
    expect(parsed.modelMetadata.find(item => item.id === 'llama.cpp/qwen3-coder:a3b')?.context).toBe(32768)
    expect(isOpenCodeModelFree('opencode/qwen3.6-plus-free', [])).toBe(false)
  })
})
