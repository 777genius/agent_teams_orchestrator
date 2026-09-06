import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function parseAcceptanceInvocation(args: readonly string[]): {
  configArgs: readonly string[]
  bootstrapFds: { launcherLeaseFd: number; livenessFd: number; bootstrapFd: number }
} {
  const expected = ['--runtime-manifest', '--actual-owner-contract', '--actual-owner-contract-sha256',
    '--actual-owner-contract-byte-count', '--launcher-lease-fd', '--liveness-fd', '--bootstrap-fd']
  if (args.length !== 14 || expected.some((flag, index) => args[index * 2] !== flag)) {
    throw new Error('hosted_actual_owner_invocation_invalid')
  }
  const values = [args[9], args[11], args[13]].map(value => Number(value))
  if (values.some((value, index) => value !== index + 6) || new Set(values).size !== 3) {
    throw new Error('hosted_actual_owner_bootstrap_fd_map_invalid')
  }
  return {
    configArgs: args.slice(0, 8),
    bootstrapFds: { launcherLeaseFd: values[0]!, livenessFd: values[1]!, bootstrapFd: values[2]! },
  }
}

export function isDirectAcceptanceEntry(argv: readonly string[], entryUrl: string): boolean {
  return resolve(argv[1] ?? '') === fileURLToPath(entryUrl)
}
