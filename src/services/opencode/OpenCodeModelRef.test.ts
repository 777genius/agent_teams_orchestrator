import { describe, expect, test } from 'bun:test'

import {
  assertOpenCodeProviderScopedModelRef,
  formatOpenCodeModelRef,
  normalizeOpenCodeProviderId,
  OpenCodeInvalidProviderModelReferenceError,
  parseFirstOpenCodeModelToken,
  parseOpenCodeProviderScopedModelRef,
} from './OpenCodeModelRef.js'

describe('OpenCodeModelRef', () => {
  test('parses dotted providers and model ids with nested slashes', () => {
    expect(parseOpenCodeProviderScopedModelRef('llama.cpp/qwen3-coder:a3b')).toEqual({
      providerId: 'llama.cpp',
      modelId: 'qwen3-coder:a3b',
      raw: 'llama.cpp/qwen3-coder:a3b',
    })

    expect(parseOpenCodeProviderScopedModelRef('lmstudio/google/gemma-3n-e4b')).toEqual({
      providerId: 'lmstudio',
      modelId: 'google/gemma-3n-e4b',
      raw: 'lmstudio/google/gemma-3n-e4b',
    })
    expect(parseOpenCodeProviderScopedModelRef('lm-studio/google/gemma-3n-e4b')).toEqual({
      providerId: 'lmstudio',
      modelId: 'google/gemma-3n-e4b',
      raw: 'lmstudio/google/gemma-3n-e4b',
    })
  })

  test('reads the first whitespace token from OpenCode models output', () => {
    expect(parseFirstOpenCodeModelToken('llama.cpp/qwen3-coder:a3b local model')?.raw).toBe(
      'llama.cpp/qwen3-coder:a3b',
    )
    expect(parseFirstOpenCodeModelToken('lmstudio/google/gemma-3n-e4b ready')?.raw).toBe(
      'lmstudio/google/gemma-3n-e4b',
    )
  })

  test('rejects unscoped, whitespace, and invalid provider refs', () => {
    expect(parseOpenCodeProviderScopedModelRef('qwen3-coder:a3b')).toBeNull()
    expect(parseOpenCodeProviderScopedModelRef('llama.cpp/qwen test')).toBeNull()
    expect(parseOpenCodeProviderScopedModelRef('llama cpp/qwen3-coder:a3b')).toBeNull()
    expect(parseOpenCodeProviderScopedModelRef('/qwen3-coder:a3b')).toBeNull()
    expect(parseOpenCodeProviderScopedModelRef('llama.cpp/')).toBeNull()
    expect(parseOpenCodeProviderScopedModelRef('xai//grok')).toBeNull()
    expect(parseOpenCodeProviderScopedModelRef('xai/grok/')).toBeNull()
  })

  test('raises one typed deterministic error for invalid persisted references', () => {
    for (const value of [undefined, '', 'xai/', 'cursor-acp/', 'xai//grok', 'bad provider/model']) {
      expect(() => assertOpenCodeProviderScopedModelRef(value)).toThrow(
        OpenCodeInvalidProviderModelReferenceError,
      )
      try {
        assertOpenCodeProviderScopedModelRef(value)
      } catch (error) {
        expect(error).toMatchObject({
          name: 'OpenCodeInvalidProviderModelReferenceError',
          code: 'OPENCODE_INVALID_PROVIDER_MODEL_REFERENCE',
          message: 'OpenCode selected model must be a non-empty provider-scoped reference',
        })
      }
    }
  })

  test('normalizes provider ids without changing model ids', () => {
    expect(normalizeOpenCodeProviderId(' Llama.CPP ')).toBe('llama.cpp')
    expect(formatOpenCodeModelRef(' Llama.CPP ', ' qwen3-coder:a3b ')).toBe(
      'llama.cpp/qwen3-coder:a3b',
    )
  })
})
