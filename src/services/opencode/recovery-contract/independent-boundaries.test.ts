import { expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fixture, fresh, saved, current, exists, c0, c1 } from './review-fixture'
import { recoverOpenCodeOwnedOAuthSave, openCodeOAuthSuccessorPath } from '../OpenCodeAuthStore'
import { OpenCodeExecutionProbe } from '../OpenCodeExecutionProbe'

// Independent schedules; reuse only the existing synthetic native fixture.
test('required: successful final owner callback source replacement rejects publication', async () => {
  const f = await fixture()
  let checks = 0
  const result = await recoverOpenCodeOwnedOAuthSave({ globalAuthPath: f.global,
    sourceAuthPaths: f.receipt.sourceAuthPaths, env: f.env,
    assertRetirementAuthority: async owner => { expect(owner.projectPath).toBe(f.project) },
    assertOwner: async () => {
      expect(await current(f)).toBe(true)
      if (++checks === 3) await writeFile(f.global, JSON.stringify({ xai: { ...c0, refresh: 'LAST-CHECK-replacement', accountId: 'replacement' } }))
    },
    isNativeProbeSettled: owner => new OpenCodeExecutionProbe().isOwnedOAuthNativeProbeSettled(owner, path.join(f.root, 'app-data')),
  }).catch(e => ({ error: e.message }))
  await writeFile(f.global, JSON.stringify({ xai: c0 }))
  let selected: unknown
  try { selected = (await saved(f)).xai } catch { selected = null }
  console.log(JSON.stringify({ schedule: 'last-owner-success', result, checks, active: await exists(f.receiptPath), archive: await exists(f.archivePath), revived: JSON.stringify(selected) === JSON.stringify(c1) }))
  // Final recheck observes this callback mutation; external writes remain non-atomic.
  expect(result).toEqual({ error: expect.stringContaining('superseded') })
  expect(selected).not.toEqual(c1)
})

for (const after of [false, true]) test(`archive interruption retains durable late revocation after=${after}`, async () => {
  const f = await fixture()
  let checks = 0
  await expect(recoverOpenCodeOwnedOAuthSave({ globalAuthPath: f.global, sourceAuthPaths: f.receipt.sourceAuthPaths, env: f.env,
    assertOwner: async () => {}, assertRetirementAuthority: async owner => { expect(owner.projectPath).toBe(f.project) },
    isNativeProbeSettled: async owner => {
      const settled = await new OpenCodeExecutionProbe().isOwnedOAuthNativeProbeSettled(owner, path.join(f.root, 'app-data'))
      if (++checks === 2) await writeFile(f.global, JSON.stringify({ xai: { ...c0, refresh: 'replacement', accountId: 'replacement' } }))
      return settled
    },
  })).rejects.toThrow('superseded')
  const marked = await Bun.file(f.receiptPath).json()
  expect(marked.publicationRevoked).toBe(true)
  await writeFile(f.global, JSON.stringify({ xai: c0 }))
  const fault = await fresh(f, f.env, f.purpose, f.project, { path: f.archivePath, after })
  expect(fault.ok).toBe(false)
  expect(await exists(f.receiptPath)).toBe(true)
  expect((await Bun.file(f.receiptPath).json()).nativeProbe).toEqual(f.receipt.nativeProbe)
  expect(await exists(f.archivePath)).toBe(after)
  await Promise.all([fresh(f), fresh(f)])
  expect(await exists(f.receiptPath)).toBe(false)
  const archive = await Bun.file(f.archivePath).json()
  expect(archive.owner).toEqual(f.receipt.owner)
  expect(archive.publicationRevoked).toBe(true)
  expect(archive.successor).toEqual(c1)
  expect(await exists(openCodeOAuthSuccessorPath(f.global))).toBe(false)
  expect((await Bun.file(f.profile.managedAuthPath).json()).xai).toEqual(c1)
})

