import { createHash, randomBytes } from 'node:crypto'
import {
  decodeOpenCodeLaunchAttemptResponse,
  encodeOpenCodeLaunchAttemptRequest,
  isOpenCodeOpaqueIdentity,
  validateOpenCodeLaunchAttemptCorrelation,
  type OpenCodeLaunchAttemptRequest,
  type OpenCodeLaunchMemberLinkage,
  type OpenCodeOpaqueIdentity,
  type OpenCodeRetainedHostIdentity,
} from './OpenCodeBridgeContractV2.js'
import {
  OpenCodeLaunchAttemptPolicy,
  classifyOpenCodeLaunchFailure,
  type OpenCodeLaunchFailureKind,
  type OpenCodeLaunchPhase,
} from './OpenCodeLaunchAttemptPolicy.js'
import {
  OpenCodeLaunchAttemptStore,
  OpenCodeLaunchPoisonedLeaseError,
  type OpenCodeLaunchJournalEvent,
  type OpenCodeLaunchJournalReconciliationEvent,
  type OpenCodeLaunchStoreContext,
} from './OpenCodeLaunchAttemptStore.js'

export type OpenCodeLaunchProfile = {
  purpose: 'launch_attempt'
  providerId: string
  projectIdentity: OpenCodeOpaqueIdentity
  profileIdentity: OpenCodeOpaqueIdentity
  pluginPolicyIdentity: OpenCodeOpaqueIdentity
  cacheIdentity: OpenCodeOpaqueIdentity
  /** Opaque snapshots; each changes whenever its launch input changes. */
  authIdentity: OpenCodeOpaqueIdentity
  configIdentity: OpenCodeOpaqueIdentity
  binaryIdentity: OpenCodeOpaqueIdentity
}

export type OpenCodeLaunchProofObservation = {
  host: OpenCodeRetainedHostIdentity
  /** Re-read from the retained proof message, never copied from the request. */
  nonceHash: string
  providerId: string
  modelId: string
  mcpConnected: boolean
  observedTools: string[]
  profileIdentity: OpenCodeOpaqueIdentity
  pluginPolicyIdentity: OpenCodeOpaqueIdentity
  cacheIdentity: OpenCodeOpaqueIdentity
  authIdentity: OpenCodeOpaqueIdentity
  configIdentity: OpenCodeOpaqueIdentity
  binaryIdentity: OpenCodeOpaqueIdentity
}

export type OpenCodeLaunchOwnedResources = {
  memberIdentity: OpenCodeOpaqueIdentity
  sessionIdentity?: OpenCodeOpaqueIdentity
  lockOwnershipIdentity?: OpenCodeOpaqueIdentity
  httpOwnershipIdentity?: OpenCodeOpaqueIdentity
  childOwnershipIdentity?: OpenCodeOpaqueIdentity
  grandchildOwnershipIdentities?: OpenCodeOpaqueIdentity[]
}

export type OpenCodeLaunchMaterializeResult =
  | { outcome: 'applied'; linkage: OpenCodeLaunchMemberLinkage; owned: OpenCodeLaunchOwnedResources }
  | { outcome: 'known_failure'; failure: OpenCodeLaunchFailureKind; externalEffect: false; owned?: OpenCodeLaunchOwnedResources }
  | { outcome: 'unknown_transport'; owned?: OpenCodeLaunchOwnedResources }

export type OpenCodeLaunchCleanupOutcome = 'complete' | 'timed_out'

