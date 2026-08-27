import { describe, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { readOpenCodeCommandOutcomeReadOnly } from './OpenCodePassiveCommandStatusRoute.js'
import type { OpenCodePassiveObservation } from './OpenCodePassiveStatusContract.js'
import { OpenCodePassiveStatusProductionReader } from './OpenCodePassiveStatusProductionReader.js'
import {
  encodeOpenCodeRedactedSnapshotV1,
  type OpenCodeRedactedSnapshotV1,
} from './OpenCodeRedactedStatusSnapshot.js'
import { OpenCodeSafePublicationDirectory } from './OpenCodeSafePublication.js'
import { OpenCodeWindowsPublicationAuthorityClient } from './OpenCodeWindowsPublicationAuthorityClient.js'

const describeWindows = process.platform === 'win32' ? describe : describe.skip
const scope = (canonical: string): `sha256:${string}` => `sha256:${createHash('sha256')
  .update('opencode-project-scope-v1\0').update(canonical).digest('hex')}`

function snapshot(canonical: string): string {
  const observation = <T>(
    value: T,
    authority: OpenCodePassiveObservation<T>['authority'],
  ): OpenCodePassiveObservation<T> => ({
    value, authority, freshness: 'fresh' as const, condition: 'normal' as const,
    observedAt: 900, validUntil: 2_000, issueCode: 'none' as const,
  })
  const value: OpenCodeRedactedSnapshotV1 = {
    schemaVersion: 1,
    projectScope: scope(canonical),
    capturedAt: 1_000,
    binary: observation({ presence: 'present', version: '1.2.3' }, 'binary_metadata'),
    providers: [],
  }
  const encoded = encodeOpenCodeRedactedSnapshotV1(value)
  if (!encoded.ok || !encoded.bytes) throw new Error('invalid fixture')
  return new TextDecoder().decode(encoded.bytes)
}

async function tree(root: string): Promise<readonly string[]> {
  const values: string[] = []
  const walk = async (directory: string, relative = ''): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const childRelative = relative ? path.join(relative, entry.name) : entry.name
      const child = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        values.push(`d:${childRelative}`)
        await walk(child, childRelative)
      } else {
        const bytes = await readFile(child)
        values.push(`f:${childRelative}:${createHash('sha256').update(bytes).digest('hex')}`)
      }
    }
  }
  await walk(root)
  return values.sort()
}

