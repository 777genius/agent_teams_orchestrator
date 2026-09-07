import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { BehaviorNamespaceCheck } from '../../../src/services/opencode/OpenCodeBehaviorInventory.js'
import { assertNativeDroppedCredentials } from './native-deployment-trust.js'
import { requireReadonlyMount } from './native-readonly-mount.js'

/** The independent launcher provisions native behavior inputs read-only,
 * including parents of absent selected names. Cache/profile runtime directories
 * and ordinary desktop preparation are outside this policy. */
export function createNativeBehaviorNamespaceCheck(projectRoot: string): BehaviorNamespaceCheck {
  const ownerUid = process.getuid!()
  const mounts = new Map<string, string>()
  return (fd, target, stat) => {
    if (process.platform !== 'linux') throw new Error('native_behavior_namespace_unavailable')
    assertNativeDroppedCredentials(readFileSync('/proc/self/status', 'utf8'), ownerUid)
    const info = readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8')
    const id = /^mnt_id:\s+([0-9]+)$/m.exec(info)?.[1]
    if (info.length > 8192 || !id) throw new Error('native_behavior_mount_identity')
    const original = mounts.get(target)
    if (original && original !== id) throw new Error('native_behavior_mount_changed')
    const ancestor = target !== projectRoot && projectRoot.startsWith(target === '/' ? '/' : target + path.sep)
    const protectedAncestor = ancestor && stat.isDirectory() && stat.uid === 0n &&
      ownerUid !== 0 && !(stat.mode & 0o022n)
    if (!protectedAncestor) requireReadonlyMount(readFileSync('/proc/self/mountinfo', 'utf8'), id)
    mounts.set(target, id)
  }
}