export type OpenCodeLaunchAttemptPorts = {
  clock: { monotonicNow(): number }
  profile: {
    createSelectedProviderProfile(input: {
      providerId: string
      purpose: 'launch_attempt'
      deadlineAtMs: number
      signal: AbortSignal
    }): Promise<OpenCodeLaunchProfile>
  }
  host: {
    acquireOperationHost(input: {
      profile: OpenCodeLaunchProfile
      deadlineAtMs: number
      signal: AbortSignal
    }): Promise<OpenCodeRetainedHostIdentity>
    releaseOperationHost(input: {
      host: OpenCodeRetainedHostIdentity
      deadlineAtMs: number
      signal: AbortSignal
    }): Promise<void>
  }
  mcp: {
    verifyAppMcp(input: {
      host: OpenCodeRetainedHostIdentity
      requiredTools: readonly string[]
      deadlineAtMs: number
      signal: AbortSignal
    }): Promise<{ host: OpenCodeRetainedHostIdentity; observedTools: string[] }>
  }
  proof: {
    runFreshExactModelProof(input: {
      request: OpenCodeLaunchAttemptRequest
      profile: OpenCodeLaunchProfile
      host: OpenCodeRetainedHostIdentity
      deadlineAtMs: number
      signal: AbortSignal
    }): Promise<{
      response: unknown
      authIdentity: OpenCodeOpaqueIdentity
      configIdentity: OpenCodeOpaqueIdentity
      binaryIdentity: OpenCodeOpaqueIdentity
    }>
    /** A second independent observation, immediately before the first member mutation. */
    observeRetainedProofState(input: {
      request: OpenCodeLaunchAttemptRequest
      profile: OpenCodeLaunchProfile
      host: OpenCodeRetainedHostIdentity
      deadlineAtMs: number
      signal: AbortSignal
    }): Promise<OpenCodeLaunchProofObservation>
  }
  sessions: {
    /** Authoritative durable read; null means the session ledger proves absence. */
    readMemberLinkage(input: {
      attemptId: string; payloadHash: string; inputDigest: string; generation: number; fence: number
      claimToken: string; currentGeneration: number; currentFence: number
      memberIdentity: OpenCodeOpaqueIdentity; deadlineAtMs: number; signal: AbortSignal
    }): Promise<OpenCodeLaunchMemberLinkage | null>
    claimMemberMutation(input: {
      attemptId: string; payloadHash: string; inputDigest: string; generation: number; fence: number
      acquisitionToken: string; claimToken: string
      memberIdentity: OpenCodeOpaqueIdentity; deadlineAtMs: number; signal: AbortSignal
    }): Promise<'claimed' | 'already_committed' | 'unknown' | 'reconciliation_required'>
    /** The single durable CAS for cancellation and commit of an exact live claim. */
    transitionMemberClaim(input: {
      attemptId: string; payloadHash: string; inputDigest: string; generation: number; fence: number
      acquisitionToken: string; claimToken: string
      memberIdentity: OpenCodeOpaqueIdentity; deadlineAtMs: number; signal: AbortSignal
    } & ({ transition: 'cancel' } | { transition: 'commit'; linkage: OpenCodeLaunchMemberLinkage })):
      Promise<'cancelled' | 'committed' | 'fenced' | 'unknown'>
    /** Includes session create, noReply bootstrap, and truthful durable linkage commit. */
    createBootstrapAndCommit(input: {
      attemptId: string
      payloadHash: string
      inputDigest: string
      memberIdentity: OpenCodeOpaqueIdentity
      host: OpenCodeRetainedHostIdentity
      generation: number
      fence: number
      acquisitionToken: string
      claimToken: string
      deadlineAtMs: number
      signal: AbortSignal
      /** Called before an owned side effect may outlive the awaited transport. */
      registerOwned(resources: OpenCodeLaunchOwnedResources): void
      /** Must be awaited immediately before every irreversible mutation and its durable commit. */
      revalidateBeforeCommit(): Promise<void>
      /** The durable session commit point must CAS the still-live claim token. */
      commitIfClaimLive(linkage: OpenCodeLaunchMemberLinkage): Promise<'committed' | 'fenced' | 'unknown'>
    }): Promise<OpenCodeLaunchMaterializeResult>
  }
  ownership: {
    abortOwned(input: {
      resources: OpenCodeLaunchOwnedResources; deadlineAtMs: number; signal: AbortSignal
    }): Promise<void>
    cleanupOwned(input: {
      resources: OpenCodeLaunchOwnedResources[]
      host: OpenCodeRetainedHostIdentity
      /** Cleanup implementations must reject shared/unowned resources. */
      deadlineAtMs: number
      /** Remains aborted after attempt cancellation while bounded cleanup proceeds. */
      attemptSignal: AbortSignal
      signal: AbortSignal
    }): Promise<OpenCodeLaunchCleanupOutcome>
  }
  /** Enforces a monotonic deadline/cancellation around every awaited port call. */
  deadline: {
    run<T>(operation: Promise<T>, deadlineAtMs: number, signal: AbortSignal): Promise<T>
  }
}

export type OpenCodeLaunchAttemptInput = {
  request: OpenCodeLaunchAttemptRequest
  members: readonly OpenCodeOpaqueIdentity[]
  requestedBudgetMs?: number
  continuation?: boolean
  signal?: AbortSignal
  /** Locally recomputed digest of every mutation-bearing production command field. */
  commandInputDigest?: string
  /** Stable plan digest across generations; excludes continuation-only fields. */
  commandImmutableDigest?: string
}

export type OpenCodeLaunchAttemptResult = {
  generation: number
  status: 'succeeded' | 'partial' | 'failed' | 'reconciliation_required' | 'cancelled'
  committed: OpenCodeLaunchMemberLinkage[]
  pending: OpenCodeOpaqueIdentity[]
  failure?: ReturnType<typeof classifyOpenCodeLaunchFailure>
  cleanup: OpenCodeLaunchCleanupOutcome
  absoluteDeadlineAtMs: number
  workDeadlineAtMs: number
}

export class OpenCodeLaunchAttemptError extends Error {
  constructor(readonly field: string) {
    super(`OpenCode launch attempt contract violation: ${field}`)
    this.name = 'OpenCodeLaunchAttemptError'
  }
}

/** Focused orchestration core. It has no production handler/client dependencies. */
export class OpenCodeLaunchAttempt {
  constructor(
    private readonly store: OpenCodeLaunchAttemptStore,
    private readonly ports: OpenCodeLaunchAttemptPorts,
  ) {}

