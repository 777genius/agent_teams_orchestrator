import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'fs/promises'
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
import {
  claimUnreadRegularMessages,
  createShutdownApprovedMessage,
  readMailbox,
  writeToMailbox,
} from './teammateMailbox.js'
import {
  createTeammateContext,
  runWithTeammateContext,
} from './teammateContext.js'
import { getTeamDir, readTeamFileAsync, writeTeamFileAsync } from './swarm/teamHelpers.js'

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

  it('application mailbox keeps process identity when exact termination fails', async () => {
    const shutdown = createShutdownApprovedMessage({
      requestId: 'shutdown-1',
      from: 'bob',
      paneId: `process:${process.pid}`,
      backendType: 'process',
      processStartedAtMs: 100,
      processOsIdentity: `unix-pgid:${process.pid}`,
      processOwnerToken: 'owner-token',
      processRunId: 'run-a',
    })
    await mkdir(getTeamDir('my-team'), { recursive: true })
    await writeTeamFileAsync('my-team', {
      name: 'my-team',
      createdAt: Date.now(),
      leadAgentId: 'lead-id',
      members: [{
        agentId: 'bob@my-team',
        name: 'bob',
        joinedAt: 0,
        tmuxPaneId: `process:${process.pid}`,
        cwd: '/tmp',
        processStartedAtMs: 100,
        processOsIdentity: `unix-pgid:${process.pid}`,
        processOwnerToken: 'owner-token',
        processRunId: 'run-a',
        outstandingShutdownRequestId: 'shutdown-1',
        subscriptions: [],
        backendType: 'process',
      }],
    })
    let appState = {
      abortController: new AbortController(),
      messages: [],
      tasks: {},
      toolPermissionContext: getEmptyToolPermissionContext(),
      inbox: {
        messages: [{
          id: 'shutdown-row',
          from: 'bob',
          text: JSON.stringify(shutdown),
          timestamp: shutdown.timestamp,
          status: 'pending' as const,
        }],
      },
      teamContext: {
        teamName: 'my-team',
        teamFilePath: '/tmp/my-team.json',
        leadAgentId: 'lead-id',
        teammates: {
          'bob@my-team': {
            name: 'bob',
            tmuxSessionName: 'process',
            tmuxPaneId: `process:${process.pid}`,
            cwd: '/tmp',
            spawnedAt: 0,
            processStartedAtMs: 100,
            processOsIdentity: `unix-pgid:${process.pid}`,
            processOwnerToken: 'owner-token',
            processRunId: 'run-a',
          },
        },
      },
    } as unknown as AppState
    const toolUseContext = {
      options: {
        commands: [], debug: false, mainLoopModel: 'test-model', tools: [],
        verbose: false, thinkingConfig: { type: 'disabled' as const },
        mcpClients: [], mcpResources: {}, isNonInteractiveSession: false,
        agentDefinitions: { definitions: [], errors: [] },
      },
      abortController: new AbortController(),
      readFileState: new Map(),
      getAppState: () => appState,
      setAppState: (updater: (prev: AppState) => AppState) => {
        appState = updater(appState)
      },
    } as unknown as ToolUseContext

    await getTeammateMailboxAttachments(toolUseContext)

    expect(appState.teamContext?.teammates?.['bob@my-team']).toMatchObject({
      processStartedAtMs: 100,
      processOsIdentity: `unix-pgid:${process.pid}`,
      processOwnerToken: 'owner-token',
      processRunId: 'run-a',
    })
    expect(appState.inbox.messages).toHaveLength(1)
    expect(appState.inbox.messages[0]?.status).toBe('processed')
    expect(appState.teammateTerminationRecovery.bob).toMatchObject({
        paneId: `process:${process.pid}`,
        processStartedAtMs: 100,
        processOsIdentity: `unix-pgid:${process.pid}`,
        processOwnerToken: 'owner-token',
        processRunId: 'run-a',
    })
  })

  it('ignores shutdown approval when the payload sender differs from the mailbox row', async () => {
    const shutdown = createShutdownApprovedMessage({
      requestId: 'shutdown-forged', from: 'bob', paneId: `process:${process.pid}`,
      backendType: 'process',
      processStartedAtMs: 100, processOwnerToken: 'owner-token', processRunId: 'run-a',
      processOsIdentity: `unix-pgid:${process.pid}`,
    })
    await mkdir(getTeamDir('my-team'), { recursive: true })
    await writeTeamFileAsync('my-team', {
      name: 'my-team', createdAt: Date.now(), leadAgentId: 'lead-id',
      members: [{
        agentId: 'bob@my-team', name: 'bob', joinedAt: 0,
        tmuxPaneId: `process:${process.pid}`, cwd: '/tmp', subscriptions: [],
        processStartedAtMs: 100, processOwnerToken: 'owner-token', processRunId: 'run-a',
        processOsIdentity: `unix-pgid:${process.pid}`,
        outstandingShutdownRequestId: 'shutdown-forged', backendType: 'process',
      }],
    })
    let appState = {
      tasks: {},
      inbox: { messages: [{
        id: 'shutdown-forged-row', from: 'mallory', text: JSON.stringify(shutdown),
        timestamp: shutdown.timestamp, status: 'pending' as const,
      }] },
      teamContext: {
        teamName: 'my-team', teamFilePath: '/tmp/my-team.json', leadAgentId: 'lead-id',
        teammates: { 'bob@my-team': { name: 'bob', tmuxPaneId: `process:${process.pid}` } },
      },
    } as unknown as AppState
    const context = {
      getAppState: () => appState,
      setAppState: (updater: (prev: AppState) => AppState) => { appState = updater(appState) },
    } as unknown as ToolUseContext

    await getTeammateMailboxAttachments(context)

    expect((await readTeamFileAsync('my-team'))?.members[0]?.name).toBe('bob')
  })

  it('ignores shutdown approval when runtime binding differs from the roster', async () => {
    const shutdown = createShutdownApprovedMessage({
      requestId: 'shutdown-substituted', from: 'bob', paneId: 'process:999999',
      backendType: 'process', processStartedAtMs: 100,
      processOsIdentity: 'unix-pgid:999999', processOwnerToken: 'owner-token',
      processRunId: 'run-a',
    })
    await mkdir(getTeamDir('my-team'), { recursive: true })
    await writeTeamFileAsync('my-team', {
      name: 'my-team', createdAt: Date.now(), leadAgentId: 'lead-id',
      members: [{
        agentId: 'bob@my-team', name: 'bob', joinedAt: 0,
        tmuxPaneId: 'process:42', cwd: '/tmp', subscriptions: [],
        processStartedAtMs: 100, processOsIdentity: 'unix-pgid:42',
        processOwnerToken: 'owner-token', processRunId: 'run-a',
        outstandingShutdownRequestId: 'shutdown-substituted', backendType: 'process',
      }],
    })
    let appState = {
      tasks: {},
      inbox: { messages: [{
        id: 'shutdown-substituted-row', from: 'bob', text: JSON.stringify(shutdown),
        timestamp: shutdown.timestamp, status: 'pending' as const,
      }] },
      teamContext: {
        teamName: 'my-team', teamFilePath: '/tmp/my-team.json', leadAgentId: 'lead-id',
        teammates: { 'bob@my-team': { name: 'bob', tmuxPaneId: 'process:42' } },
      },
    } as unknown as AppState
    const context = {
      getAppState: () => appState,
      setAppState: (updater: (prev: AppState) => AppState) => { appState = updater(appState) },
    } as unknown as ToolUseContext

    const attachments = await getTeammateMailboxAttachments(context)

    expect((await readTeamFileAsync('my-team'))?.members[0]).toMatchObject({
      agentId: 'bob@my-team', tmuxPaneId: 'process:42', processOsIdentity: 'unix-pgid:42',
    })
    expect(attachments[0]).toMatchObject({
      type: 'teammate_mailbox',
      messages: [expect.objectContaining({ text: JSON.stringify(shutdown) })],
    })
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
})
