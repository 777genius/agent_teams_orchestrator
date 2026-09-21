import { expect, test } from 'bun:test'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fixture, fresh, saved, c0, c1, manager } from './review-fixture'
import { resolveOpenCodeProfileScope } from '../OpenCodeProfileManager'
import { OpenCodeExecutionProbe } from '../OpenCodeExecutionProbe'

for (const original of [true, false]) test(`observed valid config replacement remains revoked after restoration original=${original}`, async () => {
  const f = await fixture()
  const config = path.join(f.project, 'opencode.json')
  const replace = () => writeFile(config, JSON.stringify({ provider: { xai: { options: { baseURL: 'http://config-replacement.invalid/v1' } } } }))
  let failure = ''
  if (original) {
    await rm(f.receiptPath)
    await writeFile(f.profile.managedAuthPath, JSON.stringify({ xai: c0 }))
    try {
      await manager.withOwnedOAuthRefresh({ profile: f.profile, assertHostOwnership: async () => {},
        operation: async (_arm, armProbe) => {
          await armProbe(f.native)
          await writeFile(f.profile.managedAuthPath, JSON.stringify({ xai: c1 }))
          await replace()
        }, isNativeSettled: () => true })
    } catch (error: any) { failure = error.message }
    expect(failure).toContain('publication source configuration changed')
  } else {
    let checks = 0
    try {
      await resolveOpenCodeProfileScope({ projectPath: f.project, selectedModel: 'xai/grok-4.3', purpose: f.purpose, env: f.env,
        isOAuthNativeProbeSettled: async owner => {
          const settled = await new OpenCodeExecutionProbe().isOwnedOAuthNativeProbeSettled(owner, path.join(f.root, 'app-data'))
          expect(settled).toBe(true)
          if (++checks === 2) await replace()
          return settled
        } })
    } catch (error: any) { failure = error.message }
    expect(checks).toBe(2)
  }
  const retained = await Bun.file(f.receiptPath).exists() ? await Bun.file(f.receiptPath).json() : null
  if (original) {
    expect(retained.owner).toEqual(f.receipt.owner)
    expect(retained.nativeProbe).toEqual(f.receipt.nativeProbe)
    expect(retained.successor).toBeNull()
  }
  await rm(config)
  const recovery = await fresh(f)
  let selected: unknown
  try { selected = (await saved(f)).xai } catch { selected = null }
  console.log(JSON.stringify({ original, failure, revoked: retained?.publicationRevoked ?? false, recoveryOk: recovery.ok,
    revived: JSON.stringify(selected) === JSON.stringify(c1), archive: await Bun.file(f.archivePath).exists() }))
  expect(selected).not.toEqual(c1)
})