  async run(input: OpenCodeLaunchAttemptInput): Promise<OpenCodeLaunchAttemptResult> {
    const suppliedRequest = encodeOpenCodeLaunchAttemptRequest(input.request)
    const members = deepFreeze(structuredClone([...input.members]))
    const request = deepFreeze(structuredClone({
      ...suppliedRequest,
      launchAttempt: { ...suppliedRequest.launchAttempt, proofNonce: randomBytes(32).toString('base64url') },
    }))
    const attempt = request.launchAttempt
    if (new Set(members).size !== members.length || !members.every(isOpenCodeOpaqueIdentity)) {
      throw new OpenCodeLaunchAttemptError('members')
    }
    if (input.continuation && attempt.generation <= 1) throw new OpenCodeLaunchAttemptError('generation')
    const initialPolicy = new OpenCodeLaunchAttemptPolicy({
      requestedBudgetMs: input.requestedBudgetMs,
      monotonicNow: () => this.ports.clock.monotonicNow(),
    })
    const controller = new AbortController()
    const cancel = () => controller.abort(input.signal?.reason)
    input.signal?.addEventListener('abort', cancel, { once: true })
    if (input.signal?.aborted) cancel()
    const inputDigest = computeOpenCodeLaunchAttemptInputDigest(
      suppliedRequest, members, input.continuation ? 'continue' : 'begin',
      input.requestedBudgetMs ?? initialPolicy.totalBudgetMs, initialPolicy.totalBudgetMs,
      input.commandInputDigest,
    )
    const immutableDigest = computeOpenCodeLaunchAttemptImmutableDigest(
      suppliedRequest, members,
      input.requestedBudgetMs ?? initialPolicy.totalBudgetMs, initialPolicy.totalBudgetMs,
      input.commandImmutableDigest,
    )
    const initialStoreContext = {
      deadlineAtMs: initialPolicy.workDeadlineAtMs, signal: controller.signal,
      monotonicNow: () => this.ports.clock.monotonicNow(),
    }

    try {
      return await this.store.withGeneration(
        {
          attemptId: attempt.attemptId, payloadHash: attempt.payloadHash, inputDigest, immutableDigest,
          generation: attempt.generation,
          ...(input.continuation ? {} : {
            startedAtMs: initialPolicy.startedAtMs,
            totalBudgetMs: initialPolicy.totalBudgetMs,
          }),
        },
        input.continuation ? 'continue' : 'begin',
        async lease => {
          if (lease.generation !== attempt.generation) throw new OpenCodeLaunchAttemptError('generation')
          let firstClockRead = true
          const policy = new OpenCodeLaunchAttemptPolicy({
            requestedBudgetMs: lease.journal.totalBudgetMs,
            monotonicNow: () => {
              if (firstClockRead) { firstClockRead = false; return lease.journal.startedAtMs }
              return this.ports.clock.monotonicNow()
            },
          })
          const committed: OpenCodeLaunchMemberLinkage[] = []
          const pending: OpenCodeOpaqueIdentity[] = []
          const recovery = await this.reconcile(
            lease.journal.events, members, committed, lease.generation,
            { attemptId: attempt.attemptId, payloadHash: attempt.payloadHash, currentFence: lease.fence },
            lease.reconcile,
            policy.workDeadlineAtMs, controller.signal,
          )
          if (recovery === 'required') {
            return this.result(policy, lease.generation, 'reconciliation_required', committed,
              members.filter(member => !committed.some(link => link.memberIdentity === member)),
              'unknown_transport_after_side_effect', 'complete')
          }
          if (recovery) {
            const recoveryStatus = recovery === 'unknown_transport_after_side_effect'
              ? 'reconciliation_required' : committed.length ? 'partial' : 'failed'
            return this.result(policy, lease.generation, recoveryStatus, committed,
              members.filter(member => !committed.some(link => link.memberIdentity === member)),
              recovery, 'complete')
          }
          if (committed.length === members.length) {
            return this.result(policy, lease.generation, 'succeeded', committed, [], undefined, 'complete')
          }

          const owned: OpenCodeLaunchOwnedResources[] = []
          const claimTokens = new Map<OpenCodeOpaqueIdentity, string>()
          const registerOwned = (resource: OpenCodeLaunchOwnedResources, memberIdentity: OpenCodeOpaqueIdentity) => {
            validateOwnedResources(resource, memberIdentity)
            const existing = owned.find(candidate => candidate.memberIdentity === memberIdentity)
            if (existing && !sameOwnedResources(existing, resource)) {
              throw new OpenCodeLaunchAttemptError('member.ownedChanged')
            }
            if (!existing) owned.push(deepFreeze(structuredClone(resource)))
          }
          let host: OpenCodeRetainedHostIdentity | undefined
          let failure: OpenCodeLaunchFailureKind | undefined
          let cleanup: OpenCodeLaunchCleanupOutcome = 'complete'
          let ambiguousMember: OpenCodeOpaqueIdentity | undefined
          let ambiguousClaimToken: string | undefined
          let memberUnknownPersisted = false
          let inFlightAmbiguous: Promise<unknown> | undefined
          let inFlightAmbiguousSettled = false
          const trackAmbiguous = <T>(operation: Promise<T>): Promise<T> => {
            inFlightAmbiguous = operation
            inFlightAmbiguousSettled = false
            void operation.then(
              () => { if (inFlightAmbiguous === operation) inFlightAmbiguousSettled = true },
              () => { if (inFlightAmbiguous === operation) inFlightAmbiguousSettled = true },
            )
            return operation
          }
          let deferredAuthoritySettlement: Promise<void> | undefined
          try {
            this.ensureWork(policy, controller.signal)
            const profile = deepFreeze(await this.phase('profile_prepare', policy, controller.signal,
              deadline => this.ports.profile.createSelectedProviderProfile({
                providerId: attempt.providerId, purpose: 'launch_attempt', deadlineAtMs: deadline,
                signal: controller.signal,
              })))
            this.validateProfile(profile, attempt.providerId)
            await lease.bindProfile({
              profileIdentity: profile.profileIdentity,
              pluginPolicyIdentity: profile.pluginPolicyIdentity,
              cacheIdentity: profile.cacheIdentity,
              authIdentity: profile.authIdentity,
              configIdentity: profile.configIdentity,
              binaryIdentity: profile.binaryIdentity,
            })
            host = deepFreeze(await this.phase('retained_host_start', policy, controller.signal,
              deadline => this.ports.host.acquireOperationHost({ profile, deadlineAtMs: deadline, signal: controller.signal })))
            if (host.profileScopeIdentity !== profile.profileIdentity) throw new OpenCodeLaunchAttemptError('host.profileScopeIdentity')

            const mcp = await this.phase('provider_live_validate', policy, controller.signal,
              deadline => this.ports.mcp.verifyAppMcp({
                host: host!, requiredTools: attempt.requiredMcpTools, deadlineAtMs: deadline, signal: controller.signal,
              }))
            if (!sameHost(mcp.host, host)) throw new OpenCodeLaunchAttemptError('mcp.host')
            for (const tool of attempt.requiredMcpTools) {
              if (!mcp.observedTools.includes(tool)) throw new OpenCodeLaunchAttemptError('mcp.observedTools')
            }

            const proofStartedAt = this.ports.clock.monotonicNow()
            const proofResult = await this.phase('retained_host_mcp_proof', policy, controller.signal,
              deadline => this.ports.proof.runFreshExactModelProof({
                request, profile, host: host!, deadlineAtMs: deadline, signal: controller.signal,
              }))
            const proofCompletedAt = this.ports.clock.monotonicNow()
            const decoded = decodeOpenCodeLaunchAttemptResponse(proofResult.response)
            if (!decoded.ok || decoded.value.kind !== 'v2') throw new OpenCodeLaunchAttemptError('proof.response')
            const proofResponse = deepFreeze(decoded.value.response)
            const correlation = validateOpenCodeLaunchAttemptCorrelation(request, proofResponse, {
              currentGeneration: lease.generation,
              expectedNonceHash: createHash('sha256').update(request.launchAttempt.proofNonce).digest('hex'),
              expectedProfilePurpose: profile.purpose,
              expectedProviderId: profile.providerId,
              expectedProjectIdentity: profile.projectIdentity,
              expectedConfigIdentity: profile.configIdentity,
              expectedAuthIdentity: profile.authIdentity,
              expectedPluginPolicyIdentity: profile.pluginPolicyIdentity,
              expectedCacheIdentity: profile.cacheIdentity,
              expectedBinaryIdentity: profile.binaryIdentity,
              expectedRetainedHostIdentity: host,
              requiredMcpTools: attempt.requiredMcpTools,
            })
            if (correlation.ok === false) throw new OpenCodeLaunchAttemptError(correlation.failure.field)
            if (!proofResponse.proof || proofResponse.proof.verifiedAt <= proofStartedAt
              || proofResponse.proof.verifiedAt > proofCompletedAt
              || proofResponse.launchAttempt.profilePurpose !== profile.purpose
              || proofResponse.launchAttempt.profileIdentity !== profile.profileIdentity
              || proofResponse.launchAttempt.pluginPolicyIdentity !== profile.pluginPolicyIdentity
              || proofResponse.launchAttempt.cacheIdentity !== profile.cacheIdentity
              || proofResult.authIdentity !== profile.authIdentity
              || proofResult.configIdentity !== profile.configIdentity
              || proofResult.binaryIdentity !== profile.binaryIdentity
              || proofResponse.proof.observedMcpTools.length !== attempt.requiredMcpTools.length
              || proofResponse.proof.observedMcpTools.some((tool, index) => tool !== attempt.requiredMcpTools[index])) {
              throw new OpenCodeLaunchAttemptError('proof.profile')
            }

            const memberPhaseStartedAt = this.ports.clock.monotonicNow()
            for (const memberIdentity of members) {
              if (committed.some(link => link.memberIdentity === memberIdentity)) continue
              const observation = await this.phase('provider_live_validate', policy, controller.signal,
                deadline => this.ports.proof.observeRetainedProofState({
                  request, profile, host: host!, deadlineAtMs: deadline, signal: controller.signal,
                }))
              this.validateProofObservation(observation, profile, host, attempt.providerId,
                attempt.modelId, attempt.proofNonce, attempt.requiredMcpTools)
              this.ensureWork(policy, controller.signal)
              const budget = policy.memberMaterializationBudget(
                memberPhaseStartedAt,
                members.length - committed.length,
                this.ports.clock.monotonicNow(),
              )
              if (budget.memberBudgetMs <= 0) throw new DeadlineError()
              const revalidateMember = async (): Promise<void> => {
                await lease.revalidate(memberIdentity, claimToken)
                this.ensureWork(policy, controller.signal)
                const current = await this.ports.deadline.run(
                  this.ports.proof.observeRetainedProofState({
                    request, profile, host: host!, deadlineAtMs: budget.memberDeadlineAtMs,
                    signal: controller.signal,
                  }),
                  budget.memberDeadlineAtMs,
                  controller.signal,
                )
                this.validateProofObservation(current, profile, host!, attempt.providerId,
                  attempt.modelId, attempt.proofNonce, attempt.requiredMcpTools)
                await lease.revalidate(memberIdentity, claimToken)
              }
              const claimToken = await lease.claim(memberIdentity)
              claimTokens.set(memberIdentity, claimToken)
              ambiguousClaimToken = claimToken
              // Deadline remains active across the persistence/external-effect boundary.
              this.ensureWork(policy, controller.signal)
              // Once the claim transport is registered its timeout is ambiguous, even if it never replies.
              ambiguousMember = memberIdentity
              const claimOperation = Promise.resolve().then(() => this.ports.sessions.claimMemberMutation({
                attemptId: attempt.attemptId, payloadHash: attempt.payloadHash, inputDigest,
                generation: lease.generation, fence: lease.fence, acquisitionToken: lease.acquisitionToken,
                claimToken, memberIdentity,
                deadlineAtMs: budget.memberDeadlineAtMs, signal: controller.signal,
              }))
              trackAmbiguous(claimOperation)
              const claim = await this.ports.deadline.run(claimOperation, budget.memberDeadlineAtMs, controller.signal)
              inFlightAmbiguous = undefined
              if (claim !== 'claimed') {
                const abortSignal = new AbortController().signal
                await this.ports.deadline.run(this.ports.sessions.transitionMemberClaim({
                  attemptId: attempt.attemptId, payloadHash: attempt.payloadHash, inputDigest,
                  generation: lease.generation, fence: lease.fence, acquisitionToken: lease.acquisitionToken,
                  claimToken, memberIdentity, transition: 'cancel', deadlineAtMs: policy.absoluteDeadlineAtMs,
                  signal: abortSignal,
                }), policy.absoluteDeadlineAtMs, abortSignal).catch(() => 'unknown' as const)
                await lease.append({ type: 'member_unknown', memberIdentity, claimToken })
                memberUnknownPersisted = true
                failure = 'unknown_transport_after_side_effect'; break
              }
              await lease.revalidate(memberIdentity, claimToken)
              let claimCommitted = false
              let claimCommitStarted = false
              const materializeOperation = Promise.resolve().then(() =>
                this.ports.sessions.createBootstrapAndCommit({
                  attemptId: attempt.attemptId, payloadHash: attempt.payloadHash, inputDigest,
                  memberIdentity, host: host!, generation: lease.generation, fence: lease.fence,
                  acquisitionToken: lease.acquisitionToken, claimToken,
                  deadlineAtMs: budget.memberDeadlineAtMs, signal: controller.signal,
                  registerOwned: resource => { registerOwned(resource, memberIdentity) },
                  revalidateBeforeCommit: revalidateMember,
                  commitIfClaimLive: async linkage => {
                    validateLinkage(linkage, memberIdentity)
                    if (claimCommitStarted) throw new OpenCodeLaunchAttemptError('member.claimCommitDuplicate')
                    claimCommitStarted = true
                    this.ensureWork(policy, controller.signal)
                    if (this.ports.clock.monotonicNow() >= budget.memberDeadlineAtMs) throw new DeadlineError()
                    await revalidateMember()
                    this.ensureWork(policy, controller.signal)
                    if (this.ports.clock.monotonicNow() >= budget.memberDeadlineAtMs) throw new DeadlineError()
                    const transition = await this.ports.sessions.transitionMemberClaim({
                      attemptId: attempt.attemptId, payloadHash: attempt.payloadHash, inputDigest,
                      generation: lease.generation, fence: lease.fence, acquisitionToken: lease.acquisitionToken,
                      claimToken, memberIdentity, linkage, transition: 'commit',
                      deadlineAtMs: budget.memberDeadlineAtMs, signal: controller.signal,
                    })
                    const result = transition === 'cancelled' ? 'fenced' : transition
                    if (result === 'committed') {
                      claimCommitted = true
                      committed.push(linkage)
                      await lease.append({ type: 'member_applied', memberIdentity, linkage, claimToken })
                      ambiguousMember = undefined
                      ambiguousClaimToken = undefined
                    }
                    return result
                  },
                }))
              trackAmbiguous(materializeOperation)
              const materialized = await this.ports.deadline.run(
                materializeOperation, budget.memberDeadlineAtMs, controller.signal)
              inFlightAmbiguous = undefined
              if (materialized.outcome === 'unknown_transport') {
                if (materialized.owned) registerOwned(materialized.owned, memberIdentity)
                const abortSignal = new AbortController().signal
                await this.ports.deadline.run(this.ports.sessions.transitionMemberClaim({
                  attemptId: attempt.attemptId, payloadHash: attempt.payloadHash, inputDigest,
                  generation: lease.generation, fence: lease.fence, acquisitionToken: lease.acquisitionToken,
                  claimToken, memberIdentity, transition: 'cancel', deadlineAtMs: policy.absoluteDeadlineAtMs,
                  signal: abortSignal,
                }), policy.absoluteDeadlineAtMs, abortSignal).catch(() => 'unknown' as const)
                await lease.append({ type: 'member_unknown', memberIdentity, claimToken })
                memberUnknownPersisted = true
                failure = 'unknown_transport_after_side_effect'
                pending.push(...members.filter(member => member !== memberIdentity
                  && !committed.some(link => link.memberIdentity === member)))
                break
              }
              if (materialized.outcome === 'known_failure') {
                if (materialized.owned) registerOwned(materialized.owned, memberIdentity)
                const abortSignal = new AbortController().signal
                const abortResult = await this.ports.deadline.run(this.ports.sessions.transitionMemberClaim({
                  attemptId: attempt.attemptId, payloadHash: attempt.payloadHash, inputDigest,
                  generation: lease.generation, fence: lease.fence, acquisitionToken: lease.acquisitionToken,
                  claimToken, memberIdentity, transition: 'cancel', deadlineAtMs: policy.absoluteDeadlineAtMs,
                  signal: abortSignal,
                }), policy.absoluteDeadlineAtMs, abortSignal).catch(() => 'unknown' as const)
                if (abortResult !== 'cancelled' && abortResult !== 'fenced') {
                  await lease.append({ type: 'member_unknown', memberIdentity, claimToken })
                  memberUnknownPersisted = true
                  failure = 'unknown_transport_after_side_effect'
                  break
                }
                await lease.append({
                  type: 'member_failed', memberIdentity,
                  failure: materialized.failure, externalEffect: false, claimToken,
                })
                ambiguousMember = undefined
                ambiguousClaimToken = undefined
                failure = materialized.failure
                pending.push(...members.filter(member => member !== memberIdentity
                  && !committed.some(link => link.memberIdentity === member)))
                break
              }
              validateLinkage(materialized.linkage, memberIdentity)
              if (!claimCommitted) throw new OpenCodeLaunchAttemptError('member.claimCommit')
              if (!sameLinkage(committed.at(-1)!, materialized.linkage)) {
                throw new OpenCodeLaunchAttemptError('member.claimCommitLinkage')
              }
              registerOwned(materialized.owned, memberIdentity)
              ambiguousMember = undefined
              ambiguousClaimToken = undefined
              this.ensureWork(policy, controller.signal)
            }
          } catch (error) {
            if (error instanceof OpenCodeLaunchPoisonedLeaseError) {
              deferredAuthoritySettlement = error.physicalSettlement
            }
            controller.abort(error)
            if (ambiguousMember) {
              if (ambiguousClaimToken) {
                const abortSignal = new AbortController().signal
                await this.ports.deadline.run(this.ports.sessions.transitionMemberClaim({
                  attemptId: attempt.attemptId, payloadHash: attempt.payloadHash, inputDigest,
                  generation: lease.generation, fence: lease.fence, acquisitionToken: lease.acquisitionToken,
                  claimToken: ambiguousClaimToken, memberIdentity: ambiguousMember, transition: 'cancel',
                  deadlineAtMs: policy.absoluteDeadlineAtMs, signal: abortSignal,
                }), policy.absoluteDeadlineAtMs, abortSignal).catch(() => 'unknown' as const)
              }
              if (!memberUnknownPersisted) {
                const persistenceSignal = new AbortController().signal
                await lease.append({ type: 'member_unknown', memberIdentity: ambiguousMember,
                  claimToken: ambiguousClaimToken! }, {
                  deadlineAtMs: policy.absoluteDeadlineAtMs, signal: persistenceSignal,
                  monotonicNow: () => this.ports.clock.monotonicNow(),
                }).then(() => { memberUnknownPersisted = true }).catch(() => undefined)
              }
              failure = 'unknown_transport_after_side_effect'
            } else {
              failure = error instanceof DeadlineError
                || policy.remainingWorkMs(this.ports.clock.monotonicNow()) <= 0
                ? (committed.length ? 'deadline_after_partial' : 'deadline_before_partial')
                : failure ?? (controller.signal.aborted && input.signal?.aborted ? 'cancelled' : 'contract_violation')
            }
            // A durable tombstone prevents a late commit from becoming authoritative, but it
            // does not make the physical operation finished. This also covers a transport that
            // became ambiguous after its inner commit durably succeeded.
            if (inFlightAmbiguous && !inFlightAmbiguousSettled) {
              failure = 'unknown_transport_after_side_effect'
              const physicalSettlement = inFlightAmbiguous.then(() => undefined, () => undefined)
              lease.retainUntilPhysicalSettlement(physicalSettlement)
              deferredAuthoritySettlement = deferredAuthoritySettlement
                ? Promise.all([deferredAuthoritySettlement, physicalSettlement]).then(() => undefined)
                : physicalSettlement
              inFlightAmbiguous = undefined
            } else if (inFlightAmbiguousSettled) {
              inFlightAmbiguous = undefined
            }
          } finally {
            if (host) {
              let cleanupHostChain: Promise<void> | undefined
              let releaseHostChain: Promise<void> | undefined
              const releaseHost = (): Promise<void> => {
                if (releaseHostChain) return releaseHostChain
                releaseHostChain = (async () => {
                  const releaseController = new AbortController()
                  const physicalRelease = this.ports.host.releaseOperationHost({
                    host: host!, deadlineAtMs: policy.absoluteDeadlineAtMs, signal: releaseController.signal,
                  })
                  try {
                    await this.ports.deadline.run(
                      physicalRelease, policy.absoluteDeadlineAtMs, releaseController.signal,
                    )
                  } catch {
                    cleanup = 'timed_out'
                    // The physical release may ignore cancellation.  Abort its supplied signal and
                    // observe its eventual settlement without extending the caller's absolute
                    // deadline.  In particular, never await it again after the bounded race lost.
                    releaseController.abort(new DeadlineError())
                    void physicalRelease.then(() => undefined, () => undefined)
                  }
                })()
                return releaseHostChain
              }
              const cleanupHost = (): Promise<void> => {
                if (cleanupHostChain) return cleanupHostChain
                cleanupHostChain = (async () => {
                  const uncommitted = owned.filter(resource =>
                    !committed.some(link => link.memberIdentity === resource.memberIdentity))
                  const cleanupController = new AbortController()
                  for (const resource of uncommitted) {
                    const abortOperation = this.ports.ownership.abortOwned({
                      resources: resource, deadlineAtMs: policy.absoluteDeadlineAtMs,
                      signal: cleanupController.signal,
                    })
                    await this.ports.deadline.run(
                      abortOperation, policy.absoluteDeadlineAtMs, cleanupController.signal,
                    ).catch(() => undefined)
                  }
                  let cleanupPhysicallyCompleted = false
                  try {
                    // Keep physical settlement separate from its caller-facing deadline so late
                    // completion can be diagnosed/reaped without delaying the launch result.
                    const physicalCleanup = this.ports.ownership.cleanupOwned({
                      resources: uncommitted,
                      host: host!, deadlineAtMs: policy.absoluteDeadlineAtMs,
                      attemptSignal: controller.signal, signal: cleanupController.signal,
                    })
                    try {
                      cleanup = await this.ports.deadline.run(
                        physicalCleanup, policy.absoluteDeadlineAtMs, cleanupController.signal)
                    } catch {
                      cleanup = 'timed_out'
                      cleanupController.abort(new DeadlineError())
                      // Register a one-shot late reaper. It may request release if physical cleanup
                      // eventually proves completeness, but release itself remains deadline bounded.
                      void physicalCleanup.then(
                        outcome => outcome === 'complete' ? releaseHost() : undefined,
                        () => undefined,
                      ).catch(() => undefined)
                    }
                    cleanupPhysicallyCompleted = cleanup === 'complete'
                  } catch {
                    // A rejected cleanup does not prove that owned descendants are gone. Retaining
                    // the host is the conservative outcome; reconciliation may reap it later.
                    cleanup = 'timed_out'
                  }
                  if (cleanupPhysicallyCompleted) await releaseHost()
                  for (const resource of uncommitted) {
                    const cleanupClaimToken = claimTokens.get(resource.memberIdentity)
                    if (!cleanupClaimToken) continue
                    await lease.append({ type: 'cleanup', memberIdentity: resource.memberIdentity,
                      outcome: cleanup, claimToken: cleanupClaimToken }, {
                      deadlineAtMs: policy.absoluteDeadlineAtMs, signal: cleanupController.signal,
                      monotonicNow: () => this.ports.clock.monotonicNow(),
                    }).catch(() => undefined)
                  }
                })()
                return cleanupHostChain
              }
              if (deferredAuthoritySettlement) {
                cleanup = 'timed_out'
                void deferredAuthoritySettlement.then(
                  () => cleanupHost(), () => cleanupHost(),
                ).catch(() => undefined)
              } else await cleanupHost()
            }
          }
          const status = failure === undefined ? 'succeeded'
            : failure === 'unknown_transport_after_side_effect' ? 'reconciliation_required'
              : committed.length ? 'partial'
                : failure === 'cancelled' ? 'cancelled'
                  : 'failed'
          const unresolved = members.filter(member => !committed.some(link => link.memberIdentity === member))
          return this.result(policy, lease.generation, status, committed, [...pending, ...unresolved], failure, cleanup)
        },
        initialStoreContext,
      )
    } finally {
      input.signal?.removeEventListener('abort', cancel)
    }
  }

