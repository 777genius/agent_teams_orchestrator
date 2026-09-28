import { createHash, randomBytes } from 'node:crypto'

import type { HostedProductMemberBinding } from '../productAuthority/HostedProductCurrentMemberDecision.js'
import { HostedRootSingleMemberAuthority } from './HostedRootSingleMemberAuthority.js'
import { RootDockerEngineDispatcher, type RootDockerOperation } from './RootDockerEngineDispatcher.js'

const SHA = /^[a-f0-9]{64}$/
const IMAGE = /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/
const BOOTSTRAP_LABEL = 'org.agentteams.hosted-opencode.bootstrap-sha256'
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

type Options = Readonly<{
  effectClaimDirectory: string
  socketPath: string
  authority: HostedRootSingleMemberAuthority
  binding: HostedProductMemberBinding
  image: string
  imageId: string
  bootstrapSha256: string
  networkId: string
  testOnlyAllowNonRoot?: boolean
}>

function object(bytes: Buffer): Record<string, unknown> {
  let parsed: unknown
  try { parsed = JSON.parse(bytes.toString('utf8')) }
  catch { throw new Error('root-docker-proof-response-invalid') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('root-docker-proof-response-invalid')
  }
  return parsed as Record<string, unknown>
}

/** Fixed, read-only image/network probes. Owner supplies neither Docker target nor operation body. */
export class RootDockerReadOnlyProofPort {
  private readonly dispatcher: RootDockerEngineDispatcher<HostedProductMemberBinding>
  private readonly binding: HostedProductMemberBinding
  private readonly targets: Readonly<{ image: string; imageId: string;
    bootstrapSha256: string; networkId: string }>
  private readonly pending = new Map<string, RootDockerOperation>()

  private constructor(options: Options) {
    if (!IMAGE.test(options.image) || !/^sha256:[a-f0-9]{64}$/.test(options.imageId) ||
      !SHA.test(options.bootstrapSha256) || !SHA.test(options.networkId)) {
      throw new Error('root-docker-proof-policy-invalid')
    }
    this.binding = Object.freeze({ ...options.binding })
    this.targets = Object.freeze({ image: options.image, imageId: options.imageId,
      bootstrapSha256: options.bootstrapSha256, networkId: options.networkId })
    this.dispatcher = RootDockerEngineDispatcher.create({ stateDir: options.effectClaimDirectory,
      socketPath: options.socketPath, decision: options.authority,
      testOnlyAllowNonRoot: options.testOnlyAllowNonRoot,
      resolveAuthorizedOperation: (_binding, _current, id) => {
        const operation = this.pending.get(id)
        if (!operation || operation.kind === 'inspect_image' && operation.imageRef !== this.targets.image ||
          operation.kind === 'inspect_network' && operation.networkId !== this.targets.networkId) {
          throw new Error('root-docker-proof-target-unbound')
        }
        return operation
      },
    })
  }

  static create(options: Options): RootDockerReadOnlyProofPort {
    return new RootDockerReadOnlyProofPort(options)
  }

  private async read(operation: RootDockerOperation): Promise<Record<string, unknown>> {
    this.pending.set(operation.operationId, operation)
    try {
      const result = await this.dispatcher.dispatch(operation, this.binding)
      if (result.outcome !== 'responded') throw new Error('root-docker-proof-unresolved')
      return object(result.body)
    } finally { this.pending.delete(operation.operationId) }
  }

  async inspectImage(): Promise<Record<string, unknown>> {
    const image = await this.read({ kind: 'inspect_image', imageRef: this.targets.image,
      operationId: `image_inspect_${randomBytes(16).toString('hex')}`, bodySha256: sha('') })
    const config = image.Config
    const labels = config && typeof config === 'object' && !Array.isArray(config)
      ? (config as Record<string, unknown>).Labels : null
    if (image.Id !== this.targets.imageId || !Array.isArray(image.RepoDigests) ||
      !image.RepoDigests.includes(this.targets.image) || !labels || typeof labels !== 'object' ||
      (labels as Record<string, unknown>)[BOOTSTRAP_LABEL] !== this.targets.bootstrapSha256) {
      throw new Error('root-docker-image-proof-invalid')
    }
    return image
  }

  async inspectNetwork(): Promise<Record<string, unknown>> {
    const network = await this.read({ kind: 'inspect_network', networkId: this.targets.networkId,
      operationId: `network_inspect_${randomBytes(16).toString('hex')}`, bodySha256: sha('') })
    if (network.Id !== this.targets.networkId || network.Driver !== 'bridge' ||
      network.Scope !== 'local' || network.Internal !== true || network.EnableIPv6 !== false ||
      !network.Containers || typeof network.Containers !== 'object' || Array.isArray(network.Containers)) {
      throw new Error('root-docker-network-proof-invalid')
    }
    return network
  }
}
