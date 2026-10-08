export type CodexAppServerApprovalMethod =
  | 'item/commandExecution/requestApproval'
  | 'item/fileChange/requestApproval'
  | 'item/permissions/requestApproval'
  | 'execCommandApproval'
  | 'applyPatchApproval'

export type CodexAppServerRequestId = string | number

export interface CodexAppServerRequest<TParams = Record<string, unknown>> {
  jsonrpc?: '2.0'
  id: CodexAppServerRequestId
  method: string
  params?: TParams
}

export interface CodexAppServerToolApprovalRequest {
  providerId: 'codex'
  requestId: string
  providerRequestId: string
  method: CodexAppServerApprovalMethod
  threadId: string | null
  turnId: string | null
  itemId: string | null
  toolName: string
  toolInput: Record<string, unknown>
  reason: string | null
  raw: Record<string, unknown>
}

export interface CodexAppServerApprovalDecision {
  allow: boolean
  message?: string
}

export type CodexAppServerEffort =
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra'

export type CodexAppServerApprovalRequestHandler = (
  approval: CodexAppServerToolApprovalRequest,
  abortSignal?: AbortSignal,
) => Promise<CodexAppServerApprovalDecision>

export interface CodexAppServerThreadManualPolicy {
  approvalPolicy: 'on-request'
  approvalsReviewer: 'user'
  sandbox: 'read-only'
}

export interface CodexAutoExecPolicy {
  approvalPolicy: 'never'
  sandboxMode: 'danger-full-access'
}

export interface CodexAppServerInitializeRequest {
  jsonrpc: '2.0'
  id: CodexAppServerRequestId
  method: 'initialize'
  params: {
    clientInfo: {
      name: string
      title: string
      version: string
    }
    capabilities: {
      experimentalApi: false
      optOutNotificationMethods: string[]
    }
  }
}

export interface CodexAppServerNotification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

export interface CodexManualThreadStartParams extends CodexAppServerThreadManualPolicy {
  model?: string | null
  cwd?: string | null
  ephemeral: boolean
  experimentalRawEvents: false
  persistExtendedHistory: false
}

export interface CodexManualTurnStartParams {
  threadId: string
  input: Array<
    | { type: 'text'; text: string; text_elements: [] }
    | { type: 'localImage'; path: string }
  >
  cwd?: string | null
  approvalPolicy: 'on-request'
  approvalsReviewer: 'user'
  sandboxPolicy: {
    type: 'readOnly'
    access: { type: 'fullAccess' }
    networkAccess: false
  }
  model?: string | null
  effort?: CodexAppServerEffort
}

export class CodexAppServerApprovalProtocolUnsupportedError extends Error {
  constructor(message = 'update Codex CLI or enable auto-approve') {
    super(message)
    this.name = 'CodexAppServerApprovalProtocolUnsupportedError'
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function requestIdToString(id: CodexAppServerRequestId): string {
  return typeof id === 'number' ? String(id) : id
}

function buildProviderRequestId(
  request: Pick<CodexAppServerRequest, 'id' | 'method'>,
  params: Record<string, unknown>,
): string {
  const scopedId =
    stringValue(params.approvalId) ??
    stringValue(params.callId) ??
    stringValue(params.itemId) ??
    requestIdToString(request.id)
  return `codex:${request.method}:${scopedId}`
}

export function buildCodexManualAppServerThreadPolicy(): CodexAppServerThreadManualPolicy {
  return {
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: 'read-only',
  }
}

export function buildCodexAutoExecPolicy(): CodexAutoExecPolicy {
  return {
    approvalPolicy: 'never',
    sandboxMode: 'danger-full-access',
  }
}

export function buildCodexAppServerInitializeRequest(
  id: CodexAppServerRequestId = 1,
): CodexAppServerInitializeRequest {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      clientInfo: {
        name: 'agent-teams-orchestrator',
        title: 'Agent Teams Orchestrator',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: false,
        optOutNotificationMethods: [],
      },
    },
  }
}

