import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

const authorityPath = 'native/opencode-catalog-authority/src/main.rs'
const identityPath = 'native/opencode-catalog-authority/src/windows_identity.rs'

function windowsEnterRoot(source: string): string {
  const start = source.indexOf('#[cfg(windows)]\nfn enter_root')
  const end = source.indexOf('#[cfg(windows)]\nfn validate_windows_root', start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('OpenCode catalog Windows authority security contract', () => {
  test('admits only local NTFS for the retained full 128-bit file identity', async () => {
    const [source, identity] = await Promise.all([
      readFile(authorityPath, 'utf8'),
      readFile(identityPath, 'utf8'),
    ])
    const enterRoot = windowsEnterRoot(source)

    expect(enterRoot).toMatch(/if fs != "NTFS" \{\s*return Err\("WINDOWS_VOLUME_UNVERIFIED"\.into\(\)\);\s*\}/)
    expect(enterRoot).not.toMatch(/fs\s*!=\s*"NTFS"\s*&&/)
    expect(enterRoot).not.toContain('"ReFS"')
    expect(identity).toContain('full FILE_ID_128 identity')
    expect(identity).toContain('pub(super) type FileIdentity = (u64, u128)')
    expect(identity).toContain('GetFileInformationByHandleEx')
    expect(identity).toContain('FileIdInfo')
    expect(identity).toContain('information.VolumeSerialNumber')
    expect(identity).toContain('u128::from_le_bytes(information.FileId.Identifier)')
    expect(identity).toContain('GetVolumeInformationByHandleW')
    expect(identity).toContain('NtQueryVolumeInformationFile')
    expect(identity).toContain('device.device_type != FILE_DEVICE_DISK')
    expect(identity).toContain('device.characteristics & (0x0000_0001 | 0x0000_0010) != 0')
    expect(enterRoot.indexOf('windows_identity::validate_local_ntfs(&root_handle)')).toBeGreaterThan(
      enterRoot.indexOf('.open(&root_path)'),
    )
  })

  test('captures each component from its no-follow handle without pathname metadata trust', async () => {
    const [source, identity] = await Promise.all([
      readFile(authorityPath, 'utf8'),
      readFile(identityPath, 'utf8'),
    ])
    const enterRoot = windowsEnterRoot(source)
    const loopStart = enterRoot.indexOf('for component in target.components()')
    const loop = enterRoot.slice(loopStart)
    const open = loop.indexOf('windows_identity::open_relative_directory(')
    const handleMetadata = loop.indexOf('file.metadata()', open)
    const handleIdentity = loop.indexOf('windows_identity::file_identity(&file)', handleMetadata)
    const retain = loop.indexOf('held.push(WindowsRootComponent', handleIdentity)
    const durabilityProtocol = loop.indexOf('confirm_windows_root(&target, &held)', retain)

    expect(loopStart).toBeGreaterThanOrEqual(0)
    expect(loop).not.toContain('symlink_metadata')
    expect(loop).not.toContain('cursor.exists()')
    expect(loop).not.toContain('create_dir(&cursor)')
    expect(loop).not.toContain('.open(&cursor)')
    expect(open).toBeGreaterThanOrEqual(0)
    expect(handleMetadata).toBeGreaterThan(open)
    expect(handleIdentity).toBeGreaterThan(handleMetadata)
    expect(retain).toBeGreaterThan(handleIdentity)
    expect(durabilityProtocol).toBeGreaterThan(retain)
    expect(identity).toContain('root_directory: parent.as_raw_handle()')
    expect(identity).toContain('if create { 3 } else { 1 }')
    expect(identity).toContain('FILE_OPEN_IF makes creation/open one indivisible')
    expect(identity).toContain('0x0020_0000, // DIRECTORY|SYNC_NONALERT|OPEN_REPARSE_POINT')
    expect(identity).toContain('FILE_SHARE_READ; deliberately no write/delete')
  })

  test('missing root confirmation persistently retries the complete parent barrier chain', async () => {
    const source = await readFile(authorityPath, 'utf8')
    const start = source.indexOf('fn confirm_windows_root')
    const end = source.indexOf('#[cfg(windows)]\nfn validate_windows_root_components', start)
    const protocol = source.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(protocol).toContain('WINDOWS_ROOT_PENDING')
    expect(protocol).toContain('WINDOWS_ROOT_CONFIRMED')
    expect(protocol).toMatch(/open_windows_state_file\(&confirmed_path, false\)/)
    expect(protocol).toMatch(/held\.iter\(\)\.take\(held\.len\(\)\.saturating_sub\(1\)\)/)
    expect(protocol).toMatch(/fault\("root-before-directory-sync"\)[\s\S]*parent\.handle\.sync_all\(\)[\s\S]*validate_windows_root_components\(held\)/)
    expect(protocol).toMatch(/pending\.is_none\(\)[\s\S]*!expected\.starts_with\(&contents\)/)
    expect(protocol.indexOf('create_windows_state_file(&confirmed_path')).toBeGreaterThan(
      protocol.indexOf('held.iter().take(held.len().saturating_sub(1))'))
    expect(protocol.lastIndexOf('remove_file(&pending_path)')).toBeGreaterThan(
      protocol.indexOf('create_windows_state_file(&confirmed_path'))
    expect(protocol).toContain('"ROOT_STATE_CLEANUP"')
  })

  test('root state is bounded, no-follow, identity-bound and retained without delete sharing', async () => {
    const source = await readFile(authorityPath, 'utf8')
    expect(source).toContain('const WINDOWS_ROOT_STATE_MAX: u64 = 128')
    expect(source).toContain('FILE_FLAG_OPEN_REPARSE_POINT')
    expect(source).toMatch(/metadata\.len\(\) > WINDOWS_ROOT_STATE_MAX/)
    expect(source).toMatch(/component\.volume\.to_be_bytes\(\)/)
    expect(source).toMatch(/component\.index\.to_be_bytes\(\)/)
    expect(source).toContain('WINDOWS_ROOT_MARKER')
    expect(source).toMatch(/open_windows_state_file\(&confirmed_path, false\)/)
    expect(source).toMatch(/expected\.is_some_and\(\|value\| contents != value\)/)
  })

  test('native Windows fixtures select the production LocalAppData volume explicitly', async () => {
    const [identity, publication, roundTrip, passive, nativeSuite] = await Promise.all([
      readFile(identityPath, 'utf8'),
      readFile('native/opencode-catalog-authority/src/windows_publication.rs', 'utf8'),
      readFile('src/services/opencode/OpenCodeWindowsPublicationAuthorityRoundTrip.test.ts', 'utf8'),
      readFile('src/services/opencode/OpenCodePassiveSnapshotConsistency.test.ts', 'utf8'),
      readFile('scripts/windows-publication-native.test.ts', 'utf8'),
    ])
    for (const source of [identity, publication, roundTrip, passive, nativeSuite]) {
      expect(source).toContain('LOCALAPPDATA')
    }
    expect(identity).toContain('Windows authority fixtures require local NTFS')
    expect(roundTrip).not.toContain('os.tmpdir()')
    expect(passive).not.toContain('os.tmpdir()')
    expect(nativeSuite).not.toContain('path.join(os.tmpdir()')
  })

  test('uses aligned NT rename and flush primitives for every directory barrier', async () => {
    const [identity, publication] = await Promise.all([
      readFile(identityPath, 'utf8'),
      readFile('native/opencode-catalog-authority/src/windows_publication.rs', 'utf8'),
    ])
    const rename = identity.slice(
      identity.indexOf('pub(super) fn rename_relative'),
      identity.indexOf('pub(super) fn link_relative'),
    )
    const flush = identity.slice(
      identity.indexOf('pub(super) fn flush_directory'),
      identity.indexOf('pub(super) fn list_relative_names'),
    )
    expect(identity).toContain('#[repr(C)]\nstruct IoStatusBlock')
    expect(identity).toContain('fn NtSetInformationFile(')
    expect(identity).toContain('fn NtFlushBuffersFile(')
    expect(identity).toContain('fn nt_success(status: NtStatus) -> bool')
    expect(identity).toContain('const RENAME_FLAGS_OFFSET: usize = 0')
    expect(identity).toContain('const RENAME_ROOT_OFFSET: usize = 8')
    expect(identity).toContain('const RENAME_LENGTH_OFFSET: usize = 16')
    expect(identity).toContain('const RENAME_NAME_OFFSET: usize = 20')
    expect(identity).toContain('storage: Vec<usize>')
    expect(identity).toContain('std::mem::align_of::<HANDLE>()')
    expect(identity).toContain('let flags: u32 = if replace { 0x1 | 0x2 } else { 0 }')
    expect(rename).toMatch(/NtSetInformationFile\([\s\S]*?\n\s*65, \/\/ FileRenameInformationEx/)
    expect(rename).not.toContain('SetFileInformationByHandle')
    expect(flush).toContain('NtFlushBuffersFile(directory.as_raw_handle(), &mut status)')
    expect(flush).toContain('!nt_success(result) || !nt_success(status.status)')
    expect(identity).toMatch(/NtSetInformationFile\([\s\S]*?\n\s*11,/)
    expect(identity).not.toContain('FileRenameInfoEx')
    expect(identity).not.toContain('FlushFileBuffers')
    expect(publication.match(/windows_identity::flush_directory/g)).toHaveLength(39)
    expect(publication).not.toMatch(/(?:parent|source_parent|destination_parent|directory)\.sync_all\(/)
    expect(publication).not.toMatch(/\.handle\s*\.sync_all\(/)
    expect(publication).toContain('recovery.sync_all().map_err')
    expect(publication).toContain('file.sync_all().map_err')
    expect(publication).toContain('temporary.sync_all().map_err')
    expect(identity).not.toContain('symlink_metadata')
  })
})
