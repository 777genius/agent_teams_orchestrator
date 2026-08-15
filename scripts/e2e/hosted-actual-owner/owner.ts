import { createHash, randomBytes } from 'node:crypto'
import { chmod, lstat, rename, unlink, type FileHandle } from 'node:fs/promises'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HostedApprovalOwnerService } from '../../../src/services/hostedControl/HostedApprovalOwnerService.js'
import { HostedApprovalOwnerStore } from '../../../src/services/hostedControl/HostedApprovalOwnerStore.js'
import { HostedApprovalOwnerWal } from '../../../src/services/hostedControl/HostedApprovalOwnerWal.js'
import { PrivateFileHostedApprovalRuntimeAdmissionStore, type HostedApprovalRuntimeAdmission } from '../../../src/services/hostedControl/HostedApprovalRuntimeAdmission.js'
import type { HostedApprovalWirePort } from '../../../src/services/hostedControl/HostedApprovalWire.js'
import type { HostedControlRuntimePortFactoryContext } from '../../../src/services/hostedControl/HostedControlRuntime.js'
import { HostedControlRuntime } from '../../../src/services/hostedControl/HostedControlRuntime.js'
import { hostedControlAuthorityFromConfig } from '../../../src/services/hostedControl/HostedControlRuntimeConfig.js'
import { HOSTED_LIFECYCLE_PROOF_DOMAIN } from '../../../src/services/hostedControl/HostedControlServer.js'
import { createHostedRawDomainProof, parseStrictHostedProofLastJsonFrame } from '../../../src/services/hostedControl/ownerProof.js'
import type { HostedControlOwnerBinding } from '../../../src/services/hostedControl/protocol.js'
import { readHostedControlBootstrap, type HostedControlBootstrapAdmission } from '../../../src/services/hostedControl/HostedControlBootstrap.js'
import { OpenCodeHostedApprovalRuntimeAdapter } from '../../../src/services/hostedControl/OpenCodeHostedApprovalRuntimeAdapter.js'
import { fingerprintOpenCodeApprovalSessionRecord, liveEffectFingerprint } from '../../../src/services/hostedControl/OpenCodeHostedApprovalRuntimeAdapter.js'
import { openCodeSessionBridge, type OpenCodePermissionEffectContext } from '../../../src/services/opencode/OpenCodeSessionBridge.js'
import { openCodeSessionStore } from '../../../src/services/opencode/OpenCodeSessionStore.js'
import { prepareOpenCodeArtifactDigestToken, resolveExecutingOpenCodeArtifactDigest } from '../../../src/services/opencode/OpenCodeArtifactDigest.js'
import {
  assertAcceptanceConfigCurrent, assertMarkerOwnedSandbox, loadAcceptanceConfig, HOSTED_APPROVAL_ADMISSION_FILE,
  isWithin, sandboxAnchor, type ActualOwnerAcceptanceConfig,
} from './contracts.js'
import { validateBootstrapAcceptance } from './bootstrap.js'
import { AcceptanceAuthority } from './authority.js'
import { processStartIdentity, proveExecutingProviderIdentity } from './provider-identity.js'
import { buildAcceptanceEvidence, productTimelineLine, validateAcceptanceEvidence, validateProductTimelineEvent,
  type ActualOwnerAcceptanceEvidence, type ActualOwnerProductTimelineEvent } from './evidence.js'
import {
  appendPrivateLine, assertAnchoredIdentity, assertControlCleanupAuthority, assertSocketBinding, atomicPrivateJson, readAnchoredFile,
  openTrustedDirectory, type SecureFileIdentity,
} from './secure-files.js'

