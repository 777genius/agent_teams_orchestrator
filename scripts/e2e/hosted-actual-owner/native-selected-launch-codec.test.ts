import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { canonicalJson } from './native-http-contract.js'
import { nativeAdmissionFixture, pairedNativeCodecVectors } from './native-admission.fixture.js'
import { admitNativeOwnerLaunch } from './native-launch-admission.js'
import { canonicalSelectedLaunchJson, decodeSelectedLaunchPhase, selectedLaunchBootstrapDeadline,
  SELECTED_LAUNCH_MAGIC, SELECTED_LAUNCH_MAXIMUM } from '../../../src/services/hostedControl/HostedControlSelectedLaunchPhase.js'

function frame(text: string | Buffer) {
  const bytes = Buffer.from(text), prefix = Buffer.alloc(8)
  prefix.writeUInt32BE(SELECTED_LAUNCH_MAGIC); prefix.writeUInt32BE(bytes.length, 4)
  return Buffer.concat([prefix, bytes])
}
test('HSL1 exact keys, canonical UTF8 and aggregate framing reject all suffixes and missing admission', () => {
  const f = nativeAdmissionFixture(), text = canonicalJson(f.phase), encoded = frame(text)
  assert.deepEqual(decodeSelectedLaunchPhase(encoded), f.phase)
  const { nativeAdmission: _removed, ...missing } = f.phase
  for (const bytes of [frame(canonicalJson(missing)), frame(canonicalJson({ ...f.phase, extra: 1 })),
    frame('\ufeff' + text), frame(text + '\n'), frame(text + '{}'), frame(' ' + text),
    frame(text.replace('"contract":', '"contract":null,"contract":')),
    frame(Buffer.from([0xff])), Buffer.concat([encoded, Buffer.from([0])]), encoded.subarray(0, -1),
    frame('x'.repeat(SELECTED_LAUNCH_MAXIMUM + 1)), frame('')]) assert.throws(() => decodeSelectedLaunchPhase(bytes))
  const wrongMagic = Buffer.from(encoded); wrongMagic.writeUInt32BE(0x48534c32)
  assert.throws(() => decodeSelectedLaunchPhase(wrongMagic))
  const exactMaximum = frame('x'.repeat(SELECTED_LAUNCH_MAXIMUM))
  assert.throws(() => decodeSelectedLaunchPhase(exactMaximum), /selection_phase_rejected/)
  assert.equal(canonicalSelectedLaunchJson({ '𐀀': -1, '\ue000': Number.MAX_SAFE_INTEGER }),
    canonicalJson({ '𐀀': -1, '\ue000': Number.MAX_SAFE_INTEGER }))
  assert.throws(() => canonicalSelectedLaunchJson({ n: 0.5 }))
})
test('the retained absolute bootstrap deadline is unchanged and cannot be recovered from JSON or renewed', () => {
  const vector = pairedNativeCodecVectors().find(v => v.generation === 1)!
  const bytes = Buffer.from(vector.frameHex, 'hex'), deadline = performance.now() - 1
  const phase = decodeSelectedLaunchPhase(bytes, deadline)
  assert.equal(selectedLaunchBootstrapDeadline(phase), deadline)
  assert.throws(() => selectedLaunchBootstrapDeadline(structuredClone(phase)), /deadline_missing/)
  assert.throws(() => selectedLaunchBootstrapDeadline(decodeSelectedLaunchPhase(bytes)), /deadline_missing/)
  // Fails before attempting any deployment key/root access.
  assert.throws(() => admitNativeOwnerLaunch(phase), /deadline/)
})
