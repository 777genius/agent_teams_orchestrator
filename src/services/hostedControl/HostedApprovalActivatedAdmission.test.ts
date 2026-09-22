import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmod,
  chown,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  loadHostedApprovalActivatedAdmission,
  type HostedApprovalRetainedActivationSocket,
} from './HostedApprovalActivatedAdmission.js'
import { HostedApprovalActivatablePort } from './HostedApprovalActivatablePort.js'
import type { VerifiedHostedApprovalActivation } from './HostedApprovalRuntimeActivation.js'
import type { HostedApprovalWirePort } from './HostedApprovalWire.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(
  root => rm(root, { recursive: true, force: true }),
)))

describe('C1 verified activated-admission adapter', () => {
  test('projects only the requested team, cross-bound actors, and bare global WAL digest', async () => {
    const harness = await createHarness()
    const otherTeamRoute = harness.activation.globalAdmission.routes[1]!

    expect(harness.activation.globalAdmission.routes).toHaveLength(2)
    expect(harness.admission.routes).toEqual(harness.activation.requestedTeam.routes)
    expect(harness.admission.routes).toHaveLength(1)
    expect(harness.admission.routes).not.toContainEqual(otherTeamRoute)
    expect(harness.admission.actorMembers).toEqual(
      harness.activation.requestedTeam.actorMembers,
    )
    expect(harness.admission.actorMembers[otherTeamRoute.scope.principalId]).toBeUndefined()
    expect(harness.admission.digest).toBe(
      harness.activation.admissionDocumentDigest.slice('sha256:'.length),
    )
    expect(harness.admission.outerAuthority.teamId)
      .toBe(harness.activation.requestedTeam.teamId)
    expect(Object.isFrozen(harness.admission.routes)).toBe(true)
    expect(Object.isFrozen(harness.admission.actorMembers)).toBe(true)
  })

  test('loads during recovery without installing, observing, or effecting a delegate', async () => {
    let observations = 0
    let effects = 0
    const harness = await createHarness({
      delegate: wire({
        claimIngress: async () => { observations += 1; return [] },
        deliverDecision: async () => { effects += 1; return { status: 'delivered' } },
      }),
      install: false,
    })

    expect(harness.port.lifecycle).toEqual({ status: 'recovering', epoch: 1 })
    expect(await harness.admission.isCurrent()).toBe(true)
    expect(await harness.admission.prepareEffectToken()).toBeNull()
    await expect(harness.port.claimIngress({} as never)).rejects.toThrow('unavailable')
    expect(await harness.port.deliverDecision({} as never)).toEqual({ status: 'unavailable' })
    expect(observations).toBe(0)
    expect(effects).toBe(0)
  })

  test('requires exact verified bytes with one LF and accepts exactly 256 KiB', async () => {
    const exact = await createHarness({ activation: await sizedActivation(256 * 1024) })
    expect(await exact.admission.isCurrent()).toBe(true)

    const tooLarge = await activationFile(await sizedActivation(256 * 1024 + 1))
    expect(() => load(tooLarge)).toThrow('256 KiB')

    const noLf = await goldenActivation()
    noLf.canonicalAdmissionDocument = noLf.canonicalAdmissionDocument.slice(0, -1)
    const noLfInput = await activationFile(noLf)
    expect(() => load(noLfInput)).toThrow('exactly one LF')

    const mismatch = await activationFile(await goldenActivation())
    await writeFile(mismatch.path, `${mismatch.activation.canonicalAdmissionDocument} `, {
      mode: 0o600,
    })
    expect(() => load(mismatch)).toThrow('exact private file')
  })

  test('rejects non-0600, non-owner, symlink, and non-regular raw admission paths', async () => {
    let input = await activationFile(await goldenActivation())
    await chmod(input.path, 0o640)
    expect(() => load(input)).toThrow('exact private file')

    input = await activationFile(await goldenActivation())
    if ((process.geteuid?.() ?? process.getuid?.()) === 0) {
      await chown(input.path, 1, 0)
      expect(() => load(input)).toThrow('exact private file')
    }

    input = await activationFile(await goldenActivation())
    const target = `${input.path}.target`
    await rename(input.path, target)
    await symlink(target, input.path)
    expect(() => load(input)).toThrow('unavailable')

    input = await activationFile(await goldenActivation())
    await unlink(input.path)
    await mkdir(input.path)
    expect(() => load(input)).toThrow('exact private file')
  })

  test('isCurrent fails for replacement, removal, byte rotation, mode drift, epoch drift, and socket loss', async () => {
    for (const mutate of [
      async (harness: Harness) => {
        const replacement = `${harness.path}.replacement`
        await writeFile(replacement, harness.activation.canonicalAdmissionDocument, { mode: 0o600 })
        await rename(replacement, harness.path)
      },
      async (harness: Harness) => { await unlink(harness.path) },
      async (harness: Harness) => {
        const raw = Buffer.from(harness.activation.canonicalAdmissionDocument)
        raw[1] = raw[1] === 0x61 ? 0x62 : 0x61
        await writeFile(harness.path, raw, { mode: 0o600 })
      },
      async (harness: Harness) => { await chmod(harness.path, 0o640) },
      async (harness: Harness) => { await harness.port.revoke() },
      async (harness: Harness) => { harness.socket.current = false },
    ]) {
      const harness = await createHarness()
      expect(await harness.admission.isCurrent()).toBe(true)
      await mutate(harness)
      expect(await harness.admission.isCurrent()).toBe(false)
    }
  })

  test('combined effect tokens synchronously reject every drift and are single-use', async () => {
    const current = await createHarness()
    const accepted = await current.admission.prepareEffectToken()
    expect(accepted?.consume()).toBe(true)
    expect(accepted?.consume()).toBe(false)

    for (const mutate of [
      async (harness: Harness) => {
        const replacement = `${harness.path}.replacement`
        await writeFile(replacement, harness.activation.canonicalAdmissionDocument, { mode: 0o600 })
        await rename(replacement, harness.path)
      },
      async (harness: Harness) => { await unlink(harness.path) },
      async (harness: Harness) => {
        const raw = Buffer.from(harness.activation.canonicalAdmissionDocument)
        raw[1] = raw[1] === 0x61 ? 0x62 : 0x61
        await writeFile(harness.path, raw, { mode: 0o600 })
      },
      async (harness: Harness) => { await chmod(harness.path, 0o640) },
      async (harness: Harness) => { await harness.port.revoke() },
      async (harness: Harness) => { harness.socket.generation += 1 },
    ]) {
      const harness = await createHarness()
      const token = await harness.admission.prepareEffectToken()
      expect(token).not.toBeNull()
      await mutate(harness)
      expect(token!.consume()).toBe(false)
      expect(token!.consume()).toBe(false)
    }
  })

  test('rename-away then restore permanently seals the activation epoch', async () => {
    let delegatedEffects = 0
    const harness = await createHarness({
      delegate: wire({
        deliverDecision: async () => {
          delegatedEffects += 1
          return { status: 'delivered' }
        },
      }),
    })
    const token = await harness.admission.prepareEffectToken()
    const away = `${harness.path}.away`

    await rename(harness.path, away)
    // Some hosted filesystems coalesce back-to-back inode timestamp updates.
    // Keep the transient drift observable without weakening the restore case.
    await Bun.sleep(5)
    await rename(away, harness.path)

    expect(await harness.admission.isCurrent()).toBe(false)
    expect(harness.port.lifecycle).toMatchObject({ status: 'revoked', sealed: true })
    expect(harness.guard.isCurrent()).toBe(false)
    expect(token?.consume()).toBe(false)
    expect(await harness.port.deliverDecision({} as never)).toEqual({ status: 'unavailable' })
    expect(delegatedEffects).toBe(0)
  })

  test('mutate bytes then restore permanently seals the activation epoch', async () => {
    const harness = await createHarness()
    const token = await harness.admission.prepareEffectToken()
    const original = Buffer.from(harness.activation.canonicalAdmissionDocument)
    const changed = Buffer.from(original)
    changed[1] = changed[1] === 0x61 ? 0x62 : 0x61

    await writeFile(harness.path, changed, { mode: 0o600 })
    await Bun.sleep(5)
    await writeFile(harness.path, original, { mode: 0o600 })

    expect(await harness.admission.isCurrent()).toBe(false)
    expect(harness.port.lifecycle).toMatchObject({ status: 'revoked', sealed: true })
    expect(harness.guard.isCurrent()).toBe(false)
    expect(token?.consume()).toBe(false)
    expect(await harness.admission.prepareEffectToken()).toBeNull()
  })

  test('fails closed when the retained socket cannot prepare or consume its exact token', async () => {
    const prepareFailure = await createHarness()
    prepareFailure.socket.allowPrepare = false
    expect(await prepareFailure.admission.prepareEffectToken()).toBeNull()

    const consumeFailure = await createHarness()
    const token = await consumeFailure.admission.prepareEffectToken()
    consumeFailure.socket.allowConsume = false
    expect(token?.consume()).toBe(false)

    const thrown = await createHarness()
    const thrownToken = await thrown.admission.prepareEffectToken()
    thrown.socket.throwOnConsume = true
    expect(thrownToken?.consume()).toBe(false)
  })

  test('rejects requested-team actor and route substitution despite verified typing', async () => {
    let input = await activationFile(await goldenActivation())
    input.activation.requestedTeam.actorMembers = Object.freeze({})
    expect(() => load(input)).toThrow('actor cross-binding')

    input = await activationFile(await goldenActivation())
    input.activation.requestedTeam.routes = Object.freeze([
      input.activation.globalAdmission.routes[1]!,
    ])
    expect(() => load(input)).toThrow('requested-team route')
  })
})