  private async reconcile(
    events: readonly OpenCodeLaunchJournalEvent[],
    members: readonly OpenCodeOpaqueIdentity[],
    committed: OpenCodeLaunchMemberLinkage[],
    currentGeneration: number,
    coordination: { attemptId: string; payloadHash: string; currentFence: number },
    append: (event: OpenCodeLaunchJournalReconciliationEvent, context?: OpenCodeLaunchStoreContext) => Promise<void>,
    deadlineAtMs: number,
    signal: AbortSignal,
  ): Promise<'required' | OpenCodeLaunchFailureKind | null> {
    for (const memberIdentity of members) {
      const memberEvents = events.filter(event => event.memberIdentity === memberIdentity && event.type !== 'cleanup')
      const last = memberEvents.at(-1)
      if (!last) continue
      const authoritative = await this.ports.deadline.run(this.ports.sessions.readMemberLinkage({
        ...coordination, inputDigest: last.inputDigest, generation: last.generation, fence: last.fence,
        claimToken: last.claimToken, currentGeneration,
        memberIdentity, deadlineAtMs, signal,
      }), deadlineAtMs, signal)
      if (last.type === 'member_applied' || last.type === 'member_reconciled_applied') {
        if (!authoritative || !sameLinkage(last.linkage, authoritative)) return 'required'
        committed.push(last.linkage)
      } else if (last.type === 'member_intent' || last.type === 'member_unknown') {
        if (authoritative) {
          validateLinkage(authoritative, memberIdentity)
          await append({ type: 'member_reconciled_applied', memberIdentity, linkage: authoritative,
            claimToken: last.claimToken })
          committed.push(authoritative)
        } else if (last.type === 'member_unknown') {
          // Unknown-after-claim is reconciliation-only. Durable absence is evidence, but never
          // authorization for an automatic duplicate mutation.
          return 'unknown_transport_after_side_effect'
        } else {
          // An authoritative durable absence is the required reconciliation before a resend.
          await append({ type: 'member_reconciled_absent', memberIdentity, claimToken: last.claimToken })
        }
      } else if (last.type === 'member_failed') {
        if (last.generation < currentGeneration
          && classifyOpenCodeLaunchFailure(last.failure).retryDisposition === 'automatic') {
          await append({ type: 'member_reconciled_absent', memberIdentity, claimToken: last.claimToken })
          continue
        }
        return last.failure
      }
    }
    return null
  }

