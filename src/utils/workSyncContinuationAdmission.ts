import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { QueryGuard, type ContinuationTicket } from './QueryGuard.js'

export const WORK_SYNC_ADMISSION_FEATURE_DIR = '.member-work-sync'
export const WORK_SYNC_ADMISSION_ROOT_SEGMENT = 'runtime-admission'

export function encodeTeamMemberStorageKey(memberName: string): string {
  const normalized = memberName.trim().toLowerCase()
  if (!normalized) {
    throw new Error('memberName is required for member-scoped storage')
  }
  const encoded = encodeURIComponent(normalized)
  if (encoded === '.') return '%2E'
  if (encoded === '..') return '%2E%2E'
  return encoded
}

export type WorkSyncAdmissionScope = {
  teamName: string
  teamIncarnation: string
  memberName: string
  runtimeInstanceId: string
}

export type WorkSyncAdmissionControl = {
  runtimeInstanceId: string
  controlRevision: number
  stopped: boolean
  localAdmissionClosed: boolean
  teamIncarnation?: string
  handshakeCompleted: boolean
}

export type WorkSyncAdmissionCommand =
  | {
      schemaVersion: 1
      requestId: string
      op: 'reserve'
      scope: WorkSyncAdmissionScope
      intentId: string
      admissionPayloadHash: string
      expectedGeneration: number
      reservationNonce: string
      controlRevision: number
      commandDeadline: string
      issuedAt: string
    }
  | {
      schemaVersion: 1
      requestId: string
      op: 'cancel'
      scope: WorkSyncAdmissionScope
      intentId: string
      reservationNonce: string
      expectedGeneration: number
      issuedAt: string
    }
  | {
      schemaVersion: 1
      requestId: string
      op: 'sync_control'
      scope: WorkSyncAdmissionScope
      controlRevision: number
      stopped: boolean
      issuedAt: string
    }

export type WorkSyncAdmissionAck = {
  schemaVersion: 1
  requestId: string
  op: WorkSyncAdmissionCommand['op']
  ok: boolean
  code?: string
  intentId?: string
  reservationNonce?: string
  runtimeInstanceId: string
  generation: number
  controlRevision: number
  localAdmissionClosed: boolean
  expiresAt?: string
  ackedAt: string
}

export type WorkSyncAdmissionApplyResult = {
  ack: WorkSyncAdmissionAck
  control: WorkSyncAdmissionControl
}

const tombstonesByRequestId = new Map<string, WorkSyncAdmissionAck>()
const tombstonesByIntentNonce = new Map<string, WorkSyncAdmissionAck>()
let controlState: WorkSyncAdmissionControl | null = null

function intentNonceKey(intentId: string, reservationNonce: string): string {
  return `${intentId}:${reservationNonce}`
}

export const WORK_SYNC_TEST_HOLD_CONSUME_PATH_ENV =
  'CLAUDE_WORK_SYNC_TEST_HOLD_CONSUME_PATH'

/** Test-owned barrier: inbox may persist, but consume/start stays blocked while the file exists. */
export function isWorkSyncTestConsumeHoldOpen(): boolean {
  const holdPath = process.env[WORK_SYNC_TEST_HOLD_CONSUME_PATH_ENV]?.trim()
  return Boolean(holdPath && existsSync(holdPath))
}

export function resetWorkSyncAdmissionProcessorForTests(): void {
  tombstonesByRequestId.clear()
  tombstonesByIntentNonce.clear()
  controlState = null
  postTurnAdmissionUntilMs = 0
}

export function closeLocalWorkSyncAdmissionForUserStop(guard: QueryGuard): void {
  const control = controlState ?? initializeWorkSyncAdmissionControl(guard.runtimeInstanceId)
  control.stopped = true
  control.localAdmissionClosed = true
  control.controlRevision += 1
  const ticket = guard.continuationTicket
  if (ticket) {
    guard.cancelReservedContinuation(ticket)
  }
}

export function initializeWorkSyncAdmissionControl(
  runtimeInstanceId: string,
): WorkSyncAdmissionControl {
  controlState = {
    runtimeInstanceId,
    controlRevision: 0,
    stopped: false,
    localAdmissionClosed: true,
    handshakeCompleted: false,
  }
  return controlState
}

/** REPL capability may publish this before desktop handshake supplies lifecycle authority. */
const UNBOUND_WORK_SYNC_TEAM_INCARNATION = 'unspecified'

