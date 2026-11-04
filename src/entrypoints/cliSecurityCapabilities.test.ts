import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('reports managed MCP authorization support before startup without provider configuration', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./cli.tsx', import.meta.url)),
    'runtime', 'security-capabilities', '--json'], {
    env: { PATH: process.env.PATH, NODE_ENV: 'test' },
    encoding: 'utf8',
    timeout: 5_000,
  })
  expect(result.status).toBe(0)
  expect(result.stderr).toBe('')
  expect(JSON.parse(result.stdout)).toEqual({ schemaVersion: 1, mcpHttpAuthorizationHeaders: true })
})
