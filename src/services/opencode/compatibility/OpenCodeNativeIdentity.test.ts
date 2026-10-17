import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { classifyOpenCodeReadGeneration } from './OpenCodeGenerationPolicy.js'
import { hashOpenCodeFile, selectedOpenCodeReadPath } from './OpenCodeNativeIdentity.js'

test('strict family/dialect classification preserves V1 floor and refuses ambiguous output', () => {
  for (const version of ['1.16.0', '1.18.34']) expect(classifyOpenCodeReadGeneration(version).generation).toBe('v1')
  for (const version of ['2.0.0', '2.0.21']) expect(classifyOpenCodeReadGeneration(version).generation).toBe('v2')
  for (const version of ['2.0.1', '3.0.0', '2.0.21-rc.1', 'opencode 2.0.21', '1.18.34\n2.0.21', '02.0.21']) {
    expect(classifyOpenCodeReadGeneration(version).generation).toBe('unsupported')
  }
})

for (const pin of ['2.0.0', '2.0.21'] as const) {
  test(`official native --version stdout admits exact V2 ${pin} dialect`, () => {
    // Exact stdout observed from the canonical official CLI package, exit 0.
    expect(classifyOpenCodeReadGeneration(`opencode v${pin}\n`)).toEqual({
      generation: 'v2', version: pin, dialect: `v2-${pin}`,
    })
  })
}

test('decorated, multiline and unqualified branded versions remain unsupported', () => {
  for (const output of [
    'warning: opencode v2.0.21\n', 'opencode v2.0.21 extra\n',
    'banner\nopencode v2.0.21\n', 'opencode v2.0.21\nbanner\n',
    'opencode v2.0.0\nopencode v2.0.21\n', 'opencode v2.0.21\n\n',
    '\nopencode v2.0.21\n', ' opencode v2.0.21\n', 'opencode 2.0.21\n',
    'opencode v02.0.21\n', 'opencode v2.0.21-rc.1\n',
    'opencode v2.0.1\n', 'opencode v2.0.26\n', 'opencode v2.1.0\n', 'opencode v3.0.0\n',
  ]) expect(classifyOpenCodeReadGeneration(output).generation).toBe('unsupported')
})

test('invalid explicit override cannot silently resolve another PATH binary', () => {
  const before = process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH
  try {
    process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = 'relative/opencode'
    expect(() => selectedOpenCodeReadPath()).toThrow('identity_mismatch')
  } finally {
    if (before === undefined) delete process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH
    else process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = before
  }
})

test('same-path executable replacement changes authority digest', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'TEST-opencode-identity-'))
  try {
    const executable = path.join(root, 'opencode')
    await writeFile(executable, 'old executable bytes')
    const old = await hashOpenCodeFile(executable)
    await writeFile(executable, 'new executable bytes')
    expect(await hashOpenCodeFile(executable)).not.toBe(old)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('file hashing matches independent SHA for empty, tiny and multiple read chunks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'TEST-opencode-hash-buffer-'))
  try {
    for (const size of [0, 1, 37, 64 * 1024, 64 * 1024 + 1, 3 * 64 * 1024 + 17]) {
      const content = Buffer.from(Uint8Array.from({ length: size }, (_, index) => index % 251))
      const file = path.join(root, `bytes-${size}`)
      await writeFile(file, content)
      expect(await hashOpenCodeFile(file)).toBe(createHash('sha256').update(content).digest('hex'))
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})


test('cancelled file hashing rejects the caller reason before opening a missing path', async () => {
  const controller = new AbortController()
  const reason = new Error('TEST-hash-cancelled')
  controller.abort(reason)
  await expect(hashOpenCodeFile(path.join(tmpdir(), 'TEST-missing-cancelled-hash'), controller.signal)).rejects.toBe(reason)
})
