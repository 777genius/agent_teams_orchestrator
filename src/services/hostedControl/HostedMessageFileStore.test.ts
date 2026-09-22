import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostedMessageFileStore } from './HostedMessageFileStore.js'
import type { HostedControlAuthority } from './protocol.js'

const roots: string[] = []
const teamId = `team_${'a'.repeat(32)}`
const authority: HostedControlAuthority = {
  actorId: 'actor-a',
  deploymentId: 'deployment-a',
  bootId: 'boot-a',
  restoreGeneration: 1,
  workspaceId: 'workspace-a',
  mountBinding: { mountGeneration: 1, declaredRootHash: 'b'.repeat(64) },
  teamId,
}
const command = {
  schemaVersion: 1 as const,
  teamId,
  clientMessageId: 'client_message_message01',
  text: 'hello from hosted',
}

function recordDigest(forAuthority: HostedControlAuthority, clientMessageId: string): string {
  return createHash('sha256')
    .update('agent-teams.hosted-message.idempotency/v1')
    .update('\0')
    .update(JSON.stringify({
      actorId: forAuthority.actorId,
      deploymentId: forAuthority.deploymentId,
      bootId: forAuthority.bootId,
      restoreGeneration: forAuthority.restoreGeneration,
      workspaceId: forAuthority.workspaceId,
      mountBinding: forAuthority.mountBinding,
      teamId: forAuthority.teamId,
      clientMessageId,
    }))
    .digest('hex')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string; directory: string }> {
  const root = await mkdtemp(join(tmpdir(), 'hosted-message-store-'))
  roots.push(root)
  return { root, directory: join(root, 'records') }
}

describe('HostedMessageFileStore', () => {
  test('persists once and replays the same receipt after a process-like restart', async () => {
    const { directory } = await fixture()
    const first = new HostedMessageFileStore(
      directory,
      teamId,
      () => new Date('2026-08-09T10:00:00.000Z'),
      () => `message_${'c'.repeat(32)}`,
    )
    const persisted = await first.persist(command, authority)
    expect(persisted).toEqual({
      kind: 'persisted',
      receipt: {
        schemaVersion: 1,
        teamId,
        messageId: `message_${'c'.repeat(32)}`,
        clientMessageId: command.clientMessageId,
        persistence: 'durable',
      },
    })

    const restarted = new HostedMessageFileStore(directory, teamId)
    if (persisted.kind !== 'persisted') throw new Error('expected persisted message')
    await expect(restarted.persist(command, authority)).resolves.toEqual({
      kind: 'idempotent_replay',
      receipt: persisted.receipt,
    })
    await expect(restarted.find({
      teamId,
      messageId: `message_${'c'.repeat(32)}`,
      clientMessageId: command.clientMessageId,
      text: command.text,
    }, authority)).resolves.toEqual({
      kind: 'found',
      message: {
        teamId,
        messageId: `message_${'c'.repeat(32)}`,
        clientMessageId: command.clientMessageId,
        text: command.text,
        createdAt: '2026-08-09T10:00:00.000Z',
      },
    })
  })

  test('returns deterministic conflict for idempotency or delivery mismatch', async () => {
    const { directory } = await fixture()
    const store = new HostedMessageFileStore(
      directory,
      teamId,
      () => new Date('2026-08-09T10:00:00.000Z'),
      () => `message_${'d'.repeat(32)}`,
    )
    await store.persist(command, authority)
    await expect(store.persist({ ...command, text: 'different text' }, authority)).resolves.toEqual({
      kind: 'conflict',
      reason: 'idempotency_mismatch',
    })
    await expect(store.find({
      teamId,
      messageId: `message_${'e'.repeat(32)}`,
      clientMessageId: command.clientMessageId,
      text: command.text,
    }, authority)).resolves.toEqual({ kind: 'conflict' })
  })

  test('separates replay domains by actor and workspace while preserving scoped conflicts', async () => {
    const { directory } = await fixture()
    let ids = 0
    const store = new HostedMessageFileStore(
      directory,
      teamId,
      () => new Date('2026-08-09T10:00:00.000Z'),
      () => `message_${String(++ids).padStart(32, '0')}`,
    )
    const otherActor = { ...authority, actorId: 'actor-b' }
    const otherWorkspace = { ...authority, workspaceId: 'workspace-b' }

    const original = await store.persist(command, authority)
    const actorScoped = await store.persist(command, otherActor)
    const workspaceScoped = await store.persist(command, otherWorkspace)
    expect([original.kind, actorScoped.kind, workspaceScoped.kind]).toEqual([
      'persisted', 'persisted', 'persisted',
    ])
    await expect(store.persist(command, otherActor)).resolves.toMatchObject({
      kind: 'idempotent_replay', receipt: { messageId: `message_${'2'.padStart(32, '0')}` },
    })
    await expect(store.persist({ ...command, text: 'different text' }, otherWorkspace)).resolves.toEqual({
      kind: 'conflict', reason: 'idempotency_mismatch',
    })
  })

  test('never replays the same client id across authority incarnations or mount generations', async () => {
    const { directory } = await fixture(); let ids = 0
    const store = new HostedMessageFileStore(directory, teamId, undefined, () => `message_${String(++ids).padStart(32, '0')}`)
    const variants: HostedControlAuthority[] = [
      authority,
      { ...authority, deploymentId: 'deployment-b' },
      { ...authority, bootId: 'boot-b' },
      { ...authority, restoreGeneration: 2 },
      { ...authority, mountBinding: { ...authority.mountBinding, mountGeneration: 2 } },
      { ...authority, mountBinding: { ...authority.mountBinding, declaredRootHash: 'c'.repeat(64) } },
    ]
    for (const variant of variants) expect((await store.persist(command, variant)).kind).toBe('persisted')
    expect(ids).toBe(variants.length)
  })

  test('rejects a record copied across actor or workspace idempotency domains', async () => {
    const { directory } = await fixture()
    const store = new HostedMessageFileStore(directory, teamId)
    await store.persist(command, authority)
    const source = join(directory, `${recordDigest(authority, command.clientMessageId)}.message.v1.json`)

    for (const changedAuthority of [
      { ...authority, actorId: 'actor-b' },
      { ...authority, workspaceId: 'workspace-b' },
    ]) {
      const target = join(directory, `${recordDigest(changedAuthority, command.clientMessageId)}.message.v1.json`)
      await writeFile(target, await readFile(source), { mode: 0o600 })
      await expect(store.persist(command, changedAuthority)).resolves.toEqual({
        kind: 'conflict', reason: 'idempotency_mismatch',
      })
      await rm(target)
    }
  })

  test('rejects cross-team authority and private-record substitution', async () => {
    const { root, directory } = await fixture()
    const store = new HostedMessageFileStore(directory, teamId)
    await expect(store.persist(command, {
      ...authority,
      teamId: `team_${'f'.repeat(32)}`,
    })).rejects.toThrow('authority mismatch')

    await store.persist(command, authority)
    const digest = recordDigest(authority, command.clientMessageId)
    const record = join(directory, `${digest}.message.v1.json`)
    const outside = join(root, 'outside.json')
    await writeFile(outside, await readFile(record))
    await rm(record)
    await symlink(outside, record)
    await expect(store.persist(command, authority)).rejects.toThrow()
  })

  test('rejects a group-writable persistence directory', async () => {
    const { directory } = await fixture()
    const store = new HostedMessageFileStore(directory, teamId)
    await store.persist(command, authority)
    await chmod(directory, 0o770)
    await expect(store.persist(command, authority)).rejects.toThrow('Unsafe hosted message store directory')
  })
})
