import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { OpenCodePassiveStatusSnapshotWriter } from './OpenCodePassiveStatusSnapshotWriter.js'
import { OpenCodePassiveStatusProductionReader, readBoundedSnapshotText } from './OpenCodePassiveStatusProductionReader.js'
import type { OpenCodeRedactedSnapshotV1 } from './OpenCodeRedactedStatusSnapshot.js'

const canonical = '/canonical/project'
const scopeFor = (value: string) => `sha256:${createHash('sha256').update('opencode-project-scope-v1\0').update(value).digest('hex')}` as const
const scope = scopeFor(canonical)
const otherScope = scopeFor('/other/project')
const observation = <T>(value: T, authority: any, at: number) => ({
  value, authority, freshness: 'fresh' as const, condition: 'normal' as const,
  observedAt: at, validUntil: at + 10_000, issueCode: 'none' as const,
})
function snapshot(at: number, projectScope: `sha256:${string}` = scope): OpenCodeRedactedSnapshotV1 {
  return {
    schemaVersion: 1, projectScope, capturedAt: at,
    binary: observation({ presence: 'present' as const, version: `${Math.floor(at / 1_000)}.2.3` }, 'binary_metadata', at),
    providers: [{
      providerId: 'deepinfra',
      configured: observation('configured' as const, 'config_metadata', at),
      lastConnected: observation({ state: 'connected' as const, at }, 'auth_metadata', at),
      catalogAvailable: observation('available' as const, 'catalog_snapshot', at),
      executionVerified: observation('verified' as const, 'execution_snapshot', at),
    }],
  }
}
function deferred() {
  let resolve!: () => void
  return { promise: new Promise<void>(done => { resolve = done }), resolve }
}
async function read(root: string, canonicalPath = canonical, at = 9_000) {
  return new OpenCodePassiveStatusProductionReader({
    rootDirectory: root, now: () => at, canonicalizePath: async () => canonicalPath,
  }).reader.read({ projectPath: canonicalPath, providerIds: ['deepinfra'], timeoutMs: 1_000 })
}

const describeSupportedPersistence = process.platform === 'win32' ? describe.skip : describe

