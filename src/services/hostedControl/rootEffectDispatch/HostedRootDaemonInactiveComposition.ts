import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

import { HostedRootInactiveDockerAssembly } from './HostedRootInactiveDockerAssembly.js'

const SHA = /^[a-f0-9]{64}$/
const IMAGE = /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/

export type HostedRootDaemonConfig = Readonly<{
  schemaVersion: 3
  image: string
  bootstrapSha256: string
  workspaceParent: string
  profileParent: string
  configParent: string
  memberManagerStateDirectory: string
  memberNetworkStateDirectory: string
  seccompPath: string
  seccompSha256: string
  apparmorProfile: string
  handoffHelperPath: string
  handoffHelperSha256: string
  handoffPythonSha256: string
  ownerSocketDirectory: string
  ownerUid: number
  ownerGid: number
  rpcSocketPath: string
  rpcSecretPath: string
  serverPasswordKeyPath: string
  inactiveAssemblyConfigPath: string
}>

function rootFile(filePath: string, mode: number, maxBytes: number, uid: number,
  test: boolean): Buffer {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) ||
    path.normalize(filePath) !== filePath) throw new Error('hosted-root-config-path-invalid')
  const parent = path.dirname(filePath)
  if (!test) {
    for (let current = parent; ; current = path.dirname(current)) {
      const ancestor = lstatSync(current)
      if (!ancestor.isDirectory() || ancestor.isSymbolicLink() || ancestor.uid !== 0 ||
        (ancestor.mode & 0o022) !== 0 || realpathSync(current) !== current) {
        throw new Error('hosted-root-config-ancestor-untrusted')
      }
      if (current === path.dirname(current)) break
    }
  }
  const directory = lstatSync(parent)
  const entry = lstatSync(filePath)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== uid || entry.nlink !== 1 ||
    (entry.mode & 0o777) !== mode || entry.size < 1 || entry.size > maxBytes ||
    !directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== uid ||
    (test ? (directory.mode & 0o777) !== 0o700 : (directory.mode & 0o022) !== 0) ||
    realpathSync(filePath) !== filePath || realpathSync(parent) !== parent) {
    throw new Error('hosted-root-config-file-invalid')
  }
  const fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(fd)
    if (opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size) {
      throw new Error('hosted-root-config-substituted')
    }
    const bytes = readFileSync(fd)
    const after = lstatSync(parent)
    if (after.dev !== directory.dev || after.ino !== directory.ino ||
      bytes.length !== opened.size) throw new Error('hosted-root-config-substituted')
    return bytes
  } finally { closeSync(fd) }
}

function configFrom(value: unknown): HostedRootDaemonConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('hosted-root-config-invalid')
  }
  const config = value as Record<string, unknown>
  const fields = ['schemaVersion', 'image', 'bootstrapSha256', 'workspaceParent', 'profileParent',
    'configParent', 'memberManagerStateDirectory', 'memberNetworkStateDirectory',
    'seccompPath', 'seccompSha256', 'apparmorProfile', 'handoffHelperPath',
    'handoffHelperSha256', 'handoffPythonSha256', 'ownerSocketDirectory', 'ownerUid',
    'rpcSocketPath', 'rpcSecretPath', 'serverPasswordKeyPath', 'ownerGid',
    'inactiveAssemblyConfigPath']
  const paths = ['workspaceParent', 'profileParent', 'configParent', 'memberManagerStateDirectory',
    'memberNetworkStateDirectory', 'seccompPath', 'handoffHelperPath', 'ownerSocketDirectory',
    'rpcSocketPath', 'rpcSecretPath', 'serverPasswordKeyPath', 'inactiveAssemblyConfigPath']
  if (Object.keys(config).sort().join(',') !== fields.sort().join(',') || config.schemaVersion !== 3 ||
    typeof config.image !== 'string' || !IMAGE.test(config.image) ||
    !['bootstrapSha256', 'seccompSha256', 'handoffHelperSha256', 'handoffPythonSha256']
      .every(key => typeof config[key] === 'string' && SHA.test(config[key] as string)) ||
    !paths.every(key => typeof config[key] === 'string' && path.isAbsolute(config[key] as string) &&
      path.normalize(config[key] as string) === config[key]) ||
    typeof config.apparmorProfile !== 'string' ||
    !/^[A-Za-z0-9_.-]{1,80}$/.test(config.apparmorProfile) ||
    !Number.isSafeInteger(config.ownerUid) || (config.ownerUid as number) < 0 ||
    !Number.isSafeInteger(config.ownerGid) || (config.ownerGid as number) < 0) {
    throw new Error('hosted-root-config-invalid')
  }
  return Object.freeze({ ...config }) as HostedRootDaemonConfig
}

/** Start with an exact root-owned read-only authority; keep the manager's effect gates denied. */
export class HostedRootDaemonInactiveComposition {
  private constructor(readonly config: HostedRootDaemonConfig,
    readonly rpcSecret: Buffer, readonly serverPasswordKey: Buffer,
    private readonly assembly: HostedRootInactiveDockerAssembly) {}

  static async load(configPath: string, options: { testOnlyAllowNonRoot?: boolean;
    now?: () => number } = {}): Promise<HostedRootDaemonInactiveComposition> {
    const test = options.testOnlyAllowNonRoot === true && process.env.NODE_ENV === 'test'
    if (!test && (process.platform !== 'linux' || process.getuid?.() !== 0)) {
      throw new Error('hosted-root-daemon-invocation-invalid')
    }
    const uid = process.getuid?.() ?? -1
    const config = configFrom(JSON.parse(rootFile(configPath, 0o400, 8192, uid, test).toString('utf8')))
    const secretHex = rootFile(config.rpcSecretPath, 0o400, 64, uid, test).toString('ascii').trim()
    const passwordHex = rootFile(config.serverPasswordKeyPath, 0o400, 64, uid, test)
      .toString('ascii').trim()
    if (!SHA.test(secretHex) || !SHA.test(passwordHex) || secretHex === passwordHex) {
      throw new Error('hosted-root-secret-invalid')
    }
    const rpcSecret = Buffer.from(secretHex, 'hex')
    const serverPasswordKey = Buffer.from(passwordHex, 'hex')
    let assembly: HostedRootInactiveDockerAssembly | undefined
    try {
      assembly = await HostedRootInactiveDockerAssembly.load(config.inactiveAssemblyConfigPath,
        { testOnlyAllowNonRoot: test, now: options.now })
      assembly.assertRuntimePins({ image: config.image, bootstrapSha256: config.bootstrapSha256,
        workspaceParent: config.workspaceParent, profileParent: config.profileParent,
        configParent: config.configParent, managerStateDirectory: config.memberManagerStateDirectory,
        networkStateDirectory: config.memberNetworkStateDirectory,
        serverPasswordKeyPath: config.serverPasswordKeyPath })
      await assembly.observeConfiguredMembers()
      return new HostedRootDaemonInactiveComposition(config, rpcSecret, serverPasswordKey, assembly)
    } catch (error) {
      try { assembly?.close() }
      finally { rpcSecret.fill(0); serverPasswordKey.fill(0) }
      throw error
    }
  }

  prepare(memberId: string) { return this.assembly.prepareMember(memberId) }
  observe(memberId: string) { return this.assembly.observeMember(memberId) }
  provePreparedMember(memberId: string) { return this.assembly.provePreparedMember(memberId) }

  close(): void {
    try { this.assembly.close() }
    finally { this.rpcSecret.fill(0); this.serverPasswordKey.fill(0) }
  }
}
