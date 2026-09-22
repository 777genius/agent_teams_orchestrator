import { describe, expect, it } from 'bun:test'

import { shouldEmitProcessBackedIdleNotification } from './teammateInit.js'

describe('shouldEmitProcessBackedIdleNotification', () => {
  it('emits when the teammate is active or not yet explicitly idle', () => {
    expect(
      shouldEmitProcessBackedIdleNotification(
        {
          name: 'team',
          createdAt: 0,
          leadAgentId: 'lead-id',
          members: [
            {
              agentId: 'alice-id',
              name: 'alice',
              joinedAt: 0,
              tmuxPaneId: '1',
              cwd: '/tmp',
              subscriptions: [],
            },
          ],
        },
        'alice',
      ),
    ).toBe(true)

    expect(
      shouldEmitProcessBackedIdleNotification(
        {
          name: 'team',
          createdAt: 0,
          leadAgentId: 'lead-id',
          members: [
            {
              agentId: 'alice-id',
              name: 'alice',
              joinedAt: 0,
              tmuxPaneId: '1',
              cwd: '/tmp',
              subscriptions: [],
              isActive: true,
            },
          ],
        },
        'alice',
      ),
    ).toBe(true)
  })

  it('suppresses duplicate idle notifications once the teammate is already idle', () => {
    expect(
      shouldEmitProcessBackedIdleNotification(
        {
          name: 'team',
          createdAt: 0,
          leadAgentId: 'lead-id',
          members: [
            {
              agentId: 'alice-id',
              name: 'alice',
              joinedAt: 0,
              tmuxPaneId: '1',
              cwd: '/tmp',
              subscriptions: [],
              isActive: false,
            },
          ],
        },
        'alice',
      ),
    ).toBe(false)
  })

  it('prefers tracked active state over stale disk idle state', () => {
    expect(
      shouldEmitProcessBackedIdleNotification(
        {
          name: 'team',
          createdAt: 0,
          leadAgentId: 'lead-id',
          members: [
            {
              agentId: 'alice-id',
              name: 'alice',
              joinedAt: 0,
              tmuxPaneId: '1',
              cwd: '/tmp',
              subscriptions: [],
              isActive: false,
            },
          ],
        },
        'alice',
        true,
      ),
    ).toBe(true)
  })
})
