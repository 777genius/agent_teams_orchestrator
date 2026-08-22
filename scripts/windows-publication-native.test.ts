import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { OpenCodeWindowsPublicationAuthorityClient } from '../src/services/opencode/OpenCodeWindowsPublicationAuthorityClient.js'
import { OpenCodeSafePublicationDirectory } from '../src/services/opencode/OpenCodeSafePublication.js'

const roots: string[] = []
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }) })
const windowsTest = process.platform === 'win32' ? test : test.skip
function artifacts() { const directory = process.env.OPENCODE_WINDOWS_NATIVE_ARTIFACT_DIR; return directory ? {
  launcherPath: path.join(directory, 'opencode-catalog-launcher.exe'), workerPath: path.join(directory, 'opencode-catalog-authority.exe'),
} : {} }

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
  windowsTest('rejects a pre-existing junction with a fixed redacted failure', async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), 'opencode-junction-')); roots.push(sandbox)
    const attacker = path.join(sandbox, 'attacker'); const junction = path.join(sandbox, 'junction')
    await mkdir(attacker); await symlink(attacker, junction, 'junction')
    const client = new OpenCodeWindowsPublicationAuthorityClient({ deadline: performance.now() + 10_000, ...artifacts() })
    await expect(client.openRoot(junction, false, false)).rejects.toThrow('unavailable [redacted]'); await client.close()
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
})
