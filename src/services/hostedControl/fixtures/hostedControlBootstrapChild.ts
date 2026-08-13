import { fstat } from 'node:fs'
import { readHostedControlBootstrap } from '../HostedControlBootstrap.js'

try {
  const admission = await readHostedControlBootstrap({ deadlineMs: Number(process.argv[2] ?? 5_000) })
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
  })}\n`)
  await admission.guard.lost
  admission.secret.fill(0)
  await admission.guard.close()
  process.stdout.write(`${JSON.stringify({
    kind: 'lost', secretZeroed: admission.secret.every(byte => byte === 0),
    fd3Closed: !(await descriptorOpen(3)), fd4Closed: !(await descriptorOpen(4)),
  })}\n`)
} catch (error) {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(
      `${JSON.stringify({ kind: 'rejected', message: (error as Error).message })}\n`,
      writeError => writeError ? reject(writeError) : resolve(),
    )
  })
  process.exitCode = 2
}
