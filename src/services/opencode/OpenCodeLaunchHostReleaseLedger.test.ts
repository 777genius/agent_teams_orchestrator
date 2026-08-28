import { describe, expect, test } from 'bun:test'
import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  OpenCodeLaunchHostReleaseLedger,
  type OpenCodeLaunchHostCleanupRecord,
  type OpenCodeLaunchHostLedgerContext,
  type OpenCodeLaunchHostLedgerPersistence,
} from './OpenCodeLaunchHostReleaseLedger.js'
import { OpenCodeLaunchFileJournalPersistence } from './OpenCodeLaunchAttemptStore.js'
import type { OpenCodeOpaqueIdentity } from './OpenCodeBridgeContractV2.js'

const attemptId = '123e4567-e89b-42d3-a456-426614174000'
const payloadHash = 'b'.repeat(64)
const hostKeyIdentity = `sha256:${'a'.repeat(64)}` as OpenCodeOpaqueIdentity
const context = (): OpenCodeLaunchHostLedgerContext => ({
  deadlineAtMs: Date.now() + 10_000,
  signal: new AbortController().signal,
})

async function fixture(name: string, hooks: ConstructorParameters<typeof OpenCodeLaunchFileJournalPersistence>[1] = {}) {
  const root = await mkdtemp(path.join(tmpdir(), `opencode-ledger-${name}-`))
  const attempts = path.join(root, 'data', 'opencode', 'launch-attempts')
  await mkdir(attempts, { recursive: true })
  const file = path.join(attempts, 'attempt.host-release.json')
  const persistence = new OpenCodeLaunchFileJournalPersistence(file, hooks)
  return { root, attempts, file, persistence,
    ledger: OpenCodeLaunchHostReleaseLedger.production(persistence) }
}

function receipt(id = '123e4567-e89b-42d3-a456-426614174443') {
  return { schemaVersion: 1 as const, receiptId: id, hostKeyDigest: 'c'.repeat(64),
    pid: 443, processStartedAtMs: 12_345, lifetime: 'process' as const }
}

class FaultPersistence implements OpenCodeLaunchHostLedgerPersistence {
  candidate: Uint8Array | null = null
  constructor(
    private readonly inner: OpenCodeLaunchFileJournalPersistence,
    private readonly mode: 'before' | 'after',
  ) {}
  read(...args: Parameters<OpenCodeLaunchFileJournalPersistence['read']>) {
    return this.inner.read(...args)
  }
  readOnlySnapshot(...args: Parameters<OpenCodeLaunchFileJournalPersistence['readOnlySnapshot']>) {
    return this.inner.readOnlySnapshot(...args)
  }
  readUnframedLegacy(...args: Parameters<OpenCodeLaunchFileJournalPersistence['readUnframedLegacy']>) {
    return this.inner.readUnframedLegacy(...args)
  }
  acquireExclusive(...args: Parameters<OpenCodeLaunchFileJournalPersistence['acquireExclusive']>) {
    return this.inner.acquireExclusive(...args)
  }
  async replaceAndSync(bytes: Uint8Array, storeContext: Parameters<OpenCodeLaunchFileJournalPersistence['replaceAndSync']>[1]) {
    this.candidate = new Uint8Array(bytes)
    if (this.mode === 'before') throw new Error('synthetic crash before publication')
    await this.inner.replaceAndSync(bytes, storeContext)
    throw new Error('synthetic crash after publication')
  }
  async replaceUnframedLegacyAndSync(bytes: Uint8Array,
    storeContext: Parameters<OpenCodeLaunchFileJournalPersistence['replaceUnframedLegacyAndSync']>[1]) {
    this.candidate = new Uint8Array(bytes)
    if (this.mode === 'before') throw new Error('synthetic crash before migration publication')
    await this.inner.replaceUnframedLegacyAndSync(bytes, storeContext)
    throw new Error('synthetic crash after migration publication')
  }
}

async function buildPredecessor(
  ledger: OpenCodeLaunchHostReleaseLedger,
  stage: 'reservation' | 'receipt' | 'disposition' | 'completion' | 'clear',
): Promise<OpenCodeLaunchHostCleanupRecord | null> {
  if (stage === 'reservation') return null
  const obligation = await ledger.reserve({ attemptId, payloadHash, generation: 1,
    hostKeyIdentity, hostKeyDigest: 'c'.repeat(64) }, context())
  if (stage === 'receipt') return obligation
  const received = { ...obligation, receipt: receipt() }
  await ledger.record(received, context())
  const receiptRecord = await ledger.readObligation({ attemptId, payloadHash, generation: 1,
    obligationId: obligation.obligationId }, context())
  if (stage === 'disposition') return receiptRecord
  const disposed = { ...receiptRecord!, disposition: 'dispose' as const }
  await ledger.record(disposed, context())
  if (stage === 'completion') return disposed
  const completed = { ...disposed, releaseState: 'complete' as const }
  await ledger.record(completed, context())
  return completed
}

