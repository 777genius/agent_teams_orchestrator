import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeToMailboxAtCanonicalTeamRootVerified } from '../../utils/teammateMailbox.js'
import { HostedTeamLeadMessageDelivery } from './HostedTeamLeadMessageDelivery.js'
import { HostedTeamRecipientRoster } from './HostedTeamRecipientRoster.js'
import type { HostedPersistedMessage } from './HostedTeamMessageService.js'
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
const message: HostedPersistedMessage = {
  teamId,
  messageId: `message_${'c'.repeat(32)}`,
  clientMessageId: 'client_message_delivery-test',
  text: 'Ship the hosted message.',
  createdAt: '2026-08-09T10:00:00.000Z',
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
  )
})

describe('HostedTeamLeadMessageDelivery', () => {
  test('writes exactly once to the explicit team-lead inbox and replays durably', async () => {
    const teamRoot = await makeTeamRoot()
    const delivery = makeDelivery(teamRoot)

    expect(await delivery.deliver(message, authority)).toEqual({
      kind: 'delivered',
    })
    expect(await delivery.deliver(message, authority)).toEqual({
      kind: 'delivered',
    })

    const rows = JSON.parse(
      await readFile(join(teamRoot, 'inboxes', 'team-lead.json'), 'utf8'),
    )
    expect(rows).toEqual([
      {
        messageId: message.messageId,
        from: 'user',
        text: message.text,
        timestamp: message.createdAt,
        read: false,
      },
    ])
    const markerFiles = await readdir(
      join(teamRoot, 'hosted-message-delivery-operations'),
    )
    expect(markerFiles).toHaveLength(1)
    const marker = JSON.parse(
      await readFile(
        join(teamRoot, 'hosted-message-delivery-operations', markerFiles[0]!),
        'utf8',
      ),
    )
    expect(marker.status).toBe('delivered')
    expect(marker.binding).toEqual({
      actorId: authority.actorId,
      workspaceId: authority.workspaceId,
      teamId,
      clientMessageId: message.clientMessageId,
      messageId: message.messageId,
      textSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
  })

  test('treats a binding mismatch as operator_required without another mailbox effect', async () => {
    const teamRoot = await makeTeamRoot()
    const delivery = makeDelivery(teamRoot)
    expect(await delivery.deliver(message, authority)).toEqual({
      kind: 'delivered',
    })

    const mismatch = { ...message, messageId: `message_${'d'.repeat(32)}` }
    expect(await delivery.deliver(mismatch, authority)).toEqual({
      kind: 'operator_required',
    })
    const rows = JSON.parse(
      await readFile(join(teamRoot, 'inboxes', 'team-lead.json'), 'utf8'),
    )
    expect(rows).toHaveLength(1)
  })

  test('serializes concurrent exact deliveries behind one mailbox effect', async () => {
    const teamRoot = await makeTeamRoot()
    let effects = 0
    const delivery = makeDelivery(teamRoot, async input => {
      effects += 1
      return writeToMailboxAtCanonicalTeamRootVerified(input)
    })

    const decisions = await Promise.all(
      Array.from({ length: 5 }, () => delivery.deliver(message, authority)),
    )
    expect(decisions).toEqual(
      Array.from({ length: 5 }, () => ({ kind: 'delivered' })),
    )
    expect(effects).toBe(1)
  })

  test('never resends after an ambiguous mailbox effect', async () => {
    const teamRoot = await makeTeamRoot()
    let effects = 0
    const delivery = makeDelivery(teamRoot, async input => {
      effects += 1
      await writeToMailboxAtCanonicalTeamRootVerified(input)
      throw new Error('lost acknowledgement after durable write')
    })

    expect(await delivery.deliver(message, authority)).toEqual({
      kind: 'operator_required',
    })
    expect(await delivery.deliver(message, authority)).toEqual({
      kind: 'operator_required',
    })
    expect(effects).toBe(1)
    const rows = JSON.parse(
      await readFile(join(teamRoot, 'inboxes', 'team-lead.json'), 'utf8'),
    )
    expect(rows).toHaveLength(1)
  })

  test('requires an operator for an unreadable existing operation marker', async () => {
    const teamRoot = await makeTeamRoot()
    let effects = 0
    const delivery = makeDelivery(teamRoot, async input => {
      effects += 1
      return writeToMailboxAtCanonicalTeamRootVerified(input)
    })
    expect(await delivery.deliver(message, authority)).toEqual({
      kind: 'delivered',
    })
    const markerDirectory = join(teamRoot, 'hosted-message-delivery-operations')
    const [markerName] = await readdir(markerDirectory)
    await writeFile(join(markerDirectory, markerName!), '{', 'utf8')

    expect(await delivery.deliver(message, authority)).toEqual({
      kind: 'operator_required',
    })
    expect(effects).toBe(1)
  })

  test('fails closed on incarnation or root binding mismatch', async () => {
    const teamRoot = await makeTeamRoot()
    const delivery = makeDelivery(teamRoot)
    expect(
      await delivery.deliver(message, {
        ...authority,
        bootId: 'other-boot',
      }),
    ).toEqual({ kind: 'operator_required' })
    expect(await readdir(teamRoot)).toEqual([])
    expect(
      () =>
        new HostedTeamLeadMessageDelivery({
          canonicalTeamRoot: teamRoot,
          legacyKey: '../different-key',
          authority,
          guard: { isCurrent: async () => true },
        }),
    ).toThrow('explicit canonical team root')
    expect(
      () =>
        new HostedTeamLeadMessageDelivery({
          canonicalTeamRoot: teamRoot,
          legacyKey: 'different-key',
          authority,
          guard: { isCurrent: async () => true },
        }),
    ).toThrow('explicit canonical team root')
  })

  test('waits for an admitted mailbox effect during close and rejects later effects', async () => {
    const teamRoot = await makeTeamRoot()
    let releaseEffect!: () => void
    const effectReleased = new Promise<void>(resolve => {
      releaseEffect = resolve
    })
    let effectStarted!: () => void
    const started = new Promise<void>(resolve => {
      effectStarted = resolve
    })
    const delivery = makeDelivery(teamRoot, async input => {
      effectStarted()
      await effectReleased
      return writeToMailboxAtCanonicalTeamRootVerified(input)
    })

    const admitted = delivery.deliver(message, authority)
    await started
    let closed = false
    const closing = delivery.close().then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(closed).toBe(false)
    expect(
      await delivery.deliver(
        { ...message, messageId: `message_${'e'.repeat(32)}` },
        authority,
      ),
    ).toEqual({ kind: 'unavailable' })

    releaseEffect()
    expect(await admitted).toEqual({ kind: 'delivered' })
    await closing
    expect(closed).toBe(true)
  })

  test('does not repair an unsafe preexisting inbox file', async () => {
    const teamRoot = await makeTeamRoot()
    const inboxDir = join(teamRoot, 'inboxes')
    await mkdir(inboxDir, { mode: 0o700 })
    const inboxPath = join(inboxDir, 'team-lead.json')
    await writeFile(inboxPath, '[]', { mode: 0o660 })
    await chmod(inboxPath, 0o660)

    expect(await makeDelivery(teamRoot).deliver(message, authority)).toEqual({
      kind: 'operator_required',
    })
    expect((await lstat(inboxPath)).mode & 0o077).toBe(0o060)
  })

  test('revalidates after the effect and leaves a delivered replay marker', async () => {
    const teamRoot = await makeTeamRoot()
    let current = true
    let checks = 0
    const delivery = new HostedTeamLeadMessageDelivery({
      canonicalTeamRoot: teamRoot,
      legacyKey: 'legacy',
      authority,
      guard: { isCurrent: async () => ++checks < 3 || current },
    })
    current = false
    expect(await delivery.deliver(message, authority)).toEqual({
      kind: 'unavailable',
    })
    current = true
    expect(await delivery.deliver(message, authority)).toEqual({
      kind: 'delivered',
    })
    const rows = JSON.parse(
      await readFile(join(teamRoot, 'inboxes', 'team-lead.json'), 'utf8'),
    )
    expect(rows).toHaveLength(1)
  })

  test('appends a teammate DM to its own inbox and never to a removed teammate', async () => {
    const teamRoot = await makeTeamRoot()
    const writeRoster = (members: unknown[]) =>
      writeFile(join(teamRoot, 'config.json'), JSON.stringify({ name: 'legacy', members }), { mode: 0o600 })
    await writeRoster([{ name: 'team-lead', agentType: 'team-lead' }, { name: 'alice' }, { name: 'bob' }])
    const delivery = new HostedTeamLeadMessageDelivery({
      canonicalTeamRoot: teamRoot,
      legacyKey: 'legacy',
      authority,
      guard: { isCurrent: async () => true },
      recipients: new HostedTeamRecipientRoster(teamRoot),
    })

    expect(await delivery.deliver({ ...message, recipient: 'alice' }, authority))
      .toEqual({ kind: 'delivered' })
    expect(JSON.parse(await readFile(join(teamRoot, 'inboxes', 'alice.json'), 'utf8'))).toEqual([{
      messageId: message.messageId, from: 'user', text: message.text, timestamp: message.createdAt, read: false,
    }])
    await expect(lstat(join(teamRoot, 'inboxes', 'team-lead.json'))).rejects.toThrow()
    const [markerFile] = await readdir(join(teamRoot, 'hosted-message-delivery-operations'))
    const marker = JSON.parse(await readFile(
      join(teamRoot, 'hosted-message-delivery-operations', markerFile!), 'utf8'))
    expect({ recipient: marker.recipient, status: marker.status }).toEqual({ recipient: 'alice', status: 'delivered' })

    await writeRoster([{ name: 'team-lead', agentType: 'team-lead' }, { name: 'alice' }, { name: 'bob', removedAt: 1 }])
    const toRemoved = { ...message, clientMessageId: 'client_message_removed-bob', recipient: 'bob' }
    expect(await delivery.deliver(toRemoved, authority)).toEqual({ kind: 'operator_required' })
    await expect(lstat(join(teamRoot, 'inboxes', 'bob.json'))).rejects.toThrow()
    expect(await readdir(join(teamRoot, 'hosted-message-delivery-operations'))).toHaveLength(1)
  })
})

async function makeTeamRoot(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'hosted-message-delivery-'))
  roots.push(parent)
  const root = join(parent, 'legacy')
  await mkdir(root, { mode: 0o700 })
  return realpath(root)
}

function makeDelivery(
  teamRoot: string,
  writeMailbox = writeToMailboxAtCanonicalTeamRootVerified,
): HostedTeamLeadMessageDelivery {
  return new HostedTeamLeadMessageDelivery({
    canonicalTeamRoot: teamRoot,
    legacyKey: 'legacy',
    authority,
    guard: { isCurrent: async () => true },
    writeMailbox,
  })
}
