import { describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { OpenCodeClientFactory } from './OpenCodeClientFactory.js'
import { getOpenCodeCuratedSubscriptionProviderConfigs } from './OpenCodeCuratedSubscriptionCatalog.js'
import { openCodeEventTranslator } from './OpenCodeEventTranslator.js'
import { openCodeHostManager } from './OpenCodeHostManager.js'

const transportE2ETest =
  process.env.OPENCODE_SUBSCRIPTION_TRANSPORT_FAKE_E2E === '1' ? test : test.skip

type ChatRequest = {
  model?: string
  messages?: Array<Record<string, unknown>>
  tools?: Array<{
    type?: string
    function?: {
      name?: string
      parameters?: {
        properties?: Record<string, unknown>
      }
    }
  }>
  stream?: boolean
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
}

function writeStreamChunk(response: import('node:http').ServerResponse, chunk: unknown): void {
  response.write(`data: ${JSON.stringify(chunk)}\n\n`)
}

async function startToolLoopServer(input: {
  modelId: string
  projectPath: string
  marker: string
}): Promise<{
  baseUrl: string
  chatRequests: ChatRequest[]
  close: () => Promise<void>
}> {
  const chatRequests: ChatRequest[] = []
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'not found' } }))
      return
    }

    const chunks: Buffer[] = []
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as ChatRequest
    chatRequests.push(body)

    const serializedMessages = JSON.stringify(body.messages ?? [])
    const isTransportProbe = serializedMessages.includes(input.marker)
    const hasToolResult = body.messages?.some(message => message.role === 'tool') === true
    const created = Math.floor(Date.now() / 1000)
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    })

    if (isTransportProbe && !hasToolResult) {
      const readTool = body.tools?.find(tool => tool.function?.name === 'read')
      const properties = readTool?.function?.parameters?.properties ?? {}
      const pathProperty = ['filePath', 'file_path', 'path'].find(key => key in properties)
      if (!readTool?.function?.name || !pathProperty) {
        writeStreamChunk(response, {
          id: 'chatcmpl-transport-missing-tool',
          object: 'chat.completion.chunk',
          created,
          model: input.modelId,
          choices: [{
            index: 0,
            delta: { role: 'assistant', content: 'READ_TOOL_UNAVAILABLE' },
            finish_reason: 'stop',
          }],
        })
        response.end('data: [DONE]\n\n')
        return
      }

      const toolArguments = JSON.stringify({
        [pathProperty]: path.join(input.projectPath, 'README.md'),
      })
      const splitAt = Math.max(1, Math.floor(toolArguments.length / 2))
      writeStreamChunk(response, {
        id: 'chatcmpl-transport-tool',
        object: 'chat.completion.chunk',
        created,
        model: input.modelId,
        choices: [{
          index: 0,
          delta: { role: 'assistant', reasoning_content: 'transport-reasoning' },
          finish_reason: null,
        }],
      })
      writeStreamChunk(response, {
        id: 'chatcmpl-transport-tool',
        object: 'chat.completion.chunk',
        created,
        model: input.modelId,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_transport_read',
              type: 'function',
              function: {
                name: readTool.function.name,
                arguments: toolArguments.slice(0, splitAt),
              },
            }],
          },
          finish_reason: null,
        }],
      })
      writeStreamChunk(response, {
        id: 'chatcmpl-transport-tool',
        object: 'chat.completion.chunk',
        created,
        model: input.modelId,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: toolArguments.slice(splitAt) },
            }],
          },
          finish_reason: null,
        }],
      })
      writeStreamChunk(response, {
        id: 'chatcmpl-transport-tool',
        object: 'chat.completion.chunk',
        created,
        model: input.modelId,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      })
      response.end('data: [DONE]\n\n')
      return
    }

    writeStreamChunk(response, {
      id: 'chatcmpl-transport-final',
      object: 'chat.completion.chunk',
      created,
      model: input.modelId,
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          reasoning_content: isTransportProbe ? 'final-reasoning' : undefined,
          content: isTransportProbe ? 'TRANSPORT_PONG' : 'PONG',
        },
        finish_reason: null,
      }],
    })
    writeStreamChunk(response, {
      id: 'chatcmpl-transport-final',
      object: 'chat.completion.chunk',
      created,
      model: input.modelId,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })
    response.end('data: [DONE]\n\n')
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    await closeServer(server)
    throw new Error('Fake subscription transport server did not bind to a TCP port')
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    chatRequests,
    close: () => closeServer(server),
  }
}

const TRANSPORT_CASES = [
  {
    sourceProviderId: 'zai-coding-plan',
    testProviderId: 'zai-transport-proof',
    modelId: 'glm-5.2',
  },
  {
    sourceProviderId: 'kimi-for-coding',
    testProviderId: 'kimi-transport-proof',
    modelId: 'kimi-for-coding',
  },
  {
    sourceProviderId: 'xiaomi-token-plan-ams',
    testProviderId: 'mimo-transport-proof',
    modelId: 'mimo-v2.5-pro',
  },
] as const

