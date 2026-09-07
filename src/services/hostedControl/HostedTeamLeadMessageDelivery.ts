import { createHash } from 'node:crypto'
import { constants, lstat, mkdir, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { writeFileAtomic } from '../../utils/atomicWrite.js'
import * as lockfile from '../../utils/lockfile.js'
import {
  writeToMailboxAtCanonicalTeamRootVerified,
  type ExplicitRootVerifiedMailboxWriteResult,
} from '../../utils/teammateMailboxExplicitRoot.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import { fsyncFileAndParent } from './HostedTaskMutationWal.js'
import type {
  HostedMessageAuthorityGuard,
  HostedMessageDeliveryEffectPort,
  HostedPersistedMessage,
} from './HostedTeamMessageService.js'
import type {
  HostedControlAuthority,
  HostedControlStableAuthority,
} from './protocol.js'

const MARKER_DIRECTORY = 'hosted-message-delivery-operations'
const MARKER_DOMAIN = 'agent-teams.hosted-message.delivery-operation/v1'
const MAX_MARKER_BYTES = 16 * 1024
const LOCK_OPTIONS = {
  realpath: false,
  retries: { retries: 50, minTimeout: 5, maxTimeout: 100 },
} as const

type MarkerStatus = 'intent' | 'delivered' | 'operator_required'
type DeliveryBinding = {
  actorId: string
  workspaceId: string
  teamId: string
  clientMessageId: string
  messageId: string
  textSha256: string
}
type DeliveryMarker = {
  schemaVersion: 1
  canonicalTeamRoot: string
  legacyKey: string
  authority: HostedControlAuthority
  binding: DeliveryBinding
  recipient: typeof TEAM_LEAD_NAME
  status: MarkerStatus
}
type MailboxWriter = (input: {
  canonicalTeamRoot: string
  recipientName: string
  message: { messageId: string; from: string; text: string; timestamp: string }
}) => Promise<ExplicitRootVerifiedMailboxWriteResult>

export type HostedTeamLeadMessageDeliveryOptions = {
  canonicalTeamRoot: string
  legacyKey: string
  authority: Readonly<HostedControlStableAuthority>
  guard: HostedMessageAuthorityGuard
  writeMailbox?: MailboxWriter
}

/** Owns the one production effect that appends hosted v1 messages to team-lead's inbox. */
export class HostedTeamLeadMessageDelivery implements HostedMessageDeliveryEffectPort {
  readonly #root: string
  readonly #legacyKey: string
  readonly #authority: Readonly<HostedControlStableAuthority>
  readonly #guard: HostedMessageAuthorityGuard
  readonly #writeMailbox: MailboxWriter
  readonly #markerDirectory: string
  readonly #declaredLegacyRoot: string
  readonly #inFlight = new Set<Promise<void>>()
  #accepting = true
  #closePromise: Promise<void> | null = null

  constructor(options: HostedTeamLeadMessageDeliveryOptions) {
    if (
      !isAbsolute(options.canonicalTeamRoot) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(options.legacyKey) ||
      join(dirname(options.canonicalTeamRoot), options.legacyKey) !==
        options.canonicalTeamRoot
    ) {
      throw new TypeError(
        'Hosted delivery requires an explicit canonical team root and legacy key',
      )
    }
    this.#root = options.canonicalTeamRoot
    this.#legacyKey = options.legacyKey
    this.#authority = Object.freeze({
      ...options.authority,
      mountBinding: Object.freeze({ ...options.authority.mountBinding }),
    })
    this.#guard = options.guard
    this.#writeMailbox =
      options.writeMailbox ?? writeToMailboxAtCanonicalTeamRootVerified
    this.#markerDirectory = join(this.#root, MARKER_DIRECTORY)
    this.#declaredLegacyRoot = join(dirname(this.#root), this.#legacyKey)
  }

  async deliver(
    message: HostedPersistedMessage,
    authority: HostedControlAuthority,
  ): Promise<{ kind: 'delivered' | 'operator_required' | 'unavailable' }> {
    if (!this.#accepting) return { kind: 'unavailable' }
    const operation = this.#deliver(message, authority)
    const tracked = operation.then(
      () => undefined,
      () => undefined,
    )
    this.#inFlight.add(tracked)
    void tracked.finally(() => this.#inFlight.delete(tracked))
    return operation
  }

  async close(): Promise<void> {
    this.#accepting = false
    this.#closePromise ??= Promise.all([...this.#inFlight]).then(
      () => undefined,
    )
    await this.#closePromise
  }

  async #deliver(
    message: HostedPersistedMessage,
    authority: HostedControlAuthority,
  ): Promise<{ kind: 'delivered' | 'operator_required' | 'unavailable' }> {
    if (
      !this.#matchesAuthority(authority) ||
      message.teamId !== authority.teamId
    ) {
      return { kind: 'operator_required' }
    }
    if (!(await this.#guard.isCurrent(authority)))
      return { kind: 'unavailable' }

    const binding = deliveryBinding(message, authority)
    let intentPersisted = false
    try {
      await this.#prepareMarkerDirectory()
      const path = this.#markerPath(binding)
      const release = await lockfile.lock(path, LOCK_OPTIONS)
      try {
        let existing: DeliveryMarker | null
        try {
          existing = await this.#readMarker(path)
        } catch {
          return { kind: 'operator_required' }
        }
        if (existing) {
          if (!isMarkerStatus(existing.status))
            return { kind: 'operator_required' }
          if (
            !isDeepStrictEqual(existing, this.#marker(binding, existing.status))
          ) {
            return { kind: 'operator_required' }
          }
          if (!(await this.#guard.isCurrent(authority)))
            return { kind: 'unavailable' }
          return existing.status === 'delivered'
            ? { kind: 'delivered' }
            : { kind: 'operator_required' }
        }

        await this.#writeMarker(path, this.#marker(binding, 'intent'))
        intentPersisted = true
        if (!(await this.#guard.isCurrent(authority)))
          return { kind: 'operator_required' }
        let write: ExplicitRootVerifiedMailboxWriteResult
        try {
          write = await this.#writeMailbox({
            canonicalTeamRoot: this.#root,
            recipientName: TEAM_LEAD_NAME,
            message: {
              messageId: message.messageId,
              from: 'user',
              text: message.text,
              timestamp: message.createdAt,
            },
          })
        } catch {
          await Promise.resolve(this.#guard.isCurrent(authority)).catch(
            () => false,
          )
          return { kind: 'operator_required' }
        }
        const currentAfterEffect = await this.#guard.isCurrent(authority)
        if (write.kind === 'conflict') {
          await this.#writeMarker(
            path,
            this.#marker(binding, 'operator_required'),
          )
          return { kind: 'operator_required' }
        }
        await this.#writeMarker(path, this.#marker(binding, 'delivered'))
        if (!currentAfterEffect) return { kind: 'unavailable' }
        return { kind: 'delivered' }
      } finally {
        await release()
      }
    } catch {
      return intentPersisted
        ? { kind: 'operator_required' }
        : { kind: 'unavailable' }
    }
  }

  #matchesAuthority(authority: HostedControlAuthority): boolean {
    return (
      authority.workspaceId === this.#authority.workspaceId &&
      authority.teamId === this.#authority.teamId &&
      authority.deploymentId === this.#authority.deploymentId &&
      authority.bootId === this.#authority.bootId &&
      authority.restoreGeneration === this.#authority.restoreGeneration &&
      authority.mountBinding.mountGeneration ===
        this.#authority.mountBinding.mountGeneration &&
      authority.mountBinding.declaredRootHash ===
        this.#authority.mountBinding.declaredRootHash
    )
  }

  #marker(binding: DeliveryBinding, status: MarkerStatus): DeliveryMarker {
    return {
      schemaVersion: 1,
      canonicalTeamRoot: this.#root,
      legacyKey: this.#legacyKey,
      authority: { actorId: binding.actorId, ...this.#authority },
      binding,
      recipient: TEAM_LEAD_NAME,
      status,
    }
  }

  #markerPath(binding: DeliveryBinding): string {
    const digest = createHash('sha256')
      .update(MARKER_DOMAIN)
      .update('\0')
      .update(
        JSON.stringify({
          actorId: binding.actorId,
          workspaceId: binding.workspaceId,
          teamId: binding.teamId,
          clientMessageId: binding.clientMessageId,
        }),
      )
      .digest('hex')
    return join(this.#markerDirectory, `${digest}.delivery.v1.json`)
  }

  async #prepareMarkerDirectory(): Promise<void> {
    const [canonicalRoot, canonicalDeclaredRoot, rootStat, declaredRootStat] =
      await Promise.all([
        realpath(this.#root),
        realpath(this.#declaredLegacyRoot),
        lstat(this.#root),
        lstat(this.#declaredLegacyRoot),
      ])
    if (
      canonicalRoot !== this.#root ||
      canonicalDeclaredRoot !== this.#root ||
      rootStat.dev !== declaredRootStat.dev ||
      rootStat.ino !== declaredRootStat.ino
    )
      throw new Error('Hosted delivery root is no longer canonical')
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      (rootStat.mode & 0o022) !== 0 ||
      (process.getuid?.() !== undefined && rootStat.uid !== process.getuid())
    ) {
      throw new Error('Hosted delivery root is not private')
    }
    try {
      await mkdir(this.#markerDirectory, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const stat = await lstat(this.#markerDirectory)
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await realpath(this.#markerDirectory)) !== this.#markerDirectory
    ) {
      throw new Error('Unsafe hosted delivery marker directory')
    }
    if (
      (stat.mode & 0o022) !== 0 ||
      (process.getuid?.() !== undefined && stat.uid !== process.getuid())
    ) {
      throw new Error('Hosted delivery marker directory is not private')
    }
  }

  async #writeMarker(path: string, marker: DeliveryMarker): Promise<void> {
    await writeFileAtomic(path, `${JSON.stringify(marker)}\n`, { mode: 0o600 })
    await fsyncFileAndParent(path)
  }

  async #readMarker(path: string): Promise<DeliveryMarker | null> {
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    ).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (!handle) return null
    try {
      const [stat, current] = await Promise.all([handle.stat(), lstat(path)])
      if (
        !stat.isFile() ||
        !current.isFile() ||
        current.isSymbolicLink() ||
        stat.dev !== current.dev ||
        stat.ino !== current.ino ||
        stat.size > MAX_MARKER_BYTES ||
        (stat.mode & 0o077) !== 0 ||
        (process.getuid?.() !== undefined && stat.uid !== process.getuid())
      ) {
        throw new Error('Unsafe hosted delivery marker')
      }
      const text = await handle.readFile('utf8')
      if (Buffer.byteLength(text) > MAX_MARKER_BYTES)
        throw new Error('Hosted delivery marker is too large')
      return JSON.parse(text) as DeliveryMarker
    } finally {
      await handle.close()
    }
  }
}

function deliveryBinding(
  message: HostedPersistedMessage,
  authority: HostedControlAuthority,
): DeliveryBinding {
  return {
    actorId: authority.actorId,
    workspaceId: authority.workspaceId,
    teamId: authority.teamId,
    clientMessageId: message.clientMessageId,
    messageId: message.messageId,
    textSha256: createHash('sha256').update(message.text).digest('hex'),
  }
}

function isMarkerStatus(value: unknown): value is MarkerStatus {
  return (
    value === 'intent' || value === 'delivered' || value === 'operator_required'
  )
}
