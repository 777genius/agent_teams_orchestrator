// TEST-only preload for the run control peer: the real provider wire reads through a
// synthetic endpoint that answers every provider read with 404. Nothing else changes.
import { mock } from 'bun:test'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as host from '../../host/OpenCodeV2ExecutionHost.js'

const endpoint = { baseUrl: 'http://127.0.0.1:1', password: 'TEST', signal: new AbortController().signal,
  fetch: async () => new Response(JSON.stringify({ name: 'NotFoundError' }), { status: 404, headers: { 'content-type': 'application/json' } }) }
mock.module(realpathSync(fileURLToPath(import.meta.resolve('../../host/OpenCodeV2ExecutionHost.ts'))),
  () => ({ ...host, requireExecutionEndpoint: () => endpoint }))
