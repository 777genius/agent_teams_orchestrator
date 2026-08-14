import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { fingerprintHostedApprovalDelivery, type HostedApprovalDeliveryRequest } from './HostedApprovalWire.js'
import { HostedApprovalOwnerService } from './HostedApprovalOwnerService.js'
import { HostedApprovalOwnerStore } from './HostedApprovalOwnerStore.js'
import { HostedApprovalOwnerWal } from './HostedApprovalOwnerWal.js'
import type { HostedApprovalRuntimeAdmission, HostedApprovalRuntimeRoute } from './HostedApprovalRuntimeAdmission.js'
import type {
  HostedApprovalObservedPermission,
  OpenCodeHostedApprovalRuntimeAdapter,
} from './OpenCodeHostedApprovalRuntimeAdapter.js'

const teamId = `team_${'1'.repeat(32)}`
const runId = `run_${'2'.repeat(32)}`
const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

async function fixture(
  overrides: {
    current?: () => boolean
    deliver?: (
      input: Parameters<OpenCodeHostedApprovalRuntimeAdapter['deliver']>[0],
    ) =>
      | 'delivered'
      | 'not_started'
      | 'unavailable'
      | 'ambiguous'
      | Promise<'delivered' | 'not_started' | 'unavailable' | 'ambiguous'>
    observe?: () => readonly HostedApprovalObservedPermission[]
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'approval-owner-r2-'))
  roots.push(root)
  const route = makeRoute()
  let admissionCurrent = true
  const admission: HostedApprovalRuntimeAdmission = {
    schemaVersion: 1,
    admissionGeneration: 'approval-admission-generation_test',
    outerAuthority: {
      deploymentId: 'deployment_test',
      bootId: 'boot_test',
      workspaceId: `workspace_${'3'.repeat(32)}`,
      teamId,
      restoreGeneration: 1,
      mountBinding: { mountGeneration: 1, declaredRootHash: 'b'.repeat(64) },
    },
    routes: [route],
    actorMembers: {
      actor_owner: route.authority.deliveryOwnerId,
      actor_operator: `member_${'8'.repeat(32)}`,
      actor_self: route.authority.deliveryOwnerId,
    },
    digest: 'a'.repeat(64),
    isCurrent: async () => admissionCurrent,
    prepareEffectToken: async () => ({ consume: () => admissionCurrent }),
  }
  let rawPermission: Record<string, unknown> = {
    requestID: 'permission_1',
    sessionID: route.authority.sessionId,
    tool: 'bash',
    title: 'Run tests',
  }
  const observed = (): HostedApprovalObservedPermission[] => [
    {
      route,
      observedAtIso: '2026-08-13T10:00:00.000Z',
      permission: {
        requestId: 'permission_1',
        sessionId: route.authority.sessionId,
        tool: 'bash',
        title: 'Run tests',
        kind: 'tool',
        raw: rawPermission,
      },
    },
  ]
  const runtime = {
    observe: async () => overrides.observe?.() ?? observed(),
    deliver: async (input: Parameters<OpenCodeHostedApprovalRuntimeAdapter['deliver']>[0]) =>
      (await overrides.deliver?.(input)) ?? 'delivered',
  } as unknown as OpenCodeHostedApprovalRuntimeAdapter
  const store = new HostedApprovalOwnerStore(new HostedApprovalOwnerWal(join(root, 'owner.json')), () =>
    Date.parse('2026-08-13T10:00:01.000Z'),
  )
  const service = new HostedApprovalOwnerService({
    store,
    admission,
    runtime,
    isCurrentOuterAuthority: async () => overrides.current?.() ?? true,
    now: () => Date.parse('2026-08-13T10:00:01.000Z'),
    createToken: () => 'token',
  })
  await service.recoverStateOnly()
  return {
    service,
    store,
    admission,
    route,
    runtime,
    revoke: () => {
      admissionCurrent = false
    },
    replaceRawPermission: (raw: Record<string, unknown>) => {
      rawPermission = raw
    },
  }
}

