import { describe, expect, spyOn, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { OpenCodeCatalogAuthorityClient,
  resolveOpenCodeCatalogSourceArtifacts } from './OpenCodeCatalogAuthorityClient.js'

describe('native catalog cross-platform source contract', () => {
  test('source resolution prefers a complete release pair, falls back to debug, and reports missing', () => {
    const root = path.resolve('/source-contract')
    const resolved = (platform: NodeJS.Platform, files: string[]) =>
      resolveOpenCodeCatalogSourceArtifacts(root, platform, candidate => files.includes(candidate))
    const release = resolveOpenCodeCatalogSourceArtifacts(root, 'linux', () => true)
    expect(release.profile).toBe('release')
    expect(release.launcherPath).toBe(path.join(
      root, 'native/opencode-catalog-launcher/target/release/opencode-catalog-launcher',
    ))

    const debugFiles = [
      path.join(root, 'native/opencode-catalog-launcher/target/debug/opencode-catalog-launcher'),
      path.join(root, 'native/opencode-catalog-authority/target/debug/opencode-catalog-authority'),
    ]
    const debug = resolved('linux', debugFiles)
    expect(debug.profile).toBe('debug')
    expect(debug.workerPath).toBe(path.join(
      root, 'native/opencode-catalog-authority/target/debug/opencode-catalog-authority',
    ))
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

  test('authority contention uses a per-request monotonic deadline on every platform', async () => {
    const authority = await readFile('native/opencode-catalog-authority/src/main.rs', 'utf8')
    const client = await readFile('src/services/opencode/OpenCodeCatalogAuthorityClient.ts', 'utf8')
    const protocol = await readFile('src/services/opencode/OpenCodeCatalogAuthorityProtocol.ts', 'utf8')
    expect(authority).toContain('sqlite3_busy_handler')
    expect(authority).toContain('deadline_busy_handler')
    expect(authority).toContain('backoff.min(state.deadline.saturating_duration_since(now))')
    expect(authority).toContain('exec(db, "BEGIN IMMEDIATE")?')
    expect(authority).not.toContain('sqlite3_busy_timeout(db.raw, 0)')
    expect(client).toContain('wait_ms: Math.min(0xffff_ffff, Math.ceil(remaining))')
    expect(client).toContain("reply.error === 'DEADLINE'")
    expect(protocol).toContain('id: string; wait_ms: number')
  })

  test('catalog shutdown never probes or signals a negative process group', async () => {
    const client = await readFile('src/services/opencode/OpenCodeCatalogAuthorityClient.ts', 'utf8')
    expect(client).not.toMatch(/process\.kill\s*\(\s*-/)
    expect(client).not.toMatch(/kill\s*\(\s*-this\.#child\.pid/)
    expect(client).toContain("this.#child.kill('SIGKILL')")
    expect(client).toContain('this.#child.exited.then')

    const processKill = spyOn(process, 'kill').mockImplementation(() => true)
    const childSignals: Array<NodeJS.Signals | number | undefined> = []
    const child = {
      pid: 443,
      stdin: { write: () => 0, flush: () => 0, end: () => {} },
      stdout: new ReadableStream<Uint8Array>(),
      exited: Promise.resolve(0),
      kill: (signal?: NodeJS.Signals | number) => { childSignals.push(signal) },
      unref: () => {},
    }
    try {
      const authority = new OpenCodeCatalogAuthorityClient({
        deadline: performance.now() - 1,
        signal: new AbortController().signal,
        launcherPath: '/static/launcher', workerPath: '/static/worker',
        launch: () => child,
      })
      await authority.close()
      expect(childSignals).toEqual(['SIGKILL'])
      expect(processKill).not.toHaveBeenCalled()
    } finally { processKill.mockRestore() }
  })

  test('native artifact overrides expose exactly the retained launcher pair', async () => {
    const { resolveOpenCodeNativeAuthorityArtifacts } = await import('./OpenCodeNativeAuthorityArtifacts.js')
    expect(Object.keys(resolveOpenCodeNativeAuthorityArtifacts({
      launcherPath: '/static/launcher', workerPath: '/static/worker', extra: 'secret',
    } as never)).sort()).toEqual(['launcherPath', 'workerPath'])
  })

  test('launcher enforces same-object Unix exec and locked Windows job launch', async () => {
    const source = await readFile('native/opencode-catalog-launcher/src/main.rs', 'utf8')
    expect(source).toContain('SYS_execveat')
    expect(source).toContain('libc::fexecve')
    expect(source).toContain('FILE_FLAG_OPEN_REPARSE_POINT')
    expect(source).toContain('CREATE_SUSPENDED')
    expect(source).toContain('ancestor_handles')
    expect(source).toContain('PROC_THREAD_ATTRIBUTE_JOB_LIST')
    expect(source).toContain('PROC_THREAD_ATTRIBUTE_HANDLE_LIST')
    expect(source).toContain('DuplicateHandle')
    expect(source).toContain('STARTF_USESTDHANDLES')
    expect(source).toContain('startup.StartupInfo.hStdInput = protocol_handles[0]')
    expect(source).toContain('startup.StartupInfo.hStdOutput = protocol_handles[1]')
    expect(source).toContain('startup.StartupInfo.hStdError = protocol_handles[2]')
    expect(source).toMatch(/CreateProcessW\([\s\S]*?\n\s*1,\n\s*CREATE_SUSPENDED/)
    expect(source).toContain('InitializeProcThreadAttributeList')
    expect(source).toContain('UpdateProcThreadAttribute')
    expect(source).toContain('STARTUPINFOEXW')
    expect(source).toContain('EXTENDED_STARTUPINFO_PRESENT')
    expect(source).toContain('OPENCODE_CATALOG_LAUNCHER_TEST_GATE')
    expect(source).not.toContain('AssignProcessToJobObject')
    expect(source).toContain('named_after')
    expect(source).toContain('same_object')
    expect(source).toContain('before.nFileIndexHigh == after.nFileIndexHigh')
    expect(source).toContain('--verified-opencode-host-v1')
    expect(source).toContain('actual_ino != expected_ino')
    expect(source).toContain('actual_size != expected_size')
    expect(source).toContain('GetVolumeInformationByHandleW')
    expect(source).toMatch(/GetVolumeInformationByHandleW\(\s*held,/)
    expect(source).toContain('filesystem == "NTFS"')
    expect(source).toContain('OPENCODE_LAUNCH_WINDOWS_VOLUME_IDENTITY_UNVERIFIED')
    expect(source).toContain('eprintln!("{WINDOWS_VOLUME_IDENTITY_UNVERIFIED}")')
    expect(source).not.toContain('filesystem == "ReFS"')
    const volumeGate = source.indexOf('if !windows_filesystem_has_retained_identity(&filesystem)')
    const createProcess = source.indexOf('CreateProcessW(')
    expect(volumeGate).toBeGreaterThanOrEqual(0)
    expect(createProcess).toBeGreaterThan(volumeGate)
    expect(source).toContain('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE')
    expect(source).toContain('OPENCODE_NATIVE_LAUNCHER_FAILURE_V1 stage=')
    for (const stage of ['job_create', 'job_configure', 'job_attribute', 'handle_attribute',
      'create_process', 'named_worker_identity', 'resume_thread', 'wait_process', 'query_exit_code']) {
      expect(source).toContain(`"${stage}"`)
    }
    expect(source).toMatch(/let wait = unsafe \{ WaitForSingleObject[\s\S]*?if wait != WAIT_OBJECT_0/)
    expect(source).toMatch(/if unsafe \{ GetExitCodeProcess[\s\S]*?\} == 0/)
    expect(source).toMatch(/Win32::Foundation::\{[^}]*GENERIC_READ/)
    expect(source).not.toMatch(/Win32::Storage::FileSystem::\{[^}]*\bGENERIC_READ\b/)
  })

  test('Windows launcher diagnostics cross only a bounded redacted stderr contract', async () => {
    const artifacts = await readFile('src/services/opencode/OpenCodeNativeAuthorityArtifacts.ts', 'utf8')
    const diagnostic = await readFile('src/services/opencode/OpenCodeNativeLauncherDiagnostic.ts', 'utf8')
    const client = await readFile('src/services/opencode/OpenCodeWindowsPublicationAuthorityClient.ts', 'utf8')
    expect(artifacts).toContain("stdin: 'pipe', stdout: 'pipe', stderr: 'pipe'")
    expect(artifacts).not.toContain("stderr: 'ignore'")
    expect(diagnostic).toContain('OPEN_CODE_NATIVE_LAUNCHER_STDERR_MAX_BYTES = 1024')
    expect(diagnostic).toContain('OPENCODE_NATIVE_LAUNCHER_FAILURE_V1 stage=')
    expect(diagnostic).not.toContain('${stderr}')
    expect(client).toContain('drainOpenCodeNativeLauncherStderr(this.#child.stderr)')
    expect(client).toContain('this.#terminate(false); throw reported')
  })

  test('Windows authority rejects reparse components and unverifiable non-local filesystems', async () => {
    const source = await readFile('native/opencode-catalog-authority/src/main.rs', 'utf8')
    const publication = await readFile('native/opencode-catalog-authority/src/windows_publication.rs', 'utf8')
    const vfs = await readFile('native/opencode-catalog-authority/src/windows_vfs.rs', 'utf8')
    const identity = await readFile('native/opencode-catalog-authority/src/windows_identity.rs', 'utf8')
    expect(source).toContain('FILE_ATTRIBUTE_REPARSE_POINT')
    expect(source).toContain('FILE_FLAG_OPEN_REPARSE_POINT')
    expect(source).toContain('GetDriveTypeW')
    expect(source).toContain('DRIVE_FIXED')
    expect(source).toMatch(/if fs != "NTFS" \{\s*return Err\("WINDOWS_VOLUME_UNVERIFIED"\.into\(\)\);\s*\}/)
    expect(source).not.toContain('fs != "NTFS" && fs != "ReFS"')
    expect(source).toContain('windows_vfs::name()')
    expect(source).toContain('windows_vfs::release()')
    expect(source.match(/windows_vfs::release\(\)/g)?.length).toBe(1)
    expect(publication).toContain('if deny_writes')
    expect(publication).toContain('pin_relative_writable_file')
    expect(identity).toContain('root_directory: parent.as_raw_handle()')
    expect(identity).toContain('FILE_OPEN_IF makes creation/open one indivisible')
    expect(identity).toContain('0x0010_0000')
    expect(identity).toContain('0x0000_0002 | 0x0000_0004')
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
    expect(identity).toContain('GetFileInformationByHandleEx')
    expect(identity).toContain('FILE_ID_INFO')
    expect(identity).toContain('file.as_raw_handle()')
    expect(identity).toContain('u128::from_le_bytes(information.FileId.Identifier)')
    expect(identity).toContain('GetVolumeInformationByHandleW')
    expect(identity).toContain('NtQueryVolumeInformationFile')
    expect(identity).toContain('device.device_type != FILE_DEVICE_DISK')
    expect(identity).toContain('device.characteristics & (0x0000_0001 | 0x0000_0010) != 0')
    expect(source).toContain('windows_identity::validate_local_ntfs(&root_handle)')
    expect(source).toContain('Win32::System::WindowsProgramming::DRIVE_FIXED')
    expect(source).not.toMatch(/Win32::Storage::FileSystem::\{[^}]*\bDRIVE_FIXED\b/)
    for (const unstable of ['.volume_serial_number()', '.file_index()']) {
      expect(source).not.toContain(unstable)
      expect(vfs).not.toContain(unstable)
      expect(identity).not.toContain(unstable)
    }
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
      expect(lock).toMatch(/name = "windows-sys"\r?\nversion = "0\.61\.2"/)
    }
    for (const feature of ['Win32_Foundation', 'Win32_Security', 'Win32_Storage_FileSystem',
      'Win32_System_Console', 'Win32_System_JobObjects', 'Win32_System_Threading']) expect(launcherToml).toContain(feature)
    for (const symbol of ['CreateProcessW', 'STARTUPINFOEXW', 'PROC_THREAD_ATTRIBUTE_HANDLE_LIST',
      'PROC_THREAD_ATTRIBUTE_JOB_LIST', 'GetStdHandle', 'DuplicateHandle', 'CreateJobObjectW',
      'SetInformationJobObject']) expect(launcher).toContain(symbol)
    for (const feature of ['Win32_Foundation', 'Win32_Security', 'Win32_Storage_FileSystem',
      'Win32_System_IO', 'Win32_System_WindowsProgramming']) expect(authorityToml).toContain(feature)
    for (const symbol of ['FILE_FLAG_BACKUP_SEMANTICS', 'FILE_FLAG_OPEN_REPARSE_POINT']) {
      expect(authority).toContain(symbol)
    }
    const identity = await readFile('native/opencode-catalog-authority/src/windows_identity.rs', 'utf8')
    for (const symbol of ['GetFileInformationByHandleEx', 'GetVolumeInformationByHandleW',
      'FILE_DEVICE_DISK']) expect(identity).toContain(symbol)
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
