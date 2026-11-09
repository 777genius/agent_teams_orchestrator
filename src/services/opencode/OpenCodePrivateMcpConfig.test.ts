import { afterEach, beforeEach, expect, test } from 'bun:test'
import { execFileSync, spawn } from 'node:child_process'
import { chmod, chown, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { assertPrivateWindowsAcl, assertPrivateWindowsAclAsync, validateWindowsAcl, validateWindowsAncestorAcl, runWindowsMcpAclScript, runWindowsMcpAclScriptAsync } from './OpenCodePrivateMcpAcl.js'
import * as lockfile from '../../utils/lockfile.js'
import { publishPrivateCursorMcpConfig } from './OpenCodePrivateMcpConfig.js'

let root: string
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-private-cursor-mcp-'))) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const secretConfig = { mcp: { 'agent-teams': { type: 'remote', url: 'http://127.0.0.1:1234/mcp',
  headers: { Authorization: 'Bearer TEST-private-credential-must-not-reach-other-files' } } } }
const credentialDirectory = () => path.join(root, 'mcp-credentials')
const credentialFile = () => path.join(credentialDirectory(), 'opencode.json')

test('publishes a private first config and replacement without changing legacy configuration', async () => {
  const legacy = path.join(root, 'opencode.json')
  await writeFile(legacy, 'legacy sentinel', { mode: 0o644 })
  const file = await publishPrivateCursorMcpConfig(root, secretConfig)
  expect(file).toBe(credentialFile())
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(secretConfig)
  expect(await readFile(legacy, 'utf8')).toBe('legacy sentinel')
  if (process.platform === 'win32') {
    // Actual inherited ACLs from the runner's default temporary profile, not a mode mock.
    assertPrivateWindowsAcl(credentialDirectory())
    assertPrivateWindowsAcl(file)
  } else {
    expect((await lstat(credentialDirectory())).mode & 0o777).toBe(0o700)
    expect((await lstat(file)).mode & 0o777).toBe(0o600)
  }
  expect(await publishPrivateCursorMcpConfig(root, { ...secretConfig, version: 2 })).toBe(file)
  expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(2)
  expect(await readdir(credentialDirectory())).toEqual(['opencode.json'])
})

test('serializes parallel private publication without false inode errors or leftovers', async () => {
  // Windows verifies each filesystem ACL through a real PowerShell subprocess.
  // Two simultaneous writers still prove the race without approaching the
  // 30-second per-test budget; POSIX exercises the higher contention count.
  const writers = process.platform === 'win32' ? 2 : 8
  const files = await Promise.all(Array.from({ length: writers }, (_, index) =>
    publishPrivateCursorMcpConfig(root, { ...secretConfig, version: index })))
  expect(files).toEqual(Array.from({ length: writers }, () => credentialFile()))
  const result = JSON.parse(await readFile(credentialFile(), 'utf8'))
  expect(result.mcp).toEqual(secretConfig.mcp)
  expect(Number.isInteger(result.version) && result.version >= 0 && result.version < writers).toBe(true)
  expect(await readdir(credentialDirectory())).toEqual(['opencode.json'])
  expect(await readdir(root)).toEqual(['mcp-credentials'])
  if (process.platform !== 'win32') {
    expect((await lstat(credentialFile())).mode & 0o777).toBe(0o600)
    expect((await lstat(credentialDirectory())).mode & 0o777).toBe(0o700)
  }
})

test('recovers an abandoned publication lock without leaving stale state', async () => {
  await mkdir(credentialDirectory(), { mode: 0o700 })
  const lock = path.join(credentialDirectory(), '.publication.lock')
  await mkdir(lock, { mode: 0o700 })
  const expired = new Date(Date.now() - 40_000)
  await utimes(lock, expired, expired)
  await publishPrivateCursorMcpConfig(root, secretConfig)
  expect(JSON.parse(await readFile(credentialFile(), 'utf8'))).toEqual(secretConfig)
  expect(await readdir(credentialDirectory())).toEqual(['opencode.json'])
})

test('serializes publication across processes while another process owns the lock', async () => {
  await mkdir(credentialDirectory(), { mode: 0o700 })
  const release = await lockfile.lock(path.join(credentialDirectory(), '.publication'), {
    realpath: false,
    stale: 30_000,
    update: 5_000,
  })
  const source = new URL('./OpenCodePrivateMcpConfig.ts', import.meta.url).href
  const script = `const { publishPrivateCursorMcpConfig } = await import(${JSON.stringify(source)}); process.stdout.write('ready\\n'); await publishPrivateCursorMcpConfig(${JSON.stringify(root)}, { source: 'child' });`
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  const completed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  let exited = false
  void completed.then(() => { exited = true }, () => { exited = true })
  let released = false
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', (chunk: Buffer) =>
        chunk.toString('utf8').includes('ready') ? resolve() : reject(new Error('Child not ready')))
      child.once('error', reject)
    })
    // Child is ready to publish, but cannot pass a lock held by this process.
    await Bun.sleep(500)
    expect(exited).toBe(false)
    expect(await readdir(credentialDirectory())).toEqual(['.publication.lock'])
    await release()
    released = true
    expect(await completed).toBe(0)
  } finally {
    if (!released) await release()
    child.kill()
  }
  expect(JSON.parse(await readFile(credentialFile(), 'utf8'))).toEqual({ source: 'child' })
  expect(await readdir(credentialDirectory())).toEqual(['opencode.json'])
}, 30_000)

