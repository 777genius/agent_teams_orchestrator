import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PrivateFileHostedApprovalRuntimeAdmissionStore } from './HostedApprovalRuntimeAdmission.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))
const teamId = `team_${'1'.repeat(32)}`
const authority = {
  deploymentId: 'deployment_1',
  bootId: 'boot_1',
  restoreGeneration: 1,
  workspaceId: `workspace_${'3'.repeat(32)}`,
  teamId,
  mountBinding: { mountGeneration: 1, declaredRootHash: 'a'.repeat(64) },
}

describe('PrivateFileHostedApprovalRuntimeAdmissionStore R2', () => {
  test('deep-decodes exact nested fields and rejects route-authority substitution', async () => {
    const { path } = await file(snapshot())
    await expect(new PrivateFileHostedApprovalRuntimeAdmissionStore(path).load(authority)).resolves.toMatchObject({
      routes: [{ authority: { sessionId: 'session_1' } }],
    })
    const changed = snapshot()
    changed.actorMembers.actor_owner = `member_${'9'.repeat(32)}`
    await writeFile(path, JSON.stringify(changed), { mode: 0o600 })
    await expect(new PrivateFileHostedApprovalRuntimeAdmissionStore(path).load(authority)).rejects.toThrow(
      'cross-binding',
    )
    const extra = snapshot() as unknown as {
      routes: Array<Record<string, unknown>>
    }
    extra.routes[0]!.extra = true
    await writeFile(path, JSON.stringify(extra), { mode: 0o600 })
    await expect(new PrivateFileHostedApprovalRuntimeAdmissionStore(path).load(authority)).rejects.toThrow('keys')
  })

  test('raw digest is a replacement fence and actor mappings are explicit canonical MemberIds', async () => {
    const { path } = await file(snapshot())
    const loaded = await new PrivateFileHostedApprovalRuntimeAdmissionStore(path).load(authority)
    expect(await loaded.isCurrent()).toBe(true)
    const replacement = snapshot()
    replacement.actorMembers.actor_operator = `member_${'7'.repeat(32)}`
    await writeFile(path, JSON.stringify(replacement), { mode: 0o600 })
    expect(await loaded.isCurrent()).toBe(false)
    const invalidActors = replacement as unknown as {
      actorMembers: Record<string, string>
    }
    invalidActors.actorMembers.actor_bad = 'worker'
    await writeFile(path, JSON.stringify(invalidActors), { mode: 0o600 })
    await expect(new PrivateFileHostedApprovalRuntimeAdmissionStore(path).load(authority)).rejects.toThrow(
      'actor mapping',
    )
  })

  test('rejects outer boot incarnation drift', async () => {
    const changed = snapshot()
    changed.outerAuthority.bootId = 'boot_replaced'
    const { path } = await file(changed)
    await expect(new PrivateFileHostedApprovalRuntimeAdmissionStore(path).load(authority)).rejects.toThrow(
      'outer authority mismatch',
    )
  })

  test('rejects outer mount generation and declared-root drift', async () => {
    for (const mountBinding of [
      {
        ...authority.mountBinding,
        mountGeneration: authority.mountBinding.mountGeneration + 1,
      },
      { ...authority.mountBinding, declaredRootHash: 'b'.repeat(64) },
    ]) {
      const value = snapshot()
      value.outerAuthority.mountBinding = mountBinding
      const { path } = await file(value)
      await expect(new PrivateFileHostedApprovalRuntimeAdmissionStore(path).load(authority)).rejects.toThrow(
        'outer authority mismatch',
      )
    }
  })

  test('admits only manual approval-mode routes', async () => {
    const invalid = snapshot()
    invalid.routes[0]!.openCodeBinding.toolApprovalMode = 'auto' as never
    const { path } = await file(invalid)
    await expect(new PrivateFileHostedApprovalRuntimeAdmissionStore(path).load(authority))
      .rejects.toThrow('OpenCode binding')
  })

  test('requires the exact lowercase sha256 OpenCode artifact binding', async () => {
    const missing = snapshot() as unknown as {
      routes: Array<{ openCodeBinding: Record<string, unknown> }>
    }
    delete missing.routes[0]!.openCodeBinding.openCodeArtifactDigest
    let input = await file(missing)
    await expect(new PrivateFileHostedApprovalRuntimeAdmissionStore(input.path).load(authority))
      .rejects.toThrow('OpenCode binding keys')

    for (const digest of [
      '033c9c6f4f73e6d84a10c6edc3ab84e5aad078bf5c75f005721e1e94e85b8a02',
      `sha256:${'A'.repeat(64)}`,
      `sha256:${'a'.repeat(63)}`,
      `sha512:${'a'.repeat(64)}`,
    ]) {
      const malformed = snapshot()
      malformed.routes[0]!.openCodeBinding.openCodeArtifactDigest = digest as `sha256:${string}`
      input = await file(malformed)
      await expect(new PrivateFileHostedApprovalRuntimeAdmissionStore(input.path).load(authority))
        .rejects.toThrow('OpenCode binding')
    }
  })

  test('effect token rejects an admission inode replacement at consume edge', async () => {
    const { path } = await file(snapshot())
    const admission = await new PrivateFileHostedApprovalRuntimeAdmissionStore(path).load(authority)
    const token = await admission.prepareEffectToken()
    expect(token).not.toBeNull()
    const replacement = `${path}.replacement`
    await writeFile(replacement, JSON.stringify(snapshot()), { mode: 0o600 })
    await rename(replacement, path)
    expect(token!.consume()).toBe(false)
  })

  test('rejects malformed UTF-8 and duplicate nested JSON keys', async () => {
    const { path } = await file(snapshot())
    await writeFile(path, Buffer.from([0x7b, 0xff, 0x7d]), { mode: 0o600 })
    await expect(new PrivateFileHostedApprovalRuntimeAdmissionStore(path).load(authority)).rejects.toThrow()
    const source = JSON.stringify(snapshot()).replace(
      '"routeId":"route_1"',
      '"routeId":"route_1","routeId":"route_substituted"',
    )
    await writeFile(path, source, { mode: 0o600 })
    await expect(new PrivateFileHostedApprovalRuntimeAdmissionStore(path).load(authority)).rejects.toThrow('JSON')
  })

  test('rejects symlink and group-readable provisioning authority', async () => {
    const { root, path } = await file(snapshot())
    const target = join(root, 'target.json')
    await writeFile(target, JSON.stringify(snapshot()), { mode: 0o600 })
    await rm(path)
    await symlink(target, path)
    await expect(new PrivateFileHostedApprovalRuntimeAdmissionStore(path).load(authority)).rejects.toThrow()
    await rm(path)
    await writeFile(path, JSON.stringify(snapshot()), { mode: 0o600 })
    await chmod(path, 0o640)
    await expect(new PrivateFileHostedApprovalRuntimeAdmissionStore(path).load(authority)).rejects.toThrow()
  })
})