const MAX_CONTROL_BYTES = 16 * 1024
type ProviderIdentity = ActualOwnerAcceptanceEvidence['providers'][number]
function approvalIdForRecord(record: { authority: { teamId: string; runId: string }; commandId: string }): string {
  return `approval_${createHash('sha256').update(JSON.stringify({
    schemaVersion: 1, teamId: record.authority.teamId,
    runId: record.authority.runId, requestId: record.commandId,
  })).digest('hex').slice(0, 32)}`
}
export { processStartIdentity, proveExecutingProviderIdentity } from './provider-identity.js'
class EvidenceApprovalPort implements HostedApprovalWirePort {
  constructor(
    readonly service: HostedApprovalOwnerService,
    private readonly changed: (
      event: ActualOwnerProductTimelineEvent['event'], approvalId: string | null,
      requestId: string | null, effectId: string | null,
      reconciliation?: { reconciliationRef: string; providerDeliveryId: string; runId: string },
    ) => Promise<void>,
  ) {}
  async claimIngress(input: Parameters<HostedApprovalWirePort['claimIngress']>[0]) {
    const result = await this.service.claimIngress(input)
    for (const record of result) {
      await this.changed('ingress_durable', approvalIdForRecord(record), record.commandId, record.effectRef)
    }
    return result
  }
  acknowledgeIngress(request: Parameters<HostedApprovalWirePort['acknowledgeIngress']>[0]) { return this.service.acknowledgeIngress(request) }
  getAdmittedIngressAuthority(authority: Parameters<HostedApprovalWirePort['getAdmittedIngressAuthority']>[0]) { return this.service.getAdmittedIngressAuthority(authority) }
  resolveIngressAuthority(authority: Parameters<HostedApprovalWirePort['resolveIngressAuthority']>[0]) { return this.service.resolveIngressAuthority(authority) }
  authorizeDecision(input: Parameters<HostedApprovalWirePort['authorizeDecision']>[0]) { return this.service.authorizeDecision(input) }
  async deliverDecision(input: Parameters<HostedApprovalWirePort['deliverDecision']>[0]) {
    const result = await this.service.deliverDecision(input)
    const event = result.status === 'delivered' || result.status === 'idempotent_replay'
      ? input.request.decision === 'allow' ? 'completed' : 'rejected'
      : 'decision_committed'
    await this.changed(event, input.request.approvalId, input.request.requestId, null)
    return result
  }
  async reconcileDecision(request: Parameters<HostedApprovalWirePort['reconcileDecision']>[0]) {
    const result = await this.service.reconcileDecision(request)
    await this.changed(`reconcile_${result.status}`, null, null, null, {
      reconciliationRef: request.reconciliationRef, providerDeliveryId: request.providerDeliveryId,
      runId: request.partition.runId,
    })
    return result
  }
}
export class AcceptanceRuntime {
  private runtime: HostedControlRuntime | null = null
  private readinessLease: Socket | null = null
  private service: HostedApprovalOwnerService | null = null
  private store: HostedApprovalOwnerStore | null = null
  private admission: HostedApprovalRuntimeAdmission | null = null
  private control: Server | null = null
  private controlIdentity: { device: number; inode: number } | null = null
  private controlParentIdentity: { device: number; inode: number } | null = null
  private controlParentHandle: FileHandle | null = null
  private controlRootHandle: FileHandle | null = null
  private publication: {
    admission: SecureFileIdentity
  } | null = null
  private admissionSha256: string | null = null
  private configSha256: string | null = null
  private ownerProcessStartIdentity = '0'
  private providerIdentities = new Map<string, ProviderIdentity>()
  private acceptanceAuthority: AcceptanceAuthority | null = null
  private bootstrapReleased = false
  private stopping = false
  private evidence: ActualOwnerAcceptanceEvidence
  private sequence = 0
  private timeline: {
    identity: SecureFileIdentity; sha256: string; bytes: number; eventCount: number; lastSequence: number
  } | null = null

