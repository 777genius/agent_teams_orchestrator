import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync,
  realpathSync } from 'node:fs'
import path from 'node:path'

import { hostedMemberStartOperationId } from '../../teamLifecycleOwner/HostedMemberStartOperationId.js'
import type { HostedMemberNetworkDockerPort, HostedMemberNetworkRequest } from
  '../containerNetworkProvisioning/HostedMemberNetworkProvisioner.js'
import type { HostedProductMemberBinding } from '../productAuthority/HostedProductCurrentMemberDecision.js'
import { HostedRootSingleMemberAuthority } from './HostedRootSingleMemberAuthority.js'
import { RootDockerEngineDispatcher, type RootDockerOperation } from './RootDockerEngineDispatcher.js'

const MARKER = 'org.agentteams.hosted-opencode.member-network-claim'
const NAME = /^hat-member-[a-f0-9]{32}$/
const HEX64 = /^[a-f0-9]{64}$/
const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

type Claim = Readonly<{ requestSha256: string; name: string; nonce: string }>

function canonicalRequest(binding: HostedProductMemberBinding): HostedMemberNetworkRequest {
  return { operationId: hostedMemberStartOperationId(binding.runId, binding.memberId,
    binding.planSha256), planTeamId: binding.teamId, planFingerprint: binding.planSha256,
  runId: binding.runId, teamId: binding.teamId, laneId: binding.laneId, memberId: binding.memberId }
}

function requestSha256(request: HostedMemberNetworkRequest): string {
  return sha(JSON.stringify([request.operationId, request.planTeamId, request.planFingerprint,
    request.runId, request.teamId, request.laneId, request.memberId]))
}

function effectOperationId(request: HostedMemberNetworkRequest): string {
  return `network_create_${sha(request.operationId)}`
}

function networkOperation(request: HostedMemberNetworkRequest, claim: Claim): RootDockerOperation {
  const body = JSON.stringify({ Name: claim.name, Driver: 'bridge', Internal: true,
    EnableIPv4: true, EnableIPv6: false,
    Options: { 'com.docker.network.bridge.enable_ip_masquerade': 'false' },
    Labels: { [MARKER]: claim.nonce } })
  return { kind: 'create_network', operationId: effectOperationId(request),
    body, bodySha256: sha(body) }
}

/** Only the network CREATE route is implemented. Other routes deliberately deny. */
export class RootDockerNetworkCreatePort implements HostedMemberNetworkDockerPort {
  private readonly dispatcher: RootDockerEngineDispatcher<HostedProductMemberBinding>
  private readonly directoryIdentity: Readonly<{ dev: number; ino: number }>
  private readonly uid: number

  private constructor(private readonly stateDirectory: string,
    private readonly authority: HostedRootSingleMemberAuthority,
    private readonly assertDockerApiCompatible: () => Promise<boolean>,
    options: { effectClaimDirectory: string; socketPath: string; testOnlyAllowNonRoot?: boolean }) {
    if (!path.isAbsolute(stateDirectory) || path.normalize(stateDirectory) !== stateDirectory ||
      typeof assertDockerApiCompatible !== 'function') {
      throw new Error('hosted-network-root-port-policy-invalid')
    }
    this.uid = process.getuid?.() ?? -1
    const stat = lstatSync(stateDirectory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.uid ||
      (stat.mode & 0o777) !== 0o700 || realpathSync(stateDirectory) !== stateDirectory) {
      throw new Error('hosted-network-root-port-state-invalid')
    }
    this.directoryIdentity = { dev: stat.dev, ino: stat.ino }
    this.dispatcher = RootDockerEngineDispatcher.create({ stateDir: options.effectClaimDirectory,
      socketPath: options.socketPath, decision: authority, testOnlyAllowNonRoot: options.testOnlyAllowNonRoot,
      resolveAuthorizedOperation: (binding, _current, operationId) => {
        const request = canonicalRequest(binding)
        if (operationId !== effectOperationId(request)) throw new Error('hosted-network-root-target-unbound')
        return networkOperation(request, this.readClaim(request))
      },
    })
  }

