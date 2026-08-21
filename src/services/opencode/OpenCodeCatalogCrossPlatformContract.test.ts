import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { resolveOpenCodeCatalogSourceArtifacts } from './OpenCodeCatalogAuthorityClient.js'

describe('native catalog cross-platform source contract', () => {
  test('source resolution prefers a complete release pair, falls back to debug, and reports missing', () => {
    const root = path.resolve('/source-contract')
    const resolved = (platform: NodeJS.Platform, files: string[]) =>
      resolveOpenCodeCatalogSourceArtifacts(root, platform, candidate => files.includes(candidate))
    const release = resolveOpenCodeCatalogSourceArtifacts(root, 'linux', () => true)
    expect(release.profile).toBe('release')
    expect(release.launcherPath).toContain('/target/release/opencode-catalog-launcher')

    const debugFiles = [
      path.join(root, 'native/opencode-catalog-launcher/target/debug/opencode-catalog-launcher'),
      path.join(root, 'native/opencode-catalog-authority/target/debug/opencode-catalog-authority'),
    ]
    const debug = resolved('linux', debugFiles)
    expect(debug.profile).toBe('debug')
    expect(debug.workerPath).toContain('/target/debug/opencode-catalog-authority')
    const missing = resolved('win32', [])
    expect(missing.profile).toBe('missing')
    expect(missing.launcherPath).toEndWith('opencode-catalog-launcher.exe')
    expect(missing.workerPath).toEndWith('opencode-catalog-authority.exe')
  })

  test('POSIX authority uses held beneath/no-follow components without descriptor pseudo-paths', async () => {
    const source = await readFile('native/opencode-catalog-authority/src/main.rs', 'utf8')
    const vfs = await readFile('native/opencode-catalog-authority/src/posix_vfs.rs', 'utf8')
    expect(source).toContain('libc::openat')
    expect(source).toContain('libc::O_NOFOLLOW')
    expect(source).toContain('libc::fchdir')
    expect(source).toContain('posix_vfs::name()')
    expect(vfs).toContain('sqlite3_vfs_register')
    expect(vfs).toContain('libc::openat')
    expect(vfs).toContain('libc::pread')
    expect(vfs).toContain('libc::pwrite')
    expect(vfs).toContain('libc::fcntl')
    expect(vfs).toContain('libc::fsync')
    expect(`${source}\n${vfs}`).not.toContain('/proc/self/fd')
    expect(`${source}\n${vfs}`).not.toContain('/dev/fd')
  })

  test('launcher enforces same-object Unix exec and locked Windows job launch', async () => {
    const source = await readFile('native/opencode-catalog-launcher/src/main.rs', 'utf8')
    expect(source).toContain('SYS_execveat')
    expect(source).toContain('libc::fexecve')
    expect(source).toContain('FILE_FLAG_OPEN_REPARSE_POINT')
    expect(source).toContain('CREATE_SUSPENDED')
    expect(source).toContain('ancestor_handles')
    expect(source).toContain('PROC_THREAD_ATTRIBUTE_JOB_LIST')
    expect(source).toContain('InitializeProcThreadAttributeList')
    expect(source).toContain('UpdateProcThreadAttribute')
    expect(source).toContain('STARTUPINFOEXW')
    expect(source).toContain('EXTENDED_STARTUPINFO_PRESENT')
    expect(source).toContain('OPENCODE_CATALOG_LAUNCHER_TEST_GATE')
    expect(source).not.toContain('AssignProcessToJobObject')
    expect(source).not.toContain('named_after')
    expect(source).toContain('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE')
  })

  test('Windows authority rejects reparse components and unverifiable non-local filesystems', async () => {
    const source = await readFile('native/opencode-catalog-authority/src/main.rs', 'utf8')
    const vfs = await readFile('native/opencode-catalog-authority/src/windows_vfs.rs', 'utf8')
    expect(source).toContain('FILE_ATTRIBUTE_REPARSE_POINT')
    expect(source).toContain('FILE_FLAG_OPEN_REPARSE_POINT')
    expect(source).toContain('GetDriveTypeW')
    expect(source).toContain('DRIVE_FIXED')
    expect(source).toMatch(/fs\s*!=\s*"NTFS"\s*&&\s*fs\s*!=\s*"ReFS"/)
    expect(source).toContain('windows_vfs::name()')
    expect(source).toContain('windows_vfs::release()')
    expect(source.match(/windows_vfs::release\(\)/g)?.length).toBe(1)
    expect(source).toContain('GENERIC_READ | GENERIC_WRITE')
    expect(source).not.toContain('FlushFileBuffers(parent.as_raw_handle()')
    expect(vfs).toContain('sqlite3_vfs_register')
    expect(vfs).toContain('.share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)')
    expect(vfs).toContain('seek_read')
    expect(vfs).toContain('seek_write')
    expect(vfs).toContain('LockFileEx')
    expect(vfs).toContain('sync_all')
    expect(vfs).toContain('JOURNAL_REPLACED')
    expect(vfs).toContain('Release the retained baselines only when the attempt closes')
    expect(vfs).not.toContain('FILE_SHARE_DELETE')
  })

  test('windows-sys 0.61.2 features cover the exact launcher and authority APIs', async () => {
    const launcherToml = await readFile('native/opencode-catalog-launcher/Cargo.toml', 'utf8')
    const authorityToml = await readFile('native/opencode-catalog-authority/Cargo.toml', 'utf8')
    const launcherLock = await readFile('native/opencode-catalog-launcher/Cargo.lock', 'utf8')
    const authorityLock = await readFile('native/opencode-catalog-authority/Cargo.lock', 'utf8')
    const launcher = await readFile('native/opencode-catalog-launcher/src/main.rs', 'utf8')
    const authority = await readFile('native/opencode-catalog-authority/src/main.rs', 'utf8')
    expect(launcherToml).toContain('version = "=0.61.2"')
    for (const lock of [launcherLock, authorityLock]) {
      expect(lock).toMatch(/name = "windows-sys"\nversion = "0\.61\.2"/)
    }
    for (const feature of ['Win32_Foundation', 'Win32_Security', 'Win32_Storage_FileSystem',
      'Win32_System_JobObjects', 'Win32_System_Threading']) expect(launcherToml).toContain(feature)
    for (const symbol of ['CreateProcessW', 'STARTUPINFOEXW', 'PROC_THREAD_ATTRIBUTE_JOB_LIST',
      'CreateJobObjectW', 'SetInformationJobObject']) expect(launcher).toContain(symbol)
    for (const feature of ['Win32_Foundation', 'Win32_Security', 'Win32_Storage_FileSystem',
      'Win32_System_IO']) expect(authorityToml).toContain(feature)
    for (const symbol of ['CreateFileW', 'FlushFileBuffers', 'GENERIC_WRITE',
      'FILE_FLAG_BACKUP_SEMANTICS']) expect(authority).toContain(symbol)
  })

  test('production build is online-clean by default with explicit offline verification opt-in', async () => {
    const build = await readFile('scripts/build.ts', 'utf8')
    expect(build).toContain("OPENCODE_CATALOG_CARGO_OFFLINE === '1'")
    expect(build).not.toContain("'--locked', '--offline'")
    const workflow = await readFile('.github/workflows/release-runtime.yml', 'utf8')
    expect(workflow).toContain('cargo fetch --locked --manifest-path native/opencode-catalog-authority/Cargo.toml')
    expect(workflow).toContain('cargo fetch --locked --manifest-path native/opencode-catalog-launcher/Cargo.toml')
  })

  test('release/build sources name authority and launcher for all five required targets', async () => {
    const layout = await readFile('scripts/release-archive-layout.ts', 'utf8')
    for (const platform of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-arm64', 'win32-x64']) {
      expect(layout).toContain(platform)
    }
    const build = await readFile('scripts/build.ts', 'utf8')
    expect(build).toContain('aarch64-apple-darwin')
    expect(build).toContain('x86_64-apple-darwin')
    expect(build).toContain('x86_64-unknown-linux-gnu')
    expect(build).toContain('aarch64-pc-windows-msvc')
    expect(build).toContain('x86_64-pc-windows-msvc')
    const workflow = await readFile('.github/workflows/release-runtime.yml', 'utf8')
    expect(workflow).toContain('runner: windows-11-arm')
  })
})