describe('HostedApprovalOwnerService R2', () => {
  test('dynamically polls and atomically admits exact pending permissions before claim', async () => {
    const { service } = await fixture()
    const records = await service.claimIngress({
      request: {
        ownerId: 'owner_1',
        leaseToken: 'lease_1',
        leaseDurationMs: 30_000,
        limit: 10,
      },
      maximumAggregateBytes: 1_000_000,
    })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      commandId: 'permission_1',
      authority: { runId, teamId },
    })
  })

  test('fails a permission-list outage closed instead of treating it as empty', async () => {
    const { service } = await fixture({
      observe: () => {
        throw new Error('list failed')
      },
    })
    await expect(
      service.claimIngress({
        request: {
          ownerId: 'owner_1',
          leaseToken: 'lease_1',
          leaseDurationMs: 30_000,
          limit: 1,
        },
        maximumAggregateBytes: 1000,
      }),
    ).rejects.toThrow('list failed')
  })

  test('startup recovery is state-only and never probes or affects the provider', async () => {
    let providerCalls = 0
    const root = await mkdtemp(join(tmpdir(), 'approval-owner-r2-recovery-'))
    roots.push(root)
    const route = makeRoute()
    const admission: HostedApprovalRuntimeAdmission = {
      schemaVersion: 1,
      admissionGeneration: 'approval-admission-generation_recovery',
      outerAuthority: {
        deploymentId: 'deployment_test',
        bootId: 'boot_test',
        workspaceId: `workspace_${'3'.repeat(32)}`,
        teamId,
        restoreGeneration: 1,
        mountBinding: { mountGeneration: 1, declaredRootHash: 'b'.repeat(64) },
      },
      routes: [route],
      actorMembers: { actor_owner: route.authority.deliveryOwnerId },
      digest: 'b'.repeat(64),
      isCurrent: async () => true,
      prepareEffectToken: async () => ({ consume: () => true }),
    }
    const runtime = {
      observe: async () => {
        providerCalls += 1
        return []
      },
      deliver: async () => {
        providerCalls += 1
        return 'delivered'
      },
    } as unknown as OpenCodeHostedApprovalRuntimeAdapter
    const service = new HostedApprovalOwnerService({
      store: new HostedApprovalOwnerStore(new HostedApprovalOwnerWal(join(root, 'owner.json'))),
      admission,
      runtime,
      isCurrentOuterAuthority: async () => true,
    })
    await service.recoverStateOnly()
    expect(providerCalls).toBe(0)
  })

  test('revalidates admission immediately before effect and performs no provider call after revocation', async () => {
    let effects = 0
    const fx = await fixture({
      deliver: () => {
        effects += 1
        return 'delivered'
      },
    })
    const record = (
      await fx.service.claimIngress({
        request: {
          ownerId: 'o',
          leaseToken: 'l',
          leaseDurationMs: 30_000,
          limit: 1,
        },
        maximumAggregateBytes: 1_000_000,
      })
    )[0]!
    const request = delivery(record)
    const fingerprint = fingerprintHostedApprovalDelivery(request)
    const auth = await fx.service.authorizeDecision({
      request,
      payloadFingerprint: fingerprint,
    })
    expect(auth.status).toBe('authorized')
    fx.revoke()
    if (auth.status === 'authorized')
      expect(
        await fx.service.deliverDecision({
          request,
          payloadFingerprint: fingerprint,
          authorization: auth.authorization,
          admittedAuthority: record.authority,
        }),
      ).toEqual({ status: 'unavailable' })
    expect(effects).toBe(0)
  })

  test('fence replacement after durable started fails closed at the final provider edge', async () => {
    let effects = 0
    const fx = await fixture({ deliver: async input => {
      const replacement = `${fx.store.wal.fencePath}.replacement`
      await writeFile(replacement, '', { mode: 0o600 }); await rename(replacement, fx.store.wal.fencePath)
      if (!(await input.revalidate())) return 'not_started'
      effects += 1; return 'delivered'
    } })
    const [record] = await fx.service.claimIngress({ request: { ownerId: 'o', leaseToken: 'l', leaseDurationMs: 30_000, limit: 1 }, maximumAggregateBytes: 1_000_000 })
    const request = delivery(record!); const fingerprint = fingerprintHostedApprovalDelivery(request)
    const auth = await fx.service.authorizeDecision({ request, payloadFingerprint: fingerprint })
    expect(auth.status).toBe('authorized')
    if (auth.status === 'authorized') {
      await expect(fx.service.deliverDecision({ request, payloadFingerprint: fingerprint,
        authorization: auth.authorization, admittedAuthority: record!.authority })).resolves.toEqual({
          status: 'operator_required', reconciliationRef: request.reconciliationRef,
        })
    }
    expect(effects).toBe(0)
    const persisted = await fx.store.read()
    expect(persisted?.deliveries).toMatchObject([{ phase: 'started', result: null }])
    expect(await fx.service.authorizeDecision({ request, payloadFingerprint: fingerprint })).toEqual({
      status: 'operator_required', reconciliationRef: request.reconciliationRef,
    })
  })

  test('SIGKILL after the service effect edge leaves durable started and the replacement performs zero provider effects', async () => {
    const fx = await fixture()
    const [record] = await fx.service.claimIngress({
      request: { ownerId: 'o', leaseToken: 'l', leaseDurationMs: 30_000, limit: 1 },
      maximumAggregateBytes: 1_000_000,
    })
    const request = delivery(record!)
    const root = join(fx.store.wal.path, '..')
    const effects = join(root, 'provider-effects')
    const entered = join(root, 'provider-effect-durable')
    const outcome = join(root, 'replacement-outcome.json')
    const input = join(root, 'service-crash-input.json')
    const processScript = join(root, 'service-crash-owner.ts')
    await writeFile(input, JSON.stringify({
      walPath: fx.store.wal.path,
      route: fx.route,
      request,
      admittedAuthority: record!.authority,
      effects,
      entered,
      outcome,
    }))

    const serviceUrl = pathToFileURL(resolve('src/services/hostedControl/HostedApprovalOwnerService.ts')).href
    const storeUrl = pathToFileURL(resolve('src/services/hostedControl/HostedApprovalOwnerStore.ts')).href
    const walUrl = pathToFileURL(resolve('src/services/hostedControl/HostedApprovalOwnerWal.ts')).href
    const wireUrl = pathToFileURL(resolve('src/services/hostedControl/HostedApprovalWire.ts')).href
    await writeFile(processScript, `
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { HostedApprovalOwnerService } from ${JSON.stringify(serviceUrl)}
import { HostedApprovalOwnerStore } from ${JSON.stringify(storeUrl)}
import { HostedApprovalOwnerWal } from ${JSON.stringify(walUrl)}
import { fingerprintHostedApprovalDelivery } from ${JSON.stringify(wireUrl)}

const mode = process.argv[2]
const fixture = JSON.parse(await readFile(process.argv[3], 'utf8'))
const admission = {
  schemaVersion: 1,
  admissionGeneration: 'approval-admission-generation_test',
  outerAuthority: {
    deploymentId: 'deployment_test', bootId: 'boot_test',
    workspaceId: ${JSON.stringify(`workspace_${'3'.repeat(32)}`)},
    teamId: ${JSON.stringify(teamId)}, restoreGeneration: 1,
    mountBinding: { mountGeneration: 1, declaredRootHash: '${'b'.repeat(64)}' },
  },
  routes: [fixture.route],
  actorMembers: {
    actor_owner: fixture.route.authority.deliveryOwnerId,
    actor_operator: ${JSON.stringify(`member_${'8'.repeat(32)}`)},
    actor_self: fixture.route.authority.deliveryOwnerId,
  },
  digest: '${'a'.repeat(64)}',
  isCurrent: async () => true,
  prepareEffectToken: async () => ({ consume: () => true }),
}
let providerCalls = 0
const runtime = {
  observe: async () => [],
  deliver: async input => {
    providerCalls += 1
    if (mode === 'effect') {
      if (!(await input.revalidate())) return 'not_started'
      const token = await input.prepareEffectToken?.()
      if (!token || !token.consume()) return 'not_started'
      // Model provider invocation synchronously at the consumed effect-token
      // edge, and fsync it before exposing the kill point to the parent.
      const fd = openSync(fixture.effects, 'a', 0o600)
      try { writeSync(fd, 'provider-effect\\n'); fsyncSync(fd) } finally { closeSync(fd) }
      await writeFile(fixture.entered, 'durable')
      await new Promise(() => {})
    }
    await appendFile(fixture.effects, 'replacement-provider-effect\\n')
    return 'delivered'
  },
}
const service = new HostedApprovalOwnerService({
  store: new HostedApprovalOwnerStore(new HostedApprovalOwnerWal(fixture.walPath)),
  admission,
  runtime,
  isCurrentOuterAuthority: async () => true,
  now: () => Date.parse('2026-08-13T10:00:01.000Z'),
  createToken: () => mode,
})
await service.recoverStateOnly()
const payloadFingerprint = fingerprintHostedApprovalDelivery(fixture.request)
const authorization = await service.authorizeDecision({ request: fixture.request, payloadFingerprint })
let result = authorization
if (authorization.status === 'authorized') {
  result = await service.deliverDecision({
    request: fixture.request, payloadFingerprint,
    authorization: authorization.authorization,
    admittedAuthority: fixture.admittedAuthority,
  })
}
if (mode === 'replacement') {
  await writeFile(fixture.outcome, JSON.stringify({ result, providerCalls }))
}
`)

    const crashed = Bun.spawn({
      cmd: [process.execPath, processScript, 'effect', input],
      stdout: 'ignore',
      stderr: 'pipe',
    })
    try {
      const deadline = Date.now() + 5_000
      while (!await Bun.file(entered).exists()) {
        if (crashed.exitCode !== null || Date.now() >= deadline) {
          throw new Error('Effect owner did not reach its durable provider boundary')
        }
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      crashed.kill('SIGKILL')
      expect(await crashed.exited).not.toBe(0)
    } finally {
      if (crashed.exitCode === null) {
        crashed.kill('SIGKILL')
        await crashed.exited
      }
    }

    const replacement = Bun.spawn({
      cmd: [process.execPath, processScript, 'replacement', input],
      stdout: 'ignore',
      stderr: 'pipe',
    })
    const replacementExit = await replacement.exited
    if (replacementExit !== 0) {
      throw new Error(`Replacement owner failed: ${await new Response(replacement.stderr).text()}`)
    }
    expect(JSON.parse(await readFile(outcome, 'utf8'))).toEqual({
      result: { status: 'operator_required', reconciliationRef: request.reconciliationRef },
      providerCalls: 0,
    })
    expect((await readFile(effects, 'utf8')).trim().split('\n')).toEqual(['provider-effect'])
    expect(await fx.store.read()).toMatchObject({
      deliveries: [{ phase: 'started', result: null }],
    })
  }, 15_000)

  test('distinguishes not_started terminal rejection from ambiguous operator_required and restart replay', async () => {
    for (const [effect, status] of [
      ['not_started', 'stale_generation'],
      ['unavailable', 'unavailable'],
      ['ambiguous', 'operator_required'],
    ] as const) {
      const fx = await fixture({ deliver: () => effect })
      const record = (
        await fx.service.claimIngress({
          request: {
            ownerId: 'o',
            leaseToken: 'l',
            leaseDurationMs: 30_000,
            limit: 1,
          },
          maximumAggregateBytes: 1_000_000,
        })
      )[0]!
      const request = delivery(record)
      const expected = status === 'operator_required'
        ? { status, reconciliationRef: request.reconciliationRef }
        : { status }
      expect(await runDelivery(fx.service, request, record.authority)).toEqual(expected)
      expect(
        await fx.service.authorizeDecision({
          request,
          payloadFingerprint: fingerprintHostedApprovalDelivery(request),
        }),
      ).toEqual(expected)
    }
  })

  test('reconciles durable evidence without repeating the provider effect', async () => {
    for (const [effect, expected] of [
      ['delivered', 'delivered'],
      ['not_started', 'not_delivered'],
      ['ambiguous', 'operator_required'],
      ['unavailable', 'not_delivered'],
    ] as const) {
      let providerCalls = 0
      const fx = await fixture({ deliver: () => { providerCalls += 1; return effect } })
      const record = (await fx.service.claimIngress({
        request: { ownerId: 'o', leaseToken: 'l', leaseDurationMs: 30_000, limit: 1 },
        maximumAggregateBytes: 1_000_000,
      }))[0]!
      const request = delivery(record)
      await runDelivery(fx.service, request, record.authority)
      expect(providerCalls).toBe(1)
      expect(await fx.service.reconcileDecision({
        reconciliationRef: request.reconciliationRef,
        providerDeliveryId: request.providerDeliveryId,
        partition: request.partition,
      })).toEqual({ status: expected })
      expect(providerCalls).toBe(1)
    }
  })

  test('returns unavailable for missing, mismatched, or stale reconciliation identity', async () => {
    const fx = await fixture({ deliver: () => 'ambiguous' })
    const record = (await fx.service.claimIngress({
      request: { ownerId: 'o', leaseToken: 'l', leaseDurationMs: 30_000, limit: 1 },
      maximumAggregateBytes: 1_000_000,
    }))[0]!
    const request = delivery(record)
    await runDelivery(fx.service, request, record.authority)
    await expect(fx.service.reconcileDecision({
      reconciliationRef: `approval-reconciliation_${'9'.repeat(64)}`,
      providerDeliveryId: request.providerDeliveryId,
      partition: request.partition,
    })).resolves.toEqual({ status: 'unavailable' })
    fx.revoke()
    await expect(fx.service.reconcileDecision({
      reconciliationRef: request.reconciliationRef,
      providerDeliveryId: request.providerDeliveryId,
      partition: request.partition,
    })).resolves.toEqual({ status: 'unavailable' })
  })

  test('maps identity-snapshot read failures to unavailable during external-writer revalidation', async () => {
    const fx = await fixture()
    const [record] = await fx.service.claimIngress({
      request: { ownerId: 'o', leaseToken: 'l', leaseDurationMs: 30_000, limit: 1 },
      maximumAggregateBytes: 1_000_000,
    })
    const request = delivery(record!)
    fx.store.read = async () => { throw new Error('external writer replaced identity snapshot') }
    await expect(fx.service.getAdmittedIngressAuthority(record!.authority)).resolves.toBeNull()
    await expect(fx.service.resolveIngressAuthority(record!.authority))
      .resolves.toEqual({ status: 'unavailable' })
    await expect(fx.service.authorizeDecision({
      request,
      payloadFingerprint: fingerprintHostedApprovalDelivery(request),
    })).resolves.toEqual({ status: 'unavailable' })
  })

  test('fences acknowledged replay by exact generation owner and token', async () => {
    const { service } = await fixture()
    const [record] = await service.claimIngress({
      request: {
        ownerId: 'owner_1',
        leaseToken: 'lease_1',
        leaseDurationMs: 30_000,
        limit: 1,
      },
      maximumAggregateBytes: 1_000_000,
    })
    const ack = {
      outboxId: record!.outboxId,
      generation: record!.lease!.generation,
      ownerId: 'owner_1',
      leaseToken: 'lease_1',
    }
    expect(await service.acknowledgeIngress(ack)).toEqual({
      status: 'acknowledged',
    })
    expect(await service.acknowledgeIngress(ack)).toEqual({
      status: 'already_acknowledged',
    })
    expect(
      await service.acknowledgeIngress({
        ...ack,
        generation: ack.generation + 1,
      }),
    ).toEqual({ status: 'conflict' })
  })

  test('stops an ordered claim prefix at a blocked or oversized earlier record', async () => {
    const fx = await fixture()
    await fx.service.pollIngress()
    await fx.store.claim(
      {
        ownerId: 'owner_a',
        leaseToken: 'lease_a',
        leaseDurationMs: 30_000,
        limit: 1,
      },
      1_000_000,
    )
    const claimed = await fx.store.claim(
      {
        ownerId: 'owner_b',
        leaseToken: 'lease_b',
        leaseDurationMs: 30_000,
        limit: 100,
      },
      1_000_000,
    )
    expect(claimed).toEqual([])
  })

  test('reconciles rotated same-session authority as revoked instead of leaving it claimable', async () => {
    const fx = await fixture()
    await fx.service.pollIngress()
    const rotatedRoute = {
      ...fx.route,
      authority: {
        ...fx.route.authority,
        credentialGeneration: fx.route.authority.credentialGeneration + 1,
      },
      openCodeBinding: {
        ...fx.route.openCodeBinding,
        credentialGeneration: fx.route.authority.credentialGeneration + 1,
      },
    }
    const rotated: HostedApprovalRuntimeAdmission = {
      ...fx.admission,
      admissionGeneration: 'approval-admission-generation_rotated',
      digest: 'c'.repeat(64),
      routes: [rotatedRoute],
      isCurrent: async () => true,
    }
    await fx.store.reconcileAdmission(rotated)
    const state = await fx.store.read()
    expect(state?.ingress).toEqual([])
    expect(state?.retiredIngress).toEqual([])
  })

  test('revokes a same-authority route whose scope or member binding rotates', async () => {
    const fx = await fixture()
    await fx.service.pollIngress()
    const rotatedRoute = { ...fx.route, memberName: 'replacement-worker' }
    const rotated: HostedApprovalRuntimeAdmission = {
      ...fx.admission,
      admissionGeneration: 'approval-admission-generation_member-rotated',
      digest: 'd'.repeat(64),
      routes: [rotatedRoute],
      isCurrent: async () => true,
    }
    await fx.store.reconcileAdmission(rotated)
    expect((await fx.store.read())?.ingress).toEqual([])
  })

  test('rejects alternate provider delivery IDs for delivered and ambiguous immutable effects', async () => {
    for (const result of ['delivered', 'ambiguous'] as const) {
      let effects = 0
      const fx = await fixture({
        deliver: () => {
          effects += 1
          return result
        },
      })
      const [record] = await fx.service.claimIngress({
        request: {
          ownerId: 'o',
          leaseToken: 'l',
          leaseDurationMs: 30_000,
          limit: 1,
        },
        maximumAggregateBytes: 1_000_000,
      })
      const request = delivery(record!)
      await runDelivery(fx.service, request, record!.authority)
      const alternate = { ...request, providerDeliveryId: 'delivery_2' }
      expect(
        await fx.service.authorizeDecision({
          request: alternate,
          payloadFingerprint: fingerprintHostedApprovalDelivery(alternate),
        }),
      ).toEqual({ status: 'conflict' })
      expect(effects).toBe(1)
    }
  })

  test('does not answer a reused request ID after the provider permission incarnation changes', async () => {
    let effects = 0
    const fx = await fixture({
      deliver: () => {
        effects += 1
        return 'delivered'
      },
    })
    const [first] = await fx.service.claimIngress({
      request: {
        ownerId: 'o',
        leaseToken: 'l',
        leaseDurationMs: 30_000,
        limit: 1,
      },
      maximumAggregateBytes: 1_000_000,
    })
    await runDelivery(fx.service, delivery(first!), first!.authority)
    fx.replaceRawPermission({
      requestID: 'permission_1',
      sessionID: fx.route.authority.sessionId,
      tool: 'bash',
      permission: 'write',
    })
    expect(await fx.service.pollIngress()).toBe(1)
    const state = await fx.store.read()
    const second = state!.ingress.find(record => record.outboxId !== first!.outboxId)!
    const request = { ...delivery(second), providerDeliveryId: 'delivery_2' }
    expect(
      await fx.service.authorizeDecision({
        request,
        payloadFingerprint: fingerprintHostedApprovalDelivery(request),
      }),
    ).toEqual({ status: 'conflict' })
    expect(effects).toBe(1)
  })

  test('performs zero effects after exact plan credential runtime or owner rotation with the same run and session', async () => {
    for (const rotate of [
      (route: HostedApprovalRuntimeRoute) => ({
        ...route,
        authority: {
          ...route.authority,
          planGeneration: route.authority.planGeneration + 1,
        },
        openCodeBinding: {
          ...route.openCodeBinding,
          planGeneration: route.authority.planGeneration + 1,
        },
      }),
      (route: HostedApprovalRuntimeRoute) => ({
        ...route,
        authority: {
          ...route.authority,
          credentialGeneration: route.authority.credentialGeneration + 1,
        },
        openCodeBinding: {
          ...route.openCodeBinding,
          credentialGeneration: route.authority.credentialGeneration + 1,
        },
      }),
      (route: HostedApprovalRuntimeRoute) => ({
        ...route,
        authority: { ...route.authority, credentialId: 'credential_2' },
        openCodeBinding: {
          ...route.openCodeBinding,
          credentialId: 'credential_2',
        },
      }),
      (route: HostedApprovalRuntimeRoute) => ({
        ...route,
        authority: { ...route.authority, runtimeInstanceId: 'runtime_2' },
        openCodeBinding: {
          ...route.openCodeBinding,
          runtimeInstanceId: 'runtime_2',
        },
      }),
      (route: HostedApprovalRuntimeRoute) => ({
        ...route,
        authority: {
          ...route.authority,
          deliveryOwnerId: `member_${'5'.repeat(32)}`,
        },
        openCodeBinding: {
          ...route.openCodeBinding,
          deliveryOwnerId: `member_${'5'.repeat(32)}`,
        },
      }),
    ]) {
      let effects = 0
      const fx = await fixture({
        deliver: () => {
          effects += 1
          return 'delivered'
        },
      })
      const [record] = await fx.service.claimIngress({
        request: {
          ownerId: 'o',
          leaseToken: 'l',
          leaseDurationMs: 30_000,
          limit: 1,
        },
        maximumAggregateBytes: 1_000_000,
      })
      const request = delivery(record!)
      const fingerprint = fingerprintHostedApprovalDelivery(request)
      const auth = await fx.service.authorizeDecision({
        request,
        payloadFingerprint: fingerprint,
      })
      ;(fx.admission.routes as HostedApprovalRuntimeRoute[])[0] = rotate(fx.route)
      if (auth.status === 'authorized') {
        expect(
          await fx.service.deliverDecision({
            request,
            payloadFingerprint: fingerprint,
            authorization: auth.authorization,
            admittedAuthority: record!.authority,
          }),
        ).toEqual({ status: 'stale_generation' })
      }
      expect(effects).toBe(0)
    }
  })
})

