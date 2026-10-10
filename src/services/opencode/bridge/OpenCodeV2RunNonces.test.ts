import { expect, test } from 'bun:test'
import { OpenCodeV2RunNonces } from './OpenCodeV2RunNonces.js'

const nonce = (index: number) => index.toString(16).padStart(64, '0')

test('long-running fresh CLI polling does not consume permanent run authority', () => {
  const history = new OpenCodeV2RunNonces()
  for (let index = 0; index < 10_000; index++) {
    const now = 100_000 + index * 1000
    history.claim(nonce(index), now + 5000, 'status', now)
  }
  history.claim(nonce(10_000), 10_105_000, 'stop', 10_100_000)
})

test('a saturated observation channel retains bounded reserved scoped-stop slots', () => {
  const history = new OpenCodeV2RunNonces(), now = 100_000
  for (let index = 0; index < 4088; index++) history.claim(nonce(index), now + 30_000, 'status', now)
  expect(() => history.claim(nonce(4088), now + 30_000, 'observe', now)).toThrow('run_control_replay')
  for (let index = 4088; index < 4096; index++) history.claim(nonce(index), now + 30_000, 'stop', now)
  expect(() => history.claim(nonce(4096), now + 30_000, 'stop', now)).toThrow('run_control_replay')
  history.claim(nonce(4096), now + 60_000, 'stop', now + 30_000)
})

test('expired signed frames cannot replay after their history is pruned', () => {
  const history = new OpenCodeV2RunNonces(), now = 100_000
  history.claim(nonce(1), now + 1000, 'send', now)
  expect(() => history.claim(nonce(1), now + 1000, 'send', now + 1)).toThrow('run_control_replay')
  expect(() => history.claim(nonce(1), now + 1000, 'send', now + 1000)).toThrow('run_control_timeout')
  history.claim(nonce(2), now + 31_000, 'status', now + 1000)
  expect(() => history.claim(nonce(1), now + 1000, 'send', now + 1001)).toThrow('run_control_timeout')
  expect(() => history.claim(nonce(3), now + 31_002, 'status', now + 1001)).toThrow('run_control_timeout')
})
