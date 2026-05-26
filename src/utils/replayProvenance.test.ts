import { describe, expect, test } from 'bun:test'

import {
  classifyUserTurnProvenance,
  hasNonHumanOrigin,
  isSyntheticQueuedCommandReplay,
  isSyntheticSDKUserReplay,
  protocolKindFromUserContent,
} from './replayProvenance.js'

describe('replayProvenance', () => {
  describe('hasNonHumanOrigin', () => {
    test('treats missing origin kind and explicit human origin as human-authored', () => {
      expect(hasNonHumanOrigin(undefined)).toBe(false)
      expect(hasNonHumanOrigin({})).toBe(false)
      expect(hasNonHumanOrigin({ kind: 'human' })).toBe(false)
    })

    test('treats task, coordinator, and channel origins as non-human', () => {
      expect(hasNonHumanOrigin({ kind: 'task-notification' })).toBe(true)
      expect(hasNonHumanOrigin({ kind: 'coordinator' })).toBe(true)
      expect(hasNonHumanOrigin({ kind: 'channel' })).toBe(true)
    })
  })

  describe('isSyntheticQueuedCommandReplay', () => {
    test('does not mark ordinary queued prompt replay as synthetic', () => {
      expect(isSyntheticQueuedCommandReplay({ commandMode: 'prompt' })).toBe(false)
    })

    test('does not mark explicit human-origin queued prompt replay as synthetic', () => {
      expect(
        isSyntheticQueuedCommandReplay({
          commandMode: 'prompt',
          origin: { kind: 'human' },
        }),
      ).toBe(false)
    })

    test('marks meta, task-notification, and non-human-origin queued replays as synthetic', () => {
      expect(isSyntheticQueuedCommandReplay({ isMeta: true })).toBe(true)
      expect(
        isSyntheticQueuedCommandReplay({ commandMode: 'task-notification' }),
      ).toBe(true)
      expect(isSyntheticQueuedCommandReplay({ mode: 'task-notification' })).toBe(
        true,
      )
      expect(
        isSyntheticQueuedCommandReplay({
          commandMode: 'prompt',
          origin: { kind: 'coordinator' },
        }),
      ).toBe(true)
    })
  })

  describe('classifyUserTurnProvenance', () => {
    test('treats replay alone as human-compatible', () => {
      expect(
        classifyUserTurnProvenance({
          type: 'user',
          isReplay: true,
          message: { content: 'Human: I tested the feature looks good' },
        }),
      ).toBe('human')
    })

    test('uses structured protocolKind before legacy text fallback', () => {
      expect(
        classifyUserTurnProvenance({
          type: 'user',
          protocolKind: 'teammate-message',
          message: { content: 'plain text payload' },
        }),
      ).toBe('teammate-protocol')
    })

    test('detects Human-prefixed legacy teammate protocol text', () => {
      expect(
        classifyUserTurnProvenance({
          type: 'user',
          message: {
            content:
              'Human: <teammate-message teammate_id="alice">looks good</teammate-message>',
          },
        }),
      ).toBe('teammate-protocol')
    })

    test('extracts protocol kind from raw protocol content for new emissions', () => {
      expect(
        protocolKindFromUserContent(
          'Human: <teammate-message teammate_id="alice">looks good</teammate-message>',
        ),
      ).toBe('teammate-message')
      expect(
        protocolKindFromUserContent([
          {
            type: 'text',
            text: '<tick>check for updates</tick>',
          },
        ]),
      ).toBe('tick')
    })

    test('preserves tool results and local command output as non-human payloads', () => {
      expect(
        classifyUserTurnProvenance({
          type: 'user',
          isSynthetic: true,
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-1',
                content: 'result',
              },
            ],
          },
        }),
      ).toBe('tool-result')

      expect(
        classifyUserTurnProvenance({
          type: 'user',
          isSynthetic: true,
          message: {
            content:
              '<local-command-stdout>Set model to sonnet</local-command-stdout>',
          },
        }),
      ).toBe('local-command-output')
    })
  })

  describe('isSyntheticSDKUserReplay', () => {
    test('hides synthetic or structured non-human text replays', () => {
      expect(isSyntheticSDKUserReplay({})).toBe(false)
      expect(isSyntheticSDKUserReplay({ isSynthetic: false })).toBe(false)
      expect(isSyntheticSDKUserReplay({ isSynthetic: true })).toBe(true)
      expect(
        isSyntheticSDKUserReplay({
          origin: { kind: 'coordinator' },
          message: {
            content: 'Human: queued coordination update',
          },
        }),
      ).toBe(true)
      expect(
        isSyntheticSDKUserReplay({
          protocolKind: 'teammate-message',
          message: {
            content:
              '<teammate-message teammate_id="alice">Looks good</teammate-message>',
          },
        }),
      ).toBe(true)
    })

    test('does not hide synthetic local command output replays', () => {
      expect(
        isSyntheticSDKUserReplay({
          isSynthetic: true,
          message: {
            content:
              '<local-command-stdout>Set model to sonnet</local-command-stdout>',
          },
        }),
      ).toBe(false)
      expect(
        isSyntheticSDKUserReplay({
          isSynthetic: true,
          message: {
            content: [
              {
                type: 'text',
                text: '<local-command-stderr>Command failed</local-command-stderr>',
              },
            ],
          },
        }),
      ).toBe(false)
    })

    test('does not hide synthetic tool-result replays', () => {
      expect(
        isSyntheticSDKUserReplay({
          isSynthetic: true,
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-1',
                content: 'result',
              },
            ],
          },
        }),
      ).toBe(false)
      expect(
        isSyntheticSDKUserReplay({
          isSynthetic: true,
          tool_use_result: { content: 'result' },
        }),
      ).toBe(false)
    })
  })
})
