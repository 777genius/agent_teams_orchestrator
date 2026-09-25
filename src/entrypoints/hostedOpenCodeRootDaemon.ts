import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'

import { HostedOpenCodeMemberSupervisorManager } from '../services/hostedControl/container/HostedOpenCodeMemberSupervisorManager.js'
import { HostedOpenCodeSupervisorRpcServer } from '../services/hostedControl/container/HostedOpenCodeSupervisorRpc.js'
import { DENIED_HOSTED_MEMBER_NETWORK_DOCKER_PORT, HostedMemberNetworkProvisioner } from
  '../services/hostedControl/containerNetworkProvisioning/HostedMemberNetworkProvisioner.js'

const SHA = /^[0-9a-f]{64}$/

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('hosted-root-config-invalid')
  return value as Record<string, unknown>
}

function string(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('hosted-root-config-invalid')
  return value
}

/** Only installed root-owned code/config may launch this daemon. No Owner-supplied paths enter it. */
async function readRootFile(filePath: string, mode: number, maxBytes: number): Promise<Buffer> {
  if (!path.isAbsolute(filePath) || path.normalize(filePath) !== filePath) {
    throw new Error('hosted-root-config-path-invalid')
  }
  const parent = path.dirname(filePath)
  const [entry, directory] = await Promise.all([lstat(filePath), lstat(parent)])
  if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== 0 || entry.nlink !== 1 ||
    (entry.mode & 0o777) !== mode || entry.size < 1 || entry.size > maxBytes ||
    !directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== 0 ||
    (directory.mode & 0o022) !== 0 || await realpath(filePath) !== filePath) {
    throw new Error('hosted-root-config-file-invalid')
  }
  const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await file.stat()
    if (opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size) {
      throw new Error('hosted-root-config-substituted')
    }
    return await file.readFile()
  } finally { await file.close() }
}

async function main(): Promise<void> {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 ||
    process.argv.length !== 4 || process.argv[2] !== '--config') {
    throw new Error('hosted-root-daemon-invocation-invalid')
  }
  process.umask(0o077)
  const config = row(JSON.parse((await readRootFile(process.argv[3], 0o400, 8192)).toString('utf8')))
  const fields = ['schemaVersion', 'image', 'bootstrapSha256', 'workspaceParent', 'profileParent',
    'configParent', 'memberManagerStateDirectory', 'memberNetworkStateDirectory',
    'seccompPath', 'seccompSha256', 'apparmorProfile',
    'handoffHelperPath', 'handoffHelperSha256', 'handoffPythonSha256', 'ownerSocketDirectory', 'ownerUid',
    'rpcSocketPath', 'rpcSecretPath', 'serverPasswordKeyPath', 'ownerGid']
  if (Object.keys(config).sort().join(',') !== fields.sort().join(',') || config.schemaVersion !== 2 ||
    !Number.isSafeInteger(config.ownerUid) || !Number.isSafeInteger(config.ownerGid)) {
    throw new Error('hosted-root-config-invalid')
  }
  const secretHex = (await readRootFile(string(config.rpcSecretPath), 0o400, 64)).toString('ascii').trim()
  const passwordKeyHex = (await readRootFile(string(config.serverPasswordKeyPath), 0o400, 64))
    .toString('ascii').trim()
  if (!SHA.test(secretHex) || !SHA.test(passwordKeyHex) || secretHex === passwordKeyHex) {
    throw new Error('hosted-root-secret-invalid')
  }
  // Product v33 reservations alone do not prove the current boot, Owner generation,
  // Owner session, or run retirement. The manager and network provisioner still
  // use Docker CLI after async checks, outside a Product write transaction.
  // Keep every effect route denied until those independent authorities and the
  // synchronous exact Docker dispatch are composed together.
  const denyProductAuthority = async () => false
  const network = await HostedMemberNetworkProvisioner.create({
    stateDirectory: string(config.memberNetworkStateDirectory), admitMember: denyProductAuthority,
    rootDocker: DENIED_HOSTED_MEMBER_NETWORK_DOCKER_PORT,
  })
  const manager = await HostedOpenCodeMemberSupervisorManager.create({
    stateDirectory: string(config.memberManagerStateDirectory), network,
    admitMember: denyProductAuthority,
    assertEffectFence: denyProductAuthority,
    assertCleanupAuthority: denyProductAuthority,
    supervisorOptions: {
      image: string(config.image), bootstrapSha256: string(config.bootstrapSha256),
      workspaceParent: string(config.workspaceParent), profileParent: string(config.profileParent),
      configParent: string(config.configParent), seccompPath: string(config.seccompPath),
      seccompSha256: string(config.seccompSha256), apparmorProfile: string(config.apparmorProfile),
      handoffHelperPath: string(config.handoffHelperPath), handoffHelperSha256: string(config.handoffHelperSha256),
      handoffPythonSha256: string(config.handoffPythonSha256),
      ownerSocketDirectory: string(config.ownerSocketDirectory), ownerUid: Number(config.ownerUid),
      serverPasswordKey: Buffer.from(passwordKeyHex, 'hex'),
    },
  })
  const server = new HostedOpenCodeSupervisorRpcServer({ socketPath: string(config.rpcSocketPath),
    secret: Buffer.from(secretHex, 'hex'), ownerGid: Number(config.ownerGid), manager })
  await server.start()
  const shutdown = () => { void server.close().finally(() => process.exit(0)) }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
}

void main().catch(() => { process.stderr.write('hosted-root-daemon-start-failed\n'); process.exitCode = 1 })
