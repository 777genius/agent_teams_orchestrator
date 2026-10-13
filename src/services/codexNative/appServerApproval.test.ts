import { describe, expect, test } from 'bun:test'

import {
  buildCodexAppServerInitializedNotification,
  buildCodexAppServerInitializeRequest,
  buildCodexAppServerApprovalResponse,
  buildCodexAutoExecPolicy,
  buildCodexManualThreadStartParams,
  buildCodexManualTurnStartParams,
  buildCodexManualAppServerThreadPolicy,
  classifyCodexAppServerApprovalFailure,
  normalizeCodexAppServerApprovalRequest,
} from './appServerApproval.js'
import { createCodexAppServerApprovalPromptHandler } from './approvalPromptBridge.js'

describe('Codex app-server approvals', () => {
  test('builds documented auto and manual launch policies', () => {
    expect(buildCodexAutoExecPolicy()).toEqual({
      approvalPolicy: 'never',
      sandboxMode: 'danger-full-access',
    })
    expect(buildCodexManualAppServerThreadPolicy()).toEqual({
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'read-only',
    })
  })

  test('builds the app-server initialize and manual turn contract', () => {
    expect(buildCodexAppServerInitializeRequest(7)).toMatchObject({
      jsonrpc: '2.0',
      id: 7,
      method: 'initialize',
      params: {
        clientInfo: {
          name: 'agent-teams-orchestrator',
          title: 'Agent Teams Orchestrator',
        },
        capabilities: {
          experimentalApi: false,
          optOutNotificationMethods: [],
        },
      },
    })
    expect(buildCodexAppServerInitializedNotification()).toEqual({
      jsonrpc: '2.0',
      method: 'initialized',
    })
    expect(
      buildCodexManualThreadStartParams({
        model: 'gpt-5.4',
        cwd: '/repo',
        ephemeral: false,
      }),
    ).toMatchObject({
      model: 'gpt-5.4',
      cwd: '/repo',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'read-only',
      ephemeral: false,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    })
    expect(
      buildCodexManualTurnStartParams({
        threadId: 'thread-1',
        prompt: 'Ship it',
        imagePaths: ['/repo/image.png'],
        cwd: '/repo',
        effort: 'minimal',
      }),
    ).toEqual({
      threadId: 'thread-1',
      input: [
        { type: 'text', text: 'Ship it', text_elements: [] },
        { type: 'localImage', path: '/repo/image.png' },
      ],
      cwd: '/repo',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandboxPolicy: {
        type: 'readOnly',
        access: { type: 'fullAccess' },
        networkAccess: false,
      },
      effort: 'minimal',
    })
  })

  test('normalizes command execution approval requests for the app UI', () => {
    const normalized = normalizeCodexAppServerApprovalRequest({
      jsonrpc: '2.0',
      id: 10,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        approvalId: 'approval-1',
        command: 'pnpm test',
        cwd: '/repo',
        reason: 'Run tests',
      },
    })

    expect(normalized).toMatchObject({
      providerId: 'codex',
      requestId: '10',
      providerRequestId:
        'codex:item/commandExecution/requestApproval:approval-1',
      method: 'item/commandExecution/requestApproval',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      toolName: 'Bash',
      toolInput: {
        provider: 'codex',
        command: 'pnpm test',
        cwd: '/repo',
      },
      reason: 'Run tests',
    })
  })

  test('normalizes file and legacy patch approval requests', () => {
    expect(
      normalizeCodexAppServerApprovalRequest({
        id: 'file-approval',
        method: 'item/fileChange/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-2',
          grantRoot: '/repo/src',
          reason: 'Need write access',
        },
      }),
    ).toMatchObject({
      providerId: 'codex',
      toolName: 'Edit',
      toolInput: {
        file_path: '/repo/src',
        grantRoot: '/repo/src',
      },
    })

    expect(
      normalizeCodexAppServerApprovalRequest({
        id: 12,
        method: 'applyPatchApproval',
        params: {
          conversationId: 'thread-legacy',
          callId: 'call-1',
          fileChanges: {
            '/repo/a.ts': { add: true },
          },
          reason: null,
          grantRoot: null,
        },
      }),
    ).toMatchObject({
      providerId: 'codex',
      providerRequestId: 'codex:applyPatchApproval:call-1',
      threadId: 'thread-legacy',
      itemId: 'call-1',
      toolName: 'Edit',
      toolInput: {
        file_path: '/repo/a.ts',
        filePaths: ['/repo/a.ts'],
      },
    })
  })

  test('maps app allow and deny decisions to JSON-RPC approval responses', () => {
    expect(
      buildCodexAppServerApprovalResponse(
        { id: 1, method: 'item/commandExecution/requestApproval' },
        true,
      ),
    ).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { decision: 'accept' },
    })
    expect(
      buildCodexAppServerApprovalResponse(
        { id: 2, method: 'item/fileChange/requestApproval' },
        false,
      ),
    ).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: { decision: 'decline' },
    })
    expect(
      buildCodexAppServerApprovalResponse(
        { id: 'legacy', method: 'execCommandApproval' },
        false,
      ),
    ).toEqual({
      jsonrpc: '2.0',
      id: 'legacy',
      result: { decision: 'denied' },
    })
  })

  test('normalizes Codex permissions approval requests and maps allow or deny responses', () => {
    const permissions = {
      network: { allowed: ['api.example.com'] },
      fileSystem: { writableRoots: ['/repo/tmp'] },
    }
    const normalized = normalizeCodexAppServerApprovalRequest({
      id: 'permission-rpc-1',
      method: 'item/permissions/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-permission',
        permissions,
        cwd: '/repo',
        reason: 'Need temporary network and write access',
      },
    })

    expect(normalized).toMatchObject({
      providerId: 'codex',
      providerRequestId: 'codex:item/permissions/requestApproval:item-permission',
      method: 'item/permissions/requestApproval',
      toolName: 'CodexPermissions',
      toolInput: {
        provider: 'codex',
        providerRequestId: 'codex:item/permissions/requestApproval:item-permission',
        permissions,
        cwd: '/repo',
      },
      reason: 'Need temporary network and write access',
    })

    expect(
      buildCodexAppServerApprovalResponse(
        {
          id: 'permission-rpc-1',
          method: 'item/permissions/requestApproval',
          params: { permissions },
        },
        true,
      ),
    ).toEqual({
      jsonrpc: '2.0',
      id: 'permission-rpc-1',
      result: {
        permissions,
        scope: 'turn',
      },
    })
    expect(
      buildCodexAppServerApprovalResponse(
        {
          id: 'permission-rpc-2',
          method: 'item/permissions/requestApproval',
          params: { permissions },
        },
        false,
      ),
    ).toEqual({
      jsonrpc: '2.0',
      id: 'permission-rpc-2',
      result: {
        permissions: {},
        scope: 'turn',
      },
    })
  })

  test('classifies unsupported app-server methods as manual launch blockers', () => {
    expect(classifyCodexAppServerApprovalFailure(new Error('Method not found: turn/start'))).toEqual({
      unsupported: true,
      message: 'update Codex CLI or enable auto-approve',
    })
  })

  test('bridges app-server approvals through forced interactive can_use_tool decisions', async () => {
    const observed: Array<{
      toolName: string
      input: Record<string, unknown>
      toolUseId: string
      forceBehavior: string | undefined
    }> = []
    const handler = createCodexAppServerApprovalPromptHandler({
      canUseTool: async (tool, input, _context, _message, toolUseId, forceDecision) => {
        observed.push({
          toolName: tool.name,
          input,
          toolUseId,
          forceBehavior: forceDecision?.behavior,
        })
        return { behavior: 'allow', updatedInput: input }
      },
      toolUseContext: {} as never,
    })

    const decision = await handler({
      providerId: 'codex',
      requestId: '7',
      providerRequestId: 'codex:item/commandExecution/requestApproval:item-7',
      method: 'item/commandExecution/requestApproval',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-7',
      toolName: 'Bash',
      toolInput: { provider: 'codex', command: 'printf ok' },
      reason: 'Run command',
      raw: {},
    })

    expect(decision).toEqual({ allow: true })
    expect(observed).toEqual([
      {
        toolName: 'Bash',
        input: { provider: 'codex', command: 'printf ok' },
        toolUseId: 'codex:item/commandExecution/requestApproval:item-7',
        forceBehavior: 'ask',
      },
    ])
  })
})
