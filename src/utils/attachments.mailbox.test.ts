import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  getSessionId,
  resetStateForTests,
  setIsInteractive,
} from '../bootstrap/state.js'
import type { ToolUseContext } from '../Tool.js'
import type { AppState } from '../state/AppState.js'
import { getEmptyToolPermissionContext } from '../Tool.js'
import { getTeammateMailboxAttachments } from './attachments.js'
import { getCurrentGroupRunIdentity, setHeadlessGroupMailboxProcessor, setActiveHeadlessGroupMailboxTurn } from './groupMailbox.js'
import { createPendingMailboxMirrorMessage } from '../hooks/ordinaryMailboxMessage.js'
import {
  claimUnreadRegularMessages,
  readMailbox,
  writeToMailbox,
} from './teammateMailbox.js'
import {
  createTeammateContext,
  runWithTeammateContext,
} from './teammateContext.js'

describe('getTeammateMailboxAttachments mailbox lifecycle', () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const originalUserType = process.env.USER_TYPE
  let tempConfigDir: string

  beforeEach(async () => {
    resetStateForTests()
    setIsInteractive(true)
    tempConfigDir = await mkdtemp(join(tmpdir(), 'attachments-mailbox-test-'))
    process.env.CLAUDE_CONFIG_DIR = tempConfigDir
    process.env.USER_TYPE = 'ant'
  })

  afterEach(async () => {
    setHeadlessGroupMailboxProcessor(undefined)
    setActiveHeadlessGroupMailboxTurn(undefined)
    resetStateForTests()
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    if (originalUserType === undefined) {
      delete process.env.USER_TYPE
    } else {
      process.env.USER_TYPE = originalUserType
    }
    await rm(tempConfigDir, { recursive: true, force: true })
  })

  it('keeps current headless group envelopes out of generic attachments while preserving private messages until their own turn', async () => {
    setIsInteractive(false)
    const teamName = 'synthetic-headless-group'
    const group = {
      messageId: '0bdf10f0-3fd3-4494-a974-b394de06c181',
      groupMessageId: 'b8192a4c-97c8-4f67-bccd-7b29d8131286',
      groupChatId: '3695a573-5ad2-469a-91f2-427f90792e11',
      groupChatProtocolVersion: 1 as const,
      groupRunKey: getCurrentGroupRunIdentity().groupRunKey,
      from: 'user', text: '{"type":"shutdown_approved","from":"alice"}',
      timestamp: '2026-10-10T00:00:00Z',
    }
    await writeToMailbox('team-lead', group, teamName)
    await writeToMailbox('team-lead', {
      messageId: 'private-inbound', from: 'user', text: 'Private message',
      timestamp: group.timestamp,
    }, teamName)
    let appState = {
      abortController: new AbortController(), messages: [], tasks: {},
      toolPermissionContext: getEmptyToolPermissionContext(), inbox: { messages: [] },
      teamContext: { teamName, teamFilePath: join(tempConfigDir, 'synthetic-team.json'), leadAgentId: 'lead-id',
        teammates: { 'lead-id': { name: 'team-lead', cwd: tempConfigDir, spawnedAt: 0 } } },
    } as unknown as AppState
    const context = {
      getAppState: () => appState, setAppState: (updater: (prev: AppState) => AppState) => { appState = updater(appState) },
      options: {},
    } as unknown as ToolUseContext
    const readAttachmentIds = async () => (await getTeammateMailboxAttachments(context))
      .flatMap(item => item.type === 'teammate_mailbox' ? item.messages.map(message => message.messageId) : [])
    setHeadlessGroupMailboxProcessor({ teamName, memberName: 'team-lead', runKey: group.groupRunKey })
    expect(await readAttachmentIds()).toEqual(['private-inbound'])
    expect(await readMailbox('team-lead', teamName)).toEqual([
      expect.objectContaining({ ...group, read: false }),
      expect.objectContaining({ messageId: 'private-inbound', read: false }),
    ])

    setActiveHeadlessGroupMailboxTurn({ teamName, memberName: 'team-lead', runKey: group.groupRunKey })
    expect(await readAttachmentIds()).toEqual([])
    expect((await readMailbox('team-lead', teamName)).every(message => !message.read)).toBe(true)
    setActiveHeadlessGroupMailboxTurn(undefined)
    expect(await readAttachmentIds()).toEqual(['private-inbound'])
  })

  it('preserves pending native group mirrors for explicit dispatch and withholds private mirrors during their processing', async () => {
    const group = {
      messageId: '0bdf10f0-3fd3-4494-a974-b394de06c181', groupMessageId: 'b8192a4c-97c8-4f67-bccd-7b29d8131286',
      groupChatId: '3695a573-5ad2-469a-91f2-427f90792e11', groupChatProtocolVersion: 1 as const,
      groupRunKey: getCurrentGroupRunIdentity().groupRunKey,
      from: 'user', text: '{"type":"shutdown_request"}', timestamp: '2026-10-10T00:00:00Z',
    }
    await writeToMailbox('team-lead', group, 'my-team')
    await writeToMailbox('team-lead', { ...group, messageId: '99a81b23-25c5-4b8c-a53e-a3cf4942507b', groupRunKey: 'old-run:123' }, 'my-team')
    const sessionId = getSessionId()
    const claimed = await claimUnreadRegularMessages('team-lead', sessionId, 'my-team')
    let appState = {
      abortController: new AbortController(), messages: [], tasks: {}, toolPermissionContext: getEmptyToolPermissionContext(),
      inbox: { messages: claimed.map(message => createPendingMailboxMirrorMessage(message, sessionId)) },
      teamContext: { teamName: 'my-team', teamFilePath: '/tmp/synthetic-team.json', leadAgentId: 'lead-id',
        teammates: { 'lead-id': { name: 'team-lead', cwd: '/tmp', spawnedAt: 0 } } },
    } as unknown as AppState
    const context = {
      getAppState: () => appState, setAppState: (updater: (prev: AppState) => AppState) => { appState = updater(appState) }, options: {},
    } as unknown as ToolUseContext
    const readAttachmentIds = async () => (await getTeammateMailboxAttachments(context))
      .flatMap(item => item.type === 'teammate_mailbox' ? item.messages.map(message => message.messageId) : [])
    expect(await readAttachmentIds()).toEqual([])
    expect(appState.inbox.messages.filter(message => message.groupChatId).every(message => message.status === 'pending')).toBe(true)
    appState = { ...appState, inbox: { messages: appState.inbox.messages.map(message =>
      message.messageId === group.messageId ? { ...message, status: 'processing' as const } :
      message.messageId === 'private-native' ? { ...message, status: 'pending' as const } : message,
    ) } }
    await writeToMailbox('team-lead', {
      messageId: 'private-native', from: 'user', text: 'Private native message', timestamp: group.timestamp,
    }, 'my-team')
    const privateRow = (await claimUnreadRegularMessages('team-lead', sessionId, 'my-team'))
      .find(message => message.messageId === 'private-native')!
    appState = { ...appState, inbox: { messages: [...appState.inbox.messages, createPendingMailboxMirrorMessage(privateRow, sessionId)] } }
    expect(await readAttachmentIds()).toEqual([])
    expect((await readMailbox('team-lead', 'my-team')).find(message => message.messageId === 'private-native')?.read).toBe(false)
    expect(appState.inbox.messages.find(message => message.messageId === 'private-native')?.status).toBe('pending')

    // The leader's mirror belongs only to its own live inbox. An unrelated
    // in-process teammate must still receive private/protocol file messages.
    await writeToMailbox('bob', { messageId: 'bob-private', from: 'user', text: 'Bob private input', timestamp: group.timestamp }, 'my-team')
    await writeToMailbox('bob', { messageId: 'bob-protocol', from: 'team-lead', text: '{"type":"permission_response","request_id":"synthetic","approved":true}', timestamp: group.timestamp }, 'my-team')
    const bobAttachments = await runWithTeammateContext(createTeammateContext({
      agentId: 'bob@my-team', agentName: 'bob', teamName: 'my-team',
      planModeRequired: false, parentSessionId: sessionId, abortController: new AbortController(),
    }), () => getTeammateMailboxAttachments(context))
    expect(bobAttachments.flatMap(item => item.type === 'teammate_mailbox' ? item.messages.map(message => message.messageId) : []))
      .toEqual(['bob-private', 'bob-protocol'])

    appState = { ...appState, inbox: { messages: appState.inbox.messages.map(message =>
      message.messageId === group.messageId ? { ...message, status: 'processed' as const } : message,
    ) } }
    expect(await readAttachmentIds()).toEqual(['private-native'])

  })

  it('moves a claimed regular teammate message through app-state processing and exact finalize', async () => {
    await writeToMailbox(
      'team-lead',
      {
        from: 'alice',
        text: 'integration-regular-message',
        timestamp: '2026-01-08T00:00:00.000Z',
      },
      'my-team',
    )

    const sessionId = getSessionId()
    const [claimed] = await claimUnreadRegularMessages(
      'team-lead',
      sessionId,
      'my-team',
      {
        now: '2026-01-08T00:00:10.000Z',
      },
    )

    let appState = {
      abortController: new AbortController(),
      messages: [],
      tasks: {},
      toolPermissionContext: getEmptyToolPermissionContext(),
      inbox: {
        messages: [
          {
            id: 'pending-1',
            messageId: claimed.messageId,
            mailboxClaimedBySessionId: sessionId,
            from: claimed.from,
            text: claimed.text,
            timestamp: claimed.timestamp,
            status: 'pending' as const,
            color: claimed.color,
            summary: claimed.summary,
          },
        ],
      },
      teamContext: {
        teamName: 'my-team',
        teamFilePath: '/tmp/my-team.json',
        leadAgentId: 'lead-id',
        teammates: {
          'lead-id': {
            name: 'team-lead',
            tmuxSessionName: 's',
            tmuxPaneId: 'p',
            cwd: '/tmp',
            spawnedAt: 0,
          },
        },
      },
    } as unknown as AppState

    const toolUseContext = {
      options: {
        commands: [],
        debug: false,
        mainLoopModel: 'test-model',
        tools: [],
        verbose: false,
        thinkingConfig: { type: 'disabled' as const },
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: false,
        agentDefinitions: { definitions: [], errors: [] },
      },
      abortController: new AbortController(),
      readFileState: new Map(),
      getAppState: () => appState,
      setAppState: (updater: (prev: AppState) => AppState) => {
        appState = updater(appState)
      },
    } as unknown as ToolUseContext

    const attachments = await getTeammateMailboxAttachments(toolUseContext)

    expect(attachments).toHaveLength(1)
    expect(attachments[0]).toMatchObject({
      type: 'teammate_mailbox',
      messages: [
        expect.objectContaining({
          messageId: claimed.messageId,
          from: 'alice',
          text: 'integration-regular-message',
        }),
      ],
    })

    expect(appState.inbox.messages).toEqual([
      expect.objectContaining({
        id: 'pending-1',
        messageId: claimed.messageId,
        status: 'processed',
      }),
    ])

    const [mailboxRow] = await readMailbox('team-lead', 'my-team')
    expect(mailboxRow).toMatchObject({
      messageId: claimed.messageId,
      read: true,
    })
    expect(mailboxRow).not.toHaveProperty('claimedBySessionId')
    expect(mailboxRow).not.toHaveProperty('claimedAt')
  })

  it('keeps work-sync nudges out of live attachments so poller proof owns finalize', async () => {
    await writeToMailbox(
      'team-lead',
      {
        from: 'work-sync',
        text: 'member work-sync nudge requiring member_work_sync_report',
        timestamp: '2026-01-08T00:00:30.000Z',
        messageKind: 'member_work_sync_nudge',
      },
      'my-team',
    )

    const sessionId = getSessionId()
    const [claimed] = await claimUnreadRegularMessages(
      'team-lead',
      sessionId,
      'my-team',
      {
        now: '2026-01-08T00:00:40.000Z',
      },
    )

    let appState = {
      abortController: new AbortController(),
      messages: [],
      tasks: {},
      toolPermissionContext: getEmptyToolPermissionContext(),
      inbox: {
        messages: [
          {
            id: 'pending-work-sync-1',
            messageId: claimed.messageId,
            messageKind: 'member_work_sync_nudge',
            mailboxClaimedBySessionId: sessionId,
            from: claimed.from,
            text: claimed.text,
            timestamp: claimed.timestamp,
            status: 'pending' as const,
            color: claimed.color,
            summary: claimed.summary,
          },
        ],
      },
      teamContext: {
        teamName: 'my-team',
        teamFilePath: '/tmp/my-team.json',
        leadAgentId: 'lead-id',
        teammates: {
          'lead-id': {
            name: 'team-lead',
            tmuxSessionName: 's',
            tmuxPaneId: 'p',
            cwd: '/tmp',
            spawnedAt: 0,
          },
        },
      },
    } as unknown as AppState

    const toolUseContext = {
      options: {
        commands: [],
        debug: false,
        mainLoopModel: 'test-model',
        tools: [],
        verbose: false,
        thinkingConfig: { type: 'disabled' as const },
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: false,
        agentDefinitions: { definitions: [], errors: [] },
      },
      abortController: new AbortController(),
      readFileState: new Map(),
      getAppState: () => appState,
      setAppState: (updater: (prev: AppState) => AppState) => {
        appState = updater(appState)
      },
    } as unknown as ToolUseContext

    const attachments = await getTeammateMailboxAttachments(toolUseContext)

    expect(attachments).toEqual([])
    expect(appState.inbox.messages).toEqual([
      expect.objectContaining({
        id: 'pending-work-sync-1',
        messageId: claimed.messageId,
        messageKind: 'member_work_sync_nudge',
        status: 'pending',
      }),
    ])

    const [mailboxRow] = await readMailbox('team-lead', 'my-team')
    expect(mailboxRow).toMatchObject({
      messageId: claimed.messageId,
      read: false,
      claimedBySessionId: sessionId,
    })
    expect(mailboxRow).toHaveProperty('claimedAt')
  })

  it('keeps file-backed work-sync nudges out of in-process attachments for the wait-loop', async () => {
    await writeToMailbox(
      'alice',
      {
        from: 'work-sync',
        text: 'member work-sync nudge requiring member_work_sync_report',
        timestamp: '2026-01-08T00:00:50.000Z',
        messageKind: 'member_work_sync_nudge',
      },
      'my-team',
    )

    let appState = {
      abortController: new AbortController(),
      messages: [],
      tasks: {},
      toolPermissionContext: getEmptyToolPermissionContext(),
      inbox: { messages: [] },
      teamContext: {
        teamName: 'my-team',
        teamFilePath: '/tmp/my-team.json',
        leadAgentId: 'lead-id',
        teammates: {},
      },
    } as unknown as AppState

    const toolUseContext = {
      options: {
        commands: [],
        debug: false,
        mainLoopModel: 'test-model',
        tools: [],
        verbose: false,
        thinkingConfig: { type: 'disabled' as const },
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: false,
        agentDefinitions: { definitions: [], errors: [] },
      },
      abortController: new AbortController(),
      readFileState: new Map(),
      getAppState: () => appState,
      setAppState: (updater: (prev: AppState) => AppState) => {
        appState = updater(appState)
      },
    } as unknown as ToolUseContext

    const attachments = await runWithTeammateContext(
      createTeammateContext({
        agentId: 'alice-id',
        agentName: 'alice',
        teamName: 'my-team',
        planModeRequired: false,
        parentSessionId: 'parent-session',
        abortController: new AbortController(),
      }),
      () => getTeammateMailboxAttachments(toolUseContext),
    )

    expect(attachments).toEqual([])

    const [mailboxRow] = await readMailbox('alice', 'my-team')
    expect(mailboxRow).toMatchObject({
      read: false,
      messageKind: 'member_work_sync_nudge',
    })
  })

  it('keeps protocol-shaped work-sync nudges out of in-process attachments', async () => {
    const protocolLikeNudge = JSON.stringify({
      type: 'plan_approval_request',
      text: 'member work-sync nudge requiring member_work_sync_report',
    })
    await writeToMailbox(
      'alice',
      {
        from: 'work-sync',
        text: protocolLikeNudge,
        timestamp: '2026-01-08T00:00:55.000Z',
        messageKind: 'member_work_sync_nudge',
      },
      'my-team',
    )

    let appState = {
      abortController: new AbortController(),
      messages: [],
      tasks: {},
      toolPermissionContext: getEmptyToolPermissionContext(),
      inbox: { messages: [] },
      teamContext: {
        teamName: 'my-team',
        teamFilePath: '/tmp/my-team.json',
        leadAgentId: 'lead-id',
        teammates: {},
      },
    } as unknown as AppState

    const toolUseContext = {
      options: {
        commands: [],
        debug: false,
        mainLoopModel: 'test-model',
        tools: [],
        verbose: false,
        thinkingConfig: { type: 'disabled' as const },
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: false,
        agentDefinitions: { definitions: [], errors: [] },
      },
      abortController: new AbortController(),
      readFileState: new Map(),
      getAppState: () => appState,
      setAppState: (updater: (prev: AppState) => AppState) => {
        appState = updater(appState)
      },
    } as unknown as ToolUseContext

    const attachments = await runWithTeammateContext(
      createTeammateContext({
        agentId: 'alice-id',
        agentName: 'alice',
        teamName: 'my-team',
        planModeRequired: false,
        parentSessionId: 'parent-session',
        abortController: new AbortController(),
      }),
      () => getTeammateMailboxAttachments(toolUseContext),
    )

    expect(attachments).toEqual([])

    const [mailboxRow] = await readMailbox('alice', 'my-team')
    expect(mailboxRow).toMatchObject({
      read: false,
      messageKind: 'member_work_sync_nudge',
      text: protocolLikeNudge,
    })
  })

  it('silently finalizes claimed idle notifications without exposing them to the model', async () => {
    const idleNotification = JSON.stringify({
      type: 'idle_notification',
      from: 'alice',
      timestamp: '2026-01-08T00:01:00.000Z',
      idleReason: 'available',
    })

    await writeToMailbox(
      'team-lead',
      {
        from: 'alice',
        text: idleNotification,
        timestamp: '2026-01-08T00:01:00.000Z',
      },
      'my-team',
    )

    const sessionId = getSessionId()
    const [claimed] = await claimUnreadRegularMessages(
      'team-lead',
      sessionId,
      'my-team',
      {
        now: '2026-01-08T00:01:10.000Z',
      },
    )

    let appState = {
      abortController: new AbortController(),
      messages: [],
      tasks: {},
      toolPermissionContext: getEmptyToolPermissionContext(),
      inbox: {
        messages: [
          {
            id: 'pending-idle-1',
            messageId: claimed.messageId,
            mailboxClaimedBySessionId: sessionId,
            from: claimed.from,
            text: claimed.text,
            timestamp: claimed.timestamp,
            status: 'pending' as const,
            color: claimed.color,
            summary: claimed.summary,
          },
        ],
      },
      teamContext: {
        teamName: 'my-team',
        teamFilePath: '/tmp/my-team.json',
        leadAgentId: 'lead-id',
        teammates: {
          'lead-id': {
            name: 'team-lead',
            tmuxSessionName: 's',
            tmuxPaneId: 'p',
            cwd: '/tmp',
            spawnedAt: 0,
          },
        },
      },
    } as unknown as AppState

    const toolUseContext = {
      options: {
        commands: [],
        debug: false,
        mainLoopModel: 'test-model',
        tools: [],
        verbose: false,
        thinkingConfig: { type: 'disabled' as const },
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: false,
        agentDefinitions: { definitions: [], errors: [] },
      },
      abortController: new AbortController(),
      readFileState: new Map(),
      getAppState: () => appState,
      setAppState: (updater: (prev: AppState) => AppState) => {
        appState = updater(appState)
      },
    } as unknown as ToolUseContext

    const attachments = await getTeammateMailboxAttachments(toolUseContext)

    expect(attachments).toEqual([])
    expect(appState.inbox.messages).toEqual([
      expect.objectContaining({
        id: 'pending-idle-1',
        messageId: claimed.messageId,
        status: 'processed',
      }),
    ])

    const [mailboxRow] = await readMailbox('team-lead', 'my-team')
    expect(mailboxRow).toMatchObject({
      messageId: claimed.messageId,
      read: true,
    })
    expect(mailboxRow).not.toHaveProperty('claimedBySessionId')
    expect(mailboxRow).not.toHaveProperty('claimedAt')
  })

  it('keeps heartbeat peer summaries out of the model path while exact-finalizing them on disk', async () => {
    const idleWithSummaryNotification = JSON.stringify({
      type: 'idle_notification',
      from: 'alice',
      timestamp: '2026-01-08T00:01:30.000Z',
      idleReason: 'available',
      summary: '[to bob] aligned on rollout order',
    })

    await writeToMailbox(
      'team-lead',
      {
        from: 'alice',
        text: idleWithSummaryNotification,
        timestamp: '2026-01-08T00:01:30.000Z',
      },
      'my-team',
    )

    const sessionId = getSessionId()
    const [claimed] = await claimUnreadRegularMessages(
      'team-lead',
      sessionId,
      'my-team',
      {
        now: '2026-01-08T00:01:40.000Z',
      },
    )

    let appState = {
      abortController: new AbortController(),
      messages: [],
      tasks: {},
      toolPermissionContext: getEmptyToolPermissionContext(),
      inbox: {
        messages: [
          {
            id: 'pending-idle-summary-1',
            messageId: claimed.messageId,
            mailboxClaimedBySessionId: sessionId,
            from: claimed.from,
            text: claimed.text,
            timestamp: claimed.timestamp,
            status: 'pending' as const,
            color: claimed.color,
            summary: claimed.summary,
          },
        ],
      },
      teamContext: {
        teamName: 'my-team',
        teamFilePath: '/tmp/my-team.json',
        leadAgentId: 'lead-id',
        teammates: {
          'lead-id': {
            name: 'team-lead',
            tmuxSessionName: 's',
            tmuxPaneId: 'p',
            cwd: '/tmp',
            spawnedAt: 0,
          },
        },
      },
    } as unknown as AppState

    const toolUseContext = {
      options: {
        commands: [],
        debug: false,
        mainLoopModel: 'test-model',
        tools: [],
        verbose: false,
        thinkingConfig: { type: 'disabled' as const },
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: false,
        agentDefinitions: { definitions: [], errors: [] },
      },
      abortController: new AbortController(),
      readFileState: new Map(),
      getAppState: () => appState,
      setAppState: (updater: (prev: AppState) => AppState) => {
        appState = updater(appState)
      },
    } as unknown as ToolUseContext

    const attachments = await getTeammateMailboxAttachments(toolUseContext)

    expect(attachments).toEqual([])
    expect(appState.inbox.messages).toEqual([
      expect.objectContaining({
        id: 'pending-idle-summary-1',
        messageId: claimed.messageId,
        status: 'processed',
      }),
    ])

    const [mailboxRow] = await readMailbox('team-lead', 'my-team')
    expect(mailboxRow).toMatchObject({
      messageId: claimed.messageId,
      read: true,
    })
    expect(mailboxRow).not.toHaveProperty('claimedBySessionId')
    expect(mailboxRow).not.toHaveProperty('claimedAt')
  })

  it('keeps failed idle notifications visible to the live owner path', async () => {
    const failedIdleNotification = JSON.stringify({
      type: 'idle_notification',
      from: 'alice',
      timestamp: '2026-01-08T00:02:00.000Z',
      idleReason: 'failed',
      completedStatus: 'failed',
      failureReason: 'teammate crashed',
    })

    await writeToMailbox(
      'team-lead',
      {
        from: 'alice',
        text: failedIdleNotification,
        timestamp: '2026-01-08T00:02:00.000Z',
      },
      'my-team',
    )

    const sessionId = getSessionId()
    const [claimed] = await claimUnreadRegularMessages(
      'team-lead',
      sessionId,
      'my-team',
      {
        now: '2026-01-08T00:02:10.000Z',
      },
    )

    let appState = {
      abortController: new AbortController(),
      messages: [],
      tasks: {},
      toolPermissionContext: getEmptyToolPermissionContext(),
      inbox: {
        messages: [
          {
            id: 'pending-failed-idle-1',
            messageId: claimed.messageId,
            mailboxClaimedBySessionId: sessionId,
            from: claimed.from,
            text: claimed.text,
            timestamp: claimed.timestamp,
            status: 'pending' as const,
            color: claimed.color,
            summary: claimed.summary,
          },
        ],
      },
      teamContext: {
        teamName: 'my-team',
        teamFilePath: '/tmp/my-team.json',
        leadAgentId: 'lead-id',
        teammates: {
          'lead-id': {
            name: 'team-lead',
            tmuxSessionName: 's',
            tmuxPaneId: 'p',
            cwd: '/tmp',
            spawnedAt: 0,
          },
        },
      },
    } as unknown as AppState

    const toolUseContext = {
      options: {
        commands: [],
        debug: false,
        mainLoopModel: 'test-model',
        tools: [],
        verbose: false,
        thinkingConfig: { type: 'disabled' as const },
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: false,
        agentDefinitions: { definitions: [], errors: [] },
      },
      abortController: new AbortController(),
      readFileState: new Map(),
      getAppState: () => appState,
      setAppState: (updater: (prev: AppState) => AppState) => {
        appState = updater(appState)
      },
    } as unknown as ToolUseContext

    const attachments = await getTeammateMailboxAttachments(toolUseContext)

    expect(attachments).toHaveLength(1)
    expect(attachments[0]).toMatchObject({
      type: 'teammate_mailbox',
      messages: [
        expect.objectContaining({
          messageId: claimed.messageId,
          text: failedIdleNotification,
        }),
      ],
    })

    expect(appState.inbox.messages).toEqual([
      expect.objectContaining({
        id: 'pending-failed-idle-1',
        messageId: claimed.messageId,
        status: 'processed',
      }),
    ])

    const [mailboxRow] = await readMailbox('team-lead', 'my-team')
    expect(mailboxRow).toMatchObject({
      messageId: claimed.messageId,
      read: true,
    })
    expect(mailboxRow).not.toHaveProperty('claimedBySessionId')
    expect(mailboxRow).not.toHaveProperty('claimedAt')
  })

  it('excludes native attachment rows from raw and live text drains without consuming them', async () => {
    const nativeRow = {
      messageId: 'native-attachment-row-1',
      from: 'user',
      text: 'Structured native attachment',
      timestamp: '2026-10-11T00:00:00Z',
      attachments: [{
        id: 'attachment-1',
        filename: 'image.png',
        mimeType: 'image/png',
        size: 3,
        filePath: '/app/attachments/team-a/native-attachment-row-1/attachment-1--image.png',
        sha256: 'a'.repeat(64),
      }],
      nativeAttachmentDelivery: {
        version: 1 as const,
        recipientRuntimeInstanceId: 'runtime-1',
      },
    }
    setIsInteractive(false)
    await writeToMailbox('team-lead', nativeRow, 'my-team')
    await writeToMailbox('team-lead', {
      messageId: 'plain-row-1',
      from: 'user',
      text: 'Plain remains drainable',
      timestamp: '2026-10-11T00:00:01Z',
    }, 'my-team')

    let appState = {
      abortController: new AbortController(),
      messages: [],
      tasks: {},
      toolPermissionContext: getEmptyToolPermissionContext(),
      inbox: { messages: [] },
      teamContext: {
        teamName: 'my-team',
        teamFilePath: join(tempConfigDir, 'my-team.json'),
        leadAgentId: 'lead-id',
        teammates: { 'lead-id': { name: 'team-lead', cwd: tempConfigDir, spawnedAt: 0 } },
      },
    } as unknown as AppState
    const context = {
      getAppState: () => appState,
      setAppState: (updater: (prev: AppState) => AppState) => {
        appState = updater(appState)
      },
      options: {},
    } as unknown as ToolUseContext
    const rawAttachments = await getTeammateMailboxAttachments(context)
    expect(rawAttachments.flatMap(item =>
      item.type === 'teammate_mailbox' ? item.messages.map(message => message.messageId) : [],
    )).toEqual(['plain-row-1'])
    expect((await readMailbox('team-lead', 'my-team')).find(
      message => message.messageId === nativeRow.messageId,
    )).toMatchObject({ read: false })

    setIsInteractive(true)
    const liveRow = createPendingMailboxMirrorMessage(
      { ...nativeRow, messageId: nativeRow.messageId, read: false },
      getSessionId(),
    )
    appState.inbox.messages = [liveRow]
    expect(await getTeammateMailboxAttachments(context)).toEqual([])
    expect(appState.inbox.messages[0]).toMatchObject({ status: 'pending' })
  })
})
