import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { OpenCodeWindowsPublicationAuthorityClient } from '../src/services/opencode/OpenCodeWindowsPublicationAuthorityClient.js'
import { resolveOpenCodeNativeAuthorityArtifacts } from '../src/services/opencode/OpenCodeNativeAuthorityArtifacts.js'
import { OpenCodeSafePublicationDirectory } from '../src/services/opencode/OpenCodeSafePublication.js'

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
    await rename(root, displaced); await rename(displaced, root)
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
    await rename(root, displaced); await rename(displaced, root)
  })
})