  private async phase<T>(
    phase: OpenCodeLaunchPhase,
    policy: OpenCodeLaunchAttemptPolicy,
    signal: AbortSignal,
    operation: (deadlineAtMs: number) => Promise<T>,
  ): Promise<T> {
    this.ensureWork(policy, signal)
    const budget = policy.phaseBudget(phase, this.ports.clock.monotonicNow())
    return this.ports.deadline.run(operation(budget.deadlineAtMs), budget.deadlineAtMs, signal)
  }

  private ensureWork(policy: OpenCodeLaunchAttemptPolicy, signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DeadlineError()
    if (policy.remainingWorkMs(this.ports.clock.monotonicNow()) <= 0) throw new DeadlineError()
  }

  private validateProfile(profile: OpenCodeLaunchProfile, providerId: string): void {
    if (profile.purpose !== 'launch_attempt' || profile.providerId !== providerId
      || ![profile.projectIdentity, profile.profileIdentity, profile.pluginPolicyIdentity, profile.cacheIdentity,
        profile.authIdentity, profile.configIdentity, profile.binaryIdentity]
        .every(isOpenCodeOpaqueIdentity)) throw new OpenCodeLaunchAttemptError('profile')
  }

  private validateProofObservation(
    observation: OpenCodeLaunchProofObservation,
    profile: OpenCodeLaunchProfile,
    host: OpenCodeRetainedHostIdentity,
    providerId: string,
    modelId: string,
    proofNonce: string,
    requiredTools: readonly string[],
  ): void {
    const nonceHash = createHash('sha256').update(proofNonce).digest('hex')
    if (!sameHost(observation.host, host) || observation.nonceHash !== nonceHash
      || observation.providerId !== providerId
      || observation.modelId !== modelId || observation.mcpConnected !== true
      || observation.observedTools.length !== requiredTools.length
      || observation.observedTools.some((tool, index) => tool !== requiredTools[index])
      || observation.profileIdentity !== profile.profileIdentity
      || observation.pluginPolicyIdentity !== profile.pluginPolicyIdentity
      || observation.cacheIdentity !== profile.cacheIdentity
      || observation.authIdentity !== profile.authIdentity
      || observation.configIdentity !== profile.configIdentity
      || observation.binaryIdentity !== profile.binaryIdentity) {
      throw new OpenCodeLaunchAttemptError('proof.drift')
    }
  }

