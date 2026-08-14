import { readFile, readlink, realpath, stat } from 'node:fs/promises'

import { resolveExecutingOpenCodeArtifactDigest } from
  '../../../src/services/opencode/OpenCodeArtifactDigest.js'

export async function processStartIdentity(pid: number): Promise<string> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('hosted_actual_owner_process_pid_invalid')
  const processStat = await readFile(`/proc/${pid}/stat`, 'utf8')
  const close = processStat.lastIndexOf(')')
  const started = close < 0 ? undefined : processStat.slice(close + 2).trim().split(/\s+/)[19]
  if (!started || !/^\d+$/.test(started)) {
    throw new Error('hosted_actual_owner_process_start_identity_unavailable')
  }
  return started
}

export async function proveExecutingProviderIdentity(input: {
  pid: number
  executable: string
  device: string
  inode: string
  sha256: string
}): Promise<{ executable: string; device: string; inode: string; processStartIdentity: string }> {
  const procExecutable = `/proc/${input.pid}/exe`
  const beforeStart = await processStartIdentity(input.pid)
  const [firstLink, firstStat, canonical, executableStat] = await Promise.all([
    readlink(procExecutable), stat(procExecutable, { bigint: true }), realpath(procExecutable),
    stat(input.executable, { bigint: true }),
  ])
  if (firstLink.endsWith(' (deleted)') || firstLink !== input.executable || canonical !== input.executable ||
    !firstStat.isFile() || !executableStat.isFile() ||
    firstStat.dev !== executableStat.dev || firstStat.ino !== executableStat.ino ||
    firstStat.dev.toString() !== input.device || firstStat.ino.toString() !== input.inode ||
    resolveExecutingOpenCodeArtifactDigest(input.pid) !== `sha256:${input.sha256}`) {
    throw new Error('hosted_actual_owner_provider_identity_invalid')
  }
  const [afterStart, secondLink, secondStat] = await Promise.all([
    processStartIdentity(input.pid), readlink(procExecutable), stat(procExecutable, { bigint: true }),
  ])
  if (afterStart !== beforeStart || secondLink !== firstLink || !secondStat.isFile() ||
    secondStat.dev !== firstStat.dev || secondStat.ino !== firstStat.ino) {
    throw new Error('hosted_actual_owner_provider_identity_invalid')
  }
  return Object.freeze({
    executable: firstLink, device: firstStat.dev.toString(), inode: firstStat.ino.toString(),
    processStartIdentity: afterStart,
  })
}
