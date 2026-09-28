import {
  decodeHostedTaskMutationCommand,
  decodeHostedTaskMutationTerminalResult,
  fingerprintHostedTaskCommand,
  HOSTED_CONTROL_OPERATION,
  type HostedTaskMutationRequest,
  type HostedTaskMutationTerminalResult,
} from './protocol.js'
import {
  sealProductOwnerBoundResponse,
  type ProductOwnerBoundRequest,
} from './HostedProductOwnerBoundEnvelope.js'

const MAX_SELF_WRITE_EFFECTS = 512

/** A task file the committed mutation published, so Product counts it as its own write. */
export type HostedTaskSelfWriteEffect = { fileKey: string; expectedChecksum: string }
export type HostedTaskMutationOutcome = { result: HostedTaskMutationTerminalResult; selfWriteEffects: HostedTaskSelfWriteEffect[] }

export type HostedProductTaskMutationPort = {
  mutateWithSelfWriteEffects(request: HostedTaskMutationRequest): Promise<HostedTaskMutationOutcome>
}

/** Runs an already opened and fence-verified Product task_mutate request through the Owner writer. */
export async function dispatchProductTaskMutation(input: {
  request: ProductOwnerBoundRequest
  secret: Uint8Array
  proofDomain: string
  tasks: HostedProductTaskMutationPort
}): Promise<Record<string, unknown>> {
  const { request: opened } = input
  if (opened.operation !== HOSTED_CONTROL_OPERATION) throw new Error('Invalid hosted Product task operation')
  const payload = opened.payload
  const keys = Object.keys(payload).sort()
  if (keys.length !== 2 || keys[0] !== 'command' || keys[1] !== 'payloadFingerprint') {
    throw new Error('Invalid hosted Product task payload keys')
  }
  const command = decodeHostedTaskMutationCommand(payload.command)
  if (command.teamId !== opened.authority.teamId || payload.payloadFingerprint !== fingerprintHostedTaskCommand(command)) {
    throw new Error('Invalid hosted Product task payload')
  }
  const request: HostedTaskMutationRequest = {
    schemaVersion: 2,
    exchangeId: opened.unsigned.exchangeId as string,
    operation: HOSTED_CONTROL_OPERATION,
    ownerBinding: opened.unsigned.ownerBinding as HostedTaskMutationRequest['ownerBinding'],
    authority: opened.authority,
    payload: { command, payloadFingerprint: payload.payloadFingerprint },
    // The Product proof was verified when the request was opened; the writer never re-checks it.
    ownerProof: '',
  }
  const outcome = await input.tasks.mutateWithSelfWriteEffects(request)
  const result = decodeHostedTaskMutationTerminalResult(outcome.result)
  if (!resultMatchesRequest(request, result)) throw new Error('Hosted Product task result does not match its request')
  return sealProductOwnerBoundResponse({
    request: opened,
    payload: productTaskMutationPayload(result, outcome.selfWriteEffects),
    secret: input.secret,
    proofDomain: input.proofDomain,
  })
}

/** Product's task-board result schema (hostedTaskBoardOrchestratorAuthority). */
export function productTaskMutationPayload(
  result: HostedTaskMutationTerminalResult,
  selfWriteEffects: HostedTaskMutationOutcome['selfWriteEffects'],
): Record<string, unknown> {
  if (result.kind === 'committed') {
    if (selfWriteEffects.length > MAX_SELF_WRITE_EFFECTS) throw new Error('Hosted Product task self-write effects exceed the limit')
    return { schemaVersion: 1, ...result, selfWriteEffects: selfWriteEffects.map(effect => ({ ...effect })) }
  }
  if (result.kind === 'unavailable') {
    return { schemaVersion: 1, kind: 'unavailable', retryAfterMs: result.retryAfterMs ?? null }
  }
  return { schemaVersion: 1, ...result }
}

function resultMatchesRequest(request: HostedTaskMutationRequest, result: HostedTaskMutationTerminalResult): boolean {
  if (result.kind !== 'committed' && result.kind !== 'idempotent_replay') return true
  const command = request.payload.command
  return result.payloadFingerprint === request.payload.payloadFingerprint &&
    result.currentSourceGeneration === command.expectedSourceGeneration &&
    result.receipt.commandId === command.commandId &&
    result.receipt.teamId === command.teamId &&
    result.receipt.sourceGeneration === command.expectedSourceGeneration
}
