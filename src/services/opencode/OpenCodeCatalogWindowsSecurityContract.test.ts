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
  test('admits only NTFS for the retained 64-bit file identity representation', async () => {
    const [source, identity] = await Promise.all([
      readFile(authorityPath, 'utf8'),
      readFile(identityPath, 'utf8'),
    ])
    const enterRoot = windowsEnterRoot(source)

    expect(enterRoot).toMatch(/if fs != "NTFS" \{\s*return Err\("WINDOWS_VOLUME_UNVERIFIED"\.into\(\)\);\s*\}/)
    expect(enterRoot).not.toMatch(/fs\s*!=\s*"NTFS"\s*&&/)
    expect(enterRoot).not.toContain('"ReFS"')
    expect(identity).toContain('stable NTFS object identity')
    expect(identity).toMatch(/\(\(information\.nFileIndexHigh as u64\) << 32\)\s*\|\s*information\.nFileIndexLow as u64/)
    expect(identity).toContain('information.dwVolumeSerialNumber as u64')
    expect(identity).toContain('ReFS requires the distinct 128-bit')
  })

  test('captures each component from its no-follow handle without pathname metadata trust', async () => {
    const enterRoot = windowsEnterRoot(await readFile(authorityPath, 'utf8'))
    const loopStart = enterRoot.indexOf('for component in target.components()')
    const loop = enterRoot.slice(loopStart)
    const open = loop.indexOf('.open(&cursor)')
    const handleMetadata = loop.indexOf('file.metadata()', open)
    const handleIdentity = loop.indexOf('windows_identity::file_identity(&file)', handleMetadata)
    const retain = loop.indexOf('held.push(WindowsRootComponent', handleIdentity)
    const durabilityProtocol = loop.indexOf('confirm_windows_root(&target, &held)', retain)

    expect(loopStart).toBeGreaterThanOrEqual(0)
    expect(loop).not.toContain('symlink_metadata')
    expect(loop).not.toContain('cursor.exists()')
    expect(loop).toMatch(/create_dir\(&cursor\)[\s\S]*ErrorKind::AlreadyExists/)
    expect(loop).toContain('FILE_FLAG_OPEN_REPARSE_POINT')
    expect(open).toBeGreaterThanOrEqual(0)
    expect(handleMetadata).toBeGreaterThan(open)
    expect(handleIdentity).toBeGreaterThan(handleMetadata)
    expect(retain).toBeGreaterThan(handleIdentity)
    expect(durabilityProtocol).toBeGreaterThan(retain)
    expect(loop).toContain('.share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)')
    expect(loop).not.toContain('FILE_SHARE_DELETE')
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
    expect(protocol).toMatch(/held\.iter\(\)\.skip\(1\)/)
    expect(protocol).toMatch(/fault\("root-before-directory-sync"\)[\s\S]*sync_windows_directory_path\(parent, "ROOT_SYNC"\)/)
    expect(protocol).toMatch(/pending\.is_none\(\)[\s\S]*!expected\.starts_with\(&contents\)/)
    expect(protocol.indexOf('create_windows_state_file(&confirmed_path')).toBeGreaterThan(
      protocol.indexOf('held.iter().skip(1)'))
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
})