  private result(
    policy: OpenCodeLaunchAttemptPolicy,
    generation: number,
    status: OpenCodeLaunchAttemptResult['status'],
    committed: OpenCodeLaunchMemberLinkage[],
    pending: OpenCodeOpaqueIdentity[],
    failure: OpenCodeLaunchFailureKind | undefined,
    cleanup: OpenCodeLaunchCleanupOutcome,
  ): OpenCodeLaunchAttemptResult {
    const aggregateFailure = committed.length > 0 && failure !== undefined
      && failure !== 'unknown_transport_after_side_effect'
      ? 'deadline_after_partial' : failure
    return {
      generation, status, committed: [...committed], pending: [...new Set(pending)],
      ...(aggregateFailure === undefined ? {} : { failure: classifyOpenCodeLaunchFailure(aggregateFailure) }),
      cleanup,
      absoluteDeadlineAtMs: policy.absoluteDeadlineAtMs,
      workDeadlineAtMs: policy.workDeadlineAtMs,
    }
  }
}

export function computeOpenCodeLaunchAttemptInputDigest(
  request: OpenCodeLaunchAttemptRequest,
  members: readonly OpenCodeOpaqueIdentity[],
  mode: 'begin' | 'continue',
  requestedBudgetMs: number,
  effectiveBudgetMs: number,
  commandInputDigest?: string,
): string {
  const attempt = request.launchAttempt
  const canonical = JSON.stringify({
    contractVersion: request.launchContractVersion,
    attemptId: attempt.attemptId,
    payloadHash: attempt.payloadHash,
    generation: attempt.generation,
    parent: attempt.parent,
    providerId: attempt.providerId,
    modelId: attempt.modelId,
    requiredMcpTools: [...attempt.requiredMcpTools],
    ...(attempt.continuationToken === undefined ? {} : { continuationToken: attempt.continuationToken }),
    requireFreshRetainedHostProof: attempt.requireFreshRetainedHostProof,
    mode,
    requestedBudgetMs,
    effectiveBudgetMs,
    members: [...members],
    ...(commandInputDigest === undefined ? {} : { commandInputDigest }),
  })
  return createHash('sha256').update(canonical).digest('hex')
}