async function performTransition(
  ledger: OpenCodeLaunchHostReleaseLedger,
  stage: 'reservation' | 'receipt' | 'disposition' | 'completion' | 'clear',
  predecessor: OpenCodeLaunchHostCleanupRecord | null,
): Promise<void> {
  if (stage === 'reservation') {
    await ledger.reserve({ attemptId, payloadHash, generation: 1,
      hostKeyIdentity, hostKeyDigest: 'c'.repeat(64) }, context())
  } else if (stage === 'receipt') {
    await ledger.record({ ...predecessor!, receipt: receipt() }, context())
  } else if (stage === 'disposition') {
    await ledger.record({ ...predecessor!, disposition: 'dispose' }, context())
  } else if (stage === 'completion') {
    await ledger.record({ ...predecessor!, releaseState: 'complete' }, context())
  } else {
    await ledger.clear(predecessor as Exclude<OpenCodeLaunchHostCleanupRecord, { receipt: null }>, context())
  }
}

describe('durable retained host-release ledger', () => {
  test('production operations require an explicit immutable deadline and cancellation context', async () => {
    const item = await fixture('mandatory-context')
    try {
      await expect(item.ledger.reserve({ attemptId, payloadHash, generation: 1,
        hostKeyIdentity, hostKeyDigest: 'c'.repeat(64) })).rejects
        .toThrow('ledger context is required')
    } finally { await rm(item.root, { recursive: true, force: true }) }
  })

  test('legacy migration fails closed and remains restartable when its verified temporary disappears', async () => {
    let removeNextTemporary = true
    const item = await fixture('legacy-temporary-disappears', {
      beforeAtomicRename: async temporary => {
        if (!removeNextTemporary) return
        removeNextTemporary = false
        await unlink(temporary)
      },
    })
    const legacy = { schemaVersion: 1 as const, attemptId, payloadHash, generation: 1,
      hostKeyIdentity, receipt: receipt() }
    try {
      await writeFile(item.file, `${JSON.stringify(legacy)}\n`)
      const migrated = await item.ledger.read({ attemptId, payloadHash, generation: 1 }, context())
      await expect(item.ledger.record(migrated, context())).rejects.toMatchObject({
        code: 'foreign',
        message: expect.stringContaining('temporary durable record disappeared'),
      })
      expect(JSON.parse(await readFile(item.file, 'utf8'))).toEqual(legacy)

      const restarted = OpenCodeLaunchHostReleaseLedger.production(
        new OpenCodeLaunchFileJournalPersistence(item.file))
      await restarted.record(migrated, context())
      expect(await restarted.read({ attemptId, payloadHash, generation: 1 }, context()))
        .toEqual(migrated)
    } finally { await rm(item.root, { recursive: true, force: true }) }
  })

  for (const stage of ['reservation', 'receipt', 'disposition', 'completion', 'clear'] as const) {
    for (const mode of ['before', 'after'] as const) {
      test(`${stage} crash ${mode} publication restarts at the exact predecessor or successor`, async () => {
        const item = await fixture(`${stage}-${mode}`)
        try {
          const predecessor = await buildPredecessor(item.ledger, stage)
          const before = await item.persistence.read({ ...context(), monotonicNow: Date.now })
          const fault = new FaultPersistence(item.persistence, mode)
          const crashing = OpenCodeLaunchHostReleaseLedger.production(fault)
          await expect(performTransition(crashing, stage, predecessor)).rejects.toThrow('synthetic crash')
          const after = await item.persistence.read({ ...context(), monotonicNow: Date.now })
          if (mode === 'before') {
            expect(after).toEqual(before)
          } else {
            expect(after).toEqual(fault.candidate)
          }
          const restarted = OpenCodeLaunchHostReleaseLedger.production(
            new OpenCodeLaunchFileJournalPersistence(item.file))
          const records = await restarted.snapshotAll({ attemptId, payloadHash, currentGeneration: 1 }, context())
          expect(records.every(record => record.attemptId === attemptId
            && record.payloadHash === payloadHash)).toBe(true)
          expect(records).toHaveLength(stage === 'clear' && mode === 'after'
            ? 0 : stage === 'reservation' && mode === 'before' ? 0 : 1)
        } finally { await rm(item.root, { recursive: true, force: true }) }
      })
    }
  }

  test('retained POSIX directory identity ignores a substituted pathname and fences later writes', async () => {
    let swap = false
    let attempts = ''
    let retained = ''
    const item = await fixture('directory-swap', {
      afterReadHandleOpened: async () => {
        if (!swap) return
        swap = false
        retained = `${attempts}.retained`
        await rename(attempts, retained)
        await mkdir(attempts)
        await writeFile(path.join(attempts, 'attempt.host-release.json'), '{"foreign":true}')
      },
    })
    attempts = item.attempts
    try {
      const obligation = await item.ledger.reserve({ attemptId, payloadHash, generation: 1,
        hostKeyIdentity, hostKeyDigest: 'c'.repeat(64) }, context())
      swap = true
      expect(await item.ledger.hasUnresolvedAcquisition({ attemptId, payloadHash,
        currentGeneration: 1 }, context())).toBe(true)
      await expect(item.ledger.record({ ...obligation, receipt: receipt() }, context()))
        .rejects.toThrow(/detached|changed|fenced/)
    } finally {
      await rm(item.root, { recursive: true, force: true })
      if (retained) await rm(retained, { recursive: true, force: true })
    }
  })

  test('record-leaf replacement between retained open and identity check is rejected', async () => {
    let swapPath: string | null = null
    const item = await fixture('leaf-swap', {
      afterReadHandleOpened: async opened => {
        if (!swapPath || opened !== swapPath) return
        const selected = swapPath
        swapPath = null
        await rename(selected, `${selected}.retained`)
        await writeFile(selected, '{"foreign":true}')
      },
    })
    try {
      await item.ledger.reserve({ attemptId, payloadHash, generation: 1,
        hostKeyIdentity, hostKeyDigest: 'c'.repeat(64) }, context())
      const marker = JSON.parse(await readFile(item.file, 'utf8')) as { slot: 0 | 1 }
      swapPath = `${item.file}.slot${marker.slot}`
      await expect(item.ledger.hasUnresolvedAcquisition({ attemptId, payloadHash,
        currentGeneration: 1 }, context())).rejects.toThrow(/identity changed|fenced|foreign/)
    } finally { await rm(item.root, { recursive: true, force: true }) }
  })

  test('hard-linked marker and record leaves are rejected', async () => {
    for (const leaf of ['marker', 'record'] as const) {
      const item = await fixture(`hardlink-${leaf}`)
      try {
        await item.ledger.reserve({ attemptId, payloadHash, generation: 1,
          hostKeyIdentity, hostKeyDigest: 'c'.repeat(64) }, context())
        const marker = JSON.parse(await readFile(item.file, 'utf8')) as { slot: 0 | 1 }
        const target = leaf === 'marker' ? item.file : `${item.file}.slot${marker.slot}`
        await link(target, `${target}.foreign-link`)
        await expect(item.ledger.hasUnresolvedAcquisition({ attemptId, payloadHash,
          currentGeneration: 1 }, context())).rejects.toThrow(/identity changed|foreign/)
      } finally { await rm(item.root, { recursive: true, force: true }) }
    }
  })

  test('symlinked retained directory chain is rejected before ledger authority opens', async () => {
    const item = await fixture('symlink-chain')
    const real = `${item.attempts}.real`
    try {
      await rename(item.attempts, real)
      await symlink(real, item.attempts, 'dir')
      const ledger = OpenCodeLaunchHostReleaseLedger.production(
        new OpenCodeLaunchFileJournalPersistence(item.file))
      await expect(ledger.reserve({ attemptId, payloadHash, generation: 1,
        hostKeyIdentity, hostKeyDigest: 'c'.repeat(64) }, context())).rejects.toThrow(/canonical|symlink|foreign/)
    } finally { await rm(item.root, { recursive: true, force: true }) }
  })

  test('Windows retained namespace contract exposes and validates hard-link count', async () => {
    const [native, client, retainedBackend] = await Promise.all([
      readFile(path.join(import.meta.dir, '../../../native/opencode-catalog-authority/src/windows_publication.rs'), 'utf8'),
      readFile(path.join(import.meta.dir, 'OpenCodeWindowsPublicationAuthorityClient.ts'), 'utf8'),
      readFile(path.join(import.meta.dir, 'OpenCodeLaunchAttemptStore.ts'), 'utf8'),
    ])
    expect(native).toContain('metadata.number_of_links()')
    expect(native).toContain('.ok_or("FILE_REJECTED")?.to_string()')
    expect(client).toContain("!/^\\d+$/.test(String(value?.linkCount))")
    expect(retainedBackend).toContain('retained.nlink !== 1 || visible.nlink !== 1')
  })
})
