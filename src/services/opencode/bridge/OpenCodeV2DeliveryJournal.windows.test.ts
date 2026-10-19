import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { lstat, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { executionHash } from '../execution/OpenCodeV2ExecutionContracts.js'
import { createWindowsNativeBroker, resolveWindowsNativeArtifact } from '../host/windows/OpenCodeV2WindowsNativeBroker.js'
import { createWindowsOwnerFilesystem, type WindowsOwnerDirectory } from '../host/windows/OpenCodeV2WindowsOwnerFilesystem.js'
import type { SendMessageOutcomeBase } from './OpenCodeBridgeDeliveryJournal.js'
import { OpenCodeV2DeliveryJournal } from './OpenCodeV2DeliveryJournal.js'

// This exercises only the real app journal in a fresh native-private TEST root.
// There is no run owner, session, prompt, model, or synthetic qualification.
test.skipIf(process.platform !== 'win32')('Windows delivery journal reserves one original app submission before native send', async () => {
  const deadline = Date.now() + 30_000
  const root = path.join(await realpath(os.tmpdir()), `TEST-v2-delivery-journal-${randomUUID()}`)
  const broker = createWindowsNativeBroker(await resolveWindowsNativeArtifact())
  broker.events.on('error', () => {})
  const filesystem = createWindowsOwnerFilesystem((request, requestDeadline, signal) =>
    broker.request(request.op, request, requestDeadline, signal))
  let held: WindowsOwnerDirectory | undefined
  let phase: 'private-root' | 'reserve' | 'fresh-observe' = 'private-root'
  try {
    held = await filesystem.prepareDirectory(root, true, deadline)
    await held.assertOwned(deadline)
    const identity = { requestId: 'TEST-request', deliveryAttemptId: 'TEST-attempt',
      localMessageId: 'TEST-message', nativeInputID: 'msg_TESTjournal' }
    const base: SendMessageOutcomeBase = { requestId: identity.requestId, teamId: 'TEST-team', teamName: 'TEST-team',
      runId: 'TEST-run', laneId: 'TEST-lane', memberName: 'TEST-worker', projectPath: root,
      body: { deliveryAttemptId: identity.deliveryAttemptId, messageId: identity.localMessageId, payloadHash: 'a'.repeat(64) } }
    const journal = new OpenCodeV2DeliveryJournal(root)
    const intentHash = executionHash({ identity, delivery: 'queue',
      input: { nativeInputID: identity.nativeInputID, text: 'TEST journal only; never submitted', resume: true } })
    phase = 'reserve'
    const original = await journal.reserve(base, 'ses_TESTjournal', identity, intentHash)
    expect(original.action).toBe('submit')
    expect(original.submissionOwner).toMatch(/^[a-f0-9-]{36}$/)
    expect((await journal.query({ requestId: identity.requestId })).record).toMatchObject({
      status: 'prompt_submitting', safeToRetry: false, runtimePromptMessageId: identity.nativeInputID,
      sessionId: 'ses_TESTjournal' })
    phase = 'fresh-observe'
    expect(await new OpenCodeV2DeliveryJournal(root).reserve(base, 'ses_TESTjournal', identity, intentHash))
      .toEqual({ action: 'observe', submissionOwner: original.submissionOwner })
    await held.assertOwned(deadline)
  } catch (error) {
    const guard = await lstat(path.join(root, 'opencode', 'command-outcomes.v2-observation.lock')).catch(() => null)
    console.error(JSON.stringify({ event: 'TEST_windows_delivery_journal_failure', phase,
      code: error instanceof Error && error.message === 'delivery_lock_foreign' ? 'delivery_lock_foreign' : 'unknown',
      getuidAvailable: typeof process.getuid === 'function',
      guardRegular: guard?.isFile() === true && !guard.isSymbolicLink(), guardSingleLink: guard?.nlink === 1,
      posixOwnerMatches: guard !== null && guard.uid === process.getuid?.(),
      posixModePrivate: guard !== null && (guard.mode & 0o077) === 0 }))
    throw error
  } finally {
    try { await held?.close() } finally { await broker.close() }
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