describeWindows('OpenCode Windows passive production composition', () => {
  test('actual passive status wiring creates zero helpers, writes, locks, or mutations', async () => {
    const fixture = await mkdtemp(path.join(process.cwd(), '.opencode-windows-passive-production-'))
    const priorDataHome = process.env.CLAUDE_MULTIMODEL_DATA_HOME
    const canonical = 'C:\\fixture\\project'
    const passiveRoot = path.join(fixture, 'opencode', 'passive-status', 'v1')
    const snapshots = path.join(passiveRoot, 'snapshots')
    const snapshotPath = path.join(snapshots, `${scope(canonical).slice(7)}.json`)
    const binaryPath = path.join(passiveRoot, 'binary.snapshot.json')
    const outcomePath = path.join(fixture, 'opencode', 'command-outcomes.json')
    const trustedOutcome = JSON.stringify({ schemaVersion: 1, records: { trusted: {
      schemaVersion: 1, command: 'opencode.sendMessage', requestId: 'trusted',
      deliveryAttemptId: null, status: 'prompt_accepted', safeToRetry: false,
    } } })
    await mkdir(snapshots, { recursive: true })
    await writeFile(snapshotPath, snapshot(canonical))
    await writeFile(binaryPath, snapshot(canonical))
    await writeFile(outcomePath, trustedOutcome)
    process.env.CLAUDE_MULTIMODEL_DATA_HOME = fixture

    let processCreations = 0
    const spawn = spyOn(Bun, 'spawn').mockImplementation((() => {
      processCreations += 1
      throw new Error('passive production attempted process creation')
    }) as typeof Bun.spawn)
    const readStatus = () => new OpenCodePassiveStatusProductionReader({
      rootDirectory: passiveRoot, now: () => 1_000, canonicalizePath: async () => canonical,
    }).reader.read({ projectPath: canonical, providerIds: [], timeoutMs: 100 })
    const readOutcome = (hooks?: Parameters<typeof readOpenCodeCommandOutcomeReadOnly>[1]) =>
      readOpenCodeCommandOutcomeReadOnly({
        requestId: 'trusted', deliveryAttemptId: null,
        signal: new AbortController().signal,
      }, hooks)

    try {
      let before = await tree(fixture)
      expect((await readStatus()).binary.value).toEqual({ presence: 'present', version: '1.2.3' })
      expect(await readOutcome()).toMatchObject({ requestId: 'trusted', status: 'prompt_accepted' })
      expect(await tree(fixture)).toEqual(before)

      await rm(snapshotPath)
      await rm(binaryPath)
      await rm(outcomePath)
      before = await tree(fixture)
      expect((await readStatus()).binary.value).toEqual({ presence: 'unknown', version: null })
      expect(await readOutcome()).toBeNull()
      expect(await tree(fixture)).toEqual(before)

      await writeFile(snapshotPath, '{corrupt')
      await writeFile(binaryPath, '{corrupt')
      await writeFile(outcomePath, '{corrupt')
      before = await tree(fixture)
      expect((await readStatus()).binary.value).toEqual({ presence: 'unknown', version: null })
      expect(await readOutcome()).toBeNull()
      expect(await tree(fixture)).toEqual(before)

      await writeFile(snapshotPath, snapshot(canonical))
      await writeFile(binaryPath, snapshot(canonical))
      await writeFile(outcomePath, trustedOutcome)
      await writeFile(`${outcomePath}.replacement`, trustedOutcome)
      before = await tree(fixture)
      let replacementDenied = false
      expect(await readOutcome({ afterPathIdentityCaptured: async () => {
        try { await rename(`${outcomePath}.replacement`, outcomePath) }
        catch { replacementDenied = true }
      } })).toMatchObject({ requestId: 'trusted', status: 'prompt_accepted' })
      expect(replacementDenied).toBeTrue()
      expect(await tree(fixture)).toEqual(before)

      expect({ helpers: processCreations, processes: processCreations, writes: 0, locks: 0, mutations: 0 })
        .toEqual({ helpers: 0, processes: 0, writes: 0, locks: 0, mutations: 0 })
    } finally {
      spawn.mockRestore()
      if (priorDataHome === undefined) delete process.env.CLAUDE_MULTIMODEL_DATA_HOME
      else process.env.CLAUDE_MULTIMODEL_DATA_HOME = priorDataHome
      await rm(fixture, { recursive: true, force: true })
    }
  })

  test('writer-capable safe publication still constructs the retained native authority', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.opencode-windows-active-publication-'))
    let processCreations = 0
    let opens = 0
    let validations = 0
    const child = {
      pid: 443,
      stdin: { write: () => 0, flush: () => 0, end: () => {} },
      stdout: new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }),
      stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }),
      exited: Promise.resolve(0),
      kill: () => {},
      unref: () => {},
    }
    const spawn = spyOn(Bun, 'spawn').mockImplementation((() => {
      processCreations += 1
      return child
    }) as unknown as typeof Bun.spawn)
    const openRoot = spyOn(OpenCodeWindowsPublicationAuthorityClient.prototype, 'openRoot')
      .mockImplementation(async () => { opens += 1; return { volumeSerial: '7', fileId: '9', createdPaths: [] } })
    const validateRoot = spyOn(OpenCodeWindowsPublicationAuthorityClient.prototype, 'validateRoot')
      .mockImplementation(async () => { validations += 1 })
    const close = spyOn(OpenCodeWindowsPublicationAuthorityClient.prototype, 'close')
      .mockImplementation(async () => {})
    try {
      const directory = await OpenCodeSafePublicationDirectory.open(root, {
        windowsAuthorityFactory: options => new OpenCodeWindowsPublicationAuthorityClient({
          ...options, launcherPath: process.execPath, workerPath: process.execPath,
        }),
      })
      await directory.validate()
      await directory.close()
      expect({ processCreations, opens, validations }).toEqual({ processCreations: 1, opens: 1, validations: 1 })
    } finally {
      close.mockRestore(); validateRoot.mockRestore(); openRoot.mockRestore(); spawn.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })
})
