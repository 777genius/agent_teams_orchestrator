import { closeSync, constants, fstatSync, fsyncSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { PinnedPosixDirectory } from '../../../src/services/hostedControl/PinnedPosixDirectory.internal.js'
import { createDiskOwnerWalImageCustodian } from '../../../src/services/hostedControl/HostedApprovalOwnerWalImageCustodian.js'
import type { HostedControlBootstrapAdmissionV2 } from '../../../src/services/hostedControl/HostedControlBootstrapV2.js'
import { requireV2 } from '../../../src/services/hostedControl/HostedControlBootstrapV2Wire.js'

/** One actual admitted Owner process, one never-reused image directory. The
 * existing image custodian stages exact WAL predecessor/successor bytes and
 * binds them to the actual FD9 emission; directory names are not evidence. */
export async function createNativeWalImagesV2(bootstrap: HostedControlBootstrapAdmissionV2, teamRoot: string) {
  const token = bootstrap.header.supervisorBinding.ownerProcessStartToken
  requireV2(/^[0-9a-f]{64}$/.test(token), 'image_process_token')
  requireV2(bootstrap.executedOwner.pid === process.pid &&
    bootstrap.executedOwner.startTicks === bootstrap.header.supervisorBinding.ownerStartTicks, 'image_owner_process')
  requireV2(await bootstrap.guard.assertCurrent(), 'image_guard')
  const parent = await PinnedPosixDirectory.open(teamRoot, { retainAncestry: true })
  try {
    parent.assertLinked()
    const name = `hosted-owner-wal-images-${token}`
    // Exclusive creation refuses a previous/crashed attempt's storage. No
    // recursive mkdir, random fallback name, reopening or cleanup of old images.
    mkdirSync(`/proc/self/fd/${parent.fd}/${name}`, { mode: 0o700 })
    const child = parent.openChild(name, constants.O_RDONLY | constants.O_DIRECTORY)
    try {
      const before = fstatSync(child)
      requireV2(before.isDirectory() && (before.mode & 0o7777) === 0o700 &&
        before.uid === process.getuid!(), 'image_directory')
      fsyncSync(child); fsyncSync(parent.fd); parent.assertLinked()
      const custodian = await createDiskOwnerWalImageCustodian(join(teamRoot, name))
      try {
        parent.assertLinked()
        const linked = parent.openChild(name, constants.O_RDONLY | constants.O_DIRECTORY)
        try {
          const after = fstatSync(linked)
          requireV2(after.dev === before.dev && after.ino === before.ino, 'image_directory_changed')
        } finally { closeSync(linked) }
        requireV2(await bootstrap.guard.assertCurrent() && custodian.isHealthy(), 'image_guard')
        return custodian
      } catch (error) { custodian.close(); throw error }
    } finally { closeSync(child) }
  } finally { closeSync(parent.fd) }
}