export function isBoundWorkSyncTeamIncarnation(
  value: string | undefined,
): value is string {
  return Boolean(value) && value !== UNBOUND_WORK_SYNC_TEAM_INCARNATION
}

function bindWorkSyncTeamIncarnation(
  control: WorkSyncAdmissionControl,
  incoming: string | undefined,
): void {
  if (!isBoundWorkSyncTeamIncarnation(incoming)) {
    return
  }
  control.teamIncarnation = incoming
}

function hasWorkSyncTeamIncarnationMismatch(
  control: WorkSyncAdmissionControl,
  incoming: string | undefined,
): boolean {
  return (
    isBoundWorkSyncTeamIncarnation(control.teamIncarnation) &&
    isBoundWorkSyncTeamIncarnation(incoming) &&
    incoming !== control.teamIncarnation
  )
}

function sameScope(
  left: WorkSyncAdmissionScope,
  runtimeInstanceId: string,
): boolean {
  return left.runtimeInstanceId === runtimeInstanceId
}

export function applyWorkSyncAdmissionCommand(input: {
  guard: QueryGuard
  command: WorkSyncAdmissionCommand
  nowIso: string
  nowMs: number
  maxTtlMs?: number
}): WorkSyncAdmissionApplyResult {
  const control =
    controlState ?? initializeWorkSyncAdmissionControl(input.guard.runtimeInstanceId)
  const existing = tombstonesByRequestId.get(input.command.requestId)
  if (existing) {
    return { ack: existing, control }
  }

  const ackBase = {
    schemaVersion: 1 as const,
    requestId: input.command.requestId,
    op: input.command.op,
    runtimeInstanceId: input.guard.runtimeInstanceId,
    generation: input.guard.generation,
    controlRevision: control.controlRevision,
    localAdmissionClosed: control.localAdmissionClosed,
    ackedAt: input.nowIso,
  }

  const fail = (code: string, extra?: Partial<WorkSyncAdmissionAck>) => {
    const ack: WorkSyncAdmissionAck = {
      ...ackBase,
      ok: false,
      code,
      ...extra,
    }
    tombstonesByRequestId.set(input.command.requestId, ack)
    return { ack, control }
  }

  if (!sameScope(input.command.scope, input.guard.runtimeInstanceId)) {
    return fail('instance_mismatch')
  }

  if (input.command.op === 'sync_control') {
    if (hasWorkSyncTeamIncarnationMismatch(control, input.command.scope.teamIncarnation)) {
      return fail('instance_mismatch')
    }
    if (input.command.controlRevision < control.controlRevision) {
      const ack: WorkSyncAdmissionAck = {
        ...ackBase,
        ok: false,
        code: 'superseded',
      }
      tombstonesByRequestId.set(input.command.requestId, ack)
      return { ack, control }
    }
    if (
      input.command.controlRevision === control.controlRevision &&
      input.command.stopped !== control.stopped
    ) {
      return fail('conflict')
    }
    control.controlRevision = input.command.controlRevision
    control.stopped = input.command.stopped
    control.localAdmissionClosed = input.command.stopped
    control.handshakeCompleted = true
    bindWorkSyncTeamIncarnation(control, input.command.scope.teamIncarnation)
    if (input.command.stopped) {
      const ticket = input.guard.continuationTicket
      if (ticket) {
        input.guard.cancelReservedContinuation(ticket)
      }
    }
    const ack: WorkSyncAdmissionAck = {
      ...ackBase,
      ok: true,
      code: input.command.stopped ? 'closed' : 'open',
      controlRevision: control.controlRevision,
      localAdmissionClosed: control.localAdmissionClosed,
    }
    tombstonesByRequestId.set(input.command.requestId, ack)
    return { ack, control }
  }

  if (hasWorkSyncTeamIncarnationMismatch(control, input.command.scope.teamIncarnation)) {
    return fail('instance_mismatch')
  }

  if (control.localAdmissionClosed || control.stopped) {
    if (input.command.op === 'cancel') {
      const ticket: ContinuationTicket = {
        runtimeInstanceId: input.guard.runtimeInstanceId,
        expectedGeneration: input.command.expectedGeneration,
        reservationNonce: input.command.reservationNonce,
        intentId: input.command.intentId,
      }
      const cancelled = input.guard.cancelReservedContinuation(ticket)
      const ack: WorkSyncAdmissionAck = {
        ...ackBase,
        ok: true,
        code: cancelled === 'cancelled' ? 'cancelled' : 'already_cancelled',
        intentId: input.command.intentId,
        reservationNonce: input.command.reservationNonce,
      }
      tombstonesByRequestId.set(input.command.requestId, ack)
      tombstonesByIntentNonce.set(
        intentNonceKey(input.command.intentId, input.command.reservationNonce),
        ack,
      )
      return { ack, control }
    }
    return fail('stopped', {
      intentId: input.command.intentId,
      reservationNonce:
        input.command.op === 'reserve' ? input.command.reservationNonce : undefined,
    })
  }

  if (input.command.op === 'cancel') {
    const prior = tombstonesByIntentNonce.get(
      intentNonceKey(input.command.intentId, input.command.reservationNonce),
    )
    const ticket: ContinuationTicket = {
      runtimeInstanceId: input.guard.runtimeInstanceId,
      expectedGeneration: input.command.expectedGeneration,
      reservationNonce: input.command.reservationNonce,
      intentId: input.command.intentId,
    }
    const cancelled = input.guard.cancelReservedContinuation(ticket)
    const code =
      cancelled === 'cancelled'
        ? 'cancelled'
        : prior
          ? 'already_cancelled'
          : input.guard.status === 'running'
            ? 'already_admitted'
            : 'already_cancelled'
    const ack: WorkSyncAdmissionAck = {
      ...ackBase,
      ok: true,
      code,
      intentId: input.command.intentId,
      reservationNonce: input.command.reservationNonce,
    }
    tombstonesByRequestId.set(input.command.requestId, ack)
    tombstonesByIntentNonce.set(
      intentNonceKey(input.command.intentId, input.command.reservationNonce),
      ack,
    )
    return { ack, control }
  }

  const deadlineMs = Date.parse(input.command.commandDeadline)
  if (!Number.isFinite(deadlineMs) || deadlineMs <= input.nowMs) {
    return fail('expired', {
      intentId: input.command.intentId,
      reservationNonce: input.command.reservationNonce,
    })
  }

  const priorIntent = tombstonesByIntentNonce.get(
    intentNonceKey(input.command.intentId, input.command.reservationNonce),
  )
  if (priorIntent?.code === 'cancelled' || priorIntent?.code === 'already_cancelled') {
    return fail('cancelled', {
      intentId: input.command.intentId,
      reservationNonce: input.command.reservationNonce,
    })
  }

  if (input.command.controlRevision !== control.controlRevision) {
    return fail('superseded', {
      intentId: input.command.intentId,
      reservationNonce: input.command.reservationNonce,
    })
  }

  const maxTtlMs = input.maxTtlMs ?? 30_000
  const remainingMs = Math.min(Math.max(0, deadlineMs - input.nowMs), maxTtlMs)
  const reserved = input.guard.reserveContinuation({
    runtimeInstanceId: input.command.scope.runtimeInstanceId,
    expectedGeneration: input.command.expectedGeneration,
    intentId: input.command.intentId,
    reservationNonce: input.command.reservationNonce,
    admissionPayloadHash: input.command.admissionPayloadHash,
    expiresAtMs: input.nowMs + remainingMs,
  })
  if (!reserved.ok) {
    return fail(reserved.code, {
      intentId: input.command.intentId,
      reservationNonce: input.command.reservationNonce,
    })
  }
  bindWorkSyncTeamIncarnation(control, input.command.scope.teamIncarnation)

  const expiresAt = new Date(input.nowMs + remainingMs).toISOString()
  const ack: WorkSyncAdmissionAck = {
    ...ackBase,
    ok: true,
    code: 'reserved',
    intentId: reserved.ticket.intentId,
    reservationNonce: reserved.ticket.reservationNonce,
    generation: reserved.ticket.expectedGeneration,
    expiresAt,
  }
  tombstonesByRequestId.set(input.command.requestId, ack)
  tombstonesByIntentNonce.set(
    intentNonceKey(reserved.ticket.intentId, reserved.ticket.reservationNonce),
    ack,
  )
  return { ack, control }
}

