import { afterEach, beforeEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmod, chown, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { assertPrivateWindowsAcl, validateWindowsAcl, validateWindowsAncestorAcl } from './OpenCodePrivateMcpAcl.js'
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
  const script = `$ErrorActionPreference='Stop'; $p='${file.replace(/'/g, "''")}'; $a=Get-Acl -LiteralPath $p; $r=[System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[System.Security.AccessControl.FileSystemRights]::Read,[System.Security.AccessControl.AccessControlType]::Allow); $a.AddAccessRule($r); Set-Acl -LiteralPath $p -AclObject $a`
  const executable = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  execFileSync(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 })
  await expect(publishPrivateCursorMcpConfig(root, secretConfig)).rejects.toThrow('not private')
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ sentinel: true })
})

test.skipIf(process.platform !== 'win32')('rejects an actual writable Windows ancestor before creating credential files', async () => {
  const state = path.join(root, 'generation-state')
  await mkdir(state)
  const script = `$ErrorActionPreference='Stop'; $p='${root.replace(/'/g, "''")}'; $a=Get-Acl -LiteralPath $p; $r=[System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles,[System.Security.AccessControl.AccessControlType]::Allow); $a.AddAccessRule($r); Set-Acl -LiteralPath $p -AclObject $a`
  const executable = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  execFileSync(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 })
  await expect(publishPrivateCursorMcpConfig(state, secretConfig)).rejects.toThrow('not private')
  expect(await readdir(state)).toEqual([])
  expect(() => assertPrivateWindowsAcl(root)).toThrow()
})