test.skipIf(process.platform !== 'win32')('accepts a case-only Windows state-root spelling with original ACL checks', async () => {
  const alternate = path.join(path.dirname(root), path.basename(root).toUpperCase())
  const file = await publishPrivateCursorMcpConfig(alternate, secretConfig)
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(secretConfig)
  // Check the same async ACL boundary used during actual publication.
  await assertPrivateWindowsAclAsync(file)
})

test.skipIf(process.platform === 'win32')('rejects an existing broad file without chmod or secret writes', async () => {
  await mkdir(credentialDirectory(), { mode: 0o700 })
  await writeFile(credentialFile(), 'unsafe sentinel', { mode: 0o644 })
  await expect(publishPrivateCursorMcpConfig(root, secretConfig)).rejects.toThrow('not private')
  expect(await readFile(credentialFile(), 'utf8')).toBe('unsafe sentinel')
  expect((await lstat(credentialFile())).mode & 0o777).toBe(0o644)
  expect(await readdir(credentialDirectory())).toEqual(['opencode.json'])
})

test('rejects an existing hardlinked file without changing its other name', async () => {
  await mkdir(credentialDirectory(), { mode: 0o700 })
  const other = path.join(root, 'other-file')
  await writeFile(other, 'hardlink sentinel', { mode: 0o600 })
  await link(other, credentialFile())
  await expect(publishPrivateCursorMcpConfig(root, secretConfig)).rejects.toThrow('not private')
  expect(await readFile(other, 'utf8')).toBe('hardlink sentinel')
  expect((await lstat(other)).nlink).toBe(2)
})

