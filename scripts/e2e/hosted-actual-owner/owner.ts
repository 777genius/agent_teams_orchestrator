import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HostedApprovalOwnerService } from '../../../src/services/hostedControl/HostedApprovalOwnerService.js'
import { HostedApprovalOwnerStore } from '../../../src/services/hostedControl/HostedApprovalOwnerStore.js'
import { HostedApprovalOwnerWal, type HostedApprovalOwnerState } from '../../../src/services/hostedControl/HostedApprovalOwnerWal.js'
import { PrivateFileHostedApprovalRuntimeAdmissionStore, type HostedApprovalRuntimeAdmission } from '../../../src/services/hostedControl/HostedApprovalRuntimeAdmission.js'
import type { HostedApprovalWirePort } from '../../../src/services/hostedControl/HostedApprovalWire.js'
import type { HostedControlRuntimePortFactoryContext } from '../../../src/services/hostedControl/HostedControlRuntime.js'
import { HostedControlRuntime } from '../../../src/services/hostedControl/HostedControlRuntime.js'
import { OpenCodeHostedApprovalRuntimeAdapter } from '../../../src/services/hostedControl/OpenCodeHostedApprovalRuntimeAdapter.js'
import { prepareOpenCodeArtifactDigestToken } from '../../../src/services/opencode/OpenCodeArtifactDigest.js'
import {
  assertMarkerOwnedSandbox, loadAcceptanceConfig, HOSTED_APPROVAL_ADMISSION_FILE,
  isWithin, type ActualOwnerAcceptanceConfig,
} from './contracts.js'
import { buildAcceptanceEvidence, type ActualOwnerAcceptanceEvidence } from './evidence.js'

const MAX_CONTROL_BYTES = 16 * 1024

async function atomicPrivateJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync() } finally { await handle.close() }
  await rename(temporary, path)
}

class EvidenceApprovalPort implements HostedApprovalWirePort {
  constructor(
    readonly service: HostedApprovalOwnerService,
    private readonly changed: (event: string, approvalId: string | null) => Promise<void>,
  ) {}
  async claimIngress(input: Parameters<HostedApprovalWirePort['claimIngress']>[0]) {
    const result = await this.service.claimIngress(input)
    for (const record of result) {
      const approvalId = `approval_${createHash('sha256').update(JSON.stringify({
        schemaVersion: 1,
        teamId: record.authority.teamId,
        runId: record.authority.runId,
        requestId: record.commandId,
      })).digest('hex').slice(0, 32)}`
      await this.changed('ingress_durable', approvalId)
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
      : result.status
    await this.changed(event, input.request.approvalId)
    return result
  }
  async reconcileDecision(request: Parameters<HostedApprovalWirePort['reconcileDecision']>[0]) {
    const result = await this.service.reconcileDecision(request)
    await this.changed(`reconcile_${result.status}`, null)
    return result
  }
}

class AcceptanceRuntime {
  private runtime: HostedControlRuntime | null = null
  private service: HostedApprovalOwnerService | null = null
  private store: HostedApprovalOwnerStore | null = null
  private admission: HostedApprovalRuntimeAdmission | null = null
  private control: Server | null = null
  private controlIdentity: { device: number; inode: number } | null = null
  private controlParentIdentity: { device: number; inode: number } | null = null
  private stopping = false
  private evidence: ActualOwnerAcceptanceEvidence
  private sequence = 0

  constructor(readonly config: ActualOwnerAcceptanceConfig) {
    this.evidence = buildAcceptanceEvidence({ config, status: 'starting' })
  }