async function runDelivery(
  service: HostedApprovalOwnerService,
  request: HostedApprovalDeliveryRequest,
  authority: HostedApprovalRuntimeRoute['authority'],
) {
  const payloadFingerprint = fingerprintHostedApprovalDelivery(request)
  const auth = await service.authorizeDecision({ request, payloadFingerprint })
  if (auth.status !== 'authorized') return auth
  return service.deliverDecision({
    request,
    payloadFingerprint,
    authorization: auth.authorization,
    admittedAuthority: authority,
  })
}
function delivery(record: {
  deliveryRef: string
  commandId: string
  effectRef: string
}): HostedApprovalDeliveryRequest {
  const approvalId = `approval_${createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 1,
        teamId,
        runId,
        requestId: record.commandId,
      }),
    )
    .digest('hex')
    .slice(0, 32)}`
  return {
    providerDeliveryId: 'delivery_1',
    reconciliationRef: `approval-reconciliation_${'4'.repeat(64)}`,
    principal: { kind: 'operator', actorId: 'actor_operator' },
    deliveryRef: record.deliveryRef,
    approvalId,
    approvalGeneration: `generation_runtime-permission-${record.effectRef.slice(7)}`,
    decision: 'allow',
    partition: { teamId, runId },
    requestId: record.commandId,
  }
}
function makeRoute(): HostedApprovalRuntimeRoute {
  return {
    routeId: 'route_1',
    memberName: 'worker',
    authority: {
      deploymentId: 'deployment_test',
      teamId,
      runId,
      planGeneration: 3,
      laneId: 'secondary:opencode:worker',
      providerId: 'opencode',
      credentialGeneration: 4,
      credentialId: 'credential_1',
      sessionId: 'session_1',
      runtimeInstanceId: 'runtime_1',
      deliveryOwnerId: `member_${'4'.repeat(32)}`,
    },
    scope: {
      principalId: 'actor_owner',
      workspaceId: `workspace_${'3'.repeat(32)}`,
      teamId,
      authorityGeneration: 'generation_1',
      restoreGeneration: 1,
    },
    openCodeBinding: {
      toolApprovalMode: 'manual',
      planGeneration: 3,
      credentialGeneration: 4,
      credentialId: 'credential_1',
      runtimeInstanceId: 'runtime_1',
      deliveryOwnerId: `member_${'4'.repeat(32)}`,
      sessionRecordFingerprint: 'a'.repeat(64),
      liveEffectFingerprint: 'b'.repeat(64),
    },
  }
}