  constructor(
    readonly config: ActualOwnerAcceptanceConfig,
    readonly bootstrap: HostedControlBootstrapAdmission,
    private readonly testHooks: Readonly<{ afterControlTombstone?: () => void | Promise<void> }> = {},
  ) {
    this.evidence = buildAcceptanceEvidence({ config, status: 'starting' })
  }
  async start(): Promise<void> {
    await assertMarkerOwnedSandbox(this.config.runtime)
    await this.waitForProductPublication()
    await this.assertPublicationCurrent()
    this.ownerProcessStartIdentity = await processStartIdentity(process.pid)
    const expectedTeamRoot = join(this.bootstrap.config.claudeRoot, 'teams', this.bootstrap.config.legacyKey)
    if (this.config.admissionFile !== join(expectedTeamRoot, HOSTED_APPROVAL_ADMISSION_FILE) ||
      this.config.walFile !== join(expectedTeamRoot, 'hosted-approval-owner.v1.json') ||
      !isWithin(this.config.sandboxRoot, expectedTeamRoot)) {
      throw new Error('hosted_actual_owner_product_admission_path_mismatch')
    }
    const admission = await new PrivateFileHostedApprovalRuntimeAdmissionStore(this.config.admissionFile)
      .load(hostedControlAuthorityFromConfig(this.bootstrap.config))
    await this.assertPublicationCurrent()
    const expectedDigest = `sha256:${this.config.openCodeSha256}`
    if (admission.digest !== this.admissionSha256 || admission.routes.length === 0 ||
      admission.routes.some(route => route.openCodeBinding.openCodeArtifactDigest !== expectedDigest)) {
      throw new Error('hosted_actual_owner_admission_candidate_digest_mismatch')
    }
    this.admission = admission
    this.acceptanceAuthority = await AcceptanceAuthority.acquire(this.config, admission)
    const runtime = new HostedControlRuntime(this.bootstrap, context => this.ports(context))
    this.runtime = runtime
    await runtime.start()
    if (!this.service || !this.store || !this.admission || !runtime.server?.ownerBinding) {
      throw new Error('hosted_actual_owner_composition_incomplete')
    }
    await this.startReadinessLease(runtime.server.ownerBinding)
    await this.startControl()
    await this.service.pollIngress()
    await this.record('poll_ingress', null, null, null)
    if (this.providerIdentities.size === 0) {
      throw new Error('hosted_actual_owner_provider_identity_missing')
    }
    await this.refreshEvidence('ready')
    await this.assertReadyAuthority()
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      purpose: 'agent-teams.hosted-actual-owner-e2e.orchestrator-readiness/v1',
      status: 'ready',
      evidenceFile: this.config.evidenceFile,
      controlSocket: this.config.controlSocket,
      ownerSocket: this.evidence.owner.ownerSocket,
      ownerBinding: runtime.server.ownerBinding,
      admissionDigest: this.admission.digest,
      openCodeArtifactDigest: `sha256:${this.config.openCodeSha256}`,
      decisionOperations: this.evidence.owner.decisionOperations,
    })}\n`)
  }
  private async waitForProductPublication(): Promise<void> {
    const deadline = Date.now() + this.config.productPublicationTimeoutMs
    while (Date.now() < deadline) {
      await assertMarkerOwnedSandbox(this.config.runtime)
      const state = await readAnchoredFile(this.config.admissionFile, sandboxAnchor(this.config.runtime), {
          minimumBytes: 2, maximumBytes: 16 * 1024 * 1024, mode: 0o600,
        }).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw error
        })
      if (state) {
        const validated = await validateBootstrapAcceptance(this.config, this.bootstrap)
        this.publication = { admission: validated.admission }
        this.admissionSha256 = validated.admissionSha256
        this.configSha256 = validated.configSha256
        await this.assertPublicationCurrent()
        return
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 50))
    }
    throw new Error('hosted_actual_owner_product_publication_timeout')
  }
  private async startReadinessLease(ownerBinding: HostedControlOwnerBinding): Promise<void> {
    if (this.readinessLease) throw new Error('hosted_actual_owner_readiness_lease_already_started')
    await this.assertPublicationCurrent()
    const challenge = randomBytes(32).toString('hex')
    const unsigned = {
      schemaVersion: 2 as const, operation: 'readiness' as const,
      capability: 'hosted-lifecycle-command' as const,
      socketIdentity: ownerBinding.socketIdentity, challenge,
      bootstrapBinding: this.bootstrap.bootstrapBinding,
      expectedOwnerBinding: ownerBinding,
    }
    const serialized = JSON.stringify(unsigned)
    const request = `${serialized.slice(0, -1)},"controllerProof":${JSON.stringify(
      createHostedRawDomainProof(this.bootstrap.secret, HOSTED_LIFECYCLE_PROOF_DOMAIN,
        'readiness-request', serialized))}}\n`
    const socket = connect(this.bootstrap.config.socketPath)
    socket.setTimeout(5_000)
    try {
      const line = await new Promise<string>((resolveLine, rejectLine) => {
        let bytes = 0; const chunks: Buffer[] = []
        const reject = (error: unknown) => rejectLine(error instanceof Error ? error :
          new Error('hosted_actual_owner_readiness_lease_failed'))
        socket.once('error', reject); socket.once('timeout', () => reject(
          new Error('hosted_actual_owner_readiness_lease_timeout')))
        socket.on('data', chunk => {
          bytes += chunk.byteLength
          if (bytes > 4 * 1024) { reject(new Error('hosted_actual_owner_readiness_response_oversized')); return }
          chunks.push(chunk)
          const raw = Buffer.concat(chunks)
          const newline = raw.indexOf(0x0a)
          if (newline < 0) return
          if (newline !== raw.length - 1) { reject(new Error('hosted_actual_owner_readiness_response_invalid')); return }
          resolveLine(raw.subarray(0, -1).toString('utf8'))
        })
        socket.once('connect', () => socket.write(request))
      })
      socket.setTimeout(0); socket.removeAllListeners('data'); socket.removeAllListeners('error')
      const parsed = parseStrictHostedProofLastJsonFrame(line, 'ownerProof')
      const response = parsed.value as Record<string, unknown>
      const expectedProof = createHostedRawDomainProof(this.bootstrap.secret,
        HOSTED_LIFECYCLE_PROOF_DOMAIN, 'readiness', parsed.serializedUnsignedEnvelope)
      if (Object.keys(response).sort().join(',') !==
          'bootstrapDigest,capability,challenge,kind,ownerBinding,ownerProof,schemaVersion' ||
        response.schemaVersion !== 2 || response.kind !== 'ready' ||
        response.capability !== 'hosted-lifecycle-command' || response.challenge !== challenge ||
        response.bootstrapDigest !== this.bootstrap.bootstrapBinding.bootstrapDigest ||
        JSON.stringify(response.ownerBinding) !== JSON.stringify(ownerBinding) ||
        response.ownerProof !== expectedProof) {
        throw new Error('hosted_actual_owner_readiness_response_invalid')
      }
      this.readinessLease = socket
      socket.on('error', () => socket.destroy())
      socket.once('close', () => { if (this.readinessLease === socket) this.readinessLease = null })
      await this.assertPublicationCurrent()
    } catch (error) {
      socket.destroy()
      throw error
    }
  }
  private async assertPublicationCurrent(): Promise<void> {
    if (!this.publication) throw new Error('hosted_actual_owner_product_publication_unadmitted')
    const validated = await validateBootstrapAcceptance(this.config, this.bootstrap)
    await Promise.all([
      assertAnchoredIdentity(this.config.admissionFile, sandboxAnchor(this.config.runtime),
        this.publication.admission, { minimumBytes: 2, maximumBytes: 16 * 1024 * 1024, mode: 0o600 }),
      this.bootstrap.guard.assertCurrent().then(current => {
        if (!current) throw new Error('hosted_actual_owner_bootstrap_authority_lost')
      }),
      this.admission?.isCurrent().then(current => {
        if (!current) throw new Error('hosted_actual_owner_admission_authority_lost')
      }) ?? Promise.resolve(),
    ])
    if (validated.admissionSha256 !== this.admissionSha256 ||
      validated.configSha256 !== this.configSha256 ||
      JSON.stringify(validated.admission) !== JSON.stringify(this.publication.admission)) {
      throw new Error('hosted_actual_owner_product_publication_rotated')
    }
  }
  private async ports(context: HostedControlRuntimePortFactoryContext) {
    await this.assertPublicationCurrent()
    const expectedAdmission = join(context.teamRoot, HOSTED_APPROVAL_ADMISSION_FILE)
    if (expectedAdmission !== this.config.admissionFile || !isWithin(this.config.sandboxRoot, context.teamRoot) ||
      this.config.walFile !== join(context.teamRoot, 'hosted-approval-owner.v1.json')) {
      throw new Error('hosted_actual_owner_product_admission_path_mismatch')
    }
    const admission = this.admission
    const acceptanceAuthority = this.acceptanceAuthority
    if (!admission || !acceptanceAuthority ||
      JSON.stringify(context.authority) !== JSON.stringify(hostedControlAuthorityFromConfig(this.bootstrap.config))) {
      throw new Error('hosted_actual_owner_preflight_authority_missing')
    }
    await this.assertPublicationCurrent()
    if (admission.digest !== this.admissionSha256) {
      throw new Error('hosted_actual_owner_admission_bytes_mismatch')
    }
    const expectedDigest = `sha256:${this.config.openCodeSha256}`
    if (admission.routes.length === 0 || admission.routes.some(route =>
      route.openCodeBinding.openCodeArtifactDigest !== expectedDigest)) {
      throw new Error('hosted_actual_owner_admission_candidate_digest_mismatch')
    }
    const store = new HostedApprovalOwnerStore(new HostedApprovalOwnerWal(this.config.walFile))
    const capture = async (effect: OpenCodePermissionEffectContext) => {
      await this.assertPublicationCurrent()
      const sessionRecordFingerprint = fingerprintOpenCodeApprovalSessionRecord(effect.record)
      const candidates = admission.routes.filter(candidate =>
        candidate.authority.sessionId === effect.record.opencodeSessionId &&
        candidate.openCodeBinding.sessionRecordFingerprint === sessionRecordFingerprint)
      const route = candidates.length === 1 ? candidates[0] : null
      if (!route || effect.host.processStartedAtMs === null || effect.host.pid < 1 ||
        resolveExecutingOpenCodeArtifactDigest(effect.host.pid) !== expectedDigest) {
        throw new Error('hosted_actual_owner_provider_identity_invalid')
      }
      const computedLiveEffectFingerprint = liveEffectFingerprint(effect)
      const provider = await proveExecutingProviderIdentity({
        pid: effect.host.pid, executable: this.config.openCodeExecutable,
        device: this.config.runtime.descriptors.openCodeExecutable.device,
        inode: this.config.runtime.descriptors.openCodeExecutable.inode,
        sha256: this.config.openCodeSha256,
      })
      if (computedLiveEffectFingerprint !== route.openCodeBinding.liveEffectFingerprint ||
        effect.record.opencodeSessionId !== route.authority.sessionId) {
        throw new Error('hosted_actual_owner_provider_identity_invalid')
      }
      this.providerIdentities.set(route.routeId, Object.freeze({
        routeId: route.routeId,
        sessionId: route.authority.sessionId,
        routeRunId: route.authority.runId,
        generation: route.scope.authorityGeneration,
        sessionRecordFingerprint: route.openCodeBinding.sessionRecordFingerprint,
        liveEffectFingerprint: computedLiveEffectFingerprint,
        executable: provider.executable,
        executableDevice: provider.device,
        executableInode: provider.inode,
        executableSha256: this.config.openCodeSha256,
        pid: effect.host.pid,
        processStartIdentity: provider.processStartIdentity,
        processStartedAtMs: effect.host.processStartedAtMs,
      }))
      await this.assertPublicationCurrent()
      await acceptanceAuthority.assertCurrent()
      return acceptanceAuthority.routes.get(route.routeId)!
    }
    const bridge = {
      observeHostedApprovalPermissions: async (
        record: Parameters<typeof openCodeSessionBridge.observeHostedApprovalPermissions>[0],
        authorize?: Parameters<typeof openCodeSessionBridge.observeHostedApprovalPermissions>[1],
      ) => openCodeSessionBridge.observeHostedApprovalPermissions(record, async effect => {
        const route = await capture(effect)
        const result = authorize ? await authorize(effect) : true
        await this.assertPublicationCurrent()
        await acceptanceAuthority.assertCurrent()
        return result
      }),
      answerPermission: async (
        record: Parameters<typeof openCodeSessionBridge.answerPermission>[0],
        parameters: Parameters<typeof openCodeSessionBridge.answerPermission>[1],
      ) => openCodeSessionBridge.answerPermission(record, {
        ...parameters,
        authorizeObservation: async effect => {
          await capture(effect)
          const result = parameters.authorizeObservation
            ? await parameters.authorizeObservation(effect) : true
          await this.assertPublicationCurrent()
          return result
        },
        validatePreparedEffect: async effect => {
          await capture(effect)
          const result = parameters.validatePreparedEffect
            ? await parameters.validatePreparedEffect(effect) : true
          await this.assertPublicationCurrent()
          return result
        },
        authorizeEffect: async effect => {
          const route = await capture(effect)
          const result = parameters.authorizeEffect ? await parameters.authorizeEffect(effect) : true
          await this.assertPublicationCurrent()
          if (!result) return false
          return acceptanceAuthority.prepareEffectToken(route)
        },
      }),
    }
    const adapter = new OpenCodeHostedApprovalRuntimeAdapter(openCodeSessionStore, bridge, undefined, {
      prepareEffectToken: expected => prepareOpenCodeArtifactDigestToken(
        expected, this.config.openCodeExecutable,
      ),
    })
    const service = new HostedApprovalOwnerService({
      store, admission, runtime: adapter,
      isCurrentOuterAuthority: () => context.isCurrentAuthority({
        actorId: 'hosted-approval-owner', ...context.authority,
      }),
    })
    await service.recoverStateOnly()
    this.store = store; this.service = service
    const approvals = new EvidenceApprovalPort(service,
      (event, approvalId, requestId, effectId) => this.record(event, approvalId, requestId, effectId))
    return {
      approvals,
      lifecycle: { dispatch: async () => { throw new Error('hosted_actual_owner_non_approval_operation_forbidden') } },
      messages: { dispatch: async () => { throw new Error('hosted_actual_owner_non_approval_operation_forbidden') } },
      close: async () => undefined,
    }
  }
  private async ownerSocket(): Promise<string> {
    await this.assertPublicationCurrent()
    return this.bootstrap.config.socketPath
  }
  private async record(
    event: ActualOwnerProductTimelineEvent['event'], approvalId: string | null,
    requestId: string | null, effectId: string | null,
    reconciliation?: { reconciliationRef: string; providerDeliveryId: string; runId: string },
  ): Promise<void> {
    await this.assertPublicationCurrent()
    if (!this.admission) throw new Error('hosted_actual_owner_timeline_admission_missing')
    const state = await this.store?.read()
    const ingressRecords = [...state?.ingress ?? [], ...state?.retiredIngress ?? []]
    let ingress = requestId ? ingressRecords
      .find(record => record.commandId === requestId) : null
    if (!ingress && reconciliation) {
      const delivery = state?.deliveries.find(candidate =>
        candidate.reconciliationRef === reconciliation.reconciliationRef &&
        candidate.providerDeliveryId === reconciliation.providerDeliveryId)
      ingress = delivery ? ingressRecords.find(candidate =>
        candidate.outboxId === delivery.outboxId && candidate.effectRef === delivery.effectRef &&
        candidate.authority.runId === reconciliation.runId) ?? null : null
      if (ingress) {
        approvalId = approvalId ?? approvalIdForRecord(ingress)
        requestId = ingress.commandId; effectId = delivery!.effectRef
      }
    }
    const routes = ingress ? this.admission.routes.filter(route =>
      route.authority.runId === ingress.authority.runId &&
      route.authority.sessionId === ingress.authority.sessionId) : this.admission.routes
    if (routes.length === 0) throw new Error('hosted_actual_owner_timeline_route_missing')
    const prior = await this.readTimeline(false)
    this.sequence = prior?.lastSequence ?? -1
    for (const route of [...routes].sort((left, right) => left.routeId.localeCompare(right.routeId))) {
      const timeline = validateProductTimelineEvent({
        schemaVersion: 1, at: new Date().toISOString(), routeId: route.routeId,
        sessionId: route.authority.sessionId, runId: route.authority.runId,
        generation: route.scope.authorityGeneration, approvalId, requestId,
        effectId: effectId ?? ingress?.effectRef ?? null, event, sequence: ++this.sequence,
      })
      await appendPrivateLine(this.config.runtime.ownerWalTimelineRawPath,
        sandboxAnchor(this.config.runtime), productTimelineLine(timeline))
    }
    this.timeline = await this.readTimeline(true)
    await this.assertPublicationCurrent()
    await this.refreshEvidence('ready')
  }
  private async readTimeline(required: boolean): Promise<typeof this.timeline> {
    const file = await readAnchoredFile(this.config.runtime.ownerWalTimelineRawPath,
      sandboxAnchor(this.config.runtime), {
        minimumBytes: 2, maximumBytes: 32 * 1024 * 1024, mode: 0o600,
      }).catch(error => {
        if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
    if (!file) return null
    const source = file.bytes.toString('utf8')
    if (!source.endsWith('\n')) throw new Error('hosted_actual_owner_timeline_bytes_invalid')
    const events = source.slice(0, -1).split('\n').map(line => {
      const event = validateProductTimelineEvent(JSON.parse(line))
      if (!productTimelineLine(event).subarray(0, -1).equals(Buffer.from(line))) {
        throw new Error('hosted_actual_owner_timeline_bytes_noncanonical')
      }
      return event
    })
    for (let index = 1; index < events.length; index++) {
      if (events[index]!.sequence !== events[index - 1]!.sequence + 1) {
        throw new Error('hosted_actual_owner_timeline_sequence_invalid')
      }
    }
    const lastSequence = events.at(-1)!.sequence
    return Object.freeze({
      identity: file.identity, sha256: createHash('sha256').update(file.bytes).digest('hex'),
      bytes: file.bytes.byteLength, eventCount: events.length, lastSequence,
    })
  }
  private async assertProvidersCurrent(): Promise<void> {
    if (!this.admission || this.providerIdentities.size !== this.admission.routes.length) {
      throw new Error('hosted_actual_owner_provider_identity_missing')
    }
    for (const route of this.admission.routes) {
      const provider = this.providerIdentities.get(route.routeId)
      if (!provider || provider.sessionId !== route.authority.sessionId ||
        provider.routeRunId !== route.authority.runId ||
        provider.generation !== route.scope.authorityGeneration ||
        provider.sessionRecordFingerprint !== route.openCodeBinding.sessionRecordFingerprint ||
        provider.liveEffectFingerprint !== route.openCodeBinding.liveEffectFingerprint) {
        throw new Error('hosted_actual_owner_provider_identity_invalid')
      }
      const current = await proveExecutingProviderIdentity({
        pid: provider.pid, executable: this.config.openCodeExecutable,
        device: provider.executableDevice, inode: provider.executableInode,
        sha256: provider.executableSha256,
      })
      if (current.processStartIdentity !== provider.processStartIdentity) {
        throw new Error('hosted_actual_owner_provider_identity_invalid')
      }
    }
  }
  private async assertReadyAuthority(): Promise<void> {
    if (!this.readinessLease || this.readinessLease.destroyed) {
      throw new Error('hosted_actual_owner_readiness_lease_lost')
    }
    await this.assertPublicationCurrent()
    await assertAcceptanceConfigCurrent(this.config)
    await this.assertProvidersCurrent()
    const timeline = await this.readTimeline(true)
    if (this.timeline && JSON.stringify(timeline) !== JSON.stringify(this.timeline)) {
      throw new Error('hosted_actual_owner_timeline_identity_drift')
    }
    this.timeline = timeline
  }
  private async refreshEvidence(status: 'ready' | 'stopping'): Promise<void> {
    if (status === 'ready') await this.assertReadyAuthority()
    else await this.assertPublicationCurrent()
    const state = await this.store?.read() ?? null
    if (!state || !this.admission || state.admissionGeneration !== this.admission.admissionGeneration ||
      state.admissionDigest !== this.admission.digest ||
      JSON.stringify(state.routes) !== JSON.stringify(this.admission.routes) ||
      JSON.stringify(state.actorMembers) !== JSON.stringify(this.admission.actorMembers) ||
      state.revision < 0) throw new Error('hosted_actual_owner_wal_state_invalid')
    const wal = await readAnchoredFile(this.config.walFile, sandboxAnchor(this.config.runtime), {
      minimumBytes: 2, maximumBytes: 32 * 1024 * 1024, mode: 0o600,
    }).catch(() => null)
    const socketIdentity = async (path: string): Promise<SecureFileIdentity | null> => {
      const parent = await openTrustedDirectory(dirname(path), sandboxAnchor(this.config.runtime))
      try {
        const anchored = `${parent.anchoredPath}/${path.split('/').at(-1)}`
        const [stat, linked] = await Promise.all([
          lstat(anchored, { bigint: true }).catch(() => null), lstat(path, { bigint: true }).catch(() => null),
        ])
        if (!stat && !linked) return null
        if (!stat || !linked || !stat.isSocket() || !linked.isSocket() || linked.isSymbolicLink() ||
          stat.dev !== linked.dev || stat.ino !== linked.ino || (stat.mode & 0o077n) !== 0n ||
          (process.getuid?.() !== undefined && stat.uid !== BigInt(process.getuid()))) {
          throw new Error('hosted_actual_owner_socket_identity_unproved')
        }
        return {
          device: stat.dev.toString(), inode: stat.ino.toString(), size: stat.size.toString(),
          mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString(),
          mode: (stat.mode & 0o777n).toString(), nlink: stat.nlink.toString(), uid: stat.uid.toString(),
        }
      } finally {
        if (parent.handle !== parent.rootHandle) await parent.handle.close()
        await parent.rootHandle.close()
      }
    }
    const ownerSocket = await this.ownerSocket()
    const ownerBinding = this.runtime?.server?.ownerBinding
    if (!ownerBinding) throw new Error('hosted_actual_owner_binding_missing')
    await assertSocketBinding(ownerSocket, sandboxAnchor(this.config.runtime), ownerBinding.socketIdentity)
    const controlSocketIdentity = await socketIdentity(this.config.controlSocket)
    const ownerSocketIdentity = await socketIdentity(ownerSocket)
    const stateSha256 = createHash('sha256').update(JSON.stringify(state)).digest('hex')
    this.evidence = buildAcceptanceEvidence({
      config: this.config, status, admission: this.admission,
      bootstrap: this.bootstrap, configSha256: this.configSha256,
      ownerProcessStartIdentity: this.ownerProcessStartIdentity,
      ownerSocket, state, publication: this.publication,
      controlSocketIdentity, ownerSocketIdentity,
      walIdentity: wal?.identity ?? null,
      walSha256: wal ? createHash('sha256').update(wal.bytes).digest('hex') : null,
      stateSha256,
      timeline: this.timeline,
      providers: Object.freeze([...this.providerIdentities.values()].sort((a, b) =>
        a.routeId.localeCompare(b.routeId))),
    })
    if (!wal) throw new Error('hosted_actual_owner_wal_identity_missing')
    const [currentState, currentControl, currentOwner] = await Promise.all([
      this.store!.read(), socketIdentity(this.config.controlSocket), socketIdentity(ownerSocket),
      assertAnchoredIdentity(this.config.walFile, sandboxAnchor(this.config.runtime), wal.identity,
        { minimumBytes: 2, maximumBytes: 32 * 1024 * 1024, mode: 0o600 }),
    ])
    if (createHash('sha256').update(JSON.stringify(currentState)).digest('hex') !== stateSha256 ||
      JSON.stringify(currentControl) !== JSON.stringify(controlSocketIdentity) ||
      JSON.stringify(currentOwner) !== JSON.stringify(ownerSocketIdentity)) {
      throw new Error('hosted_actual_owner_readiness_identity_drift')
    }
    if (status === 'ready') await this.assertReadyAuthority()
    else await this.assertPublicationCurrent()
    await this.writeEvidence()
  }
  private async writeEvidence(): Promise<void> {
    await this.assertPublicationCurrent()
    await atomicPrivateJson(this.config.evidenceFile, sandboxAnchor(this.config.runtime),
      validateAcceptanceEvidence(this.evidence))
  }
  async writeFailure(failure: string): Promise<void> {
    if (!this.publication || !this.admission) return
    await this.assertPublicationCurrent()
    this.evidence = buildAcceptanceEvidence({
      config: this.config, status: 'failed', failure, admission: this.admission,
      publication: this.publication, bootstrap: this.bootstrap, configSha256: this.configSha256,
      ownerProcessStartIdentity: this.ownerProcessStartIdentity, timeline: this.timeline,
    })
    await this.writeEvidence()
  }
  private async startControl(): Promise<void> {
    await this.assertPublicationCurrent()
    const parent = dirname(this.config.controlSocket)
    const anchoredParent = await openTrustedDirectory(parent, sandboxAnchor(this.config.runtime))
    const parentHandle = anchoredParent.handle
    const openedParent = anchoredParent.stat
    const anchoredSocket = `/proc/self/fd/${parentHandle.fd}/${this.config.controlSocket.split('/').at(-1)}`
    const existing = await lstat(this.config.controlSocket).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (existing) {
      if (parentHandle !== anchoredParent.rootHandle) await parentHandle.close()
      await anchoredParent.rootHandle.close()
      throw new Error('hosted_actual_owner_control_socket_already_exists')
    }
    const server = createServer(socket => this.handleControl(socket))
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen); server.listen(anchoredSocket, resolveListen)
      })
      await chmod(anchoredSocket, 0o600)
      const [socketStat, linkedSocket, parentStat] = await Promise.all([
        lstat(anchoredSocket), lstat(this.config.controlSocket), lstat(parent),
      ])
      if (!socketStat.isSocket() || (socketStat.mode & 0o777) !== 0o600 ||
        !linkedSocket.isSocket() || linkedSocket.isSymbolicLink() ||
        linkedSocket.dev !== socketStat.dev || linkedSocket.ino !== socketStat.ino ||
        !parentStat.isDirectory() || parentStat.isSymbolicLink()) {
        throw new Error('hosted_actual_owner_control_socket_unsafe')
      }
      if (parentStat.dev.toString() !== openedParent.dev.toString() ||
        parentStat.ino.toString() !== openedParent.ino.toString()) {
        throw new Error('hosted_actual_owner_control_parent_identity_drift')
      }
      this.controlIdentity = { device: socketStat.dev, inode: socketStat.ino }
      this.controlParentIdentity = { device: parentStat.dev, inode: parentStat.ino }
      this.controlParentHandle = parentHandle
      this.controlRootHandle = anchoredParent.rootHandle
      this.control = server
    } catch (error) {
      if (server.listening) await new Promise<void>(resolveClose => server.close(() => resolveClose()))
      if (parentHandle !== anchoredParent.rootHandle) await parentHandle.close()
      await anchoredParent.rootHandle.close()
      throw error
    }
  }

  private handleControl(socket: Socket): void {
    let bytes = 0; const chunks: Buffer[] = []
    socket.setTimeout(5_000, () => socket.destroy())
    socket.on('data', chunk => {
      bytes += chunk.byteLength
      if (bytes > MAX_CONTROL_BYTES) { socket.destroy(); return }
      chunks.push(chunk)
      const raw = Buffer.concat(chunks)
      const newline = raw.indexOf(0x0a)
      if (newline < 0) return
      if (newline !== raw.length - 1) { socket.destroy(); return }
      socket.pause()
      void this.controlRequest(raw.subarray(0, -1).toString('utf8')).then(
        response => socket.end(`${JSON.stringify(response)}\n`),
        () => socket.destroy(),
      )
    })
  }

  private async controlRequest(raw: string): Promise<unknown> {
    await this.assertPublicationCurrent()
    const request = JSON.parse(raw) as Record<string, unknown>
    if (request.schemaVersion !== 1 || Object.keys(request).some(key => !['schemaVersion', 'operation'].includes(key))) {
      throw new Error('hosted_actual_owner_control_invalid')
    }
    if (request.operation === 'readiness' || request.operation === 'evidence') {
      await this.refreshEvidence('ready'); return this.evidence
    }
    if (request.operation === 'poll_ingress') {
      const admitted = await this.service?.pollIngress()
      await this.record('poll_ingress', null, null, null)
      return { schemaVersion: 1, operation: 'poll_ingress', admitted: admitted ?? 0 }
    }
    if (request.operation === 'shutdown') {
      setTimeout(() => void this.stop().then(() => process.exit(0), error => {
        process.stderr.write(`${error instanceof Error ? error.message : 'hosted_actual_owner_cleanup_failed'}\n`)
        process.exit(1)
      }), 0)
      return { schemaVersion: 1, operation: 'shutdown', accepted: true }
    }
    throw new Error('hosted_actual_owner_control_operation_invalid')
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    if (this.evidence.status === 'ready') await this.refreshEvidence('stopping').catch(() => undefined)
    const control = this.control; this.control = null
    const parentHandle = this.controlParentHandle; this.controlParentHandle = null
    const rootHandle = this.controlRootHandle; this.controlRootHandle = null
    const anchoredSocket = parentHandle ? `/proc/self/fd/${parentHandle.fd}/${this.config.controlSocket.split('/').at(-1)}` : null
    const identity = this.controlIdentity; const parentIdentity = this.controlParentIdentity
    this.controlIdentity = null; this.controlParentIdentity = null
    const tombstoneName = `.hosted-actual-owner-control.closed-${process.pid}-${this.config.runtime.runId}`
    const anchoredTombstone = parentHandle ? `/proc/self/fd/${parentHandle.fd}/${tombstoneName}` : null
    const anchoredBefore = anchoredSocket ? await lstat(anchoredSocket).catch(() => null) : null
    const provedBefore = identity && parentIdentity && await assertControlCleanupAuthority(
      this.config.controlSocket, identity, parentIdentity,
    ).then(() => true, () => false) && anchoredBefore?.isSocket() &&
      anchoredBefore.dev === identity.device && anchoredBefore.ino === identity.inode
    let cleanupFailure: Error | null = null
    try {
      if (identity && !provedBefore) {
        cleanupFailure = new Error('hosted_actual_owner_control_cleanup_unproved')
      } else if (control) {
        if (!anchoredSocket || !anchoredTombstone || !parentHandle ||
          await lstat(anchoredTombstone).then(() => true, error =>
            (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : Promise.reject(error))) {
          throw new Error('hosted_actual_owner_control_tombstone_unsafe')
        }
        await rename(anchoredSocket, anchoredTombstone)
        await parentHandle.sync()
        const moved = await lstat(anchoredTombstone)
        if (!moved.isSocket() || !identity || moved.dev !== identity.device || moved.ino !== identity.inode ||
          await lstat(this.config.controlSocket).then(() => true, () => false)) {
          throw new Error('hosted_actual_owner_control_tombstone_unproved')
        }
        // libuv remembers the descriptor path used for bind. Closing that parent
        // descriptor before server.close makes its unlink target unreachable;
        // a same-name substitute at the public pathname cannot be removed.
        await parentHandle.close()
        await this.testHooks.afterControlTombstone?.()
        await new Promise<void>(resolveClose => control.close(() => resolveClose()))
        const reopened = await openTrustedDirectory(dirname(this.config.controlSocket),
          sandboxAnchor(this.config.runtime))
        try {
          const remaining = await lstat(`${reopened.anchoredPath}/${tombstoneName}`)
          if (!remaining.isSocket() || remaining.dev !== identity.device || remaining.ino !== identity.inode) {
            throw new Error('hosted_actual_owner_control_cleanup_unproved')
          }
          await unlink(`${reopened.anchoredPath}/${tombstoneName}`)
          await reopened.handle.sync()
        } finally {
          if (reopened.handle !== reopened.rootHandle) await reopened.handle.close()
          await reopened.rootHandle.close()
        }
      }
    } finally {
      if (parentHandle && parentHandle !== rootHandle) await parentHandle.close().catch(() => undefined)
      await rootHandle?.close().catch(() => undefined)
      if (this.runtime) {
        this.readinessLease?.destroy(); this.readinessLease = null
        await this.runtime.stop()
        this.bootstrapReleased = true
      } else if (!this.bootstrapReleased) {
        this.bootstrap.secret.fill(0)
        await this.bootstrap.guard.close()
        this.bootstrapReleased = true
      }
      await this.acceptanceAuthority?.close()
      this.acceptanceAuthority = null
    }
    if (cleanupFailure) throw cleanupFailure
  }
}

export async function runActualOwnerAcceptance(args: readonly string[]): Promise<void> {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  const invocation = parseAcceptanceInvocation(args)
  const config = await loadAcceptanceConfig({ args: invocation.configArgs, repositoryRoot })
  const bootstrap = await readHostedControlBootstrap(invocation.bootstrapFds)
  const acceptance = new AcceptanceRuntime(config, bootstrap)
  const stop = () => void acceptance.stop().then(() => process.exit(0), error => {
    process.stderr.write(`${error instanceof Error ? error.message : 'hosted_actual_owner_cleanup_failed'}\n`)
    process.exit(1)
  })
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  try {
    await acceptance.start()
  } catch (error) {
    const failure = error instanceof Error ? error.message : 'hosted_actual_owner_start_failed'
    await acceptance.writeFailure(failure).catch(() => undefined)
    await acceptance.stop().catch(() => undefined)
    throw error
  }
  await new Promise<void>(() => undefined)
}

export function parseAcceptanceInvocation(args: readonly string[]): {
  configArgs: readonly string[]
  bootstrapFds: { launcherLeaseFd: number; livenessFd: number; bootstrapFd: number }
} {
  const expected = ['--runtime-manifest', '--actual-owner-contract', '--actual-owner-contract-sha256',
    '--actual-owner-contract-byte-count', '--launcher-lease-fd', '--liveness-fd', '--bootstrap-fd']
  if (args.length !== 14 || expected.some((flag, index) => args[index * 2] !== flag)) {
    throw new Error('hosted_actual_owner_invocation_invalid')
  }
  const values = [args[9], args[11], args[13]].map(value => Number(value))
  if (values.some((value, index) => value !== index + 6) || new Set(values).size !== 3) {
    throw new Error('hosted_actual_owner_bootstrap_fd_map_invalid')
  }
  return {
    configArgs: args.slice(0, 8),
    bootstrapFds: { launcherLeaseFd: values[0]!, livenessFd: values[1]!, bootstrapFd: values[2]! },
  }
}

export function isDirectAcceptanceEntry(argv: readonly string[], entryUrl = import.meta.url): boolean {
  return resolve(argv[1] ?? '') === fileURLToPath(entryUrl)
}

if (isDirectAcceptanceEntry(process.argv)) {
  await runActualOwnerAcceptance(process.argv.slice(2))
}