async function file(value: unknown) {
  const logical = await mkdtemp(join(tmpdir(), 'approval-admission-r2-'))
  roots.push(logical)
  const root = await realpath(logical)
  const path = join(root, 'admission.json')
  await writeFile(path, JSON.stringify(value), { mode: 0o600 })
  return { root, path }
}
function snapshot() {
  const routeAuthority = {
    deploymentId: authority.deploymentId,
    teamId,
    runId: `run_${'2'.repeat(32)}`,
    planGeneration: 2,
    laneId: 'secondary:opencode:worker',
    providerId: 'opencode',
    credentialGeneration: 3,
    credentialId: 'credential_1',
    sessionId: 'session_1',
    runtimeInstanceId: 'runtime_1',
    deliveryOwnerId: `member_${'4'.repeat(32)}`,
  }
  return {
    schemaVersion: 1,
    admissionGeneration: 'approval-admission-generation_1',
    outerAuthority: {
      deploymentId: authority.deploymentId,
      bootId: authority.bootId,
      workspaceId: authority.workspaceId,
      teamId,
      restoreGeneration: 1,
      mountBinding: { ...authority.mountBinding },
    },
    routes: [
      {
        routeId: 'route_1',
        memberName: 'worker',
        authority: routeAuthority,
        scope: {
          principalId: 'actor_owner',
          workspaceId: authority.workspaceId,
          teamId,
          authorityGeneration: 'generation_1',
          restoreGeneration: 1,
        },
        openCodeBinding: {
          toolApprovalMode: 'manual',
          planGeneration: routeAuthority.planGeneration,
          credentialGeneration: routeAuthority.credentialGeneration,
          credentialId: routeAuthority.credentialId,
          runtimeInstanceId: routeAuthority.runtimeInstanceId,
          deliveryOwnerId: routeAuthority.deliveryOwnerId,
          openCodeArtifactDigest: 'sha256:033c9c6f4f73e6d84a10c6edc3ab84e5aad078bf5c75f005721e1e94e85b8a02' as const,
          sessionRecordFingerprint: 'a'.repeat(64),
          liveEffectFingerprint: 'b'.repeat(64),
        },
      },
    ],
    actorMembers: {
      actor_owner: `member_${'4'.repeat(32)}`,
      actor_operator: `member_${'8'.repeat(32)}`,
    },
  }
}