export function computeOpenCodeLaunchAttemptImmutableDigest(
  request: OpenCodeLaunchAttemptRequest,
  members: readonly OpenCodeOpaqueIdentity[],
  requestedBudgetMs: number,
  effectiveBudgetMs: number,
  commandImmutableDigest?: string,
): string {
  const attempt = request.launchAttempt
  return createHash('sha256').update(JSON.stringify({
    contractVersion: request.launchContractVersion,
    attemptId: attempt.attemptId,
    payloadHash: attempt.payloadHash,
    parent: attempt.parent,
    providerId: attempt.providerId,
    modelId: attempt.modelId,
    requiredMcpTools: [...attempt.requiredMcpTools],
    requireFreshRetainedHostProof: attempt.requireFreshRetainedHostProof,
    ...(commandImmutableDigest === undefined ? { requestedBudgetMs, effectiveBudgetMs } : {}),
    members: [...members],
    ...(commandImmutableDigest === undefined ? {} : { commandImmutableDigest }),
  })).digest('hex')
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
  }
  return value
}

class DeadlineError extends Error {}

function sameHost(left: OpenCodeRetainedHostIdentity, right: OpenCodeRetainedHostIdentity): boolean {
  return left.hostKeyIdentity === right.hostKeyIdentity && left.processId === right.processId
    && left.processStartedAtMs === right.processStartedAtMs
    && left.profileScopeIdentity === right.profileScopeIdentity
}

