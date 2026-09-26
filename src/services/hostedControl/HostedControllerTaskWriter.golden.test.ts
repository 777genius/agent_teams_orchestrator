import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { decodeCommandOutput, HostedControllerTaskWriter } from './HostedControllerTaskWriter.js'
import type { HostedTaskMutationRequest } from './protocol.js'

// The same bytes live in agent-teams-ai docs/; both repositories pin this digest. Product
// generates the cases by running the real `--hosted-task-command` of its MCP bundle.
const GOLDEN_SHA256 = '1bc4ccaa4ce2cca7c8f80bc92aeafb1173d890a28d27a9b34f2a963feeb861f5'
const GOLDEN_PATH = resolve(import.meta.dir, '../../../docs/hosted-task-command-golden.json')
const STUB = join(import.meta.dir, 'fixtures', 'hostedTaskCommandStub.cjs')

type GoldenCase = {
  name: string
  input: {
    teamName: string
    board: { deploymentId: string; bootId: string; workspaceId: string; mountGeneration: number; teamId: string }
    lockTimeoutMs: number
    payloadFingerprint: string
    command: HostedTaskMutationRequest['payload']['command']
  }
  exitCode: number
  output: unknown
}

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

const raw = await readFile(GOLDEN_PATH)
const golden = JSON.parse(raw.toString('utf8')) as { format: string; cases: GoldenCase[] }

describe('hosted task command golden', () => {
  test('is the pinned cross-repository file', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(GOLDEN_SHA256)
    expect(golden.format).toBe('agent-teams.hosted-task-command-golden/v1')
    expect(golden.cases.length).toBeGreaterThan(0)
  })

  // A case whose input the Owner cannot produce (a malformed request) only checks the answer.
  const ownerInput = (goldenCase: GoldenCase): GoldenCase['input'] =>
    'command' in goldenCase.input ? goldenCase.input : golden.cases[0]!.input

  for (const goldenCase of golden.cases) {
    test(`${goldenCase.name}: the Owner sends exactly the input and accepts the answer`, async () => {
      const input = ownerInput(goldenCase)
      const root = await realpath(await mkdtemp(join(tmpdir(), 'hosted-task-golden-')))
      roots.push(root)
      await writeFile(join(root, 'mode.json'), JSON.stringify({
        stdout: `${JSON.stringify(goldenCase.output)}\n`,
        exit: goldenCase.exitCode,
      }))
      const { board } = input
      const authority = {
        deploymentId: board.deploymentId,
        bootId: board.bootId,
        restoreGeneration: 1,
        workspaceId: board.workspaceId,
        mountBinding: { mountGeneration: board.mountGeneration, declaredRootHash: 'a'.repeat(64) },
        teamId: board.teamId,
      }
      const writer = new HostedControllerTaskWriter({
        command: process.execPath,
        entry: STUB,
        claudeRoot: root,
        legacyKey: input.teamName,
        authority,
        isCurrent: () => true,
        lockTimeoutMs: input.lockTimeoutMs,
        reportDiagnostic: () => undefined,
      })
      const request = {
        schemaVersion: 2,
        exchangeId: `task-request_${'2'.repeat(32)}`,
        operation: 'task_mutate',
        ownerBinding: {
          ownerAuthority: 'owner-authority_golden',
          ownerGeneration: 1,
          ownerSessionId: 'owner-session_golden',
          socketIdentity: { device: '1', inode: '2', uid: 501, gid: 20, mode: 0o600 },
        },
        authority: { actorId: 'actor_golden', ...authority },
        payload: { command: input.command, payloadFingerprint: input.payloadFingerprint },
        ownerProof: '',
      } as HostedTaskMutationRequest

      const outcome = await writer.mutateWithSelfWriteEffects(request)
      const seen = JSON.parse(await readFile(join(root, 'seen.json'), 'utf8')) as { input: unknown }
      expect(seen.input).toEqual(input)
      if (goldenCase.exitCode === 0) {
        expect(outcome).toEqual(decodeCommandOutput(`${JSON.stringify(goldenCase.output)}\n`))
      } else {
        expect(outcome).toEqual({ result: { kind: 'unavailable', retryAfterMs: 1_000 }, selfWriteEffects: [] })
      }
    })
  }
})
