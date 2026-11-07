import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createModelListCommand } from './modelListCommand.js'

describe('model list CLI contract', () => {
  test('preserves an explicit project with spaces as a single value', async () => {
    let args: unknown
    await createModelListCommand(async opts => { args = opts }).parseAsync([
      '--json', '--provider', 'opencode',
      '--project-path', '/Users/TEST/Library/CloudStorage/GoogleDrive/My Portfolio',
    ], { from: 'user' })
    expect(args).toMatchObject({
      json: true, provider: 'opencode',
      projectPath: '/Users/TEST/Library/CloudStorage/GoogleDrive/My Portfolio',
    })
  })
  test('source CLI model list returns a real JSON payload instead of silent exit 0', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'TEST-model-list-cli-'))
    try {
      // Exercise the same lightweight dispatch used by packaged Bun. Static
      // Gemini inventory needs no provider API, subscription or model launch.
      const entry = path.resolve(import.meta.dir, '../entrypoints/cli.tsx')
      const result = spawnSync(process.execPath,
        ['--no-install', entry, 'model', 'list', '--json', '--provider', 'gemini'], {
          cwd: home,
          env: {
            PATH: process.env.PATH ?? '',
            HOME: home, USERPROFILE: home,
            XDG_CONFIG_HOME: path.join(home, '.config'),
            XDG_DATA_HOME: path.join(home, '.local', 'share'),
            XDG_CACHE_HOME: path.join(home, '.cache'),
            NO_COLOR: '1',
            ...(process.platform === 'win32' ? {
              SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec,
              APPDATA: path.join(home, 'appdata'),
              LOCALAPPDATA: path.join(home, 'local-appdata'),
            } : {}),
          },
          encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
        })
      expect(result.status, result.stderr).toBe(0)
      const payload = JSON.parse(result.stdout) as { schemaVersion: number; providers?: Record<string, unknown> }
      expect(payload.schemaVersion).toBe(1)
      expect(payload.providers?.gemini).toBeDefined()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 35_000)

  test('preserves old calls without the project option', async () => {
    let args: unknown
    await createModelListCommand(async opts => { args = opts }).parseAsync([
      '--provider', 'opencode', '--json',
    ], { from: 'user' })
    expect(args).toMatchObject({ provider: 'opencode', json: true })
    expect(args).not.toHaveProperty('projectPath', '/Users/TEST')
  })
})