describeSupportedPersistence('OpenCode passive immutable snapshot publication', () => {
  test('has no reclaimable correctness pathname and concurrent scopes cannot lose one another', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.passive-v2-scopes-'))
    try {
      await Promise.all([
        new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root }).write(snapshot(1_000), new AbortController().signal),
        new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root }).write(snapshot(2_000, otherScope), new AbortController().signal),
      ])
      expect((await readdir(root)).sort()).not.toContain('locks')
      expect((await readdir(path.join(root, 'scopes'))).sort()).toEqual([otherScope.slice(7), scope.slice(7)].sort())
      expect((await read(root)).providers[0].configured.observedAt).toBe(1_000)
      expect((await read(root, '/other/project')).providers[0].configured.observedAt).toBe(2_000)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('same-scope late old completion is fenced by authoritative domain generation', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.passive-v2-order-'))
    const oldPaused = deferred(); const releaseOld = deferred()
    try {
      const old = new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root, safeStorageHooks: {
        beforeCommitPublished: async () => { oldPaused.resolve(); await releaseOld.promise },
      }}).write(snapshot(1_000), new AbortController().signal)
      await oldPaused.promise
      await new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root })
        .write(snapshot(2_000), new AbortController().signal)
      releaseOld.resolve(); await old
      const result = await read(root)
      expect(result.providers[0].configured.observedAt).toBe(2_000)
      expect(result.binary.value.version).toBe('2.2.3')
      expect((await readdir(path.join(root, 'scopes', scope.slice(7), 'commits'))).length).toBe(2)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('every pre-commit crash stage hides the half pair and durability hooks are ordered', async () => {
    const stages = ['afterTransactionMarker', 'afterGenerationDirectoryCreated', 'afterProjectSnapshotPublished',
      'afterBinarySnapshotPublished', 'afterGenerationParentSynced', 'beforeCommitPublished'] as const
    for (const stage of stages) {
      const root = await mkdtemp(path.join(process.cwd(), `.passive-v2-crash-${stage}-`))
      try {
        await new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root }).write(snapshot(1_000), new AbortController().signal)
        await expect(new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root, safeStorageHooks: {
          [stage]: () => { throw new Error(`crash:${stage}`) },
        }}).write(snapshot(2_000), new AbortController().signal)).rejects.toThrow(`crash:${stage}`)
        expect((await read(root)).providers[0].configured.observedAt).toBe(1_000)
      } finally { await rm(root, { recursive: true, force: true }) }
    }
    const root = await mkdtemp(path.join(process.cwd(), '.passive-v2-durability-'))
    const order: string[] = []
    try {
      await new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root, safeStorageHooks: {
        afterGenerationDirectoryCreated: () => { order.push('generation-parent-entry-fsynced') },
        afterProjectSnapshotPublished: () => { order.push('project-file-fsynced') },
        afterBinarySnapshotPublished: () => { order.push('binary-file-fsynced') },
        afterGenerationParentSynced: () => { order.push('generation-fsynced-before-commit') },
        beforeCommitPublished: () => { order.push('commit-begins') },
        afterCommitPublished: () => { order.push('commit-file-and-directory-fsynced') },
      }}).write(snapshot(1_000), new AbortController().signal)
      expect(order).toEqual(['generation-parent-entry-fsynced', 'project-file-fsynced', 'binary-file-fsynced',
        'generation-fsynced-before-commit', 'commit-begins', 'commit-file-and-directory-fsynced'])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('a reader selected before two later commits remains readable because publication never cleans generations', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.passive-v2-pin-'))
    try {
      await new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root }).write(snapshot(1_000), new AbortController().signal)
      const held = await readBoundedSnapshotText(path.join(root, 'snapshots', `${scope.slice(7)}.json`), new AbortController().signal)
      await new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root }).write(snapshot(2_000), new AbortController().signal)
      await new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root }).write(snapshot(3_000), new AbortController().signal)
      expect(held).toContain('"capturedAt":1000')
      const generations = path.join(root, 'scopes', scope.slice(7), 'generations')
      expect((await readdir(generations)).length).toBe(3)
      for (const name of await readdir(generations)) expect((await readdir(path.join(generations, name))).sort())
        .toEqual(['binary.snapshot.json', 'project.snapshot.json'])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('corrupt or oversize transactional records fail closed and only truly absent state uses legacy mirrors', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.passive-v2-corrupt-'))
    try {
      await new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root }).write(snapshot(1_000), new AbortController().signal)
      const commits = path.join(root, 'scopes', scope.slice(7), 'commits')
      const committedName = (await readdir(commits))[0]
      await writeFile(path.join(commits,
        `.${committedName}.immutable.${process.pid}.00000000-0000-4000-8000-000000000443`), '{interrupted')
      expect((await read(root)).providers[0].configured.observedAt).toBe(1_000)
      await writeFile(path.join(commits, '0000000000002000.00000000-0000-4000-8000-000000000443.json'), '{bad')
      expect((await read(root)).providers[0].configured.value).toBe('unknown')
      await writeFile(path.join(commits, '0000000000003000.00000000-0000-4000-8000-000000000444.json'), 'x'.repeat(4_097))
      expect((await read(root)).providers[0].configured.value).toBe('unknown')
    } finally { await rm(root, { recursive: true, force: true }) }

    const legacy = await mkdtemp(path.join(process.cwd(), '.passive-v2-legacy-'))
    try {
      await mkdir(path.join(legacy, 'snapshots'))
      const data = JSON.stringify(snapshot(1_000))
      await writeFile(path.join(legacy, 'snapshots', `${scope.slice(7)}.json`), data)
      await writeFile(path.join(legacy, 'binary.snapshot.json'), data)
      expect((await read(legacy)).providers[0].configured.observedAt).toBe(1_000)
      await writeFile(path.join(legacy, 'committed.json'), '{bad')
      expect((await read(legacy)).providers[0].configured.value).toBe('unknown')
    } finally { await rm(legacy, { recursive: true, force: true }) }
  })

  test('every scope path boundary rejects preexisting symlink or Windows junction substitution', async () => {
    for (const boundary of ['scopes', `scopes/${scope.slice(7)}`, `scopes/${scope.slice(7)}/generations`,
      `scopes/${scope.slice(7)}/commits`]) {
      const parent = await mkdtemp(path.join(process.cwd(), '.passive-v2-links-'))
      const root = path.join(parent, 'root'); const outside = path.join(parent, 'outside')
      try {
        await mkdir(root); await mkdir(outside)
        const target = path.join(root, boundary); await mkdir(path.dirname(target), { recursive: true })
        await symlink(outside, target, process.platform === 'win32' ? 'junction' : 'dir')
        await expect(new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root })
          .write(snapshot(1_000), new AbortController().signal)).rejects.toThrow()
        expect(await readdir(outside)).toEqual([])
      } finally { await rm(parent, { recursive: true, force: true }) }
    }
  })

  test('a root substitution after acquisition cannot redirect publication outside the proven root', async () => {
    const parent = await mkdtemp(path.join(process.cwd(), '.passive-v2-root-swap-'))
    const root = path.join(parent, 'root'); const displaced = path.join(parent, 'displaced'); const outside = path.join(parent, 'outside')
    try {
      await mkdir(root); await mkdir(outside)
      const publication = new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root, safeStorageHooks: {
        afterRootOpened: async () => {
          await rename(root, displaced)
          await symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir')
        },
      }}).write(snapshot(1_000), new AbortController().signal)
      if (process.platform === 'win32') await expect(publication).rejects.toThrow('safe publication primitive')
      else await publication
      expect(await readdir(outside)).toEqual([])
    } finally { await rm(parent, { recursive: true, force: true }) }
  })

  test('cancellation before the commit point exposes nothing', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.passive-v2-cancel-'))
    const controller = new AbortController()
    try {
      await expect(new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root, safeStorageHooks: {
        afterProjectSnapshotPublished: () => controller.abort(),
      }}).write(snapshot(1_000), controller.signal)).rejects.toThrow('cancelled')
      expect((await read(root)).providers[0].configured.value).toBe('unknown')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
