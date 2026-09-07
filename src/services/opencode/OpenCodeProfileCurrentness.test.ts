import { createServer } from 'node:net'
import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rename, rm, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { collectProjectBehaviorMetadata, prepareOpenCodeProfile } from './OpenCodeProfilePreparation.js'
import { projectPreparedProfile } from './OpenCodePreparedProfileContract.js'
import { buildManagedConfigFingerprint } from './OpenCodeManagedConfigFingerprint.js'
import { retainOpenCodeProfileCurrentness } from './OpenCodeProfileCurrentness.js'

async function fixture(run: (root: string, projection: ReturnType<typeof projectPreparedProfile>) => Promise<void>) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(),'native-profile-r1098-')))
  try {
    const projectPath = path.join(root,'project'), home = path.join(root,'source-home')
    await mkdir(projectPath); await mkdir(home); await mkdir(path.join(root,'absent-parent'))
    await writeFile(path.join(projectPath,'AGENTS.md'),'actual test behavior')
    await mkdir(path.join(projectPath,'.opencode/tools'),{recursive:true})
    const source = path.join(root,'source-auth.json')
    await writeFile(source,'{"fixture":{"type":"api","key":"private-sentinel"}}',{mode:0o600})
    const prepared = await prepareOpenCodeProfile({projectPath,workingDirectory:projectPath,
      paths:{data:path.join(root,'data'),cache:path.join(root,'cache')}, sourceHomePath:home,
      sourceAuthPaths:[path.join(root,'absent-parent/auth.json'),source],
      globalAuthPath:path.join(root,'data/opencode/auth.json'), environment:{HOME:home}, platform:'linux',
      appMcpConfig:{type:'remote',url:'https://example.invalid/secret-one',environment:{TOKEN:'secret-one'}},
      // Test fixture avoids discovering external credential CLIs; production
      // selected preparation retains its normal subscription behavior.
      options:{toolApprovalMode:'manual',includeManagedSubscriptionPlugins:false},
    })
    await run(root,projectPreparedProfile(prepared))
  } finally { await rm(root,{recursive:true,force:true}) }
}
test.skipIf(process.platform !== 'linux')('real preparation pins auth bytes, absence ancestors and complete new behavior inventory', async () => {
  for (const mutation of ['auth-bytes','auth-replace','absent-appears','ancestor-replace','new-behavior','new-symlink','dangling-symlink','ignored-symlink'] as const) {
    await fixture(async (root,projection) => {
      const retained = retainOpenCodeProfileCurrentness(projection)
      try {
        expect(retained.isCurrent()).toBe(true)
        expect(retained.readPreparedProfile().env.OPENCODE_CONFIG_CONTENT).toBe(projection.managedConfigJson)
        await Promise.resolve() // mutations occur across an authority preparation await
        if (mutation === 'auth-bytes') await writeFile(path.join(root,'source-auth.json'),'mutated')
        if (mutation === 'auth-replace') {
          await rename(path.join(root,'source-auth.json'),path.join(root,'old-auth.json'))
          await writeFile(path.join(root,'source-auth.json'),'same named replacement',{mode:0o600})
        }
        if (mutation === 'absent-appears') await writeFile(path.join(root,'absent-parent/auth.json'),'{}')
        if (mutation === 'ancestor-replace') {
          await rename(path.join(root,'absent-parent'),path.join(root,'old-parent'))
          await mkdir(path.join(root,'absent-parent'))
        }
        if (mutation === 'new-behavior') {
          await mkdir(path.join(root,'project/.opencode/tools'),{recursive:true})
          await writeFile(path.join(root,'project/.opencode/tools/new.ts'),'export default {}')
        }
        if (mutation === 'new-symlink' || mutation === 'dangling-symlink' || mutation === 'ignored-symlink') {
          await symlink(path.join(root, mutation === 'dangling-symlink' ? 'absent.ts' : 'source-auth.json'),
            path.join(root, 'project/.opencode/tools', mutation === 'ignored-symlink' ? 'node_modules' : 'new.ts'))
        }
        expect(retained.isCurrent()).toBe(false)
        expect(() => retained.readPreparedProfile()).toThrow()
      } finally { retained.close() }
    })
  }
})
test.skipIf(process.platform !== 'linux')('private URL/environment substitution cannot pass a normalized config collision', () => fixture(async (_root,projection) => {
  const retained = retainOpenCodeProfileCurrentness(projection)
  try {
    const config = JSON.parse(projection.managedConfigJson)
    const name = Object.keys(config.mcp)[0]!
    config.mcp[name].url = 'https://example.invalid/secret-two'
    config.mcp[name].environment = {TOKEN:'secret-two'}
    expect(buildManagedConfigFingerprint(config)).toBe(projection.managedConfigFingerprint)
    expect(retained.matches({...projection,managedConfigJson:JSON.stringify(config)})).toBe(false)
    expect(retained.isCurrent()).toBe(true)
  } finally { retained.close() }
}))

// These exercise the actual preparer's inventory entry point, before publication.
test('preparation rejects linked selected leaves, roots, ancestors and nested entries', async () => {
  for (const relative of ['AGENTS.md', '.opencode', '.opencode/tools', '.opencode/tools/new.ts', '.opencode/tools/node_modules']) {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'behavior-links-r1114-')))
    try {
      const project = path.join(root, 'project')
      await mkdir(path.dirname(path.join(project, relative)), { recursive: true })
      await symlink(path.join(root, 'missing-target'), path.join(project, relative))
      await expect(collectProjectBehaviorMetadata(project)).rejects.toThrow('opencode_behavior_entry_unsupported')
    } finally { await rm(root, { recursive: true, force: true }) }
  }
})

test('preparation and consumption reject unsupported socket entries in an admitted behavior directory', () => fixture(async (root, projection) => {
  const retained = retainOpenCodeProfileCurrentness(projection)
  const server = createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path.join(root, 'project/.opencode/tools/unsupported.sock'), resolve)
    })
    await expect(collectProjectBehaviorMetadata(path.join(root, 'project'))).rejects.toThrow('opencode_behavior_entry_unsupported')
    expect(retained.isCurrent()).toBe(false)
  } finally {
    retained.close()
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  }
}))
