import { expect, test } from 'bun:test'
import { requireReadonlyMount } from './native-readonly-mount.js'

test('readonly bind mounts use per-mount flags, not backing filesystem flags', () => {
  expect(() => requireReadonlyMount('42 1 8:1 /payload /selected ro,nosuid - ext4 /dev/root rw\n', '42')).not.toThrow()
  expect(() => requireReadonlyMount('42 1 8:1 /payload /selected rw,nosuid - ext4 /dev/root ro\n', '42')).toThrow('mount_not_readonly')
})

test('mount lookup cannot substitute another readonly mount or ambiguous identity', () => {
  const row = '42 1 8:1 /payload /selected ro - ext4 /dev/root rw\n'
  expect(() => requireReadonlyMount(row, '41')).toThrow('mount_identity')
  expect(() => requireReadonlyMount(row + row, '42')).toThrow('mount_identity')
  expect(() => requireReadonlyMount(row.replace(' ro ', ' ro,rw '), '42')).toThrow('mount_not_readonly')
  expect(() => requireReadonlyMount(row.replace(' - ext4', ' ext4'), '42')).toThrow('mount_not_readonly')
})
