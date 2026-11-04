import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'bun:test'

import { createCodexNativeHomeOverlay } from './nativeHomeOverlay.js'

test('fresh overlays mount only owned sessions and cleanup preserves the target on this platform', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'TEST-codex-overlay-'))
  const source = path.join(root, 'source')
  const sessions = path.join(root, 'owned-sessions')
  await mkdir(path.join(source, 'sessions'), { recursive: true })
  await mkdir(sessions)
  await writeFile(path.join(source, 'auth.json'), '{"test":true}')
  for (const name of ['config.toml', 'history.jsonl', 'session_index.jsonl', 'state_5.sqlite', 'state_5.sqlite-wal', 'state_5.sqlite-shm']) {
    await writeFile(path.join(source, name), 'source must not be imported')
  }
  await writeFile(path.join(source, 'sessions', 'foreign.jsonl'), 'foreign')
  await writeFile(path.join(sessions, 'sentinel'), 'owned')
  try {
    for (let turn = 0; turn < 2; turn++) {
      const overlay = await createCodexNativeHomeOverlay({
        env: { CODEX_HOME: source, CODEX_SQLITE_HOME: path.join(source, 'foreign-db') },
        sessionsDirectory: sessions,
        loopbackOverlayToml: 'model_provider = "TEST-local"\n',
      })
      const home = overlay.env.CODEX_HOME!
      try {
        expect(overlay.env.CODEX_SQLITE_HOME).toBe(home)
        expect(overlay.configOverrides).toEqual([`sqlite_home=${JSON.stringify(home)}`])
        expect((await readdir(home)).sort()).toEqual(['auth.json', 'config.toml', 'sessions'])
        expect(await readFile(path.join(home, 'auth.json'), 'utf8')).toBe('{"test":true}')
        expect(await readFile(path.join(home, 'config.toml'), 'utf8')).toBe('model_provider = "TEST-local"\n')
        expect(await readFile(path.join(home, 'sessions', 'sentinel'), 'utf8')).toBe('owned')
        expect(existsSync(path.join(home, 'sessions', 'foreign.jsonl'))).toBe(false)
        await writeFile(path.join(home, 'sessions', `turn-${turn}.jsonl`), 'rollout')
      } finally { await overlay.cleanup() }
      expect(existsSync(home)).toBe(false)
      expect(await readFile(path.join(sessions, 'sentinel'), 'utf8')).toBe('owned')
      expect(await readFile(path.join(sessions, `turn-${turn}.jsonl`), 'utf8')).toBe('rollout')
    }
    expect(await readFile(path.join(source, 'config.toml'), 'utf8')).toBe('source must not be imported')
    expect(await readFile(path.join(source, 'sessions', 'foreign.jsonl'), 'utf8')).toBe('foreign')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('explicit user-config inheritance copies config without allowing overlay writes into its source', async () => {
  const source = await mkdtemp(path.join(tmpdir(), 'TEST-codex-config-'))
  await writeFile(path.join(source, 'config.toml'), 'model = "TEST-user-model"\n')
  try {
    const overlay = await createCodexNativeHomeOverlay({
      env: { CODEX_HOME: source }, includeUserConfig: true,
      loopbackOverlayToml: '[model_providers.TEST]\nexperimental_bearer_token="test-secret"\n',
    })
    try {
      expect(await readFile(path.join(overlay.env.CODEX_HOME!, 'config.toml'), 'utf8')).toBe('model = "TEST-user-model"\n')
      await writeFile(path.join(overlay.env.CODEX_HOME!, 'config.toml'), 'changed only in overlay')
      expect(await readFile(path.join(source, 'config.toml'), 'utf8')).toBe('model = "TEST-user-model"\n')
    } finally { await overlay.cleanup() }
  } finally { await rm(source, { recursive: true, force: true }) }
})

test('invalid owned session storage refuses the launch instead of silently copying or creating it', async () => {
  const source = await mkdtemp(path.join(tmpdir(), 'TEST-codex-invalid-store-'))
  try {
    await expect(createCodexNativeHomeOverlay({ env: { CODEX_HOME: source }, sessionsDirectory: 'relative' }))
      .rejects.toThrow('owned absolute directory')
    await expect(createCodexNativeHomeOverlay({ env: { CODEX_HOME: source }, sessionsDirectory: path.join(source, 'absent') }))
      .rejects.toThrow()
    expect(existsSync(path.join(source, 'absent'))).toBe(false)
  } finally { await rm(source, { recursive: true, force: true }) }
})
