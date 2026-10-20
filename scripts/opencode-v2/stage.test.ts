import { expect, test, spyOn } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { verifyGraphs } from './stage.js'

// A hoisted shared effect binder must never satisfy the floor graph with the
// root Effect; exercise the staged verification against a poisoned binder.
test('a hoisted shared effect binder cannot pass staged verification with a second physical Effect', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-opencode-poisoned-binder-'))
  try {
    const drizzle = path.join(root, 'node_modules/drizzle-orm')
    await mkdir(drizzle, { recursive: true })
    await writeFile(path.join(drizzle, 'package.json'),
      JSON.stringify({ name: 'drizzle-orm', version: '1.0.0-rc.5-169397b', exports: './effect-core.js' }))
    await writeFile(path.join(drizzle, 'effect-core.js'), 'export {}')
    const effect = path.join(root, 'node_modules/effect')
    await mkdir(effect, { recursive: true })
    await writeFile(path.join(effect, 'package.json'),
      JSON.stringify({ name: 'effect', version: '4.0.1', exports: './index.js' }))
    await writeFile(path.join(effect, 'index.js'), 'export {}')
    const entry = path.join(drizzle, 'effect-core.js')
    const original = Bun.resolveSync
    const resolution = spyOn(Bun, 'resolveSync').mockImplementation((specifier, from) =>
      specifier === 'drizzle-orm/effect-core' ? entry : original(specifier, from))
    try {
      await expect(verifyGraphs(path.join(import.meta.dir, '..', '..'))).rejects.toThrow('mismatch')
    } finally { resolution.mockRestore() }
  } finally { await rm(root, { recursive: true, force: true }) }
})