  static create(options: { stateDirectory: string; effectClaimDirectory: string; socketPath: string;
    authority: HostedRootSingleMemberAuthority; assertDockerApiCompatible: () => Promise<boolean>;
    testOnlyAllowNonRoot?: boolean }): RootDockerNetworkCreatePort {
    return new RootDockerNetworkCreatePort(options.stateDirectory, options.authority,
      options.assertDockerApiCompatible, options)
  }

  private readClaim(request: HostedMemberNetworkRequest): Claim {
    const directory = lstatSync(this.stateDirectory)
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== this.uid ||
      (directory.mode & 0o777) !== 0o700 || directory.dev !== this.directoryIdentity.dev ||
      directory.ino !== this.directoryIdentity.ino ||
      realpathSync(this.stateDirectory) !== this.stateDirectory) {
      throw new Error('hosted-network-root-port-state-substituted')
    }
    const operationPath = path.join(this.stateDirectory, `network-operation-${request.operationId}.json`)
    const memberPath = path.join(this.stateDirectory,
      `network-member-${sha(`${request.runId}\0${request.teamId}\0${request.memberId}`)}.json`)
    const operationFd = openSync(operationPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    let memberFd: number | undefined
    try {
      memberFd = openSync(memberPath, constants.O_RDONLY | constants.O_NOFOLLOW)
      const operation = fstatSync(operationFd)
      const member = fstatSync(memberFd)
      if (!operation.isFile() || operation.nlink !== 2 || operation.uid !== this.uid ||
        (operation.mode & 0o777) !== 0o600 || operation.size < 1 || operation.size > 256 ||
        operation.dev !== member.dev || operation.ino !== member.ino) {
        throw new Error('hosted-network-root-claim-invalid')
      }
      const bytes = readFileSync(operationFd)
      if (bytes.length !== operation.size) throw new Error('hosted-network-root-claim-invalid')
      const value: unknown = JSON.parse(bytes.toString('utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).sort().join(',') !== 'name,nonce,requestSha256') {
        throw new Error('hosted-network-root-claim-invalid')
      }
      const claim = value as Record<string, unknown>
      if (claim.requestSha256 !== requestSha256(request) ||
        typeof claim.name !== 'string' || !NAME.test(claim.name) ||
        typeof claim.nonce !== 'string' || !HEX64.test(claim.nonce)) {
        throw new Error('hosted-network-root-claim-invalid')
      }
      return claim as Claim
    } finally {
      if (memberFd !== undefined) closeSync(memberFd)
      closeSync(operationFd)
    }
  }

  async assertCompatible(request: HostedMemberNetworkRequest): Promise<void> {
    this.authority.bindingForManagedRequest(request)
    if (await this.assertDockerApiCompatible() !== true) {
      throw new Error('hosted-network-docker-v28-required')
    }
  }

  async create(name: string, marker: string, request: HostedMemberNetworkRequest): Promise<string> {
    const binding = this.authority.bindingForManagedRequest(request)
    const claim = this.readClaim(request)
    if (name !== claim.name || marker !== claim.nonce) throw new Error('hosted-network-root-target-unbound')
    const result = await this.dispatcher.dispatch(networkOperation(request, claim), binding)
    if (result.outcome !== 'responded') throw new Error('hosted-network-root-create-unresolved')
    let response: unknown
    try { response = JSON.parse(result.body.toString('utf8')) }
    catch { throw new Error('hosted-network-root-create-unresolved') }
    if (!response || typeof response !== 'object' || Array.isArray(response) ||
      Object.keys(response).sort().join(',') !== 'Id,Warning') {
      throw new Error('hosted-network-root-create-unresolved')
    }
    const row = response as Record<string, unknown>
    if (typeof row.Id !== 'string' || !HEX64.test(row.Id) || row.Warning !== '') {
      throw new Error('hosted-network-root-create-unresolved')
    }
    return row.Id
  }

  async inspect(): Promise<never> { throw new Error('hosted-network-root-inspect-unavailable') }
  async remove(): Promise<never> { throw new Error('hosted-network-root-remove-unavailable') }
}