for (const malformed of [false, true]) test(`required: observed replacement survives recovery exception with malformed authority=${malformed}`, async () => {
  const f = await fixture()
  let checks = 0
  await expect(recoverOpenCodeOwnedOAuthSave({ globalAuthPath: f.global,
    sourceAuthPaths: f.receipt.sourceAuthPaths, env: f.env,
    assertRetirementAuthority: async owner => { expect(owner.projectPath).toBe(f.project) },
    assertOwner: async () => { expect(await current(f)).toBe(true) },
    isNativeProbeSettled: async owner => {
      const result = await new OpenCodeExecutionProbe().isOwnedOAuthNativeProbeSettled(owner, path.join(f.root, 'app-data'))
      if (++checks === 2) {
        await writeFile(f.global, JSON.stringify({ xai: { ...c0, refresh: 'replacement', accountId: 'replacement' } }))
        if (malformed) await writeFile(openCodeOAuthSuccessorPath(f.global), '{}')
      }
      return result
    },
  })).rejects.toThrow()
  const retained = await Bun.file(f.receiptPath).json()
  await writeFile(f.global, JSON.stringify({ xai: c0 }))
  if (malformed) await (await import('node:fs/promises')).rm(openCodeOAuthSuccessorPath(f.global))
  await fresh(f)
  let selected: unknown
  try { selected = (await saved(f)).xai } catch { selected = null }
  console.log(JSON.stringify({ schedule: 'malformed-authority', malformed, revoked: retained.publicationRevoked ?? false, revived: JSON.stringify(selected) === JSON.stringify(c1) }))
  expect(selected).not.toEqual(c1)
})