export function buildWorkSyncAdmissionRoot(input: {
  teamName: string
  memberName: string
  teamsDir?: string
}): string {
  const teamsDir = input.teamsDir ?? join(process.env.CLAUDE_CONFIG_DIR ?? `${process.env.HOME ?? ''}/.claude`, 'teams')
  return join(
    teamsDir,
    input.teamName,
    'members',
    encodeTeamMemberStorageKey(input.memberName),
    WORK_SYNC_ADMISSION_FEATURE_DIR,
    WORK_SYNC_ADMISSION_ROOT_SEGMENT,
  )
}

export function buildWorkSyncAdmissionCommandPath(
  root: string,
  runtimeInstanceId: string,
  requestId: string,
): string {
  return join(root, runtimeInstanceId, 'commands', `${requestId}.json`)
}

export function buildWorkSyncAdmissionAckPath(
  root: string,
  runtimeInstanceId: string,
  requestId: string,
): string {
  return join(root, runtimeInstanceId, 'acks', `${requestId}.json`)
}

export async function publishWorkSyncAdmissionFileNoReplace(
  path: string,
  body: string,
): Promise<'created' | 'existing-same' | 'conflict'> {
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(path, body, { encoding: 'utf8', flag: 'wx' })
    return 'created'
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : ''
    if (code !== 'EEXIST') {
      throw error
    }
    const existing = await readFile(path, 'utf8')
    return existing === body ? 'existing-same' : 'conflict'
  }
}