type MutableVerifiedActivation = VerifiedHostedApprovalActivation & {
  canonicalAdmissionDocument: string
  requestedTeam: VerifiedHostedApprovalActivation['requestedTeam'] & {
    routes: readonly VerifiedHostedApprovalActivation['requestedTeam']['routes'][number][]
    actorMembers: Readonly<Record<string, string>>
  }
}

type Harness = Awaited<ReturnType<typeof createHarness>>

async function createHarness(options: {
  activation?: MutableVerifiedActivation
  delegate?: HostedApprovalWirePort
  install?: boolean
} = {}) {
  const input = await activationFile(options.activation ?? await goldenActivation())
  const admission = load(input)
  const delegate = options.delegate ?? wire()
  if (options.install !== false) input.guard.install(delegate)
  return { ...input, admission, delegate }
}

async function activationFile(activation: MutableVerifiedActivation) {
  const root = await mkdtemp(join(tmpdir(), 'activated-admission-'))
  roots.push(root)
  const path = join(root, 'admission.json')
  await writeFile(path, activation.canonicalAdmissionDocument, { mode: 0o600 })
  const port = new HostedApprovalActivatablePort()
  const guard = port.beginRecovery()
  const socket = new TestActivationSocket()
  return { root, path, activation, port, guard, socket }
}

