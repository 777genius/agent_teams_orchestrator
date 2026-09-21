// Independent review contracts: the original five safety assertions are preserved.
// They failed on the reviewed snapshot; the exact repair base already fixes F1.
import { expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fixture, fresh, exists, c0, c1, manager } from './review-fixture'
import { OpenCodeSessionBridge } from '../OpenCodeSessionBridge'
import { OpenCodeHostManager } from '../OpenCodeHostManager'
import { OpenCodeSessionStore } from '../OpenCodeSessionStore'

for (const terminal of [undefined, 'incomplete']) test(`F1 contract foreign configuration must preserve original active admission: ${terminal ?? 'complete'}`, async () => {
  const f = await fixture({ terminal })
  const foreign = path.join(f.root, 'foreign'); await mkdir(foreign)
  await fresh(f, { ...f.env, CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: '/foreign-command' }, 'execution_probe', foreign)
  expect(await exists(f.receiptPath)).toBe(true)
  expect(await exists(f.archivePath)).toBe(false)
  if (!terminal) {
    expect((await fresh(f)).ok).toBe(true)
  }
})

test('F2 contract late source replacement cannot release unproven session', async () => {
  const f = await fixture({ session: true, terminal: 'incomplete' })
  const dataRoot = path.join(f.root, 'app-data')
  const bridge = new OpenCodeSessionBridge({ oauthRecoveryDataRoot: dataRoot,
    hostManager: new OpenCodeHostManager({ persistentRegistryPath: path.join(dataRoot, 'opencode', 'host-registry.json') }),
    sessionStore: new OpenCodeSessionStore(path.join(dataRoot, 'opencode', 'session-store.json')) })
  await expect(manager.finishOwnedOAuthBeforeSessionRelease(f.receipt.nativeSession.record, async owner => {
    expect(await bridge.isOwnedOAuthNativeSessionSettled(owner)).toBe(false)
    await writeFile(f.global, JSON.stringify({ xai: { ...c0, refresh: 'independent-new-login', accountId: 'new-account' } }))
    return false
  })).rejects.toThrow()
  expect(await exists(f.receiptPath)).toBe(true)
  expect(await exists(f.archivePath)).toBe(false)
})