export async function readWorkSyncAdmissionCommand(
  path: string,
): Promise<WorkSyncAdmissionCommand | null> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as WorkSyncAdmissionCommand
    if (parsed?.schemaVersion !== 1 || typeof parsed.requestId !== 'string') {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export async function drainWorkSyncAdmissionCommands(input: {
  guard: QueryGuard
  teamName: string
  memberName: string
  nowIso: string
  nowMs: number
  teamsDir?: string
}): Promise<number> {
  const expired = input.guard.expireReservedContinuation(input.nowMs)
  const root = buildWorkSyncAdmissionRoot({
    teamName: input.teamName,
    memberName: input.memberName,
    teamsDir: input.teamsDir,
  })
  if (expired) {
    await persistWorkSyncAdmissionLiveState({
      root,
      guard: input.guard,
      nowIso: input.nowIso,
    })
  }
  const commandsDir = join(root, input.guard.runtimeInstanceId, 'commands')
  let names: string[] = []
  try {
    names = (await readdir(commandsDir)).filter(name => name.endsWith('.json'))
  } catch {
    await persistWorkSyncAdmissionLiveState({
      root,
      guard: input.guard,
      nowIso: input.nowIso,
    })
    return 0
  }
  const loaded: WorkSyncAdmissionCommand[] = []
  for (const name of names) {
    const command = await readWorkSyncAdmissionCommand(join(commandsDir, name))
    if (command) loaded.push(command)
  }
  const opRank = (op: WorkSyncAdmissionCommand['op']): number => {
    if (op === 'sync_control') return 0
    if (op === 'cancel') return 1
    return 2
  }
  loaded.sort((left, right) => {
    const rank = opRank(left.op) - opRank(right.op)
    if (rank !== 0) return rank
    return left.requestId.localeCompare(right.requestId)
  })
  let applied = 0
  for (const command of loaded) {
    const result = applyWorkSyncAdmissionCommand({
      guard: input.guard,
      command,
      nowIso: input.nowIso,
      nowMs: input.nowMs,
    })
    const ackPath = buildWorkSyncAdmissionAckPath(
      root,
      input.guard.runtimeInstanceId,
      command.requestId,
    )
    await publishWorkSyncAdmissionFileNoReplace(
      ackPath,
      `${JSON.stringify(result.ack)}\n`,
    )
    applied += 1
  }
  await persistWorkSyncAdmissionLiveState({
    root,
    guard: input.guard,
    nowIso: input.nowIso,
  })
  return applied
}

export type WorkSyncAdmissionLiveControl = {
  runtimeInstanceId: string
  controlRevision: number
  stopped: boolean
  localAdmissionClosed: boolean
  handshakeCompleted: boolean
  teamIncarnation?: string
  updatedAt: string
}

export type WorkSyncAdmissionSnapshot = {
  runtimeInstanceId: string
  status: 'idle' | 'dispatching' | 'running'
  generation: number
  continuation: ContinuationTicket | null
  controlRevision: number
  stopped: boolean
  localAdmissionClosed: boolean
  handshakeCompleted: boolean
  teamIncarnation?: string
  updatedAt: string
}

async function persistWorkSyncAdmissionLiveState(input: {
  root: string
  guard: QueryGuard
  nowIso: string
}): Promise<void> {
  const control =
    controlState ?? initializeWorkSyncAdmissionControl(input.guard.runtimeInstanceId)
  const live: WorkSyncAdmissionLiveControl = {
    runtimeInstanceId: input.guard.runtimeInstanceId,
    controlRevision: control.controlRevision,
    stopped: control.stopped,
    localAdmissionClosed: control.localAdmissionClosed,
    handshakeCompleted: control.handshakeCompleted,
    ...(control.teamIncarnation ? { teamIncarnation: control.teamIncarnation } : {}),
    updatedAt: input.nowIso,
  }
  const snapshot: WorkSyncAdmissionSnapshot = {
    ...live,
    status: input.guard.status,
    generation: input.guard.generation,
    continuation: input.guard.continuationTicket,
  }
  await mkdir(input.root, { recursive: true })
  await writeFile(join(input.root, 'control.json'), `${JSON.stringify(live)}\n`, 'utf8')
  await writeFile(join(input.root, 'snapshot.json'), `${JSON.stringify(snapshot)}\n`, 'utf8')
}

let boundGuard: QueryGuard | null = null
let boundTeamName: string | null = null
let boundMemberName: string | null = null

export function bindWorkSyncContinuationAdmission(input: {
  guard: QueryGuard
  teamName: string
  memberName: string
}): void {
  boundGuard = input.guard
  boundTeamName = input.teamName
  boundMemberName = input.memberName
  initializeWorkSyncAdmissionControl(input.guard.runtimeInstanceId)
}

export function unbindWorkSyncContinuationAdmission(): void {
  boundGuard = null
  boundTeamName = null
  boundMemberName = null
  resetWorkSyncAdmissionProcessorForTests()
}

export function getBoundWorkSyncContinuationTicket(): ContinuationTicket | null {
  return boundGuard?.continuationTicket ?? null
}

export function isWorkSyncAdmissionHandshakeOpen(): boolean {
  return Boolean(
    controlState?.handshakeCompleted &&
      !controlState.stopped &&
      !controlState.localAdmissionClosed,
  )
}

export const WORK_SYNC_POST_TURN_ADMISSION_WINDOW_MS = 5_000

let postTurnAdmissionUntilMs = 0

export function remainingWorkSyncPostTurnAdmissionWindowMs(nowMs = Date.now()): number {
  return Math.max(0, postTurnAdmissionUntilMs - nowMs)
}

export function armWorkSyncPostTurnAdmissionWindow(
  nowMs = Date.now(),
  windowMs = WORK_SYNC_POST_TURN_ADMISSION_WINDOW_MS,
): void {
  postTurnAdmissionUntilMs = nowMs + windowMs
}

export function isWorkSyncPostTurnAdmissionWindowOpen(nowMs = Date.now()): boolean {
  return nowMs < postTurnAdmissionUntilMs
}

/** Idle delivery must re-enter after post-turn wait or when the consume-hold file disappears. */
export function getWorkSyncIdleDeliveryRetryDelayMs(nowMs = Date.now()): number | null {
  if (isWorkSyncPostTurnAdmissionWindowOpen(nowMs)) {
    return Math.max(1, remainingWorkSyncPostTurnAdmissionWindowMs(nowMs))
  }
  if (isWorkSyncTestConsumeHoldOpen()) {
    return 250
  }
  return null
}

export function clearWorkSyncPostTurnAdmissionWindowForTests(): void {
  postTurnAdmissionUntilMs = 0
}

export async function persistBoundWorkSyncAdmissionLiveState(
  now = new Date(),
): Promise<void> {
  if (!boundGuard || !boundTeamName || !boundMemberName) {
    return
  }
  await persistWorkSyncAdmissionLiveState({
    root: buildWorkSyncAdmissionRoot({
      teamName: boundTeamName,
      memberName: boundMemberName,
    }),
    guard: boundGuard,
    nowIso: now.toISOString(),
  })
}

export async function processBoundWorkSyncContinuationAdmission(
  now = new Date(),
): Promise<number> {
  if (!boundGuard || !boundTeamName || !boundMemberName) {
    return 0
  }
  return drainWorkSyncAdmissionCommands({
    guard: boundGuard,
    teamName: boundTeamName,
    memberName: boundMemberName,
    nowIso: now.toISOString(),
    nowMs: now.getTime(),
  })
}

export async function removeWorkSyncAdmissionCommand(
  path: string,
): Promise<void> {
  try {
    await unlink(path)
  } catch {
    // Command files are durable replay sources; missing is fine.
  }
}