function load(input: Awaited<ReturnType<typeof activationFile>>) {
  return loadHostedApprovalActivatedAdmission({
    activation: input.activation,
    rawAdmissionPath: input.path,
    activationGuard: input.guard,
    activationSocket: input.socket,
  })
}

class TestActivationSocket implements HostedApprovalRetainedActivationSocket {
  current = true
  generation = 1
  allowPrepare = true
  allowConsume = true
  throwOnConsume = false

  isCurrent(): boolean { return this.current }

  prepareEffectToken() {
    if (!this.current || !this.allowPrepare) return null
    const generation = this.generation
    let consumed = false
    return {
      consume: () => {
        if (this.throwOnConsume) throw new Error('socket descriptor failed')
        if (consumed) return false
        consumed = true
        return this.current && this.allowConsume && this.generation === generation
      },
    }
  }
}

async function goldenActivation(): Promise<MutableVerifiedActivation> {
  const fixture = JSON.parse(await readFile(new URL(
    './fixtures/hosted-approval-activation-v2-golden.json',
    import.meta.url,
  ), 'utf8'))
  const globalAdmission = JSON.parse(fixture.admissionDocument)
  const routes = globalAdmission.routes.filter(
    (route: any) => route.authority.teamId === fixture.binding.teamId,
  )
  const actorMembers = Object.fromEntries(routes.map((route: any) => [
    route.scope.principalId,
    globalAdmission.actorMembers[route.scope.principalId],
  ]))
  return {
    schemaVersion: 2,
    binding: fixture.binding,
    canonicalAdmissionDocument: fixture.admissionDocument,
    admissionDocumentDigest: fixture.binding.admissionDocumentDigest,
    activationDigest: fixture.publication.activationDigest,
    globalAdmission,
    requestedTeam: {
      teamId: fixture.binding.teamId,
      admissionGeneration: globalAdmission.admissionGeneration,
      approvalDigest: fixture.binding.approvalDigest,
      globalAdmissionDigest: fixture.binding.admissionDocumentDigest,
      routes,
      actorMembers,
    },
  }
}

async function sizedActivation(size: number): Promise<MutableVerifiedActivation> {
  const activation = await goldenActivation()
  const source = `"${'a'.repeat(size - 3)}"\n`
  const digest = `sha256:${createHash('sha256').update(source).digest('hex')}` as const
  activation.canonicalAdmissionDocument = source
  activation.admissionDocumentDigest = digest
  activation.binding = { ...activation.binding, admissionDocumentDigest: digest }
  activation.requestedTeam = {
    ...activation.requestedTeam,
    globalAdmissionDigest: digest,
  }
  return activation
}

function wire(overrides: Partial<HostedApprovalWirePort> = {}): HostedApprovalWirePort {
  return {
    claimIngress: async () => [],
    acknowledgeIngress: async () => ({ status: 'unavailable' }),
    getAdmittedIngressAuthority: async () => null,
    resolveIngressAuthority: async () => ({ status: 'unavailable' }),
    authorizeDecision: async () => ({ status: 'unavailable' }),
    deliverDecision: async () => ({ status: 'unavailable' }),
    reconcileDecision: async () => ({ status: 'unavailable' }),
    ...overrides,
  }
}
