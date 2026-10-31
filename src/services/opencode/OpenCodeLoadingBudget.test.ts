import { expect, test } from 'bun:test'
import { OPEN_CODE_LOADING_TIMEOUT_MS } from './OpenCodeLoadingBudget.js'
import { openCodeV2ActivationDeadline, openCodeV2RunInitializationMs } from './execution/OpenCodeV2ExecutionContracts.js'

test('cold loading gets three minutes and does not reduce existing five-minute platform initialization', () => {
  expect(OPEN_CODE_LOADING_TIMEOUT_MS).toBe(180_000)
  expect(openCodeV2RunInitializationMs('linux')).toBe(180_000)
  expect(openCodeV2RunInitializationMs('win32')).toBe(300_000)
  expect(openCodeV2RunInitializationMs('darwin')).toBe(300_000)
})
test('initialization always clips to the original caller and acquisition deadlines', () => {
  expect(openCodeV2ActivationDeadline(1_060_000, 1_000_000, 'linux')).toBe(1_060_000)
  expect(openCodeV2ActivationDeadline(1_600_000, 1_000_000, 'linux')).toBe(1_180_000)
  expect(openCodeV2ActivationDeadline(1_600_000, 1_000_000, 'win32')).toBe(1_300_000)
})
