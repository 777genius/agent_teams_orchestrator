import { expect, test } from 'bun:test'
import { Effect, Schema } from 'effect'
import { LLMRequest } from '@opencode/ai'
import { compileRequest } from '@opencode/ai/route/client'
import { OpenAICompatible } from '@opencode/ai/providers/openai-compatible'
import { OpenAIChat } from '@opencode/ai/protocols/openai-chat'
import { Model } from '@opencode/schema/model'
import { SessionMessage } from '@opencode/schema/session-message'
import { toLLMMessages } from '@opencode/core/session/runner/to-llm-message'

const bytes = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex')
const data = bytes.toString('base64')
const compatible = OpenAICompatible.configure({ provider: 'TEST-openrouter-video', baseURL: 'http://127.0.0.1:1/v1', apiKey: 'TEST-not-a-real-credential' }).model('novel-video')

function request(mime: string, payload = data) {
  const projected = Schema.decodeUnknownSync(SessionMessage.User)({
    type: 'user', id: 'msg_TESTvideo', text: 'Inspect this clip.', time: { created: 0 },
    files: [{ data: payload, mime, source: { type: 'inline' }, name: 'clip' }],
  })
  const messages = toLLMMessages([projected], Model.Ref.parse('TEST-openrouter-video/novel-video'))
  return new LLMRequest({ model: compatible, system: [], messages, tools: [] })
}

// Actual installed core conversion and configured provider compiler, including
// provider body schema validation. No network or model inference is performed.
for (const mime of ['video/mp4', 'video/webm', 'video/quicktime', 'video/mpeg']) {
  test(`native compatible codec retains ${mime} bytes as video_url`, async () => {
    const result = await Effect.runPromise(compileRequest(request(mime)))
    expect(result.body).toMatchObject({ messages: [{ role: 'user', content: [
      { type: 'text', text: 'Inspect this clip.' }, { type: 'video_url', video_url: { url: `data:${mime};base64,${data}` } },
    ] }] })
  })
}

test('native OpenAI codec and unsupported compatible video formats fail explicitly', async () => {
  await expect(Effect.runPromise(OpenAIChat.fromRequest(request('video/mp4')))).rejects.toThrow('does not support media type video/mp4')
  for (const mime of ['video/unsupported', 'video/mp4;unexpected=true']) {
    await expect(Effect.runPromise(compileRequest(request(mime)))).rejects.toThrow('does not support media type')
  }
})

test('compatible codec keeps existing image, PDF, and text attachment routes', async () => {
  const image = await Effect.runPromise(compileRequest(request('image/png')))
  expect(image.body).toMatchObject({ messages: [{ content: [
    { type: 'text' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } },
  ] }] })
  const pdf = await Effect.runPromise(compileRequest(request('application/pdf')))
  expect(pdf.body).toMatchObject({ messages: [{ content: [
    { type: 'text' }, { type: 'file', file: { file_data: `data:application/pdf;base64,${data}` } },
  ] }] })
  const text = await Effect.runPromise(compileRequest(request('text/plain', Buffer.from('TEST reference text').toString('base64'))))
  expect(JSON.stringify(text.body)).toContain('TEST reference text')
})
