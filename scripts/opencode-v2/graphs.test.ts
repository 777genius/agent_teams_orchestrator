import { expect, test, spyOn } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyOpenCodePackage, verifyOpenCodeV2ServerGraph } from '../../src/services/opencode/host/OpenCodeV2ServerGraph.js'

// A stable root Effect must never evaluate the floor server's RC schema AST.
// Exercise the actual installed schema through each server's own runtime.
test('current stable and floor RC server graphs decode with their own physical Effect', async () => {
  const effects = new Set<string>()
  for (const [pin, version] of [['2.0.0', '4.0.0-rc.112'], ['2.0.32', '4.0.1']] as const) {
    const graph = await verifyOpenCodeV2ServerGraph(pin)
    await verifyOpenCodePackage(graph.effectPath, 'effect', version)
    effects.add(graph.effectPath)
    const entry = await realpath(Bun.resolveSync('@opencode/schema/config/provider', path.dirname(graph.modulePath)))
    const { Schema }: typeof import('effect') = await import(pathToFileURL(graph.effectPath).href)
    const { Info }: typeof import('@opencode/schema/config/provider') = await import(pathToFileURL(entry).href)
    expect(Schema.decodeUnknownSync(Info)({ models: { 'TEST-model': {} } }).models).toHaveProperty('TEST-model')
  }
  expect(effects.size).toBe(2)
})

test('AI cannot return programs from a second physical Effect with the correct version', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-opencode-duplicate-effect-')))
  try {
    const effect = path.join(root, 'node_modules/effect')
    await mkdir(effect, { recursive: true })
    await writeFile(path.join(effect, 'package.json'), JSON.stringify({ name: 'effect', version: '4.0.1', exports: './index.js' }))
    await writeFile(path.join(effect, 'index.js'), 'export {}')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: '@opencode/ai', version: '2.0.32' }))
    const entry = path.join(root, 'entry.js')
    await writeFile(entry, 'export {}')
    const original = Bun.resolveSync
    const resolution = spyOn(Bun, 'resolveSync').mockImplementation((specifier, from) =>
      specifier === '@opencode/ai/route/client' ? entry : original(specifier, from))
    try {
      await expect(verifyOpenCodeV2ServerGraph('2.0.32')).rejects.toThrow('identity_mismatch')
    } finally { resolution.mockRestore() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a shared effect binder cannot decode the floor graph with a second physical Effect', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-opencode-duplicate-binder-')))
  try {
    const drizzle = path.join(root, 'node_modules/drizzle-orm')
    await mkdir(drizzle, { recursive: true })
    await writeFile(path.join(drizzle, 'package.json'), JSON.stringify({ name: 'drizzle-orm', version: '1.0.0-rc.5-169397b' }))
    const entry = path.join(drizzle, 'effect-core.js')
    await writeFile(entry, 'export {}')
    const effect = path.join(root, 'node_modules/effect')
    await mkdir(effect, { recursive: true })
    await writeFile(path.join(effect, 'package.json'), JSON.stringify({ name: 'effect', version: '4.0.0-rc.112', exports: './index.js' }))
    await writeFile(path.join(effect, 'index.js'), 'export {}')
    const original = Bun.resolveSync
    const resolution = spyOn(Bun, 'resolveSync').mockImplementation((specifier, from) =>
      specifier === 'drizzle-orm/effect-core' ? entry : original(specifier, from))
    try {
      await expect(verifyOpenCodeV2ServerGraph('2.0.0')).rejects.toThrow('identity_mismatch')
    } finally { resolution.mockRestore() }
  } finally { await rm(root, { recursive: true, force: true }) }
})
