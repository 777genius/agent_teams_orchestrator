import { describe, expect, test } from 'bun:test'

import {
  evaluateOpenCodeAgentModelCompatibility,
  filterOpenCodeAgentModels,
  getOpenCodeModelInputModalities,
  selectOpenCodeDefaultAgentModel,
} from './OpenCodeAgentModelCompatibility.js'

import type { OpenCodeModelMetadata } from './types.js'

function metadata(id: string, raw: Record<string, unknown>): OpenCodeModelMetadata {
  return {
    id,
    cost: null,
    context: null,
    limits: null,
    free: false,
    raw,
  }
}

describe('OpenCode agent model compatibility', () => {
  test('rejects explicit image and video output models', () => {
    const image = metadata('xai/grok-imagine-image-quality', {
      capabilities: {
        toolcall: false,
        input: { text: true, image: true },
        output: { text: false, image: true },
      },
    })
    const video = metadata('example/video-generator', {
      modalities: { input: ['text'], output: ['video'] },
    })

    expect(evaluateOpenCodeAgentModelCompatibility(image.id, image).compatible).toBe(false)
    expect(evaluateOpenCodeAgentModelCompatibility(video.id, video).compatible).toBe(false)
  })

  test('rejects known Grok Imagine routes when verbose metadata is unavailable', () => {
    expect(
      evaluateOpenCodeAgentModelCompatibility('xai/grok-imagine-image-quality', null).compatible,
    ).toBe(false)
    expect(
      evaluateOpenCodeAgentModelCompatibility('xai/grok-imagine-1.0', null).compatible,
    ).toBe(false)
    expect(evaluateOpenCodeAgentModelCompatibility('xai/grok-4.3', null).compatible).toBe(true)
  })

  test('keeps unknown metadata and text tool-call models compatible', () => {
    const text = metadata('xai/grok-4.3', {
      capabilities: {
        toolcall: true,
        input: { text: true, image: true },
        output: { text: true, image: false },
      },
    })

    expect(evaluateOpenCodeAgentModelCompatibility(text.id, text)).toEqual({
      compatible: true,
      reason: null,
    })
    expect(evaluateOpenCodeAgentModelCompatibility('custom/unknown', null).compatible).toBe(true)
    expect(getOpenCodeModelInputModalities(text)).toEqual(['text', 'image'])
  })

  test('filters only models that can act as teammates', () => {
    const image = metadata('xai/grok-imagine-image', {
      modalities: { output: ['image'] },
    })
    expect(
      filterOpenCodeAgentModels(
        ['xai/grok-4.3', image.id, 'custom/unknown'],
        [image],
      ),
    ).toEqual(['xai/grok-4.3', 'custom/unknown'])
  })

  test('selects the preferred Default wherever it sits, else the first agent model', () => {
    expect(selectOpenCodeDefaultAgentModel(['openai/gpt-5.4', 'opencode/big-pickle']))
      .toBe('opencode/big-pickle')
    expect(selectOpenCodeDefaultAgentModel(['openai/gpt-5.4', 'xai/grok-4.3']))
      .toBe('openai/gpt-5.4')
    expect(selectOpenCodeDefaultAgentModel([])).toBeNull()
  })
})