function validateLinkage(linkage: OpenCodeLaunchMemberLinkage, memberIdentity: OpenCodeOpaqueIdentity): void {
  const values = [linkage.memberIdentity, linkage.sessionIdentity,
    linkage.bootstrapMessageIdentity, linkage.commitIdentity]
  if (linkage.memberIdentity !== memberIdentity || !values.every(isOpenCodeOpaqueIdentity)
    || new Set(values).size !== values.length) throw new OpenCodeLaunchAttemptError('member.linkage')
}

function sameLinkage(left: OpenCodeLaunchMemberLinkage, right: OpenCodeLaunchMemberLinkage): boolean {
  return left.memberIdentity === right.memberIdentity && left.sessionIdentity === right.sessionIdentity
    && left.bootstrapMessageIdentity === right.bootstrapMessageIdentity
    && left.commitIdentity === right.commitIdentity
}

function validateOwnedResources(
  resources: OpenCodeLaunchOwnedResources,
  memberIdentity: OpenCodeOpaqueIdentity,
): void {
  if (!resources || resources.memberIdentity !== memberIdentity) {
    throw new OpenCodeLaunchAttemptError('member.ownedIdentity')
  }
  const identities = [resources.sessionIdentity, resources.lockOwnershipIdentity,
    resources.httpOwnershipIdentity, resources.childOwnershipIdentity,
    ...(resources.grandchildOwnershipIdentities ?? [])].filter((value): value is OpenCodeOpaqueIdentity => value !== undefined)
  if (!identities.every(isOpenCodeOpaqueIdentity) || new Set(identities).size !== identities.length) {
    throw new OpenCodeLaunchAttemptError('member.ownedIdentity')
  }
}

function sameOwnedResources(left: OpenCodeLaunchOwnedResources, right: OpenCodeLaunchOwnedResources): boolean {
  return left.memberIdentity === right.memberIdentity
    && left.sessionIdentity === right.sessionIdentity
    && left.lockOwnershipIdentity === right.lockOwnershipIdentity
    && left.httpOwnershipIdentity === right.httpOwnershipIdentity
    && left.childOwnershipIdentity === right.childOwnershipIdentity
    && JSON.stringify(left.grandchildOwnershipIdentities ?? []) === JSON.stringify(right.grandchildOwnershipIdentities ?? [])
}
