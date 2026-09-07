import { readFile } from 'node:fs/promises'
import { assertRootCurrent, type RootAnchor } from './native-controller-anchors.js'

/** A planned readonly mount or a chmod bit is not an observed readonly mount. */
export function requireReadonlyMount(mountinfo: string, mountId: string): void {
  if (!/^[1-9][0-9]*$/.test(mountId) || Buffer.byteLength(mountinfo) > 4 * 1024 * 1024)
    throw new Error('hosted_owner_v2_mountinfo_bounds')
  const rows = mountinfo.split('\n').filter(line => line.split(' ', 1)[0] === mountId)
  if (rows.length !== 1) throw new Error('hosted_owner_v2_mount_identity')
  const fields = rows[0]!.split(' '), separator = fields.indexOf('-')
  if (separator < 6 || fields.length !== separator + 4 ||
    !fields[5]!.split(',').includes('ro') || fields[5]!.split(',').includes('rw'))
    throw new Error('hosted_owner_v2_mount_not_readonly')
}

export async function assertNativeReadonlyRoot(root: RootAnchor): Promise<void> {
  await assertRootCurrent(root)
  requireReadonlyMount(await readFile('/proc/self/mountinfo', 'utf8'), root.pin.mountId)
  await assertRootCurrent(root)
}
