import { expect, test } from 'bun:test'
import { classifySupervisedProviderOperation } from './OpenCodeSupervisedOperation.js'

test('native request vocabulary rejects alternate methods, paths and query authority', () => {
  for (const [method, path] of [
    ['PUT', '/auth/provider'], ['POST', '/provider/provider/oauth/callback'],
    ['POST', '/permission/reply'], ['GET', '/session/../config'],
    ['GET', '//other/session'], ['POST', '/session/ses_1/abort?extra=1'],
    ['GET', '/experimental/tool/ids?workspace=foreign'],
    ['GET', '/experimental/tool/ids?directory=a&directory=b'],
    ['GET', '/session/ses_1/message?limit=0'], ['GET', '/session/ses_1/message?limit=50&extra=1'],
  ]) expect(() => classifySupervisedProviderOperation(method!, path!)).toThrow()
  expect(classifySupervisedProviderOperation('POST', '/session/ses_1/prompt_async'))
    .toEqual({ kind: 'provider', name: 'prompt-async', method: 'POST', path: '/session/ses_1/prompt_async' })
  expect(classifySupervisedProviderOperation('GET', '/session/ses_1/message?limit=50'))
    .toMatchObject({ name: 'messages-read' })
})