test('F3 contract observed source replacement cannot resurrect old authority by restoring consumed C0', async () => {
  const f = await fixture()
  const { OpenCodeExecutionProbe } = await import('../OpenCodeExecutionProbe')
  const { resolveOpenCodeProfileScope } = await import('../OpenCodeProfileManager')
  const { saved } = await import('./review-fixture')
  const env = { ...f.env, CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43101' }
  let checks = 0
  await expect(resolveOpenCodeProfileScope({ projectPath: f.project, purpose: f.purpose,
    selectedModel: 'xai/grok-4.3', env, isOAuthNativeProbeSettled: async owner => {
      expect(await new OpenCodeExecutionProbe().isOwnedOAuthNativeProbeSettled(owner, path.join(f.root, 'app-data'))).toBe(true)
      if (++checks === 2) await writeFile(f.global, JSON.stringify({ xai: { ...c0, refresh: 'replacement-login', accountId: 'replacement-account' } }))
      return true
    } })).rejects.toThrow('superseded')
  expect((await Bun.file(f.receiptPath).json()).successor).toEqual(c1)
  await writeFile(f.global, JSON.stringify({ xai: c0 }))
  await fresh(f, env)
  let selected: any
  try { selected = (await saved(f, env)).xai } catch { selected = null }
  expect(selected).not.toEqual(c1)
})

for (const terminal of [false, true]) for (const restored of [false, true]) {
  test(`late revocation survives fresh reader terminal=${terminal} restored=${restored}`, async () => {
    const f = await fixture({ terminal: terminal ? undefined : 'incomplete' })
    const { resolveOpenCodeProfileScope } = await import('../OpenCodeProfileManager')
    const { OpenCodeExecutionProbe } = await import('../OpenCodeExecutionProbe')
    const { saved, read } = await import('./review-fixture')
    let checks = 0
    await expect(resolveOpenCodeProfileScope({ projectPath: f.project, purpose: f.purpose,
      selectedModel: 'xai/grok-4.3', env: f.env, isOAuthNativeProbeSettled: async owner => {
        const settled = await new OpenCodeExecutionProbe().isOwnedOAuthNativeProbeSettled(owner, path.join(f.root, 'app-data'))
        expect(settled).toBe(terminal)
        if (++checks === (terminal ? 2 : 1)) await writeFile(f.global, JSON.stringify({ xai: { ...c0, accountId: 'replacement', refresh: 'replacement' } }))
        return settled
      } })).rejects.toThrow()
    const receipt = await Bun.file(f.receiptPath).json()
    expect(receipt.publicationRevoked).toBe(true)
    expect(receipt.successor).toEqual(terminal ? c1 : null)
    expect(receipt.nativeProbe).toEqual(f.receipt.nativeProbe)
    if (restored) await writeFile(f.global, JSON.stringify({ xai: c0 }))
    const env = { ...f.env, CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43199' }
    await fresh(f, env)
    if (!terminal) {
      expect(await exists(f.receiptPath)).toBe(true)
      expect(await exists(f.archivePath)).toBe(false)
    } else {
      expect(await exists(f.archivePath)).toBe(true)
    }
    let selected: unknown
    try { selected = (await saved(f, env)).xai } catch { selected = null }
    expect(selected).not.toEqual(c1)
    expect(await read(f.profile.managedAuthPath)).toEqual(c1)
  })
}

for (const stage of ['native-exception', 'final-cas', 'post-publication']) test(`observed revocation survives restore at ${stage}`, async () => {
  const f = await fixture()
  const { recoverOpenCodeOwnedOAuthSave } = await import('../OpenCodeAuthStore')
  const { OpenCodeExecutionProbe } = await import('../OpenCodeExecutionProbe')
  const { current, saved } = await import('./review-fixture')
  let ownerChecks = 0
  await expect(recoverOpenCodeOwnedOAuthSave({ globalAuthPath: f.global, sourceAuthPaths: f.receipt.sourceAuthPaths,
    env: f.env, assertRetirementAuthority: async owner => { expect(owner.projectPath).toBe(f.project) },
    assertOwner: async () => {
      expect(await current(f)).toBe(true)
      if (++ownerChecks === (stage === 'post-publication' ? 3 : 2)) {
        await writeFile(f.global, JSON.stringify({ xai: { ...c0, refresh: 'replacement', accountId: 'replacement' } }))
        if (stage === 'post-publication') throw new Error('synthetic post-publication failure')
      }
    }, isNativeProbeSettled: async owner => {
      expect(await new OpenCodeExecutionProbe().isOwnedOAuthNativeProbeSettled(owner, path.join(f.root, 'app-data'))).toBe(true)
      if (stage === 'native-exception') {
        await writeFile(f.global, JSON.stringify({ xai: { ...c0, refresh: 'replacement', accountId: 'replacement' } }))
        throw new Error('synthetic canonical reader failure')
      }
      return true
    } })).rejects.toThrow()
  expect((await Bun.file(f.receiptPath).json()).publicationRevoked).toBe(true)
  expect((await Bun.file(f.receiptPath).json()).successor).toEqual(stage === 'native-exception' ? null : c1)
  await writeFile(f.global, JSON.stringify({ xai: c0 }))
  if (stage === 'post-publication') await expect(saved(f)).rejects.toThrow('retired')
  await fresh(f)
  let selected: unknown
  try { selected = (await saved(f)).xai } catch { selected = null }
  expect(selected).not.toEqual(c1)
  expect((await Bun.file(f.archivePath).json()).successor).toEqual(c1)
})

for (const session of [false, true]) for (const restore of [false, true]) test(`revoked canonically unsubmitted owner can retire session=${session} restore=${restore}`, async () => {
  const f = await fixture({ session, successor: c0 })
  const { Database } = await import('bun:sqlite')
  const db = new Database(path.join(path.dirname(f.profile.managedAuthPath), 'opencode.db'))
  try { db.exec('delete from message') } finally { db.close() }
  const { recoverOpenCodeOwnedOAuthSave } = await import('../OpenCodeAuthStore')
  const replacementDuringRead = async () => {
    await writeFile(f.global, JSON.stringify({ xai: { ...c0, refresh: 'replacement', accountId: 'replacement' } }))
    throw new Error('synthetic interrupted reader')
  }
  await expect(recoverOpenCodeOwnedOAuthSave({ globalAuthPath: f.global,
    sourceAuthPaths: f.receipt.sourceAuthPaths, assertOwner: async () => {},
    assertRetirementAuthority: async owner => { expect(owner.projectPath).toBe(f.project) },
    isNativeSessionSettled: replacementDuringRead, isNativeProbeSettled: replacementDuringRead,
  })).rejects.toThrow('interrupted reader')
  expect((await Bun.file(f.receiptPath).json()).publicationRevoked).toBe(true)
  if (restore) await writeFile(f.global, JSON.stringify({ xai: c0 }))
  await fresh(f)
  expect(await exists(f.receiptPath)).toBe(false)
  expect((await Bun.file(f.archivePath).json()).successor).toBeNull()
})