for (const newPort of [false, true]) test(`required: original owned refresh remembers observed account replacement before recovery newPort=${newPort}`, async () => {
  const { manager } = await import('./review-fixture')
  const { rm } = await import('node:fs/promises')
  const f = await fixture()
  // Rewind only this synthetic fixture's admission to re-execute the original
  // public owned-refresh path. The same OS-verified exited native history is
  // subsequently used by the unmodified fresh production recovery reader.
  await rm(f.receiptPath)
  await writeFile(f.profile.managedAuthPath, JSON.stringify({ xai: c0 }))
  let failure = ''
  try {
    await manager.withOwnedOAuthRefresh({ profile: f.profile, assertHostOwnership: async () => {},
      operation: async (_armSession, armProbe) => {
        await armProbe(f.native)
        await writeFile(f.profile.managedAuthPath, JSON.stringify({ xai: c1 }))
        await writeFile(f.global, JSON.stringify({ xai: { ...c0, refresh: 'new-login', accountId: 'new-account' } }))
      }, isNativeSettled: () => true })
  } catch (e: any) { failure = e.message }
  expect(failure).toContain('source scope changed')
  const retained = await Bun.file(f.receiptPath).json()
  await writeFile(f.global, JSON.stringify({ xai: c0 }))
  await fresh(f, newPort ? { ...f.env, CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43199' } : f.env)
  let selected: unknown
  try { selected = (await saved(f)).xai } catch { selected = null }
  console.log(JSON.stringify({ schedule: 'original-owned-refresh', newPort, failure, revoked: retained.publicationRevoked ?? false, revived: JSON.stringify(selected) === JSON.stringify(c1) }))
  expect(selected).not.toEqual(c1)
})

for (const terminal of [false, true]) test(`valid independent authority replacement stays revoked after restoration terminal=${terminal}`, async () => {
  const f = await fixture({ terminal: terminal ? undefined : 'incomplete' })
  let checks = 0
  await expect(recoverOpenCodeOwnedOAuthSave({ globalAuthPath: f.global, sourceAuthPaths: f.receipt.sourceAuthPaths, env: f.env,
    assertOwner: async () => { expect(await current(f)).toBe(true) },
    assertRetirementAuthority: async owner => { expect(owner.projectPath).toBe(f.project) },
    isNativeProbeSettled: async owner => {
      const result = await new OpenCodeExecutionProbe().isOwnedOAuthNativeProbeSettled(owner, path.join(f.root, 'app-data'))
      if (++checks === (terminal ? 2 : 1)) await writeFile(openCodeOAuthSuccessorPath(f.global), JSON.stringify({
        version: 1, operationId: 'independent-authority', owner: f.receipt.owner,
        sourceAuthPaths: f.receipt.sourceAuthPaths, before: f.receipt.before, predecessor: c0,
        successor: { ...c1, access: 'independent-authority', refresh: 'independent-authority' },
      }))
      return result
    },
  })).rejects.toThrow('superseded')
  expect((await Bun.file(f.receiptPath).json()).publicationRevoked).toBe(true)
  await (await import('node:fs/promises')).rm(openCodeOAuthSuccessorPath(f.global))
  await Promise.all([fresh(f), fresh(f)])
  expect(await exists(f.receiptPath)).toBe(!terminal)
  expect(await exists(f.archivePath)).toBe(terminal)
  let selected: unknown
  try { selected = (await saved(f)).xai } catch { selected = null }
  expect(selected).not.toEqual(c1)
})

for (const terminal of [false, true]) for (const interruption of ['before-once', 'after-exit']) test(`durable revocation write boundary ${interruption} terminal=${terminal}`, async () => {
  const f = await fixture({ terminal: terminal ? undefined : 'incomplete' })
  const sourceRoot = path.resolve(import.meta.dir, '../../..')
  const script = `
    globalThis.fetch = async () => { throw new Error('INDEPENDENT forbids network') };
    const { mock } = await import('bun:test');
    const atomicPath = ${JSON.stringify(path.join(sourceRoot, 'utils/atomicWrite.ts'))};
    const atomic = await import(atomicPath); const writeAtomic = atomic.writeJsonFileAtomic;
    let faults = 0;
    mock.module(atomicPath, () => ({ ...atomic, writeJsonFileAtomic: async (p, v, o) => {
      if (p === ${JSON.stringify(f.receiptPath)} && v.publicationRevoked && faults++ === 0) {
        if (${JSON.stringify(interruption)} === 'before-once') throw new Error('INDEPENDENT transient pre-write failure');
        await writeAtomic(p, v, o); process.exit(73);
      }
      return writeAtomic(p, v, o);
    } }));
    const { recoverOpenCodeOwnedOAuthSave } = await import(${JSON.stringify(path.join(sourceRoot, 'services/opencode/OpenCodeAuthStore.ts'))});
    const { OpenCodeExecutionProbe } = await import(${JSON.stringify(path.join(sourceRoot, 'services/opencode/OpenCodeExecutionProbe.ts'))});
    const { writeFile } = await import('node:fs/promises');
    let checks = 0;
    try { await recoverOpenCodeOwnedOAuthSave({ globalAuthPath: ${JSON.stringify(f.global)}, sourceAuthPaths: ${JSON.stringify(f.receipt.sourceAuthPaths)},
      assertOwner: async () => {}, assertRetirementAuthority: async owner => { if (owner.projectPath !== ${JSON.stringify(f.project)}) throw new Error('foreign'); },
      isNativeProbeSettled: async owner => {
        const settled = await new OpenCodeExecutionProbe().isOwnedOAuthNativeProbeSettled(owner, ${JSON.stringify(path.join(f.root, 'app-data'))});
        if (++checks === ${terminal ? 2 : 1}) await writeFile(${JSON.stringify(f.global)}, ${JSON.stringify(JSON.stringify({ xai: { ...c0, refresh: 'boundary-replacement', accountId: 'boundary-replacement' } }))});
        return settled;
      }
    }); process.exit(74); } catch(e) { process.stdout.write(e.message); }
  `
  const child = Bun.spawn([process.execPath, '-e', script], { env: f.env, stdout: 'pipe', stderr: 'pipe' })
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(err).toBe('')
  expect(code).toBe(interruption === 'after-exit' ? 73 : 0)
  if (interruption === 'before-once') expect(out).toContain('pre-write failure')
  const retained = await Bun.file(f.receiptPath).json()
  expect(retained.publicationRevoked).toBe(true)
  expect(retained.successor).toEqual(terminal ? c1 : null)
  expect(retained.owner).toEqual(f.receipt.owner)
  expect(retained.nativeProbe).toEqual(f.receipt.nativeProbe)
  expect(retained.before).toEqual(f.receipt.before)
  expect(retained.authorityBefore).toEqual(f.receipt.authorityBefore)
  await writeFile(f.global, JSON.stringify({ xai: c0 }))
  await fresh(f)
  expect(await exists(f.receiptPath)).toBe(!terminal)
  expect(await exists(f.archivePath)).toBe(terminal)
  expect((await Bun.file(f.profile.managedAuthPath).json()).xai).toEqual(c1)
})

for (const mutation of ['source', 'authority']) test(`F1 foreign late ${mutation} replacement cannot mark owner revoked`, async () => {
  const { mkdir } = await import('node:fs/promises')
  const { resolveOpenCodeProfileScope } = await import('../OpenCodeProfileManager')
  const f = await fixture()
  const foreign = path.join(f.root, 'foreign'); await mkdir(foreign)
  let checks = 0
  await resolveOpenCodeProfileScope({ projectPath: foreign, selectedModel: 'xai/grok-4.3', purpose: 'execution_probe', env: f.env,
    isOAuthNativeProbeSettled: async owner => {
      const settled = await new OpenCodeExecutionProbe().isOwnedOAuthNativeProbeSettled(owner, path.join(f.root, 'app-data'))
      if (++checks === 2) {
        if (mutation === 'source') await writeFile(f.global, JSON.stringify({ xai: { ...c0, refresh: 'foreign-replacement' } }))
        else await writeFile(openCodeOAuthSuccessorPath(f.global), JSON.stringify({ version: 1, operationId: 'foreign-replacement', owner: f.receipt.owner,
          sourceAuthPaths: f.receipt.sourceAuthPaths, before: f.receipt.before, predecessor: c0, successor: { ...c1, refresh: 'foreign-replacement' } }))
      }
      return settled
    },
  })
  expect(checks).toBe(0)
  const retained = await Bun.file(f.receiptPath).json()
  expect(retained.publicationRevoked).toBeUndefined()
  expect(retained.successor).toEqual(f.receipt.successor)
  expect(retained.owner).toEqual(f.receipt.owner)
  expect(retained.nativeProbe).toEqual(f.receipt.nativeProbe)
  expect(await exists(f.archivePath)).toBe(false)
  expect((await fresh(f)).ok).toBe(true)
  expect((await saved(f)).xai).toEqual(c1)
})

// Additional paired controls for the shared receipt mechanism.
for (const replaced of [false, true]) test(`invalid authority at recovery entry fences only readable replacement=${replaced}`, async () => {
  const f = await fixture()
  if (replaced) await writeFile(f.global, JSON.stringify({ xai: { ...c0, refresh: 'entry-replacement' } }))
  await writeFile(openCodeOAuthSuccessorPath(f.global), '{invalid')
  await expect(recoverOpenCodeOwnedOAuthSave({ globalAuthPath: f.global, sourceAuthPaths: f.receipt.sourceAuthPaths,
    assertOwner: async () => {}, assertRetirementAuthority: async owner => { expect(owner).toEqual(f.receipt.owner) },
  })).rejects.toThrow()
  const retained = await Bun.file(f.receiptPath).json()
  expect(retained.publicationRevoked).toBe(replaced ? true : undefined)
  expect(retained.nativeProbe).toEqual(f.receipt.nativeProbe)
  expect(retained.successor).toBeNull()
  expect(await Bun.file(openCodeOAuthSuccessorPath(f.global)).text()).toBe('{invalid')
  await writeFile(f.global, JSON.stringify({ xai: c0 }))
  await (await import('node:fs/promises')).rm(openCodeOAuthSuccessorPath(f.global))
  await fresh(f)
  let selected: unknown
  try { selected = (await saved(f)).xai } catch { selected = null }
  if (replaced) expect(selected).not.toEqual(c1)
  else expect(selected).toEqual(c1)
})

for (const stage of ['operation-corruption', 'final-callback', 'scope-error']) test(`original receipt retains revocation at ${stage}`, async () => {
  const { withOpenCodeOwnedOAuthRefresh, OpenCodeOAuthPublicationRevokedError } = await import('../OpenCodeAuthStore')
  const { rm } = await import('node:fs/promises')
  const f = await fixture()
  await rm(f.receiptPath)
  await writeFile(f.profile.managedAuthPath, JSON.stringify({ xai: c0 }))
  const replace = () => writeFile(f.global, JSON.stringify({ xai: { ...c0, refresh: 'original-replacement' } }))
  let checks = 0
  await expect(withOpenCodeOwnedOAuthRefresh({ globalAuthPath: f.global, managedAuthPath: f.profile.managedAuthPath,
    sourceAuthPaths: f.receipt.sourceAuthPaths, env: f.env, providerId: 'xai', predecessor: c0,
    recoveryOwner: f.receipt.owner, assertOwnership: async () => {},
    assertPublicationOwnership: async () => { if (++checks === 2) await replace() },
    operation: async (_armSession, armProbe) => {
      await armProbe(f.native)
      await writeFile(f.profile.managedAuthPath, JSON.stringify({ xai: c1 }))
      if (stage === 'operation-corruption') {
        await replace()
        await writeFile(openCodeOAuthSuccessorPath(f.global), '{}')
        throw new Error('original operation failed')
      }
      if (stage === 'scope-error') throw new OpenCodeOAuthPublicationRevokedError('observed original scope replacement')
    }, isNativeSettled: () => true,
  })).rejects.toThrow()
  const retained = await Bun.file(f.receiptPath).json()
  expect(retained.publicationRevoked).toBe(true)
  expect(retained.owner).toEqual(f.receipt.owner)
  expect(retained.nativeProbe).toEqual(f.receipt.nativeProbe)
  if (stage === 'operation-corruption') {
    expect(await Bun.file(openCodeOAuthSuccessorPath(f.global)).text()).toBe('{}')
    await rm(openCodeOAuthSuccessorPath(f.global))
  }
  if (stage === 'final-callback') expect(checks).toBe(2)
  await writeFile(f.global, JSON.stringify({ xai: c0 }))
  await fresh(f)
  let selected: unknown
  try { selected = (await saved(f)).xai } catch { selected = null }
  expect(selected).not.toEqual(c1)
})
