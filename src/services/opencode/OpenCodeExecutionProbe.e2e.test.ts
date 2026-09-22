import { describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { openCodeExecutionProbe } from './OpenCodeExecutionProbe.js'
import { openCodeHostManager } from './OpenCodeHostManager.js'

const liveTest =
  process.env.OPENCODE_E2E === '1'
    ? test
    : test.skip
const fakeLocalE2ETest =
  process.env.OPENCODE_E2E === '1' || process.env.OPENCODE_FAKE_LOCAL_E2E === '1'
    ? test
    : test.skip

async function startFakeOpenAiCompatibleServer(): Promise<{
  baseUrl: string
  requests: string[]
  close: () => Promise<void>
}> {
  const requests: string[] = []
  const server = createServer(async (request, response) => {
    requests.push(`${request.method ?? 'GET'} ${request.url ?? '/'}`)
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        object: 'list',
        data: [{ id: 'qwen-test:0.5b', object: 'model' }],
      }))
      return
    }

    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      const chunks: Buffer[] = []
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
        stream?: boolean
      }
      if (body.stream) {
        const created = Math.floor(Date.now() / 1000)
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        })
        response.write(`data: ${JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion.chunk',
          created,
          model: 'qwen-test:0.5b',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'PONG' },
              finish_reason: null,
            },
          ],
        })}\n\n`)
        response.write(`data: ${JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion.chunk',
          created,
          model: 'qwen-test:0.5b',
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: 'stop',
            },
          ],
        })}\n\n`)
        response.end('data: [DONE]\n\n')
        return
      }

      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'PONG' },
            finish_reason: 'stop',
          },
        ],
      }))
      return
    }

    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'not found' } }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    await closeServer(server)
    throw new Error('Fake OpenAI-compatible server did not bind to a TCP port')
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => closeServer(server),
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
}

describe('OpenCodeExecutionProbe live e2e', () => {
  liveTest('verifies execution on a real OpenCode model', async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), 'opencode-execution-probe-live-'))

    try {
      const result = await openCodeExecutionProbe.probeModel({
        selectedModel: 'opencode/big-pickle',
        projectPath,
      })

      expect(result.outcome).toBe('available')
      expect(result.durableState).toBe('idle')
      expect(result.latestAssistantText?.toUpperCase()).toContain('PONG')
    } finally {
      await openCodeHostManager.reconcilePersistentHosts({
        mode: 'force',
        reason: 'opencode_execution_probe_live_e2e_cleanup',
        projectPath,
        staleAgeMs: 0,
        leaseStaleAgeMs: 0,
        preflightLeaseStaleAgeMs: 0,
      }).catch(() => undefined)
      await rm(projectPath, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 150_000)

  fakeLocalE2ETest('verifies a configured local OpenAI-compatible provider without credentials', async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), 'opencode-local-provider-e2e-'))
    const fakeServer = await startFakeOpenAiCompatibleServer()

    try {
      await writeFile(
        path.join(projectPath, 'opencode.json'),
        `${JSON.stringify({
          provider: {
            'llama.cpp': {
              npm: '@ai-sdk/openai-compatible',
              options: {
                baseURL: `${fakeServer.baseUrl}/v1`,
              },
              models: {
                'qwen-test:0.5b': {},
              },
            },
          },
          model: 'llama.cpp/qwen-test:0.5b',
        }, null, 2)}\n`,
        'utf8',
      )

      const result = await openCodeExecutionProbe.probeModel({
        selectedModel: 'llama.cpp/qwen-test:0.5b',
        projectPath,
      })

      expect(result.outcome).toBe('available')
      expect(result.latestAssistantText?.toUpperCase()).toContain('PONG')
      expect(fakeServer.requests).toContain('POST /v1/chat/completions')
    } finally {
      await openCodeHostManager.reconcilePersistentHosts({
        mode: 'force',
        reason: 'opencode_local_provider_fake_e2e_cleanup',
        projectPath,
        staleAgeMs: 0,
        leaseStaleAgeMs: 0,
        preflightLeaseStaleAgeMs: 0,
      }).catch(() => undefined)
      await fakeServer.close().catch(() => undefined)
      await rm(projectPath, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 150_000)
})
