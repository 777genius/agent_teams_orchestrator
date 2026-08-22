import { afterAll, describe, expect, test } from 'bun:test'
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { OpenCodeWindowsPublicationAuthorityClient } from '../src/services/opencode/OpenCodeWindowsPublicationAuthorityClient.js'
import { resolveOpenCodeNativeAuthorityArtifacts } from '../src/services/opencode/OpenCodeNativeAuthorityArtifacts.js'
import { OpenCodeSafePublicationDirectory } from '../src/services/opencode/OpenCodeSafePublication.js'
import { publishOpenCodeProjectBehaviorSnapshotForTest } from '../src/services/opencode/OpenCodeProfileManager.js'

const roots: string[] = []
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }) })
const windowsTest = process.platform === 'win32' ? test : test.skip
function artifacts() { const directory = process.env.OPENCODE_WINDOWS_NATIVE_ARTIFACT_DIR; return directory ? {
  launcherPath: path.join(directory, 'opencode-catalog-launcher.exe'), workerPath: path.join(directory, 'opencode-catalog-authority.exe'),
} : {} }
async function nativeRequests(requests: object[]): Promise<Record<string, unknown>[]> {
  const explicit = artifacts(); const workerPath = 'workerPath' in explicit
    ? explicit.workerPath : resolveOpenCodeNativeAuthorityArtifacts({}).workerPath
  const child = Bun.spawn([workerPath, '--windows-publication-authority-v1'], { stdin: 'pipe', stdout: 'pipe' })
  child.stdin.write(requests.map(request => `${JSON.stringify(request)}\n`).join('')); child.stdin.end()
  const output = await new Response(child.stdout).text(); await child.exited
  return output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

describe('Windows retained publication native contract', () => {
  windowsTest('denies root and primary database replacement until close', async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), 'opencode-publication-')); roots.push(sandbox)
    const root = path.join(sandbox, 'store'); const displaced = path.join(sandbox, 'displaced')
    await mkdir(root); await writeFile(path.join(root, 'passive-status.sqlite3'), '')
    const client = new OpenCodeWindowsPublicationAuthorityClient({ deadline: performance.now() + 10_000, ...artifacts() })
    await client.openRoot(root, false, false); await expect(rename(root, displaced)).rejects.toBeDefined()
    await client.pinRegular('passive-status.sqlite3')
    await expect(rename(path.join(root, 'passive-status.sqlite3'), path.join(root, 'moved.sqlite3'))).rejects.toBeDefined()
    client.kill(); await rename(root, displaced); await rename(displaced, root)
  })
  windowsTest('read-only pin denies in-place SQLite writes until the bounded copy releases', async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), 'opencode-publication-readonly-')); roots.push(sandbox)
    const root = path.join(sandbox, 'store'); const database = path.join(root, 'passive-status.sqlite3')
    await mkdir(root); await writeFile(database, 'stable-checkpoint')
    const client = new OpenCodeWindowsPublicationAuthorityClient({ deadline: performance.now() + 10_000, ...artifacts() })
    await client.openRoot(root, false, false); await client.pinRegular('passive-status.sqlite3', true)
    await expect(writeFile(database, 'mutated')).rejects.toBeDefined()
    await client.close(); await writeFile(database, 'after-close')
  })
  windowsTest('creates and publishes a temp root through one retained relative handle', async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), 'opencode-retained-temp-root-')); roots.push(sandbox)
    const displaced = path.join(sandbox, 'displaced')
    const client = new OpenCodeWindowsPublicationAuthorityClient({ deadline: performance.now() + 10_000, ...artifacts() })
    await client.openRoot(sandbox, false, false)
    await client.createDirectory('attempt.snapshot')
    await expect(rename(path.join(sandbox, 'attempt.snapshot'), displaced)).rejects.toBeDefined()
    await client.createChildFile('attempt.snapshot', 'attempt.snapshot/evidence.txt', 'evidence.txt')
    await client.writeChildFile('attempt.snapshot/evidence.txt', 0, new TextEncoder().encode('retained'), true)
    await expect(writeFile(path.join(sandbox, 'attempt.snapshot', 'evidence.txt'), 'swapped')).rejects.toBeDefined()
    await client.renameDirectory('attempt.snapshot', 'published')
    expect(await readFile(path.join(sandbox, 'published', 'evidence.txt'), 'utf8')).toBe('retained')
    await client.close()
  })
  windowsTest('project snapshot temp-root swap writes zero attacker files and keeps captured bytes', async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), 'opencode-retained-project-')); roots.push(sandbox)
    const project = path.join(sandbox, 'project'); const snapshots = path.join(sandbox, 'snapshots')
    const outside = path.join(sandbox, 'outside'); const displaced = path.join(sandbox, 'displaced')
    await mkdir(path.join(project, '.opencode', 'plugins'), { recursive: true })
    await mkdir(snapshots); await mkdir(outside)
    await writeFile(path.join(project, '.opencode', 'plugins', 'fixture.js'), 'captured')
    const target = path.join(snapshots, 'project-behavior')
    await expect(publishOpenCodeProjectBehaviorSnapshotForTest(project, target, {
      afterCaptureBeforeCopy: async () => {
        const temporary = (await readdir(snapshots)).find(name => name.includes('.snapshot-'))!
        await expect(rename(path.join(snapshots, temporary), displaced)).rejects.toBeDefined()
        await symlink(outside, path.join(snapshots, temporary, 'plugins'), 'junction')
      },
    })).rejects.toBeDefined()
    expect(await readdir(outside)).toEqual([])
    const rejectedEntries = await readdir(snapshots)
    expect(rejectedEntries).not.toContain('project-behavior')
    expect(rejectedEntries.every(name => name.startsWith('project-behavior.snapshot-'))).toBe(true)
    await publishOpenCodeProjectBehaviorSnapshotForTest(project, target)
    expect(await readFile(path.join(snapshots, 'project-behavior', 'plugins', 'fixture.js'), 'utf8')).toBe('captured')
  })
  windowsTest('project replacement after capture never becomes the new identity baseline', async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), 'opencode-project-capture-swap-')); roots.push(sandbox)
    const project = path.join(sandbox, 'project'); const displaced = path.join(sandbox, 'captured-project')
    const snapshots = path.join(sandbox, 'snapshots'); await mkdir(path.join(project, '.opencode'), { recursive: true })
    await mkdir(snapshots); await writeFile(path.join(project, 'opencode.json'), '{"model":"captured"}')
    await expect(publishOpenCodeProjectBehaviorSnapshotForTest(project, path.join(snapshots, 'project-behavior'), {
      afterCaptureBeforeCopy: async () => {
        await rename(project, displaced); await mkdir(path.join(project, '.opencode'), { recursive: true })
        await writeFile(path.join(project, 'opencode.json'), '{"model":"captured"}')
      },
    })).rejects.toThrow('ancestry changed before materialization')
    expect(await readdir(snapshots)).toEqual([])
  })
  windowsTest('project config swaps at both capture boundaries never replace the initial identity', async () => {
    for (const boundary of ['before-config-read', 'after-config-identity'] as const) {
      const sandbox = await mkdtemp(path.join(os.tmpdir(), `opencode-project-config-${boundary}-`)); roots.push(sandbox)
      const project = path.join(sandbox, 'project'); const snapshots = path.join(sandbox, 'snapshots')
      const config = path.join(project, 'opencode.json'); const displaced = path.join(sandbox, 'captured.json')
      await mkdir(project); await mkdir(snapshots); await writeFile(config, '{"model":"captured"}')
      let swapped = false
      const swap = async () => {
        if (swapped) return
        swapped = true; await rename(config, displaced); await writeFile(config, '{"model":"captured"}')
      }
      await expect(publishOpenCodeProjectBehaviorSnapshotForTest(project, path.join(snapshots, 'project-behavior'), {
        ...(boundary === 'before-config-read' ? { afterWindowsComponentWalk: swap }
          : { afterWindowsFileIdentityCaptured: async (relative: string) => { if (relative === 'opencode.json') await swap() } }),
      })).rejects.toThrow(/changed during capture|changed before capture/)
      expect(swapped).toBe(true); expect(await readdir(snapshots)).toEqual([])
    }
  })
  windowsTest('an initially missing project cannot appear after Windows capture', async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), 'opencode-project-missing-capture-')); roots.push(sandbox)
    const project = path.join(sandbox, 'project'); const snapshots = path.join(sandbox, 'snapshots')
    await mkdir(snapshots)
    await expect(publishOpenCodeProjectBehaviorSnapshotForTest(project, path.join(snapshots, 'project-behavior'), {
      afterCaptureBeforeCopy: async () => {
        await mkdir(project); await writeFile(path.join(project, 'opencode.json'), '{}')
      },
    })).rejects.toThrow('path appeared before materialization')
    expect(await readdir(snapshots)).toEqual([])
  })
  windowsTest('rejects a pre-existing junction with a fixed redacted failure', async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), 'opencode-junction-')); roots.push(sandbox)
    const attacker = path.join(sandbox, 'attacker'); const junction = path.join(sandbox, 'junction')
    await mkdir(attacker); await symlink(attacker, junction, 'junction')
    const client = new OpenCodeWindowsPublicationAuthorityClient({ deadline: performance.now() + 10_000, ...artifacts() })
    await expect(client.openRoot(junction, false, false)).rejects.toThrow('unavailable [redacted]'); await client.close()
  })
  windowsTest('rejects ADS, devices, extended paths, and traversal at the native boundary', async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), 'opencode-native-path-rejection-')); roots.push(sandbox)
    const client = () => new OpenCodeWindowsPublicationAuthorityClient({ deadline: performance.now() + 10_000, ...artifacts() })
    for (const candidate of [`${sandbox}:stream`, `\\\\?\\${sandbox}`, `\\\\.\\${sandbox}`,
      `${sandbox}\\..\\${path.basename(sandbox)}`, `${sandbox}\\.\\child`, `${sandbox}\\NUL`]) {
      const authority = client()
      await expect(authority.openRoot(candidate, false, false)).rejects.toThrow('unavailable [redacted]')
      await authority.close()
    }
    const root = client(); await root.openRoot(sandbox, false, false)
    for (const leaf of ['auth.json:stream', 'CON', 'NUL.txt', 'COM1.log', '..']) {
      await expect(root.pinRegular(leaf)).rejects.toThrow('unavailable [redacted]')
    }
    await root.close()

    let sequence = 0
    for (const candidate of [`${sandbox}:stream`, `\\\\?\\${sandbox}`, `\\\\.\\${sandbox}`,
      `${sandbox}\\..\\${path.basename(sandbox)}`, `${sandbox}\\.\\child`, `${sandbox}\\NUL`]) {
      const id = `native-root-${++sequence}`
      const [reply] = await nativeRequests([{ version: 1, id, op: 'OPEN_ROOT', wait_ms: 5_000,
        root_path: candidate, create_missing: false, durable_ancestors: false }])
      expect(reply).toMatchObject({ version: 1, id, ok: false })
    }
    for (const leaf of ['auth.json:stream', 'CON', 'NUL.txt', 'COM1.log', '..']) {
      const openId = `native-open-${++sequence}`; const leafId = `native-leaf-${sequence}`
      const replies = await nativeRequests([
        { version: 1, id: openId, op: 'OPEN_ROOT', wait_ms: 5_000, root_path: sandbox,
          create_missing: false, durable_ancestors: false },
        { version: 1, id: leafId, op: 'PIN_REGULAR', wait_ms: 5_000, name: leaf },
      ])
      expect(replies[0]).toMatchObject({ version: 1, id: openId, ok: true })
      expect(replies[1]).toMatchObject({ version: 1, id: leafId, ok: false })
    }
  })
  windowsTest('holds an auth root through rollback settlement and releases it afterward', async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), 'opencode-auth-retained-')); roots.push(sandbox)
    const root = path.join(sandbox, 'profile'); const displaced = path.join(sandbox, 'profile-old')
    await mkdir(root); await writeFile(path.join(root, 'auth.json'), '{"old":true}')
    const directory = await OpenCodeSafePublicationDirectory.open(root)
    let transaction: { rollback(): Promise<void> } | undefined
    await directory.writeFileAtomic('auth.json', new TextEncoder().encode('{"credential-sentinel":true}'), 0o600,
      undefined, { retainTransaction: value => { transaction = value } })
    await expect(rename(root, displaced)).rejects.toBeDefined()
    await transaction!.rollback(); await directory.close()
    expect(await readFile(path.join(root, 'auth.json'), 'utf8')).toBe('{"old":true}')
    await rename(root, displaced); await rename(displaced, root)
  })
  windowsTest('pins the verified auth inode against regular, hard-link, and reparse replacement', async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), 'opencode-auth-pinned-boundaries-')); roots.push(sandbox)
    const root = path.join(sandbox, 'profile'); const auth = path.join(root, 'auth.json')
    const attacker = path.join(root, 'attacker.json'); const displaced = path.join(root, 'displaced.json')
    await mkdir(root); await writeFile(auth, '{"prior":true}'); await writeFile(attacker, '{"attacker":true}')
    const directory = await OpenCodeSafePublicationDirectory.open(root)
    await directory.writeFileAtomic('auth.json', '{"next":true}', 0o600, undefined, {
      afterRenameBeforeVerification: async () => {
        await expect(writeFile(auth, '{"different":true}')).rejects.toBeDefined()
        await expect(rename(auth, displaced)).rejects.toBeDefined()
        await expect(unlink(auth)).rejects.toBeDefined()
        await expect(link(attacker, auth)).rejects.toBeDefined()
        await expect(symlink(attacker, auth, 'file')).rejects.toBeDefined()
      },
    })
    await directory.close()
    expect(await readFile(auth, 'utf8')).toBe('{"next":true}')
  })
  windowsTest('failed rollback keeps exact root authority retained until retry settles', async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), 'opencode-auth-retry-retained-')); roots.push(sandbox)
    const root = path.join(sandbox, 'profile'); const displaced = path.join(sandbox, 'profile-old')
    await mkdir(root); await writeFile(path.join(root, 'auth.json'), '{"old":true}')
    const directory = await OpenCodeSafePublicationDirectory.open(root)
    let transaction: { rollback(): Promise<void> } | undefined; let attempts = 0
    await directory.writeFileAtomic('auth.json', new TextEncoder().encode('{"attempt":true}'), 0o600,
      undefined, { beforeSettlementSync: () => {
        attempts += 1
        if (attempts === 1) throw new Error('injected rollback barrier failure')
      }, retainTransaction: value => { transaction = value } })
    await expect(transaction!.rollback()).rejects.toThrow('injected rollback barrier failure')
    await expect(rename(root, displaced)).rejects.toBeDefined()
    await transaction!.rollback(); await directory.close()
    expect(await readFile(path.join(root, 'auth.json'), 'utf8')).toBe('{"old":true}')
    await rename(root, displaced); await rename(displaced, root)
  })
  windowsTest('a crashed atomic publication leaves recovery-required evidence and blocks retry', async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), 'opencode-auth-crash-evidence-')); roots.push(sandbox)
    const root = path.join(sandbox, 'profile'); await mkdir(root)
    await writeFile(path.join(root, 'auth.json'), '{"prior":true}')
    const replies = await nativeRequests([
      { version: 1, id: 'crash-open', op: 'OPEN_ROOT', wait_ms: 5_000, root_path: root,
        create_missing: false, durable_ancestors: false },
      { version: 1, id: 'crash-prepare', op: 'PREPARE_ATOMIC', wait_ms: 5_000,
        final_name: 'auth.json', temporary_name: '.auth.json.tmp.crash',
        backup_name: '.auth.json.rollback.crash', quarantine_name: '.auth.json.quarantine.crash',
        recovery_name: '.auth.json.recovery-required.crash',
        content_base64: Buffer.from('{"attempt":true}').toString('base64') },
    ])
    expect(replies).toMatchObject([{ ok: true }, { ok: true }])
    expect(await readFile(path.join(root, '.auth.json.recovery-required.crash'), 'utf8'))
      .toBe('opencode-windows-atomic-recovery-required-v1\n')
    const directory = await OpenCodeSafePublicationDirectory.open(root)
    await expect(directory.writeFileAtomic('auth.json', '{"retry":true}'))
      .rejects.toThrow('recovery is required [redacted]')
    await directory.close()
    expect(await readFile(path.join(root, 'auth.json'), 'utf8')).toBe('{"attempt":true}')
  })
})
