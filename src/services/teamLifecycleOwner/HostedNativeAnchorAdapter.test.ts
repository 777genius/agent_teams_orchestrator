import { describe, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'

import type {
  NodeAnchorProviderStdio,
  StartProcessExecutionUnitResult,
  SupervisedProcessRef,
} from '@agent-teams/owner-anchor-library'
import { HostedNativeAnchorAdapter } from './HostedNativeAnchorAdapter.js'

const cancellation = { cancellationId: 'cancel:0000000000000000', isCancellationRequested: () => false }
// Product refs are nominally branded after parsing; this fixture stands in for that parser boundary.
const productProcessRef = 'process:0000000000000000' as SupervisedProcessRef

function binding(unit = 'unit:a') {
  const planRef = {
    teamId: 'team_00000000000000000000000000000000',
    runId: 'run_00000000000000000000000000000000',
    generation: 7,
    planHash: `sha256:${'a'.repeat(64)}`,
  }
  const binaryPolicy = {
    policy: 'registered_exact_binary', binaryId: 'binary:native', binaryRevision: 3,
    binaryHash: `sha256:${'b'.repeat(64)}`,
  }
  const environmentPolicy = { policy: 'explicit_allowlist', variables: [] }
  const resourcePolicy = { maxRuntimeMs: 60_000, gracefulStopMs: 1_000, maxOutputBytes: 4_096, maxProcessCount: 16 }
  const executionUnit = {
    executionUnitId: unit,
    backendBinding: { backend: 'provisioning_cli', bindingId: 'binding:native', bindingRevision: 2 },
    laneId: 'lane:native', memberIds: ['member_00000000000000000000000000000000'],
    binaryPolicy, environmentPolicy, credentialExposureSet: { secretRefs: [] },
    credentialIsolation: 'dedicated_execution_unit', resourcePolicy,
  }
  return {
    ownerPlanGeneration: `plan-generation_${'c'.repeat(64)}`,
    ownerUnitBindingId: `owner-unit:${unit}`,
    orderedMembers: [{ ordinal: 0, memberId: executionUnit.memberIds[0] }],
    executionUnit,
    launchSpec: {
      planRef, executionUnitId: unit, backend: 'provisioning_cli',
      argvAuthority: { executableRef: 'executable:native', binaryPolicy, argv: ['/private/cli'], argvHash: `sha256:${'d'.repeat(64)}` },
      workdirAuthority: {
        workdirRef: 'workdir:registered',
        grant: {
          grantId: 'grant:0000000000000000', workspaceId: 'workspace_00000000000000000000000000000000',
          registrationRevision: 1, bindingGeneration: 2, mountGeneration: 3, permission: 'execute_process',
        },
      },
      environmentAuthority: { environmentRef: 'environment:native', policy: environmentPolicy },
      resourcePolicy,
    },
  } as any
}

function harness(
  startResult: any = { status: 'started', processRef: productProcessRef },
  stopResult: any = { status: 'drained' },
  claimFailure = false,
  release: ((processRef: SupervisedProcessRef) => void | Promise<void>) | undefined = undefined,
  provideStdio = true,
  stopTimeoutMs = 1_000,
  options: Readonly<{
    observeResult?: unknown
    closeStdio?: () => void
    closeProviderStdio?: () => void
  }> = {},
) {
  const calls: any[] = []
  const transports = new Map<SupervisedProcessRef, NodeAnchorProviderStdio>()
  const stdio: NodeAnchorProviderStdio & { processRef: SupervisedProcessRef } = {
    processRef: productProcessRef, capabilityVersion: 1,
    capabilityHash: 'sha256:8ef0fab620172bdb761af87fc471cb3a1abb46710f148037762cee5d403720b5',
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), maxOutputBytes: 4096,
    close() {
      calls.push(['stdio.close'])
      options.closeStdio?.()
    },
  }
  transports.set(stdio.processRef, stdio)
  class Materializer { constructor(readonly catalog: unknown) { calls.push(['materializer', catalog]) } }
  class Spawner {
    constructor(readonly options: unknown) { calls.push(['spawner', options]) }
    providerStdioFor(ref: SupervisedProcessRef) { return provideStdio ? transports.get(ref) : undefined }
    closeProviderStdio(ref: SupervisedProcessRef) {
      calls.push(['spawner.close', ref])
      options.closeProviderStdio?.()
      transports.delete(ref)
    }
  }
  class Supervisor {
    constructor(readonly options: unknown) { calls.push(['supervisor', options]) }
    async start(request: unknown) { calls.push(['start', request]); return startResult }
    async stop(request: unknown) { calls.push(['stop', request]); return stopResult }
    async observe(request: unknown) { calls.push(['observe', request]); return options.observeResult ?? { status: 'ready' } }
  }
  const library = {
    NodeAnchorLaunchMaterializer: Materializer, NodeAnchorSpawner: Spawner,
    AnchorProcessSupervisorAdapter: Supervisor,
    parseProcessOwnerBinding: (value: unknown) => value,
    parseProcessControllerInstanceId: (value: unknown) => value,
    parseOwnedProcessRef: (value: unknown) => value,
    parseSpawnNonce: (value: unknown) => value,
  }
  const store = { load: async () => ({ status: 'missing' }), loadByProcessRef: async () => ({ status: 'missing' }), compareAndSwap: async () => ({ status: 'unavailable' }) }
  const adapter = new HostedNativeAnchorAdapter({
    admittedLibrary: { library, anchorExecutablePath: '/private/process-anchor', admission: {} } as any,
    store: store as any,
    ownerBinding: { authorityId: 'authority:0000000000000000', bootId: 'boot:0000000000000000' } as any,
    controllerInstanceId: 'controller:0000000000000000' as any,
    launchCatalog: { executables: [], workdirs: [], environments: [] },
    neutralWorkingDirectory: '/private/neutral', launchTimeoutMs: 1_000, stopTimeoutMs, recoveryTimeoutMs: 1_000,
    claimProviderStdio: ({ processRef, stdio: claimed }: any) => {
      if (claimFailure) throw new Error('claim failed after ownership')
      claimed.stdout.resume()
      claimed.stderr.resume()
      calls.push(['claim', processRef])
      return {
        processRef,
        stdoutConsumption: 'attached',
        stderrConsumption: 'attached',
        release: () => {
          calls.push(['release', processRef])
          return release?.(processRef)
        },
      }
    },
  } as any)
  return { adapter, calls, stdio }
}

