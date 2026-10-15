import { describe, expect, it } from 'bun:test'
import { resolveGenerationModelSetting } from './generation.js'
import { getDefaultOpusModel, getDefaultSonnetModel, getRuntimeMainLoopModel, parseUserSpecifiedModel } from './model.js'

describe('generation selection policy', () => {
  it('does not apply an ambient conditional alias to a different concrete member model', () => {
    for (const configuredModel of ['haiku', 'opusplan']) {
      for (const generationModel of ['claude-opus-5', 'claude-opus-5-5[1m]']) {
        for (const exceeds200kTokens of [false, true]) {
          expect(getRuntimeMainLoopModel({
            permissionMode: 'plan',
            mainLoopModel: generationModel,
            modelSetting: resolveGenerationModelSetting(generationModel, configuredModel),
            exceeds200kTokens,
          })).toBe(generationModel)
        }
      }
    }
  })

  it('preserves a concrete subagent model even when it equals the global alias target', () => {
    const generationModel = parseUserSpecifiedModel('haiku')
    expect(getRuntimeMainLoopModel({
      permissionMode: 'plan',
      mainLoopModel: generationModel,
      modelSetting: resolveGenerationModelSetting(generationModel, 'haiku', true),
    })).toBe(generationModel)
  })

  it('preserves conditional plan aliases when they produced the generation model', () => {
    for (const configuredModel of ['haiku', 'opusplan']) {
      const generationModel = parseUserSpecifiedModel(configuredModel)
      expect(getRuntimeMainLoopModel({
        permissionMode: 'plan',
        mainLoopModel: generationModel,
        modelSetting: resolveGenerationModelSetting(generationModel, configuredModel),
        exceeds200kTokens: false,
      })).toBe(configuredModel === 'haiku' ? getDefaultSonnetModel() : getDefaultOpusModel())
      expect(getRuntimeMainLoopModel({
        permissionMode: 'default',
        mainLoopModel: generationModel,
        modelSetting: resolveGenerationModelSetting(generationModel, configuredModel),
      })).toBe(generationModel)
    }
  })
})
