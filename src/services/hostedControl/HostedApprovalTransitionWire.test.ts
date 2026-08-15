import { describe, expect, test } from 'bun:test'

import fixture from './HostedApprovalTransitionWire.contract.json'
import {
  HOSTED_APPROVAL_TRANSITION_CONTRACT_JSON_SHA256,
  HOSTED_APPROVAL_TRANSITION_MAX_FRAME_BYTES,
  admitHostedApprovalTransitionDeadline,
  createHostedApprovalTransitionProof,
  digestHostedApprovalTransitionUnsigned,
  parseHostedApprovalTransitionRequestFrame,
  parseHostedApprovalTransitionResponseFrame,
} from './HostedApprovalTransitionWire.js'

const secret = Buffer.from(fixture.testOnlyKeyHex, 'hex')
const signed = (vector: (typeof fixture.vectors)[number]) => Buffer.from(
  `${vector.canonicalUnsigned.slice(0, -1)},"ownerProof":"${vector.expectedHmacSha256}"}\n`,
)

describe('HostedApprovalTransitionWire frozen contract', () => {
  test('pins the frozen artifact and reproduces every retained golden digest and HMAC', () => {
    expect(String(HOSTED_APPROVAL_TRANSITION_CONTRACT_JSON_SHA256)).toBe(fixture.contractSha256)
    for (const vector of fixture.vectors) {
      expect(digestHostedApprovalTransitionUnsigned(vector.canonicalUnsigned)).toBe(vector.unsignedSha256)
      expect(createHostedApprovalTransitionProof(secret, vector.direction as 'request' | 'response', vector.canonicalUnsigned))
        .toBe(vector.expectedHmacSha256)
      if ('canonical' in vector && vector.canonical === false) {
        expect(() => parseHostedApprovalTransitionRequestFrame(signed(vector), secret)).toThrow()
      } else {
        const parsed = vector.direction === 'request'
          ? parseHostedApprovalTransitionRequestFrame(signed(vector), secret)
          : parseHostedApprovalTransitionResponseFrame(signed(vector), secret)
        expect(parsed.serializedUnsignedEnvelope).toBe(vector.canonicalUnsigned)
      }
    }
  })

  test('rejects noncanonical, duplicate, proof-not-last, malformed UTF-8 and bad HMAC frames', () => {
    const release = fixture.vectors.find(vector => vector.id === 'P06-release-request')!
    const valid = signed(release)
    const line = valid.subarray(0, -1).toString()
    const cases = [
      Buffer.from(`${line.slice(0, -1)},"extra":null}\n`),
      Buffer.from(`${line.slice(0, line.indexOf('"operation"'))}"operation":"release",${line.slice(line.indexOf('"operation"'))}\n`),
      Buffer.from(`${line} \n`),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), valid]),
      Buffer.from('{"x":"\xc3("}\n', 'binary'),
      Buffer.from(line.replace(release.expectedHmacSha256, '0'.repeat(64)) + '\n'),
    ]
    for (const frame of cases) expect(() => parseHostedApprovalTransitionRequestFrame(frame, secret)).toThrow()
  })

  test('enforces the exact including-LF frame ceiling and monotonic deadlines', () => {
    expect(() => parseHostedApprovalTransitionRequestFrame(Buffer.alloc(HOSTED_APPROVAL_TRANSITION_MAX_FRAME_BYTES + 1, 0x78), secret)).toThrow()
    const deadline = admitHostedApprovalTransitionDeadline('assert', 3_000, 1_000, 50)
    expect(deadline.monotonicDeadlineMs).toBe(2_050)
    expect(() => admitHostedApprovalTransitionDeadline('assert', 3_001, 1_000, 50)).toThrow('deadline')
    expect(() => admitHostedApprovalTransitionDeadline('release', 1_000, 1_000, 50)).toThrow('deadline')
  })
})