describe('HostedNativeAnchorAdapter', () => {
  test('requires the Owner durable store and constructs the actual Product API once per lifetime', () => {
    const { calls } = harness()
    expect(calls.map(call => call[0])).toEqual(['materializer', 'spawner', 'supervisor'])
    expect(() => new HostedNativeAnchorAdapter({ store: undefined } as any)).toThrow('hosted-native-anchor-store-required')
    const supervisorOptions = calls.find(call => call[0] === 'supervisor')[1]
    expect(supervisorOptions.inventoryMode).toBe('hosted_authority')
    expect(supervisorOptions.ownerBinding).toEqual({ authorityId: 'authority:0000000000000000', bootId: 'boot:0000000000000000' })
  })

  test('delegates exact Product unit scope and retains explicitly consumed process-life stdio', async () => {
    const { adapter, calls, stdio } = harness()
    const exact = binding()
    const started = await adapter.start(exact, cancellation as any)
    expect(started).toMatchObject({ status: 'started', processRef: stdio.processRef, anchorReady: 'committed_ownership_and_anchor_handshake_only' })
    expect(calls.find(call => call[0] === 'start')[1]).toMatchObject({
      executionUnit: { executionUnitId: 'unit:a' }, launchSpec: { executionUnitId: 'unit:a' },
    })
    expect(calls.some(call => call[0] === 'claim')).toBe(true)
    expect(await adapter.observe({ binding: exact, processRef: stdio.processRef } as any)).toEqual({ status: 'ready' })
    expect(await adapter.stop({ binding: exact, processRef: stdio.processRef, mode: 'graceful', cancellation } as any)).toEqual({ status: 'drained' })
    expect(calls.some(call => call[0] === 'stop')).toBe(true)
    expect(calls.some(call => call[0] === 'release')).toBe(true)
    expect(calls.some(call => call[0] === 'stdio.close')).toBe(true)
  })

  test('rejects wrong live scope without signaling Product and preserves a disposition obligation', async () => {
    const { adapter, calls, stdio } = harness()
    const exact = binding()
    await adapter.start(exact, cancellation as any)
    const wrong = binding('unit:b')
    const result = await adapter.stop({ binding: wrong, processRef: stdio.processRef, mode: 'immediate', cancellation } as any)
    expect(result).toEqual({
      status: 'uncertain', productResult: { status: 'scope_not_live' },
      disposition: { required: true, reason: 'scope_not_live' },
    })
    expect(calls.filter(call => call[0] === 'stop')).toHaveLength(0)
  })

  test('does not translate rejected start to no-effect or drained', async () => {
    const rejected = { status: 'rejected', reason: 'unavailable' } as const
    const { adapter } = harness(rejected)
    expect(await adapter.start(binding(), cancellation as any)).toEqual({
      status: 'uncertain', productResult: rejected,
      disposition: { required: true, reason: 'start_result_uncertain' },
    })
  })

  test('retains exact custody and disposition duty after unclassified cleanup', async () => {
    const { adapter, calls, stdio } = harness(undefined, { status: 'unclassified_residual' })
    const exact = binding()
    await adapter.start(exact, cancellation as any)
    expect(await adapter.stop({ binding: exact, processRef: stdio.processRef, mode: 'immediate', cancellation } as any)).toEqual({
      status: 'uncertain', productResult: { status: 'unclassified_residual' },
      disposition: { required: true, reason: 'stop_result_uncertain' },
    })
    expect(calls.some(call => call[0] === 'stdio.close')).toBe(false)
    expect(await adapter.observe({ binding: exact, processRef: stdio.processRef } as any)).toEqual({ status: 'ready' })
  })

  test('preserves safe ordered original roster ordinals without local renumbering', async () => {
    const { adapter } = harness()
    const laterMember = binding()
    laterMember.orderedMembers[0].ordinal = 3
    expect(await adapter.start(laterMember, cancellation as any)).toMatchObject({ status: 'started' })

    const duplicateOrReordered = binding()
    duplicateOrReordered.executionUnit.memberIds = ['member:a', 'member:b']
    duplicateOrReordered.orderedMembers = [
      { ordinal: 4, memberId: 'member:a' },
      { ordinal: 4, memberId: 'member:b' },
    ]
    await expect(adapter.start(duplicateOrReordered, cancellation as any)).rejects.toThrow('hosted-native-anchor-member-order-invalid')
  })

  test('returns the exact committed Product start and process handle when stdio claim fails', async () => {
    const productStart = {
      status: 'started',
      processRef: productProcessRef,
    } satisfies StartProcessExecutionUnitResult
    const { adapter, stdio } = harness(productStart, undefined, true)
    expect(await adapter.start(binding(), cancellation as any)).toEqual({
      status: 'uncertain',
      productResult: productStart,
      processRef: stdio.processRef,
      stdio,
      disposition: { required: true, reason: 'stdio_custody_failed' },
    })

    const missing = harness(productStart, undefined, false, undefined, false)
    expect(await missing.adapter.start(binding(), cancellation as any)).toEqual({
      status: 'uncertain',
      productResult: productStart,
      processRef: missing.stdio.processRef,
      disposition: { required: true, reason: 'stdio_custody_failed' },
    })

    const exact = binding()
    const claimFailed = harness(productStart, undefined, true)
    await claimFailed.adapter.start(exact, cancellation as any)
    const failedClaimStop = {
      binding: exact,
      processRef: claimFailed.stdio.processRef,
      mode: 'graceful',
      cancellation,
    } as any
    const unsettled = {
      status: 'uncertain',
      productResult: { status: 'drained' },
      processDrain: { status: 'drained' },
      consumerSettlement: 'failed',
      disposition: { required: true, reason: 'stdio_custody_release_unsettled' },
    } as const
    expect(await claimFailed.adapter.stop(failedClaimStop)).toEqual(unsettled)
    expect(await claimFailed.adapter.stop(failedClaimStop)).toEqual(unsettled)
    expect(claimFailed.calls.filter(call => call[0] === 'stop')).toHaveLength(1)
    expect(claimFailed.calls.some(call => call[0] === 'stdio.close')).toBe(false)
  })

  test('retains a terminal exact-scope tombstone and does not issue a second Product stop', async () => {
    const { adapter, calls, stdio } = harness(
      undefined,
      undefined,
      false,
      undefined,
      true,
      1_000,
      { observeResult: { status: 'exited' } },
    )
    const exact = binding()
    await adapter.start(exact, cancellation as any)
    const request = { binding: exact, processRef: stdio.processRef, mode: 'graceful', cancellation } as any
    expect(await adapter.stop(request)).toEqual({ status: 'drained' })
    expect(await adapter.stop(request)).toEqual({ status: 'drained' })
    expect(await adapter.observe({ binding: exact, processRef: stdio.processRef })).toEqual({
      status: 'exited',
      outcome: 'drained',
    })
    expect(await adapter.stop({ ...request, binding: binding('unit:foreign') })).toEqual({
      status: 'uncertain',
      productResult: { status: 'scope_not_live' },
      disposition: { required: true, reason: 'scope_not_live' },
    })
    expect(calls.filter(call => call[0] === 'stop')).toHaveLength(1)
    expect(calls.filter(call => call[0] === 'release')).toHaveLength(1)
    expect(calls.filter(call => call[0] === 'observe')).toHaveLength(0)
  })

  test('does not fabricate drained observation from a natural Product exit', async () => {
    const { adapter, calls, stdio } = harness(
      undefined,
      undefined,
      false,
      undefined,
      true,
      1_000,
      { observeResult: { status: 'exited' } },
    )
    const exact = binding()
    await adapter.start(exact, cancellation as any)
    expect(await adapter.observe({ binding: exact, processRef: stdio.processRef })).toEqual({
      status: 'exited',
      outcome: 'unknown',
      disposition: { required: true, reason: 'observation_uncertain' },
    })
    expect(calls.filter(call => call[0] === 'observe')).toHaveLength(1)
  })

  test('rejects foreign observation without signaling Product', async () => {
    const { adapter, calls, stdio } = harness(
      undefined,
      undefined,
      false,
      undefined,
      true,
      1_000,
      { observeResult: { status: 'exited' } },
    )
    await adapter.start(binding(), cancellation as any)
    expect(await adapter.observe({ binding: binding('unit:foreign'), processRef: stdio.processRef })).toEqual({
      status: 'uncertain',
      disposition: { required: true, reason: 'scope_not_live' },
    })
    expect(calls.filter(call => call[0] === 'observe')).toHaveLength(0)
  })

  test('separates proven process drain from rejected consumer settlement and retains retry custody', async () => {
    let releases = 0
    const { adapter, calls, stdio } = harness(
      undefined,
      undefined,
      false,
      async () => {
        releases += 1
        if (releases === 1) throw new Error('consumer release failed')
      },
      true,
      1_000,
      { observeResult: { status: 'exited' } },
    )
    const exact = binding()
    await adapter.start(exact, cancellation as any)
    const request = { binding: exact, processRef: stdio.processRef, mode: 'graceful', cancellation } as any
    expect(await adapter.stop(request)).toEqual({
      status: 'uncertain',
      productResult: { status: 'drained' },
      processDrain: { status: 'drained' },
      consumerSettlement: 'failed',
      disposition: { required: true, reason: 'stdio_custody_release_unsettled' },
    })
    expect(calls.some(call => call[0] === 'stdio.close')).toBe(false)
    expect(await adapter.observe({ binding: exact, processRef: stdio.processRef })).toEqual({
      status: 'uncertain',
      disposition: { required: true, reason: 'stdio_custody_release_unsettled' },
    })
    expect(await adapter.stop(request)).toEqual({ status: 'drained' })
    expect(calls.filter(call => call[0] === 'stop')).toHaveLength(1)
    expect(calls.filter(call => call[0] === 'release')).toHaveLength(2)
  })

  test('turns a synchronous release throw into retryable observed uncertainty', async () => {
    let releases = 0
    const { adapter, calls, stdio } = harness(
      undefined,
      undefined,
      false,
      () => {
        releases += 1
        if (releases === 1) throw new Error('consumer release threw')
      },
      true,
      1_000,
      { observeResult: { status: 'exited' } },
    )
    const exact = binding()
    await adapter.start(exact, cancellation as any)
    const request = { binding: exact, processRef: stdio.processRef, mode: 'graceful', cancellation } as any
    expect(await adapter.stop(request)).toMatchObject({
      status: 'uncertain',
      consumerSettlement: 'failed',
      disposition: { required: true, reason: 'stdio_custody_release_unsettled' },
    })
    expect(await adapter.observe({ binding: exact, processRef: stdio.processRef })).toEqual({
      status: 'uncertain',
      disposition: { required: true, reason: 'stdio_custody_release_unsettled' },
    })
    expect(await adapter.stop(request)).toEqual({ status: 'drained' })
    expect(calls.filter(call => call[0] === 'stop')).toHaveLength(1)
    expect(calls.filter(call => call[0] === 'release')).toHaveLength(2)
  })

  test('joins concurrent pending consumer release without duplicate release or Product stop', async () => {
    let settleRelease: () => void = () => undefined
    const pendingRelease = new Promise<void>(resolve => { settleRelease = () => resolve() })
    const { adapter, calls, stdio } = harness(undefined, undefined, false, () => pendingRelease)
    const exact = binding()
    await adapter.start(exact, cancellation as any)
    const request = { binding: exact, processRef: stdio.processRef, mode: 'graceful', cancellation } as any
    const first = adapter.stop(request)
    await Promise.resolve()
    const second = adapter.stop(request)
    settleRelease()
    expect(await Promise.all([first, second])).toEqual([{ status: 'drained' }, { status: 'drained' }])
    expect(calls.filter(call => call[0] === 'stop')).toHaveLength(1)
    expect(calls.filter(call => call[0] === 'release')).toHaveLength(1)
  })

  test('keeps timed-out release in flight and settles it without a duplicate attempt', async () => {
    let settleRelease: () => void = () => undefined
    const pendingRelease = new Promise<void>(resolve => { settleRelease = () => resolve() })
    const { adapter, calls, stdio } = harness(
      undefined,
      undefined,
      false,
      () => pendingRelease,
      true,
      5,
      { observeResult: { status: 'exited' } },
    )
    const exact = binding()
    await adapter.start(exact, cancellation as any)
    const request = { binding: exact, processRef: stdio.processRef, mode: 'graceful', cancellation } as any
    expect(await adapter.stop(request)).toEqual({
      status: 'uncertain',
      productResult: { status: 'drained' },
      processDrain: { status: 'drained' },
      consumerSettlement: 'pending',
      disposition: { required: true, reason: 'stdio_custody_release_unsettled' },
    })
    expect(calls.filter(call => call[0] === 'release')).toHaveLength(1)
    expect(await adapter.observe({ binding: exact, processRef: stdio.processRef })).toEqual({
      status: 'uncertain',
      disposition: { required: true, reason: 'stdio_custody_release_unsettled' },
    })
    settleRelease()
    expect(await adapter.stop(request)).toEqual({ status: 'drained' })
    expect(calls.filter(call => call[0] === 'stop')).toHaveLength(1)
    expect(calls.filter(call => call[0] === 'release')).toHaveLength(1)
  })

  test('does not self-await when release re-enters exact stop', async () => {
    let adapter: HostedNativeAnchorAdapter | undefined
    let request: any
    let nestedResult: any
    const created = harness(undefined, undefined, false, async () => {
      if (!adapter || !request) throw new Error('reentrant stop fixture not initialized')
      nestedResult = await adapter.stop(request)
    })
    adapter = created.adapter
    const exact = binding()
    await adapter.start(exact, cancellation as any)
    request = { binding: exact, processRef: created.stdio.processRef, mode: 'graceful', cancellation }
    expect(await adapter.stop(request)).toEqual({ status: 'drained' })
    expect(nestedResult).toMatchObject({
      status: 'uncertain',
      consumerSettlement: 'pending',
      disposition: { required: true, reason: 'stdio_custody_release_unsettled' },
    })
    expect(created.calls.filter(call => call[0] === 'stop')).toHaveLength(1)
    expect(created.calls.filter(call => call[0] === 'release')).toHaveLength(1)
  })

  test('keeps failed transport close retryable without false drain or duplicate release', async () => {
    let closeAttempts = 0
    const { adapter, calls, stdio } = harness(
      undefined,
      undefined,
      false,
      undefined,
      true,
      1_000,
      {
        closeStdio: () => {
          closeAttempts += 1
          if (closeAttempts === 1) throw new Error('transport close failed')
        },
      },
    )
    const exact = binding()
    await adapter.start(exact, cancellation as any)
    const request = { binding: exact, processRef: stdio.processRef, mode: 'graceful', cancellation } as any
    expect(await adapter.stop(request)).toEqual({
      status: 'uncertain',
      productResult: { status: 'drained' },
      processDrain: { status: 'drained' },
      transportClosure: 'failed',
      disposition: { required: true, reason: 'stdio_transport_close_unsettled' },
    })
    expect(await adapter.observe({ binding: exact, processRef: stdio.processRef })).toEqual({
      status: 'uncertain',
      disposition: { required: true, reason: 'stdio_transport_close_unsettled' },
    })
    expect(await adapter.stop(request)).toEqual({ status: 'drained' })
    expect(await adapter.observe({ binding: exact, processRef: stdio.processRef })).toEqual({
      status: 'exited',
      outcome: 'drained',
    })
    expect(calls.filter(call => call[0] === 'stop')).toHaveLength(1)
    expect(calls.filter(call => call[0] === 'release')).toHaveLength(1)
    expect(calls.filter(call => call[0] === 'stdio.close')).toHaveLength(2)
    expect(calls.filter(call => call[0] === 'spawner.close')).toHaveLength(1)
  })

  test('retries only the unfinished provider-close phase', async () => {
    let closeAttempts = 0
    const { adapter, calls, stdio } = harness(
      undefined,
      undefined,
      false,
      undefined,
      true,
      1_000,
      {
        closeProviderStdio: () => {
          closeAttempts += 1
          if (closeAttempts === 1) throw new Error('provider transport close failed')
        },
      },
    )
    const exact = binding()
    await adapter.start(exact, cancellation as any)
    const request = { binding: exact, processRef: stdio.processRef, mode: 'graceful', cancellation } as any
    expect(await adapter.stop(request)).toMatchObject({
      status: 'uncertain',
      transportClosure: 'failed',
      disposition: { required: true, reason: 'stdio_transport_close_unsettled' },
    })
    expect(await adapter.stop(request)).toEqual({ status: 'drained' })
    expect(calls.filter(call => call[0] === 'stop')).toHaveLength(1)
    expect(calls.filter(call => call[0] === 'release')).toHaveLength(1)
    expect(calls.filter(call => call[0] === 'stdio.close')).toHaveLength(1)
    expect(calls.filter(call => call[0] === 'spawner.close')).toHaveLength(2)
  })
})
