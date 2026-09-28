import { readFileSync } from 'node:fs'
import path from 'node:path'

import type { HostedRootTrustedMemberPort } from '../container/HostedOpenCodeContainerSupervisor.js'
import type { PendingOwnerChannel } from '../container/HostedOpenCodeFd3Handoff.js'
import type { HostedMemberNetworkRequest } from '../containerNetworkProvisioning/HostedMemberNetworkProvisioner.js'
import { HostedRootSingleMemberAuthority } from './HostedRootSingleMemberAuthority.js'

const ID = /^[a-z0-9][a-z0-9_-]{7,95}$/
const SHA = /^[a-f0-9]{64}$/
const SOCKET = /^fd3-[a-f0-9]{32}\.sock$/

type Connector = Readonly<{ pid: number; startTicks: string }>
type Pins = Readonly<{
  managedRequest: HostedMemberNetworkRequest
  leaseId: string
  ownerChannel: PendingOwnerChannel
  ownerSocketDirectory: string
}>

function rootConnector(): Connector {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) {
    throw new Error('hosted-root-connector-unavailable')
  }
  const stat = readFileSync('/proc/self/stat', 'ascii')
  const end = stat.lastIndexOf(') ')
  const pid = Number(stat.slice(0, stat.indexOf(' ')))
  const fields = end < 0 ? [] : stat.slice(end + 2).trim().split(/\s+/)
  const startTicks = fields[19]
  if (pid !== process.pid || !startTicks || !/^\d+$/.test(startTicks)) {
    throw new Error('hosted-root-connector-invalid')
  }
  return { pid, startTicks }
}

/** Resolves only one root-pinned member. Product is checked again before each prepare/start. */
export class HostedRootTrustedMemberResolver implements HostedRootTrustedMemberPort {
  private readonly pins: Pins
  private readonly binding: ReturnType<HostedRootSingleMemberAuthority['bindingForManagedRequest']>

  constructor(private readonly authority: HostedRootSingleMemberAuthority, pins: Pins,
    private readonly testOnlyReadConnector?: () => Connector) {
    if (testOnlyReadConnector && process.env.NODE_ENV !== 'test') {
      throw new Error('hosted-root-connector-test-hook-forbidden')
    }
    if (!pins || Object.keys(pins).sort().join(',') !==
      ['managedRequest', 'leaseId', 'ownerChannel', 'ownerSocketDirectory'].sort().join(',') ||
      !ID.test(pins.leaseId) || !pins.leaseId.startsWith('lease_') ||
      typeof pins.ownerSocketDirectory !== 'string' || !path.isAbsolute(pins.ownerSocketDirectory) ||
      path.normalize(pins.ownerSocketDirectory) !== pins.ownerSocketDirectory ||
      !pins.ownerChannel || Object.keys(pins.ownerChannel).sort().join(',') !== 'challenge,socketPath' ||
      typeof pins.ownerChannel.socketPath !== 'string' ||
      path.dirname(pins.ownerChannel.socketPath) !== pins.ownerSocketDirectory ||
      !SOCKET.test(path.basename(pins.ownerChannel.socketPath)) ||
      !SHA.test(pins.ownerChannel.challenge)) {
      throw new Error('hosted-root-trusted-member-pins-invalid')
    }
    this.binding = authority.bindingForManagedRequest(pins.managedRequest)
    this.pins = Object.freeze({ ...pins, managedRequest: Object.freeze({ ...pins.managedRequest }),
      ownerChannel: Object.freeze({ ...pins.ownerChannel }) })
  }

  async resolveCurrent(operationId: string, action: 'prepare' | 'start') {
    if (operationId !== this.pins.managedRequest.operationId ||
      (action !== 'prepare' && action !== 'start')) {
      throw new Error('hosted-root-trusted-member-selector-denied')
    }
    return this.authority.withCurrentMemberDecision(this.binding, action, current => {
      const connector = this.testOnlyReadConnector ? this.testOnlyReadConnector() : rootConnector()
      if (!connector || !Number.isSafeInteger(connector.pid) || connector.pid < 1 ||
        typeof connector.startTicks !== 'string' || !/^\d+$/.test(connector.startTicks) ||
        current.runId !== this.pins.managedRequest.runId ||
        current.teamId !== this.pins.managedRequest.teamId ||
        current.laneId !== this.pins.managedRequest.laneId ||
        current.memberId !== this.pins.managedRequest.memberId) {
        throw new Error('hosted-root-trusted-member-current-invalid')
      }
      return { request: { operationId, leaseId: this.pins.leaseId,
        runId: current.runId, teamId: current.teamId, laneId: current.laneId,
        memberId: current.memberId, ownerChannel: this.pins.ownerChannel }, connector }
    })
  }
}
