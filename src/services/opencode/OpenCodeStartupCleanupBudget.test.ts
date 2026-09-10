import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { OpenCodeStartupCleanupBudget } from './OpenCodeStartupCleanupBudget.js'
afterEach(() => mock.restore())

test('startup deadline validates before mutation and is monotonic across wall-clock changes', () => {
  spyOn(Date, 'now').mockReturnValue(10_000)
  for (const value of [undefined, null, '11000', NaN, Infinity, 10_000, 9_999, 130_001]) {
    expect(() => new OpenCodeStartupCleanupBudget(value)).toThrow()
  }
  let now = 0
  const budget = new OpenCodeStartupCleanupBudget(130_000, () => now)
  now = 12_000 // frontend enumeration allowance consumes the same absolute deadline
  expect(budget.cap(20_000)).toBe(20_000)
  spyOn(Date, 'now').mockReturnValue(-100_000)
  now = 116_000
  expect(budget.cap(6_000)).toBe(4_000)
  now = 120_000
  expect(() => budget.cap(6_000)).toThrow('exhausted')
})
