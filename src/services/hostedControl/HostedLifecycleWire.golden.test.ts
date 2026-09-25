import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { HostedControlDispatcher, type HostedLifecycleOperation } from './HostedControlDispatcher.js'
import {
  createHostedCanonicalReadinessResponseLine,
  decodeHostedReadinessRequest,
  HOSTED_LIFECYCLE_PROOF_DOMAIN,
} from './HostedControlServer.js'
import type { HostedControlBootstrapBinding } from './HostedControlBootstrap.js'
import type { HostedControlOwnerBinding, HostedControlStableAuthority } from './protocol.js'

// The same bytes live in agent-teams-ai docs/; both repositories pin this digest.
const GOLDEN_SHA256 = '3c823d960067add34992e115aa07c4931ec223de625613ee9d12ffcb19eaf159'

type Json = Record<string, unknown>
type Golden = {
  format: string
  proofDomain: string
  proofKeyHex: string
  ownerAuthority: HostedControlStableAuthority
  ownerBinding: HostedControlOwnerBinding
  bootstrapBinding: HostedControlBootstrapBinding
  readiness: { requestLine: string; responseLine: string }
  cases: Array<{
    name: string
    operation: HostedLifecycleOperation
    requestLine: string
    ownerResult: { payload: Json; resourceRevision: string | null }
    responseLine: string
  }>
}

const raw = readFileSync(new URL('../../../docs/hosted-lifecycle-wire-golden.json', import.meta.url))
const golden = JSON.parse(raw.toString('utf8')) as Golden
const secret = Buffer.from(golden.proofKeyHex, 'hex')

/** The broker hands the dispatcher the frame without its terminating newline. */
function frame(lineWithNewline: string): string {
  expect(lineWithNewline.endsWith('\n')).toBe(true)
  return lineWithNewline.slice(0, -1)
}

describe('hosted lifecycle wire cross-repository golden', () => {
  test('uses the shared Product-generated vector', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(GOLDEN_SHA256)
    expect(golden.format).toBe('agent-teams.hosted-lifecycle-wire-golden/v1')
    expect(golden.proofDomain).toBe(HOSTED_LIFECYCLE_PROOF_DOMAIN)
    expect(golden.cases.map(entry => entry.operation))
      .toEqual(['control_state', 'get_provisioning_status', 'authorize', 'replay_lookup', 'execute'])
  })

  test('admits the Product readiness request and answers with the byte-identical ready frame', () => {
    const line = frame(golden.readiness.requestLine)
    const admission = decodeHostedReadinessRequest({
      secret,
      authority: golden.ownerAuthority,
      ownerBinding: golden.ownerBinding,
      bootstrapBinding: golden.bootstrapBinding,
      line,
      message: JSON.parse(line) as Json,
    })
    if (admission.protocol !== 'canonical') throw new Error('Product readiness must be canonical')
    expect(createHostedCanonicalReadinessResponseLine(secret, admission, golden.ownerBinding))
      .toBe(golden.readiness.responseLine)
  })

  test('verifies every Product lifecycle request and signs the byte-identical Product response', async () => {
    for (const entry of golden.cases) {
      const calls: string[] = []
      const dispatcher = new HostedControlDispatcher({
        secret,
        authority: golden.ownerAuthority,
        getOwnerBinding: () => golden.ownerBinding,
        lifecycle: { dispatch: async input => { calls.push(input.operation); return entry.ownerResult } },
        messages: { dispatch: async () => { throw new Error('unexpected message dispatch') } },
      })
      const line = frame(entry.requestLine)
      const response = await dispatcher.dispatch(JSON.parse(line) as Json, line)
      expect({ name: entry.name, response: `${JSON.stringify(response)}\n` })
        .toEqual({ name: entry.name, response: entry.responseLine })
      expect(calls).toEqual([entry.operation])
    }
  })
})