export function buildCodexAppServerInitializedNotification(): CodexAppServerNotification {
  return {
    jsonrpc: '2.0',
    method: 'initialized',
  }
}

export function buildCodexManualThreadStartParams(options: {
  model?: string | null
  cwd?: string | null
  ephemeral?: boolean
} = {}): CodexManualThreadStartParams {
  return {
    ...buildCodexManualAppServerThreadPolicy(),
    ...(options.model ? { model: options.model } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ephemeral: options.ephemeral ?? true,
    experimentalRawEvents: false,
    persistExtendedHistory: false,
  }
}

export function buildCodexManualTurnStartParams(options: {
  threadId: string
  prompt: string
  imagePaths?: string[]
  cwd?: string | null
  model?: string | null
  effort?: CodexAppServerEffort | null
}): CodexManualTurnStartParams {
  return {
    threadId: options.threadId,
    input: [
      { type: 'text', text: options.prompt, text_elements: [] },
      ...(options.imagePaths ?? []).map(path => ({ type: 'localImage' as const, path })),
    ],
    ...(options.cwd ? { cwd: options.cwd } : {}),
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandboxPolicy: {
      type: 'readOnly',
      access: { type: 'fullAccess' },
      networkAccess: false,
    },
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
  }
}

export function isCodexAppServerApprovalMethod(
  method: string,
): method is CodexAppServerApprovalMethod {
  return (
    method === 'item/commandExecution/requestApproval' ||
    method === 'item/fileChange/requestApproval' ||
    method === 'item/permissions/requestApproval' ||
    method === 'execCommandApproval' ||
    method === 'applyPatchApproval'
  )
}

export function normalizeCodexAppServerApprovalRequest(
  request: CodexAppServerRequest,
): CodexAppServerToolApprovalRequest | null {
  if (!isCodexAppServerApprovalMethod(request.method)) {
    return null
  }

  const params = asRecord(request.params)
  const requestId = requestIdToString(request.id)
  const providerRequestId = buildProviderRequestId(request, params)

  switch (request.method) {
    case 'item/commandExecution/requestApproval': {
      const command = stringValue(params.command)
      return {
        providerId: 'codex',
        requestId,
        providerRequestId,
        method: request.method,
        threadId: stringValue(params.threadId),
        turnId: stringValue(params.turnId),
        itemId: stringValue(params.itemId),
        toolName: 'Bash',
        toolInput: {
          provider: 'codex',
          providerRequestId,
          ...(command ? { command } : {}),
          ...(stringValue(params.cwd) ? { cwd: stringValue(params.cwd) } : {}),
          ...(Array.isArray(params.commandActions)
            ? { commandActions: params.commandActions }
            : {}),
          ...(params.additionalPermissions ? { additionalPermissions: params.additionalPermissions } : {}),
        },
        reason: stringValue(params.reason),
        raw: params,
      }
    }
    case 'execCommandApproval': {
      const command = Array.isArray(params.command)
        ? params.command.filter((part): part is string => typeof part === 'string').join(' ')
        : null
      return {
        providerId: 'codex',
        requestId,
        providerRequestId,
        method: request.method,
        threadId: stringValue(params.conversationId),
        turnId: null,
        itemId: stringValue(params.callId),
        toolName: 'Bash',
        toolInput: {
          provider: 'codex',
          providerRequestId,
          ...(command ? { command } : {}),
          ...(stringValue(params.cwd) ? { cwd: stringValue(params.cwd) } : {}),
          ...(Array.isArray(params.parsedCmd) ? { parsedCommand: params.parsedCmd } : {}),
        },
        reason: stringValue(params.reason),
        raw: params,
      }
    }
    case 'item/fileChange/requestApproval': {
      return {
        providerId: 'codex',
        requestId,
        providerRequestId,
        method: request.method,
        threadId: stringValue(params.threadId),
        turnId: stringValue(params.turnId),
        itemId: stringValue(params.itemId),
        toolName: 'Edit',
        toolInput: {
          provider: 'codex',
          providerRequestId,
          ...(stringValue(params.grantRoot) ? { file_path: stringValue(params.grantRoot) } : {}),
          ...(stringValue(params.grantRoot) ? { grantRoot: stringValue(params.grantRoot) } : {}),
        },
        reason: stringValue(params.reason),
        raw: params,
      }
    }
    case 'applyPatchApproval': {
      const fileChanges = asRecord(params.fileChanges)
      const filePaths = Object.keys(fileChanges)
      return {
        providerId: 'codex',
        requestId,
        providerRequestId,
        method: request.method,
        threadId: stringValue(params.conversationId),
        turnId: null,
        itemId: stringValue(params.callId),
        toolName: 'Edit',
        toolInput: {
          provider: 'codex',
          providerRequestId,
          fileChanges,
          filePaths,
          ...(stringValue(params.grantRoot) ? { grantRoot: stringValue(params.grantRoot) } : {}),
          ...(filePaths[0] ? { file_path: filePaths[0] } : {}),
        },
        reason: stringValue(params.reason),
        raw: params,
      }
    }
    case 'item/permissions/requestApproval': {
      return {
        providerId: 'codex',
        requestId,
        providerRequestId,
        method: request.method,
        threadId: stringValue(params.threadId),
        turnId: stringValue(params.turnId),
        itemId: stringValue(params.itemId),
        toolName: 'CodexPermissions',
        toolInput: {
          provider: 'codex',
          providerRequestId,
          permissions: params.permissions,
          ...(stringValue(params.cwd) ? { cwd: stringValue(params.cwd) } : {}),
        },
        reason: stringValue(params.reason),
        raw: params,
      }
    }
  }
}

export function buildCodexAppServerApprovalResponse(
  request: Pick<CodexAppServerRequest, 'id' | 'method' | 'params'>,
  allow: boolean,
): { jsonrpc: '2.0'; id: CodexAppServerRequestId; result: Record<string, unknown> } {
  if (!isCodexAppServerApprovalMethod(request.method)) {
    throw new CodexAppServerApprovalProtocolUnsupportedError()
  }

  if (request.method === 'execCommandApproval' || request.method === 'applyPatchApproval') {
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        decision: allow ? 'approved' : 'denied',
      },
    }
  }

  if (request.method === 'item/commandExecution/requestApproval') {
    const params = asRecord(request.params)
    const availableDecisions = Array.isArray(params.availableDecisions)
      ? params.availableDecisions
      : []
    const allowDecision = availableDecisions.includes('accept')
      ? 'accept'
      : availableDecisions.includes('acceptForSession')
        ? 'acceptForSession'
        : 'accept'
    const denyDecision = availableDecisions.includes('decline')
      ? 'decline'
      : availableDecisions.includes('cancel')
        ? 'cancel'
        : 'decline'
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        decision: allow ? allowDecision : denyDecision,
      },
    }
  }

  if (request.method === 'item/permissions/requestApproval') {
    const params = asRecord(request.params)
    const permissions = asRecord(params.permissions)
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: allow
        ? {
            permissions: {
              ...(permissions.network ? { network: permissions.network } : {}),
              ...(permissions.fileSystem ? { fileSystem: permissions.fileSystem } : {}),
            },
            scope: 'turn',
          }
        : {
            permissions: {},
            scope: 'turn',
          },
    }
  }

  return {
    jsonrpc: '2.0',
    id: request.id,
    result: {
      decision: allow ? 'accept' : 'decline',
    },
  }
}

export function classifyCodexAppServerApprovalFailure(error: unknown): {
  unsupported: boolean
  message: string
} {
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()
  const unsupported =
    lower.includes('method not found') ||
    lower.includes('unknown method') ||
    lower.includes('unknown command') ||
    lower.includes('no such command') ||
    lower.includes('-32601')
  return {
    unsupported,
    message: unsupported ? 'update Codex CLI or enable auto-approve' : message,
  }
}
