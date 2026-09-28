import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostedControlDispatcher } from './HostedControlDispatcher.js'
import { HOSTED_TEAM_MESSAGE_PROOF_DOMAIN } from './HostedControlServer.js'
import { productOwnerBoundProofInput, type ProductOwnerBoundOperation } from './HostedProductOwnerBoundEnvelope.js'
import { hostedTaskBoardRevision, hostedTaskBoardSourceGeneration, hostedTaskBoardTaskId, sha256 } from './HostedTaskBoardIdentity.js'
import type { HostedTaskMutationOutcome } from './HostedProductTaskMutationWire.js'
import { createHostedTeamIdentityFenceVerifier } from './HostedTeamIdentityFence.js'
import {
  fingerprintHostedTaskCommand,
  type HostedControlOwnerBinding,
  type HostedControlStableAuthority,
  type HostedTaskMutationCommand,
  type HostedTaskMutationTerminalResult,
} from './protocol.js'

// The same bytes live in agent-teams-ai docs/; both repositories pin this digest.
const GOLDEN_SHA256 = '3a318fc170b8d993cc9a3373e16a7c48ba8aa219e14c02cfaa9988bd59f50e36'

type Json = Record<string, unknown>
type GoldenSide = { unsigned: Json; proofInput: string; ownerProof: string }
type Golden = {
  format: string
  proofDomain: string
  proofKeyHex: string
  teamIdentityFile: string
  cases: Array<{ name: string; operation: ProductOwnerBoundOperation; request: GoldenSide; response: GoldenSide }>
  taskPayloadFingerprint: { command: HostedTaskMutationCommand; expected: string }
  formulas: {
    sourceGeneration: { input: Parameters<typeof hostedTaskBoardSourceGeneration>[0]; expected: string }
    revision: {
      input: { sourceGeneration: string; taskFiles: Array<{ name: string; text: string }>; kanbanText: string | null; rosterFiles: Array<{ name: string; text: string | null }> }
      expected: string
    }
    taskId: { input: { teamId: string; rawTaskId: string }; expected: string }
  }
}

const raw = readFileSync(new URL('../../../docs/hosted-owner-bound-envelope-golden.json', import.meta.url))
const golden = JSON.parse(raw.toString('utf8')) as Golden

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

/** An Owner configured exactly for the golden request, answering with the golden payload. */
async function ownerFor(entry: Golden['cases'][number]) {
  const request = entry.request.unsigned
  const { actorId: _actor, ownerEffectFence: _fence, ...stableAuthority } = request.authority as Json
  const teamId = stableAuthority.teamId as string
  const root = await mkdtemp(join(tmpdir(), 'hosted-owner-bound-golden-')); roots.push(root)
  await mkdir(join(root, 'teams', 'golden'), { recursive: true })
  await writeFile(join(root, 'teams', 'golden', 'team.identity.json'), golden.teamIdentityFile)
  const payload = entry.response.unsigned.payload as Json
  const taskOutcome = (): HostedTaskMutationOutcome => {
    if (payload.kind === 'unavailable') return { result: { kind: 'unavailable' }, selfWriteEffects: [] }
    const { schemaVersion: _schema, selfWriteEffects, ...result } = payload
    return { result: result as HostedTaskMutationTerminalResult, selfWriteEffects: selfWriteEffects as HostedTaskMutationOutcome['selfWriteEffects'] }
  }
  const calls: string[] = []
  return {
    calls,
    dispatcher: new HostedControlDispatcher({
      secret: Buffer.from(golden.proofKeyHex, 'hex'),
      authority: stableAuthority as HostedControlStableAuthority,
      getOwnerBinding: () => request.ownerBinding as HostedControlOwnerBinding,
      lifecycle: { dispatch: async () => { throw new Error('unexpected lifecycle dispatch') } },
      messages: { dispatch: async input => { calls.push(input.operation); return payload } },
      tasks: { mutateWithSelfWriteEffects: async () => { calls.push('task_mutate'); return taskOutcome() } },
      verifyOwnerEffectFence: createHostedTeamIdentityFenceVerifier({ claudeRoot: root, legacyKey: 'golden', teamId }),
    }),
  }
}

describe('hosted owner-bound envelope cross-repository golden', () => {
  test('uses the shared Product-generated vector', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(GOLDEN_SHA256)
    expect(golden.format).toBe('agent-teams.hosted-owner-bound-envelope-golden/v1')
    expect(golden.proofDomain).toBe(HOSTED_TEAM_MESSAGE_PROOF_DOMAIN)
    expect(golden.cases.map(entry => entry.operation).sort()).toEqual(['message_send', 'message_send', 'task_mutate', 'task_mutate'])
  })

  test('verifies every Product request and signs the byte-identical Product response', async () => {
    for (const entry of golden.cases) {
      expect(productOwnerBoundProofInput(golden.proofDomain, entry.operation, 'request', entry.request.unsigned)).toBe(entry.request.proofInput)
      expect(productOwnerBoundProofInput(golden.proofDomain, entry.operation, 'response', entry.response.unsigned)).toBe(entry.response.proofInput)
      const owner = await ownerFor(entry)
      const response = await owner.dispatcher.dispatch({ ...entry.request.unsigned, ownerProof: entry.request.ownerProof })
      expect({ name: entry.name, response: JSON.stringify(response) })
        .toEqual({ name: entry.name, response: JSON.stringify({ ...entry.response.unsigned, ownerProof: entry.response.ownerProof }) })
      expect(owner.calls).toEqual([entry.operation])
    }
  })

  test('computes the Product task fingerprint, source generation, revision and task id', () => {
    expect(fingerprintHostedTaskCommand(golden.taskPayloadFingerprint.command)).toBe(golden.taskPayloadFingerprint.expected)
    const { sourceGeneration, revision, taskId } = golden.formulas
    expect(hostedTaskBoardSourceGeneration(sourceGeneration.input)).toBe(sourceGeneration.expected)
    expect(hostedTaskBoardRevision({
      sourceGeneration: revision.input.sourceGeneration,
      taskTexts: new Map(revision.input.taskFiles.map(file => [file.name, file.text])),
      kanbanText: revision.input.kanbanText,
      rosterHashes: revision.input.rosterFiles.map(file => [file.name, file.text === null ? null : sha256(file.text)] as const),
    })).toBe(revision.expected)
    expect(hostedTaskBoardTaskId(taskId.input.teamId, taskId.input.rawTaskId)).toBe(taskId.expected)
  })
})
