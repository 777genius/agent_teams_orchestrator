import { describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { createLSPClient } from './LSPClient.js'

const itOnWindows = process.platform === 'win32' ? it : it.skip

async function readFileWithRetry(path: string): Promise<string> {
  let lastError: unknown
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      lastError = error
      await delay(25)
    }
  }
  throw lastError
}

describe('createLSPClient', () => {
  itOnWindows('starts npm-style .cmd launchers without shell arg splitting', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'lsp-cmd-launcher-'))
    const scriptPath = join(tempDir, 'fake-lsp.cjs')
    const shimPath = join(tempDir, 'fake-lsp.cmd')
    const argPath = join(tempDir, 'args.json')

    await writeFile(
      scriptPath,
      String.raw`
const { writeFileSync } = require('node:fs')

if (process.env.FAKE_LSP_ARG_FILE) {
  writeFileSync(process.env.FAKE_LSP_ARG_FILE, JSON.stringify(process.argv.slice(2)))
}

let buffer = Buffer.alloc(0)

function send(message) {
  const body = JSON.stringify(message)
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body, 'utf8') + '\r\n\r\n' + body)
}

process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk])

  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd === -1) {
      return
    }

    const header = buffer.subarray(0, headerEnd).toString('ascii')
    const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header)
    if (!lengthMatch) {
      process.exit(2)
    }

    const bodyStart = headerEnd + 4
    const bodyLength = Number(lengthMatch[1])
    if (buffer.length < bodyStart + bodyLength) {
      return
    }

    const body = buffer.subarray(bodyStart, bodyStart + bodyLength).toString('utf8')
    buffer = buffer.subarray(bodyStart + bodyLength)
    const message = JSON.parse(body)

    if (message.method === 'shutdown' && message.id !== undefined) {
      send({ jsonrpc: '2.0', id: message.id, result: null })
    } else if (message.method === 'exit') {
      process.exit(0)
    }
  }
})
`,
    )
    await writeFile(
      shimPath,
      [
        '@ECHO off',
        'SETLOCAL',
        'SET "_prog=node"',
        '"%_prog%" "%~dp0\\fake-lsp.cjs" %*',
      ].join('\r\n'),
    )

    const client = createLSPClient('fake-lsp')

    try {
      await client.start(shimPath, ['A&B', '%PATH%'], {
        env: { FAKE_LSP_ARG_FILE: argPath },
      })

      const forwardedArgs = JSON.parse(await readFileWithRetry(argPath))
      expect(forwardedArgs).toEqual(['A&B', '%PATH%'])
    } finally {
      await client.stop().catch(() => undefined)
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