describe('OpenCode curated subscription transport e2e', () => {
  for (const transportCase of TRANSPORT_CASES) {
    transportE2ETest(
      `preserves reasoning and completes a streamed tool loop for ${transportCase.sourceProviderId}`,
      async () => {
        const projectPath = await mkdtemp(path.join(os.tmpdir(), 'opencode-subscription-transport-'))
        const marker = `TOOL_TRANSPORT_PROBE_${transportCase.testProviderId}`
        const server = await startToolLoopServer({
          modelId: transportCase.modelId,
          projectPath,
          marker,
        })
        let hostKey: string | null = null

        try {
          const sourceConfig = getOpenCodeCuratedSubscriptionProviderConfigs()[
            transportCase.sourceProviderId
          ] as {
            options?: Record<string, unknown>
            models?: Record<string, unknown>
            [key: string]: unknown
          }
          expect(sourceConfig).toBeDefined()
          await writeFile(path.join(projectPath, 'README.md'), 'transport tool proof\n', 'utf8')
          await writeFile(
            path.join(projectPath, 'opencode.json'),
            `${JSON.stringify({
              provider: {
                [transportCase.testProviderId]: {
                  ...sourceConfig,
                  options: {
                    ...(sourceConfig.options ?? {}),
                    baseURL: server.baseUrl,
                  },
                },
              },
              model: `${transportCase.testProviderId}/${transportCase.modelId}`,
            }, null, 2)}\n`,
            'utf8',
          )

          const host = await openCodeHostManager.ensureHost({
            projectPath,
            profileOptions: {
              includeAppMcp: false,
              includeManagedSubscriptionPlugins: false,
              toolApprovalMode: 'auto',
            },
            hostLifetime: 'process',
          })
          hostKey = host.hostKey
          const client = new OpenCodeClientFactory().create(host.baseUrl)
          const session = await client.createSession({ title: marker })
          await client.promptSessionAsync(session.id, {
            agent: 'teammate',
            model: {
              providerID: transportCase.testProviderId,
              modelID: transportCase.modelId,
            },
            parts: [{ type: 'text', text: `${marker}. Read README.md, then reply TRANSPORT_PONG.` }],
          })

          const deadline = Date.now() + 45_000
          let summary: ReturnType<typeof openCodeEventTranslator.reconcileSessionMessages> | null = null
          while (Date.now() < deadline) {
            const [statuses, messages] = await Promise.all([
              client.getSessionStatus(),
              client.getSessionMessages(session.id),
            ])
            summary = openCodeEventTranslator.reconcileSessionMessages({
              sessionId: session.id,
              rawStatus: statuses[session.id] ?? null,
              messages,
            })
            if (summary.durableState === 'idle' && summary.latestAssistantText === 'TRANSPORT_PONG') {
              break
            }
            await new Promise(resolve => setTimeout(resolve, 100))
          }

          expect(summary?.durableState).toBe('idle')
          expect(summary?.latestAssistantText).toBe('TRANSPORT_PONG')
          expect(summary?.toolCallCount).toBeGreaterThanOrEqual(1)

          const probeRequests = server.chatRequests.filter(request =>
            JSON.stringify(request.messages ?? []).includes(marker)
          )
          expect(probeRequests.length).toBeGreaterThanOrEqual(2)
          expect(probeRequests[0]?.model).toBe(transportCase.modelId)
          expect(probeRequests[0]?.stream).toBe(true)
          expect(probeRequests[0]?.tools?.some(tool => tool.function?.name === 'read')).toBe(true)

          const followUpMessages = probeRequests[probeRequests.length - 1]?.messages ?? []
          expect(followUpMessages).toEqual(expect.arrayContaining([
            expect.objectContaining({
              role: 'assistant',
              reasoning_content: 'transport-reasoning',
              tool_calls: expect.any(Array),
            }),
            expect.objectContaining({
              role: 'tool',
              tool_call_id: 'call_transport_read',
            }),
          ]))
        } finally {
          if (hostKey) {
            await openCodeHostManager.releaseHost(hostKey).catch(() => undefined)
          }
          await openCodeHostManager.reconcilePersistentHosts({
            mode: 'force',
            reason: 'subscription_transport_e2e_cleanup',
            projectPath,
            staleAgeMs: 0,
            leaseStaleAgeMs: 0,
            preflightLeaseStaleAgeMs: 0,
          }).catch(() => undefined)
          await server.close().catch(() => undefined)
          await rm(projectPath, { recursive: true, force: true }).catch(() => undefined)
        }
      },
      90_000,
    )
  }
})
