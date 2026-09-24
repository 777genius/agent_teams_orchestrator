import { closeSync, fstat, fstatSync, openSync } from 'node:fs'
import { readHostedControlBootstrap } from '../HostedControlBootstrap.js'

try {
  const expectedOwnerExecutableDigest = process.argv[3] as `sha256:${string}`
  const admission = await readHostedControlBootstrap({
    deadlineMs: Number(process.argv[2] ?? 5_000),
    expectedOwnerExecutableDigest,
    afterGuardCreated: process.argv[4] === 'reject-after-guard'
      ? () => { throw new Error('injected rejection after guard creation') }
      : undefined,
  })
  const fd5Closed = await new Promise<boolean>(resolve => {
    fstat(5, error => resolve((error as NodeJS.ErrnoException | null)?.code === 'EBADF'))
  })
  const descriptorOpen = (fd: number) => new Promise<boolean>(resolve => {
    fstat(fd, error => resolve(!error))
  })
  process.stdout.write(`${JSON.stringify({
    kind: 'admitted', fd5Closed, secretBytes: admission.secret.byteLength,
    fd3Retained: await descriptorOpen(3), fd4Retained: await descriptorOpen(4),
    declaredRootHash: admission.config.declaredRootHash,
    bootstrapBinding: admission.bootstrapBinding,
    expectedOwnerArtifactDigest: admission.expectedOwnerArtifactDigest,
    ...(process.argv[5] ? { approvalActivationV2Present: !!admission.approvalActivationV2 } : {}),
  })}\n`)
  await admission.guard.lost
  admission.secret.fill(0)
  await admission.guard.close()
  process.stdout.write(`${JSON.stringify({
    kind: 'lost', secretZeroed: admission.secret.every(byte => byte === 0),
    fd3Closed: !(await descriptorOpen(3)), fd4Closed: !(await descriptorOpen(4)),
  })}\n`)
} catch (error) {
  let reusedDescriptorStable: boolean | undefined
  if (process.argv[4] === 'reject-after-guard') {
    const reused = openSync('/dev/null', 'r')
    try {
      await Bun.sleep(25)
      reusedDescriptorStable = fstatSync(reused).isCharacterDevice()
    } finally {
      closeSync(reused)
    }
  }
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(
      `${JSON.stringify({
        kind: 'rejected', message: (error as Error).message, reusedDescriptorStable,
      })}\n`,
      writeError => writeError ? reject(writeError) : resolve(),
    )
  })
  process.exit(2)
}