test('rejects a linked credential directory before creating files in its target', async () => {
  const other = path.join(root, 'other-directory')
  await mkdir(other, { mode: 0o700 })
  await symlink(other, credentialDirectory(), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(publishPrivateCursorMcpConfig(root, secretConfig)).rejects.toThrow('not private')
  expect(await readdir(other)).toEqual([])
})

test.skipIf(process.platform === 'win32')('rejects a linked file and a writable ancestor without foreign writes', async () => {
  await mkdir(credentialDirectory(), { mode: 0o700 })
  const other = path.join(root, 'other-file')
  await writeFile(other, 'symlink sentinel', { mode: 0o600 })
  await symlink(other, credentialFile())
  await expect(publishPrivateCursorMcpConfig(root, secretConfig)).rejects.toThrow('not private')
  expect(await readFile(other, 'utf8')).toBe('symlink sentinel')
  await rm(credentialDirectory(), { recursive: true })
  await chmod(root, 0o777)
  await expect(publishPrivateCursorMcpConfig(root, secretConfig)).rejects.toThrow('not private')
  expect(await readdir(root)).toEqual(['other-file'])
  expect((await lstat(root)).mode & 0o777).toBe(0o777)
})

test.skipIf(process.platform === 'win32' || process.getuid?.() !== 0)('rejects a foreign-owned existing file', async () => {
  await mkdir(credentialDirectory(), { mode: 0o700 })
  await writeFile(credentialFile(), 'foreign sentinel', { mode: 0o600 })
  await chown(credentialFile(), 1, 1)
  await expect(publishPrivateCursorMcpConfig(root, secretConfig)).rejects.toThrow('not private')
  expect(await readFile(credentialFile(), 'utf8')).toBe('foreign sentinel')
  expect((await lstat(credentialFile())).uid).toBe(1)
})

test('Windows ACL policy rejects other readers and foreign owners', () => {
  const userSid = 'S-1-5-21-1-2-3-1001'
  const base = { userSid, ownerSid: userSid, rules: [{ sid: userSid, type: 'Allow' }] }
  expect(() => validateWindowsAcl(base)).not.toThrow()
  expect(() => validateWindowsAcl({ ...base, ownerSid: 'S-1-5-21-1-2-3-1002' })).toThrow()
  expect(() => validateWindowsAcl({ ...base, rules: [...base.rules, { sid: 'S-1-1-0', type: 'Allow' }] })).toThrow()
})

test('Windows ancestor policy permits system roots and readers but refuses foreign path mutation', () => {
  const userSid = 'S-1-5-21-1-2-3-1001'
  const base = { userSid, ownerSid: 'S-1-5-32-544', rules: [
    { sid: 'S-1-5-18', type: 'Allow', rights: 2032127, inheritOnly: false },
    { sid: 'S-1-1-0', type: 'Allow', rights: 131209, inheritOnly: false },
    { sid: 'S-1-5-11', type: 'Allow', rights: 4, inheritOnly: false },
  ] }
  expect(() => validateWindowsAncestorAcl(base)).not.toThrow()
  for (const rights of [2, 16, 64, 256, 65536, 262144, 524288, 0x40000000, 0x10000000]) {
    expect(() => validateWindowsAncestorAcl({ ...base, rules: [...base.rules,
      { sid: 'S-1-1-0', type: 'Allow', rights, inheritOnly: false }] })).toThrow()
  }
  expect(() => validateWindowsAncestorAcl({ ...base, ownerSid: 'S-1-5-21-1-2-3-1002' })).toThrow()
})

test.skipIf(process.platform !== 'darwin')('rejects actual macOS allow ACLs despite private mode bits', async () => {
  await mkdir(credentialDirectory(), { mode: 0o700 })
  await writeFile(credentialFile(), 'ACL sentinel', { mode: 0o600 })
  execFileSync('/bin/chmod', ['+a', 'user:nobody allow read', credentialFile()])
  await expect(publishPrivateCursorMcpConfig(root, secretConfig)).rejects.toThrow('not private')
  expect(await readFile(credentialFile(), 'utf8')).toBe('ACL sentinel')
  execFileSync('/bin/chmod', ['-a', 'user:nobody allow read', credentialFile()])
  execFileSync('/bin/chmod', ['+a', 'user:nobody allow delete_child,add_file', root])
  await expect(publishPrivateCursorMcpConfig(root, secretConfig)).rejects.toThrow('not private')
  expect(await readFile(credentialFile(), 'utf8')).toBe('ACL sentinel')
})

test.skipIf(process.platform !== 'win32')('rejects an actual broad Windows file ACL before replacing its bytes', async () => {
  const file = await publishPrivateCursorMcpConfig(root, { sentinel: true })
  const script = `$p='${file.replace(/'/g, "''")}'; $a=[System.IO.File]::GetAccessControl($p); $r=[System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[System.Security.AccessControl.FileSystemRights]::Read,[System.Security.AccessControl.AccessControlType]::Allow); $a.AddAccessRule($r); [System.IO.File]::SetAccessControl($p,$a)`
  await runWindowsMcpAclScriptAsync(script)
  await expect(publishPrivateCursorMcpConfig(root, secretConfig)).rejects.toThrow('not private')
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ sentinel: true })
})

test.skipIf(process.platform !== 'win32')('rejects an actual writable Windows ancestor before creating credential files', async () => {
  const state = path.join(root, 'generation-state')
  await mkdir(state)
  const script = `$p='${root.replace(/'/g, "''")}'; $a=[System.IO.Directory]::GetAccessControl($p); $r=[System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles,[System.Security.AccessControl.AccessControlType]::Allow); $a.AddAccessRule($r); [System.IO.Directory]::SetAccessControl($p,$a)`
  await runWindowsMcpAclScriptAsync(script)
  await expect(publishPrivateCursorMcpConfig(state, secretConfig)).rejects.toThrow('not private')
  expect(await readdir(state)).toEqual([])
  await expect(assertPrivateWindowsAclAsync(root)).rejects.toThrow()
})

test.skipIf(process.platform !== 'win32')('uses the trusted WinPS5 module context without inheriting a credential environment', () => {
  const oldModulePath = process.env.PSModulePath
  const secretKey = 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_HEADERS_JSON'
  const oldCredential = process.env[secretKey]
  try {
    process.env.PSModulePath = 'C:\\TEST-incompatible-PowerShell7-modules'
    process.env[secretKey] = 'TEST-synthetic-credential-must-not-enter-ACL-child'
    const actual = JSON.parse(runWindowsMcpAclScript(`@{major=$PSVersionTable.PSVersion.Major;modulePath=$env:PSModulePath;inheritedCredential=[bool][System.Environment]::GetEnvironmentVariable('${secretKey}')} | ConvertTo-Json -Compress`))
    expect(actual.major).toBe(5)
    expect(actual.modulePath.toLowerCase()).toBe(path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules').toLowerCase())
    expect(actual.inheritedCredential).toBe(false)
    assertPrivateWindowsAcl(root)
  } finally {
    if (oldModulePath === undefined) delete process.env.PSModulePath
    else process.env.PSModulePath = oldModulePath
    if (oldCredential === undefined) delete process.env[secretKey]
    else process.env[secretKey] = oldCredential
  }
})
