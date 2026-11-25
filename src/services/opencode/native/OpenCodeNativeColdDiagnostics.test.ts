import { describe, expect, test } from 'bun:test'
import { failureDiagnostic } from './fixtures/OpenCodeNativeColdController.js'

describe('cold controller wait diagnostics', () => {
  for (const code of ['ECHILD', 'ESRCH']) {
    test(`retains finite ${code} without the native wait error payload`, () => {
      const error = Object.assign(new Error('TEST private wait message'), {
        code, path: '/TEST-private/controller', cause: 'TEST private cause',
      })
      const diagnostic = failureDiagnostic('A-exit', error)
      expect(diagnostic).toEqual({ phase: 'A-exit', errorClass: 'Error', code, nativeHelper: undefined })
      expect(JSON.stringify(diagnostic)).not.toContain('TEST private')
      expect(JSON.stringify(diagnostic)).not.toContain('/TEST-private')
    })
  }

  test('unrecognized error codes and messages remain bounded unknown facts', () => {
    const error = Object.assign(new Error('TEST private wait message'), { code: 'TEST_PRIVATE_WAIT_TOKEN' })
    expect(failureDiagnostic('B-exit', error)).toEqual({
      phase: 'B-exit', errorClass: 'Error', code: 'other', nativeHelper: undefined,
    })
    expect(failureDiagnostic('B-exit', new Error('ECHILD')).code).toBe('other')
  })

  test('diagnostics do not execute error getters or serializers', () => {
    let reads = 0
    const error = Object.create(Error.prototype)
    for (const key of ['code', 'message', 'stack', 'cause', 'path', 'toJSON']) {
      Object.defineProperty(error, key, { get() { reads++; throw new Error('TEST private getter') } })
    }
    const diagnostic = failureDiagnostic('sentinel-close', error)
    expect(JSON.stringify(diagnostic)).toBe('{"phase":"sentinel-close","errorClass":"Error","code":"other"}')
    expect(reads).toBe(0)
  })

  test('exotic error objects cannot escape the native wait callback through diagnostics', () => {
    const error = new Proxy({}, { getPrototypeOf() { throw new Error('TEST private proxy') } })
    expect(failureDiagnostic('A-exit', error)).toEqual({
      phase: 'A-exit', errorClass: 'other', code: 'other', nativeHelper: undefined,
    })
  })

  test('an opaque failed wait remains unknown rather than implying a missing child', () => {
    for (const error of [null, 'ECHILD', 10, { code: 10 }]) {
      expect(failureDiagnostic('A-exit', error)).toEqual({
        phase: 'A-exit', errorClass: 'other', code: 'other', nativeHelper: undefined,
      })
    }
  })
})