  async start(): Promise<void> {
    await this.writeEvidence()
    await this.waitForProductPublication()
    const runtime = new HostedControlRuntime(this.config.hostedControlConfig, context => this.ports(context))
    this.runtime = runtime
    await runtime.start()
    if (!this.service || !this.store || !this.admission || !runtime.server?.ownerBinding) {
      throw new Error('hosted_actual_owner_composition_incomplete')
    }
    await this.startControl()
    this.evidence = buildAcceptanceEvidence({
      config: this.config, status: 'ready', admission: this.admission,
      ownerSocket: await this.ownerSocket(), state: await this.store.read(),
    })
    await this.writeEvidence()
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
      const states = await Promise.all([this.config.hostedControlConfig, this.config.admissionFile].map(
        path => lstat(path).then(stat => {
          if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new Error('hosted_actual_owner_product_publication_unsafe')
          }
          return true
        }).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
          throw error
        }),
      ))
      if (states.every(Boolean)) return
      await new Promise(resolveWait => setTimeout(resolveWait, 50))
    }
    throw new Error('hosted_actual_owner_product_publication_timeout')
  }

  private async ports(context: HostedControlRuntimePortFactoryContext) {
    const expectedAdmission = join(context.teamRoot, HOSTED_APPROVAL_ADMISSION_FILE)
    if (expectedAdmission !== this.config.admissionFile || !isWithin(this.config.sandboxRoot, context.teamRoot) ||
      this.config.walFile !== join(context.teamRoot, 'hosted-approval-owner.v1.json')) {
      throw new Error('hosted_actual_owner_product_admission_path_mismatch')
    }
    const admission = await new PrivateFileHostedApprovalRuntimeAdmissionStore(this.config.admissionFile)
      .load(context.authority)
    const expectedDigest = `sha256:${this.config.openCodeSha256}`
    if (admission.routes.length === 0 || admission.routes.some(route =>
      route.openCodeBinding.openCodeArtifactDigest !== expectedDigest)) {
      throw new Error('hosted_actual_owner_admission_candidate_digest_mismatch')
    }
    const store = new HostedApprovalOwnerStore(new HostedApprovalOwnerWal(this.config.walFile))
    const adapter = new OpenCodeHostedApprovalRuntimeAdapter(undefined, undefined, undefined, {
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
    this.store = store; this.service = service; this.admission = admission
    const approvals = new EvidenceApprovalPort(service, (event, approvalId) => this.record(event, approvalId))
    return {
      approvals,
      lifecycle: { dispatch: async () => { throw new Error('hosted_actual_owner_non_approval_operation_forbidden') } },
      messages: { dispatch: async () => { throw new Error('hosted_actual_owner_non_approval_operation_forbidden') } },
      close: async () => undefined,
    }
  }

  private async ownerSocket(): Promise<string> {
    const parsed = JSON.parse(await readFile(this.config.hostedControlConfig, 'utf8')) as { socketPath?: unknown }
    if (typeof parsed.socketPath !== 'string') throw new Error('hosted_actual_owner_owner_socket_missing')
    return parsed.socketPath
  }

  private async record(event: string, approvalId: string | null): Promise<void> {
    const handle = await open(this.config.runtime.capture.ownerWalTimelinePath, 'a', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify({
        schemaVersion: 1, runId: this.config.runtime.runId, sequence: ++this.sequence,
        at: new Date().toISOString(), event, approvalId,
        generation: this.admission?.admissionGeneration ?? null,
      })}\n`)
      await handle.sync()
    } finally { await handle.close() }
    await this.refreshEvidence('ready')
  }

  private async refreshEvidence(status: 'ready' | 'stopping'): Promise<void> {
    this.evidence = buildAcceptanceEvidence({
      config: this.config, status, admission: this.admission,
      ownerSocket: this.evidence.owner.ownerSocket ?? await this.ownerSocket(),
      state: await this.store?.read() ?? null,
    })
    await this.writeEvidence()
  }

  private writeEvidence(): Promise<void> { return atomicPrivateJson(this.config.evidenceFile, this.evidence) }

  private async startControl(): Promise<void> {
    const parent = dirname(this.config.controlSocket)
    if (await realpath(parent) !== parent) throw new Error('hosted_actual_owner_control_parent_not_canonical')
    const existing = await lstat(this.config.controlSocket).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (existing) throw new Error('hosted_actual_owner_control_socket_already_exists')
    const server = createServer(socket => this.handleControl(socket))
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen); server.listen(this.config.controlSocket, resolveListen)
    })
    await chmod(this.config.controlSocket, 0o600)
    const [socketStat, parentStat] = await Promise.all([
      lstat(this.config.controlSocket), lstat(parent),
    ])
    if (!socketStat.isSocket() || (socketStat.mode & 0o777) !== 0o600 ||
      !parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      await new Promise<void>(resolveClose => server.close(() => resolveClose()))
      throw new Error('hosted_actual_owner_control_socket_unsafe')
    }
    this.controlIdentity = { device: socketStat.dev, inode: socketStat.ino }
    this.controlParentIdentity = { device: parentStat.dev, inode: parentStat.ino }
    this.control = server
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
    const request = JSON.parse(raw) as Record<string, unknown>
    if (request.schemaVersion !== 1 || Object.keys(request).some(key => !['schemaVersion', 'operation'].includes(key))) {
      throw new Error('hosted_actual_owner_control_invalid')
    }
    if (request.operation === 'readiness' || request.operation === 'evidence') {
      await this.refreshEvidence('ready'); return this.evidence
    }
    if (request.operation === 'poll_ingress') {
      const admitted = await this.service?.pollIngress()
      await this.record('poll_ingress', null)
      return { schemaVersion: 1, operation: 'poll_ingress', admitted: admitted ?? 0 }
    }
    if (request.operation === 'shutdown') {
      setTimeout(() => void this.stop(), 0)
      return { schemaVersion: 1, operation: 'shutdown', accepted: true }
    }
    throw new Error('hosted_actual_owner_control_operation_invalid')
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    await this.refreshEvidence('stopping').catch(() => undefined)
    const control = this.control; this.control = null
    if (control) await new Promise<void>(resolveClose => control.close(() => resolveClose()))
    const [socketStat, parentStat] = await Promise.all([
      lstat(this.config.controlSocket).catch(() => null),
      lstat(dirname(this.config.controlSocket)).catch(() => null),
    ])
    const identity = this.controlIdentity; const parentIdentity = this.controlParentIdentity
    this.controlIdentity = null; this.controlParentIdentity = null
    if (identity && parentIdentity && socketStat?.isSocket() && parentStat?.isDirectory() &&
      !parentStat.isSymbolicLink() && (socketStat.mode & 0o077) === 0 &&
      socketStat.dev === identity.device && socketStat.ino === identity.inode &&
      parentStat.dev === parentIdentity.device && parentStat.ino === parentIdentity.inode) {
      await unlink(this.config.controlSocket)
    }
    await this.runtime?.stop()
  }
}

export async function runActualOwnerAcceptance(args: readonly string[]): Promise<void> {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  const config = await loadAcceptanceConfig({ args, repositoryRoot })
  const acceptance = new AcceptanceRuntime(config)
  const stop = () => void acceptance.stop().finally(() => process.exit(0))
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  try { await acceptance.start() } catch (error) {
    const failure = error instanceof Error ? error.message : 'hosted_actual_owner_start_failed'
    await atomicPrivateJson(config.evidenceFile, buildAcceptanceEvidence({ config, status: 'failed', failure })).catch(() => undefined)
    await acceptance.stop().catch(() => undefined)
    throw error
  }
  await new Promise<void>(() => undefined)
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await runActualOwnerAcceptance(process.argv.slice(2))
}
