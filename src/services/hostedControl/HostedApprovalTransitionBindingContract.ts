export const HOSTED_APPROVAL_TRANSITION_CONTRACT_SHA256 =
  'c4304b8eb1ed77145141390294575f403c9f041c6ff6ad5b6f9f21f8b1b9d39e' as const

export const HOSTED_APPROVAL_BINDING_GOLDEN_DIGEST =
  'bffa99076fe5920f8722f7b232a2d6558f786fbc55d3b796220dfa07ca62ec5c' as const

export const HOSTED_APPROVAL_TRANSITION_TEST_KEY_HEX =
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f' as const

/** Frozen contract vectors retained here without importing product runtime. */
export const HOSTED_APPROVAL_TRANSITION_BINDING_VECTORS = [{
  id: 'P03-consume-request',
  direction: 'request',
  canonicalUnsigned: '{"schemaVersion":1,"transitionId":"approval-transition_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","operation":"consume","sequence":2,"deadlineAtMs":1700000006000,"payload":{"leaseId":"approval-transition-lease_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","generation":11,"projectionDigest":"b0fa95dff4eaacd423eca5055dee79ccf23c3da99d6cb7dddafb66e61ad54337","bindingDigest":"bffa99076fe5920f8722f7b232a2d6558f786fbc55d3b796220dfa07ca62ec5c"}}',
  unsignedSha256: '59aa1e3527d9eafc93b7e01472468cdfffd8a07e8119309dfc760bd90290ae57',
  expectedHmacSha256: 'a5c74dc8f46d6801ed71350bda57ae0a3fbc2bbe1e37d830472b5c617bedbb29',
}, {
  id: 'P04-assert-request',
  direction: 'request',
  canonicalUnsigned: '{"schemaVersion":1,"transitionId":"approval-transition_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","operation":"assert","sequence":3,"deadlineAtMs":1700000007000,"payload":{"leaseId":"approval-transition-lease_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","generation":11,"bindingDigest":"bffa99076fe5920f8722f7b232a2d6558f786fbc55d3b796220dfa07ca62ec5c"}}',
  unsignedSha256: '1edf7385360d70293c74af11c32c0103012f69a846c1127e166fec04611fa82a',
  expectedHmacSha256: 'd5551654c156cb3a54cd1fe7b1ec9b02ef1735c172e33be9283953e5ce3424f2',
}] as const
