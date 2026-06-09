import { describe, expect, test } from 'bun:test'

import {
  buildAnthropicCompatibleRuntimeModelCatalogFromApiModels,
  buildAnthropicRuntimeModelCatalogFromApiModels,
  createStaticAnthropicRuntimeModelCatalog,
  getAnthropicRuntimeReasoningEfforts,
  getAnthropicVisibleRuntimeModels,
} from './anthropicCatalog.js'

describe('anthropic runtime catalog', () => {
  test('normalizes live Anthropic models into the curated Agent Teams catalog', () => {
    const catalog = buildAnthropicRuntimeModelCatalogFromApiModels([
      {
        id: 'claude-opus-4-8',
        type: 'model',
        display_name: 'Claude Opus 4.8',
        max_input_tokens: 1_000_000,
        max_tokens: 128_000,
        capabilities: {
          effort: {
            supported: true,
            low: { supported: true },
            medium: { supported: true },
            high: { supported: true },
            max: { supported: true },
          },
          image_input: { supported: true },
        },
      },
      {
        id: 'claude-opus-4-7',
        type: 'model',
        display_name: 'Claude Opus 4.7',
        max_input_tokens: 1_000_000,
        max_tokens: 128_000,
        capabilities: {
          effort: {
            supported: true,
            low: { supported: true },
            medium: { supported: true },
            high: { supported: true },
            max: { supported: true },
          },
          image_input: { supported: true },
        },
      },
      {
        id: 'claude-opus-4-6',
        type: 'model',
        display_name: 'Claude Opus 4.6',
        max_input_tokens: 1_000_000,
        max_tokens: 128_000,
        capabilities: {
          effort: {
            supported: true,
            low: { supported: true },
            medium: { supported: true },
            high: { supported: true },
            max: { supported: true },
          },
          image_input: { supported: true },
        },
      },
      {
        id: 'claude-sonnet-4-6',
        type: 'model',
        display_name: 'Claude Sonnet 4.6',
        max_input_tokens: 1_000_000,
        max_tokens: 64_000,
        capabilities: {
          effort: {
            supported: true,
            low: { supported: true },
            medium: { supported: true },
            high: { supported: true },
          },
          image_input: { supported: true },
        },
      },
      {
        id: 'claude-haiku-4-5-20251001',
        type: 'model',
        display_name: 'Claude Haiku 4.5',
        max_input_tokens: 200_000,
        max_tokens: 64_000,
        capabilities: {
          image_input: { supported: true },
        },
      },
    ])

    expect(catalog.source).toBe('anthropic-models-api')
    expect(catalog.status).toBe('ready')
    expect(catalog.defaultLaunchModel).toBe('opus[1m]')
    expect(getAnthropicVisibleRuntimeModels(catalog)).toEqual([
      'opus',
      'claude-opus-4-6',
      'sonnet',
      'haiku',
    ])
    expect(getAnthropicRuntimeReasoningEfforts(catalog)).toEqual([
      'low',
      'medium',
      'high',
      'max',
    ])

    expect(
      catalog.models.find((model) => model.launchModel === 'opus'),
    ).toMatchObject({
      displayName: 'Opus 4.8',
      badgeLabel: 'Opus 4.8',
      hidden: false,
      supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
      defaultReasoningEffort: 'high',
      source: 'anthropic-models-api',
    })
    expect(
      catalog.models.find((model) => model.launchModel === 'opus[1m]'),
    ).toMatchObject({
      displayName: 'Opus 4.8 (1M)',
      hidden: true,
      supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
      defaultReasoningEffort: 'high',
      supportsFastMode: true,
      source: 'anthropic-models-api',
    })
    expect(
      catalog.models.find((model) => model.launchModel === 'claude-opus-4-8'),
    ).toMatchObject({
      displayName: 'Opus 4.8',
      hidden: true,
      supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
      defaultReasoningEffort: 'high',
      source: 'anthropic-models-api',
      badgeLabel: null,
    })
    expect(
      catalog.models.find((model) => model.launchModel === 'claude-opus-4-6'),
    ).toMatchObject({
      displayName: 'Opus 4.6',
      hidden: false,
      supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
      defaultReasoningEffort: 'high',
      supportsFastMode: false,
      source: 'anthropic-models-api',
    })
    expect(
      catalog.models.find((model) => model.launchModel === 'sonnet'),
    ).toMatchObject({
      displayName: 'Sonnet 4.6',
      hidden: false,
      supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
      defaultReasoningEffort: 'high',
      supportsFastMode: false,
      source: 'anthropic-models-api',
    })
    expect(
      catalog.models.find((model) => model.launchModel === 'haiku'),
    ).toMatchObject({
      displayName: 'Haiku 4.5',
      hidden: false,
      supportedReasoningEfforts: [],
      defaultReasoningEffort: null,
      supportsFastMode: false,
      source: 'anthropic-models-api',
    })
  })

  test('normalizes Anthropic-compatible models without requiring Claude model ids', () => {
    const catalog = buildAnthropicCompatibleRuntimeModelCatalogFromApiModels([
      {
        id: 'qwen3.6',
        object: 'model',
        display_name: 'Qwen 3.6',
        max_input_tokens: 128_000,
      },
      {
        id: 'glm-5:cloud',
        object: 'model',
        display_name: 'GLM 5 Cloud',
      },
    ])

    expect(catalog.source).toBe('anthropic-compatible-api')
    expect(catalog.status).toBe('ready')
    expect(catalog.defaultLaunchModel).toBe('qwen3.6')
    expect(getAnthropicVisibleRuntimeModels(catalog)).toEqual([
      'qwen3.6',
      'glm-5:cloud',
    ])
    expect(getAnthropicRuntimeReasoningEfforts(catalog)).toEqual([])
    expect(catalog.models[0]).toMatchObject({
      id: 'qwen3.6',
      launchModel: 'qwen3.6',
      displayName: 'Qwen 3.6',
      hidden: false,
      supportedReasoningEfforts: [],
      defaultReasoningEffort: null,
      supportsFastMode: false,
      inputModalities: ['text'],
      source: 'anthropic-compatible-api',
      badgeLabel: 'From gateway',
      metadata: {
        context: 128_000,
      },
    })
  })

  test('returns a static compatibility fallback catalog when live Anthropic data is unavailable', () => {
    const catalog = createStaticAnthropicRuntimeModelCatalog({
      status: 'stale',
      message: 'Using the static Anthropic compatibility catalog.',
      code: 'anthropic-auth-missing',
    })

    expect(catalog.source).toBe('static-fallback')
    expect(catalog.status).toBe('stale')
    expect(getAnthropicVisibleRuntimeModels(catalog)).toEqual([
      'opus',
      'claude-opus-4-6',
      'sonnet',
      'haiku',
    ])
    expect(getAnthropicRuntimeReasoningEfforts(catalog)).toEqual([
      'low',
      'medium',
      'high',
      'max',
    ])
    expect(
      catalog.models.find((model) => model.launchModel === 'opus'),
    ).toMatchObject({
      displayName: 'Opus 4.8',
      badgeLabel: 'Opus 4.8',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
      defaultReasoningEffort: 'high',
      source: 'static-fallback',
    })
    expect(
      catalog.models.find(
        (model) => model.launchModel === 'claude-sonnet-4-6[1m]',
      ),
    ).toMatchObject({
      hidden: true,
      supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
      defaultReasoningEffort: 'high',
      supportsFastMode: false,
      source: 'static-fallback',
    })
    expect(
      catalog.models.find((model) => model.launchModel === 'haiku'),
    ).toMatchObject({
      supportedReasoningEfforts: [],
      defaultReasoningEffort: null,
      source: 'static-fallback',
    })
  })
})
