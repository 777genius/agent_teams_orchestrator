import { AsyncLocalStorage } from 'node:async_hooks'
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, type Stats } from 'node:fs'
import { basename, dirname, isAbsolute, join, parse, relative } from 'node:path'
const PROTOCOL_VERSION = 1 as const, LOCK_EX = 2, LOCK_NB = 4, LOCK_UN = 8
const EINTR = 4, EAGAIN = 11

type NativeApi = { library: unknown
  openat(parentFd: number, name: unknown, flags: number, mode: number): number
  faccessat(fd: number, name: unknown, mode: number, flags: number): number
  flock(fd: number, operation: number): number; fcntl(fd: number, command: number): number
  pointer(value: Buffer): unknown; errno(): number }
let nativeApiPromise: Promise<NativeApi> | null = null

async function nativeApi(): Promise<NativeApi> {
  if (process.platform !== 'linux') {
    throw new Error('Canonical team lock authority requires Linux flock semantics')
  }
  nativeApiPromise ??= import('bun:ffi').then(({ dlopen, FFIType, ptr, read }) => {
    const library = dlopen('libc.so.6', {
      openat: {
        args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.u32],
        returns: FFIType.i32,
      },
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      fcntl: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      faccessat: {
        args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32],
        returns: FFIType.i32,
      },
      __errno_location: { args: [], returns: FFIType.ptr },
    } as const)
    const symbols = library.symbols as unknown as {
      openat(parentFd: number, name: unknown, flags: number, mode: number): number
      flock(fd: number, operation: number): number
      fcntl(fd: number, command: number): number
      faccessat(fd: number, name: unknown, mode: number, flags: number): number
      __errno_location(): unknown
    }
    return {
      library,
      openat: symbols.openat,
      flock: symbols.flock,
      fcntl: symbols.fcntl,
      faccessat: symbols.faccessat,
      pointer: ptr,
      errno: () => read.i32(symbols.__errno_location() as Parameters<typeof read.i32>[0]),
    }
  })
  return nativeApiPromise
}

function component(value: string): Buffer {
  if (!value || value === '.' || value === '..' || value.includes('/') ||
    value.includes('\\') || value.includes('\0')) {
    throw new Error('Unsafe host-issued canonical lock component')
  }
  return Buffer.from(`${value}\0`)
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function mountId(fd: number): number {
  const match = /^mnt_id:\s+(\d+)$/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))
  if (!match) throw new Error('Kernel mount identity is unavailable for retained descriptor')
  return Number(match[1])
}

function mode(stats: Stats): number {
  return stats.mode & 0o7777
}

type CredentialStatus = { effectiveUid: number; effectiveGid: number
  capEffective: bigint; capPermitted: bigint; capAmbient: bigint; noNewPrivileges: boolean }

function credentialStatus(): CredentialStatus {
  const effectiveUid = process.geteuid?.()
  const effectiveGid = process.getegid?.()
  if (effectiveUid === undefined || effectiveGid === undefined) {
    throw new Error('Effective application credential is unavailable')
  }
  const status = readFileSync('/proc/self/status', 'utf8')
  const hex = (name: string): bigint => {
    const value = new RegExp(`^${name}:\\s*([0-9a-f]+)$`, 'mi').exec(status)?.[1]
    if (!value) throw new Error(`Kernel credential field ${name} is unavailable`)
    return BigInt(`0x${value}`)
  }
  return {
    effectiveUid,
    effectiveGid,
    capEffective: hex('CapEff'),
    capPermitted: hex('CapPrm'),
    capAmbient: hex('CapAmb'),
    noNewPrivileges: /^NoNewPrivs:\s*1$/m.test(status),
  }
}

const CAP_CHOWN = 1n << 0n
const CAP_DAC_OVERRIDE = 1n << 1n
const CAP_FOWNER = 1n << 3n
const CAP_SYS_ADMIN = 1n << 21n
const NAMESPACE_MUTATION_CAPS = CAP_CHOWN | CAP_DAC_OVERRIDE | CAP_FOWNER | CAP_SYS_ADMIN

function hasAnyCapability(status: CredentialStatus, mask: bigint): boolean {
  return !!((status.capEffective | status.capPermitted | status.capAmbient) & mask)
}

function mountIsReadOnly(fd: number): boolean {
  const id = mountId(fd)
  const line = readFileSync('/proc/self/mountinfo', 'utf8')
    .split('\n').find(candidate => candidate.startsWith(`${id} `))
  if (!line) throw new Error(`Kernel mount ${id} is unavailable`)
  const options = line.split(' - ')[0]?.split(' ')[5]?.split(',') ?? []
  return options.includes('ro')
}

async function assertProtectedEntryChain(path: string, label: string): Promise<void> {
  if (!isAbsolute(path) || realpathSync(path) !== path) {
    throw new Error(`${label} is not an absolute, symlink-free real path`)
  }
  const credential = credentialStatus()
  const root = parse(path).root
  const parts = relative(root, path).split('/').filter(Boolean)
  let parentPath = root
  for (const part of parts) {
    const childPath = join(parentPath, part)
    const childStats = lstatSync(childPath)
    if (childStats.isSymbolicLink()) throw new Error(`${label} contains a symbolic-link ancestor`)
    const parentFd = openSync(parentPath,
      constants.O_RDONLY | constants.O_DIRECTORY | requiredCloseOnExecFlag() | (constants.O_NOFOLLOW ?? 0))
    try {
      const parentStats = fstatSync(parentFd)
      if (mountIsReadOnly(parentFd)) {
        if (!credential.noNewPrivileges || hasAnyCapability(credential, CAP_SYS_ADMIN)) {
          throw new Error(`${label} read-only mount is not qualified against application mount authority: ${parentPath}`)
        }
        // This is a kernel decision for the effective uid, effective gid,
        // supplementary groups, ACL selection, and effective capabilities;
        // no caller-provided readOnly assertion participates in admission.
        await assertKernelDeniesWrite(parentFd, `${label} read-only ancestor ${parentPath}`)
      } else {
        if (parentStats.uid !== 0 || parentStats.uid === credential.effectiveUid) {
          throw new Error(`${label} has an owner-chmod replaceable ancestor: ${parentPath}`)
        }
        if (hasAnyCapability(credential, NAMESPACE_MUTATION_CAPS)) {
          throw new Error(`${label} application credential retains namespace mutation capabilities`)
        }
        const canWrite = await kernelCredentialCanWrite(parentFd, `${label} ancestor ${parentPath}`)
        if (canWrite) {
          const stickyProtects = !!(mode(parentStats) & 0o1000) &&
            childStats.uid !== credential.effectiveUid &&
            parentStats.uid !== credential.effectiveUid &&
            !hasAnyCapability(credential, CAP_FOWNER)
          if (!stickyProtects) {
            throw new Error(`${label} has a replaceable ancestor entry: ${childPath}`)
          }
        }
      }
    } finally {
      closeSync(parentFd)
    }
    parentPath = childPath
  }
}

function assertHostProtectedDirectory(stats: Stats, label: string): void {
  if (!stats.isDirectory() || stats.uid !== 0) {
    throw new Error(`${label} is not a host-owned non-writable directory`)
  }
}

function assertHostProtectedFile(stats: Stats, label: string): void {
  if (!stats.isFile() || stats.uid !== 0 || mode(stats) !== 0o444 ||
    stats.nlink !== 1) {
    throw new Error(`${label} is not a root-owned 0444 single-link regular file`)
  }
}

function requiredCloseOnExecFlag(): number {
  if (typeof constants.O_CLOEXEC === 'number' && constants.O_CLOEXEC !== 0) {
    return constants.O_CLOEXEC
  }
  // Bun omits this export. Linux asm-generic/fcntl.h defines it as 02000000.
  if (process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64')) {
    return 0o2000000
  }
  throw new Error('Linux O_CLOEXEC is required for canonical team descriptor custody')
}

async function assertCloseOnExec(fd: number, label: string): Promise<void> {
  const api = await nativeApi()
  const flags = api.fcntl(fd, 1) // F_GETFD
  if (flags < 0) throw new Error(`${label} descriptor flags are unavailable (errno ${api.errno()})`)
  if (!(flags & 1)) throw new Error(`${label} descriptor is not close-on-exec`)
}

async function kernelCredentialCanWrite(fd: number, label: string): Promise<boolean> {
  const api = await nativeApi()
  // AT_EMPTY_PATH asks the kernel about this retained descriptor; AT_EACCESS
  // uses the effective application credential and therefore includes ACLs.
  if (api.faccessat(fd, api.pointer(Buffer.from('\0')), 2, 0x1000 | 0x200) === 0) {
    return true
  }
  const errno = api.errno()
  // Linux reports EROFS, rather than EACCES, when mode/ACL permits W_OK on a
  // read-only mount. Qualify that result from this exact descriptor and the
  // live credential; a caller assertion must never turn EROFS into evidence.
  if (errno === 30) {
    const credential = credentialStatus()
    if (!mountIsReadOnly(fd) || !credential.noNewPrivileges ||
      hasAnyCapability(credential, CAP_SYS_ADMIN)) {
      throw new Error(`${label} read-only mount is not qualified against application mount authority`)
    }
    return false
  }
  if (errno !== 13) {
    throw new Error(`${label} write-protection check failed (errno ${errno})`)
  }
  return false
}

async function assertKernelDeniesWrite(fd: number, label: string): Promise<void> {
  if (await kernelCredentialCanWrite(fd, label)) {
    throw new Error(`${label} is writable by the application credential`)
  }
}

export type HostIssuedCanonicalTeamLockBinding = { protocolVersion: typeof PROTOCOL_VERSION
  registrationId: string; publicTeamId: string; legacyKey: string
  storageGeneration: string; admittedWriterImage: string; canonicalTeamRoot: string
  root: { dev: number; ino: number; mountId: number }
  rootParent: { dev: number; ino: number; mountId: number }
  anchor: { dev: number; ino: number; mountId: number }
  anchorParent: { dev: number; ino: number; mountId: number }
}

/**
 * Descriptors are opened and retained by the host admission owner. Passing
 * paths alone can never install an authority. The issuer must keep every fd
 * open until it revokes the returned authority and all users have drained.
 */
export type RetainedHostCanonicalTeamLockRegistration = {
  binding: Omit<HostIssuedCanonicalTeamLockBinding, 'root' | 'rootParent' | 'anchor' | 'anchorParent'>
  rootFd: number; rootParentFd: number; rootName: string
  anchorFd: number; anchorParentFd: number; anchorName: string
  bindingRecordFd: number; bindingRecordName: string
}

export type CanonicalTeamLockAuthority = Readonly<{ readonly __opaque: unique symbol }>

type Registration = { handle: CanonicalTeamLockAuthority
  binding: HostIssuedCanonicalTeamLockBinding
  rootFd: number; rootParentFd: number; anchorFd: number; anchorParentFd: number
  anchorParentPath: string; anchorName: string
  bindingRecordFd: number; bindingRecordName: string; revoked: boolean }

const byHandle = new WeakMap<object, Registration>(), byRoot = new Map<string, Registration>()
const byPublicTeam = new Map<string, Registration>(), byRegistrationId = new Map<string, Registration>()
type ActiveAcquisition = { registration: Registration; active: boolean }
const activeAuthority = new AsyncLocalStorage<ActiveAcquisition>()

function requireRegistration(authority: CanonicalTeamLockAuthority): Registration {
  const registration = byHandle.get(authority as object)
  if (!registration || registration.revoked) throw new Error('Canonical team lock authority is absent, forged, stale, or revoked')
  return registration
}

function readBindingRecord(fd: number): HostIssuedCanonicalTeamLockBinding {
  let parsed: unknown
  try {
    const size = fstatSync(fd).size
    if (size <= 0 || size > 64 * 1024) throw new Error('invalid binding record size')
    const bytes = Buffer.alloc(size)
    let offset = 0
    while (offset < size) {
      const count = readSync(fd, bytes, offset, size - offset, offset)
      if (count <= 0) throw new Error('short binding record read')
      offset += count
    }
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new Error('Host-issued canonical lock binding record is unreadable', { cause: error })
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Host-issued canonical lock binding record is invalid')
  return parsed as HostIssuedCanonicalTeamLockBinding
}

function equalBinding(left: HostIssuedCanonicalTeamLockBinding, right: HostIssuedCanonicalTeamLockBinding): boolean {
  return left.protocolVersion === right.protocolVersion &&
    left.registrationId === right.registrationId &&
    left.publicTeamId === right.publicTeamId &&
    left.legacyKey === right.legacyKey &&
    left.storageGeneration === right.storageGeneration &&
    left.admittedWriterImage === right.admittedWriterImage &&
    left.canonicalTeamRoot === right.canonicalTeamRoot &&
    left.root?.dev === right.root.dev && left.root?.ino === right.root.ino && left.root?.mountId === right.root.mountId &&
    left.rootParent?.dev === right.rootParent.dev && left.rootParent?.ino === right.rootParent.ino &&
    left.rootParent?.mountId === right.rootParent.mountId &&
    left.anchor?.dev === right.anchor.dev && left.anchor?.ino === right.anchor.ino &&
    left.anchor?.mountId === right.anchor.mountId &&
    left.anchorParent?.dev === right.anchorParent.dev && left.anchorParent?.ino === right.anchorParent.ino &&
    left.anchorParent?.mountId === right.anchorParent.mountId
}

async function openAt(parentFd: number, name: string, flags: number): Promise<{ fd: number; errno: number }> {
  const api = await nativeApi()
  const fd = api.openat(parentFd, api.pointer(component(name)), flags, 0)
  return { fd, errno: fd < 0 ? api.errno() : 0 }
}

async function assertNamedIdentity(
  parentFd: number,
  name: string,
  expected: Stats,
  flags: number,
  expectedMountId: number,
  label: string,
): Promise<void> {
  const opened = await openAt(parentFd, name, flags)
  if (opened.fd < 0) throw new Error(`${label} cannot be opened from its retained parent (errno ${opened.errno})`)
  try {
    if (!sameIdentity(expected, fstatSync(opened.fd)) || mountId(opened.fd) !== expectedMountId) {
      throw new Error(`${label} no longer has its registered inode or mount identity`)
    }
    await assertCloseOnExec(opened.fd, label)
  } finally {
    closeSync(opened.fd)
  }
}

async function assertCanonicalParentAndEntry(
  parentPath: string,
  expectedParent: Stats,
  expectedParentMountId: number,
  entryName: string,
  expectedEntry: Stats,
  expectedEntryMountId: number,
  entryFlags: number,
  label: string,
): Promise<void> {
  const parentFd = openSync(parentPath,
    constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0) | requiredCloseOnExecFlag())
  try {
    if (!sameIdentity(expectedParent, fstatSync(parentFd)) || mountId(parentFd) !== expectedParentMountId) {
      throw new Error(`${label} path does not share the retained parent inode and mount identity`)
    }
    await assertCloseOnExec(parentFd, `${label} path parent`)
    await assertKernelDeniesWrite(parentFd, `${label} mutation parent`)
    await assertNamedIdentity(parentFd, entryName, expectedEntry, entryFlags,
      expectedEntryMountId, `${label} entry`)
  } finally {
    closeSync(parentFd)
  }
}

async function assertRegistration(registration: Registration): Promise<void> {
  if (registration.revoked || byRoot.get(registration.binding.canonicalTeamRoot) !== registration ||
    byPublicTeam.get(registration.binding.publicTeamId) !== registration ||
    byRegistrationId.get(registration.binding.registrationId) !== registration) {
    throw new Error('Canonical team lock authority was revoked or superseded')
  }
  const root = fstatSync(registration.rootFd)
  const rootParent = fstatSync(registration.rootParentFd)
  const anchor = fstatSync(registration.anchorFd)
  const anchorParent = fstatSync(registration.anchorParentFd)
  const record = fstatSync(registration.bindingRecordFd)
  assertHostProtectedDirectory(rootParent, 'Canonical team root parent')
  assertHostProtectedDirectory(anchorParent, 'Canonical team lock anchor parent')
  assertHostProtectedFile(anchor, 'Canonical team lock anchor')
  assertHostProtectedFile(record, 'Canonical team lock binding record')
  await assertKernelDeniesWrite(registration.rootParentFd, 'Canonical team root parent')
  await assertKernelDeniesWrite(registration.anchorParentFd, 'Canonical team lock anchor parent')
  await assertKernelDeniesWrite(registration.anchorFd, 'Canonical team lock anchor')
  await assertKernelDeniesWrite(registration.bindingRecordFd, 'Canonical team lock binding record')
  await Promise.all([
    assertCloseOnExec(registration.rootFd, 'Canonical team retained root'),
    assertCloseOnExec(registration.rootParentFd, 'Canonical team retained root parent'),
    assertCloseOnExec(registration.anchorFd, 'Canonical team retained lock anchor'),
    assertCloseOnExec(registration.anchorParentFd, 'Canonical team retained lock parent'),
    assertCloseOnExec(registration.bindingRecordFd, 'Canonical team retained binding record'),
  ])
  if (!root.isDirectory()) throw new Error('Canonical team retained root is not a directory')
  const expected = registration.binding
  if (root.dev !== expected.root.dev || root.ino !== expected.root.ino || mountId(registration.rootFd) !== expected.root.mountId ||
    rootParent.dev !== expected.rootParent.dev || rootParent.ino !== expected.rootParent.ino ||
    mountId(registration.rootParentFd) !== expected.rootParent.mountId ||
    anchor.dev !== expected.anchor.dev || anchor.ino !== expected.anchor.ino ||
    mountId(registration.anchorFd) !== expected.anchor.mountId ||
    anchorParent.dev !== expected.anchorParent.dev || anchorParent.ino !== expected.anchorParent.ino ||
    mountId(registration.anchorParentFd) !== expected.anchorParent.mountId) {
    throw new Error('Canonical team retained registration descriptor identity changed')
  }
  await assertNamedIdentity(
    registration.rootParentFd, basename(expected.canonicalTeamRoot), root,
    constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0) | requiredCloseOnExecFlag(),
    expected.root.mountId,
    'Canonical team root entry',
  )
  await assertNamedIdentity(
    registration.anchorParentFd, registration.anchorName, anchor,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0) | requiredCloseOnExecFlag(),
    expected.anchor.mountId,
    'Canonical team lock anchor',
  )
  await assertNamedIdentity(
    registration.anchorParentFd, registration.bindingRecordName, record,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0) | requiredCloseOnExecFlag(),
    mountId(registration.bindingRecordFd),
    'Canonical team lock binding record',
  )
  const rootFlags = constants.O_RDONLY | constants.O_DIRECTORY |
    (constants.O_NOFOLLOW ?? 0) | requiredCloseOnExecFlag()
  await assertCanonicalParentAndEntry(
    dirname(expected.canonicalTeamRoot), rootParent, expected.rootParent.mountId,
    basename(expected.canonicalTeamRoot), root, expected.root.mountId, rootFlags,
    'Canonical team root',
  )
  await assertCanonicalParentAndEntry(
    registration.anchorParentPath, anchorParent, expected.anchorParent.mountId,
    registration.anchorName, anchor, expected.anchor.mountId,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0) |
      requiredCloseOnExecFlag(),
    'Canonical team registry',
  )
  if (!equalBinding(readBindingRecord(registration.bindingRecordFd), expected)) {
    throw new Error('Canonical team protected binding record changed')
  }
}

export async function admitCanonicalTeamLockAuthority(
  input: RetainedHostCanonicalTeamLockRegistration,
): Promise<CanonicalTeamLockAuthority> {
  await nativeApi()
  if (input.binding.protocolVersion !== PROTOCOL_VERSION ||
    !isAbsolute(input.binding.canonicalTeamRoot) || input.rootName !== basename(input.binding.canonicalTeamRoot) ||
    dirname(input.binding.canonicalTeamRoot) === input.binding.canonicalTeamRoot ||
    input.anchorName === input.bindingRecordName ||
    !input.binding.registrationId || !input.binding.publicTeamId || !input.binding.legacyKey ||
    !input.binding.storageGeneration || !input.binding.admittedWriterImage) {
    throw new Error('Host-issued canonical lock registration fields are invalid')
  }
  const root = fstatSync(input.rootFd)
  const rootParent = fstatSync(input.rootParentFd)
  const anchor = fstatSync(input.anchorFd)
  const anchorParent = fstatSync(input.anchorParentFd)
  const binding: HostIssuedCanonicalTeamLockBinding = Object.freeze({
    ...input.binding,
    protocolVersion: PROTOCOL_VERSION,
    root: Object.freeze({ dev: root.dev, ino: root.ino, mountId: mountId(input.rootFd) }),
    rootParent: Object.freeze({ dev: rootParent.dev, ino: rootParent.ino, mountId: mountId(input.rootParentFd) }),
    anchor: Object.freeze({ dev: anchor.dev, ino: anchor.ino, mountId: mountId(input.anchorFd) }),
    anchorParent: Object.freeze({ dev: anchorParent.dev, ino: anchorParent.ino, mountId: mountId(input.anchorParentFd) }),
  })
  const protectedRecord = readBindingRecord(input.bindingRecordFd)
  if (!equalBinding(protectedRecord, binding)) throw new Error('Protected binding record does not exactly bind the retained descriptors')
  if (byRoot.has(binding.canonicalTeamRoot) || byPublicTeam.has(binding.publicTeamId) ||
    byRegistrationId.has(binding.registrationId)) {
    throw new Error('Canonical team root, public team, or registration identity is already admitted')
  }
  await assertProtectedEntryChain(dirname(binding.canonicalTeamRoot), 'Canonical team root parent chain')
  const anchorParentPath = realpathSync(`/proc/self/fd/${input.anchorParentFd}`)
  await assertProtectedEntryChain(anchorParentPath, 'Canonical team registry chain')
  await assertCanonicalParentAndEntry(
    dirname(binding.canonicalTeamRoot), rootParent, binding.rootParent.mountId,
    basename(binding.canonicalTeamRoot), root, binding.root.mountId,
    constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0) |
      requiredCloseOnExecFlag(),
    'Canonical team root',
  )
  await assertCanonicalParentAndEntry(
    anchorParentPath, anchorParent, binding.anchorParent.mountId,
    input.anchorName, anchor, binding.anchor.mountId,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0) |
      requiredCloseOnExecFlag(),
    'Canonical team registry',
  )
  const handle = Object.freeze({}) as CanonicalTeamLockAuthority
  const registration: Registration = {
    handle, binding,
    rootFd: input.rootFd, rootParentFd: input.rootParentFd,
    anchorFd: input.anchorFd, anchorParentFd: input.anchorParentFd,
    anchorParentPath, anchorName: input.anchorName, bindingRecordFd: input.bindingRecordFd,
    bindingRecordName: input.bindingRecordName, revoked: false,
  }
  byHandle.set(handle as object, registration)
  byRoot.set(binding.canonicalTeamRoot, registration)
  byPublicTeam.set(binding.publicTeamId, registration)
  byRegistrationId.set(binding.registrationId, registration)
  try { await assertRegistration(registration) } catch (error) {
    registration.revoked = true
    byRoot.delete(binding.canonicalTeamRoot)
    byPublicTeam.delete(binding.publicTeamId)
    byRegistrationId.delete(binding.registrationId)
    throw error
  }
  return handle
}

export function revokeCanonicalTeamLockAuthority(authority: CanonicalTeamLockAuthority): void {
  const registration = requireRegistration(authority)
  registration.revoked = true
  if (byRoot.get(registration.binding.canonicalTeamRoot) === registration) {
    byRoot.delete(registration.binding.canonicalTeamRoot)
  }
  if (byPublicTeam.get(registration.binding.publicTeamId) === registration) {
    byPublicTeam.delete(registration.binding.publicTeamId)
  }
  if (byRegistrationId.get(registration.binding.registrationId) === registration) {
    byRegistrationId.delete(registration.binding.registrationId)
  }
}

export function resolveCanonicalTeamLockAuthority(
  canonicalTeamRoot: string,
  legacyKey: string,
): CanonicalTeamLockAuthority {
  const registration = byRoot.get(canonicalTeamRoot)
  if (!registration || registration.revoked || registration.binding.legacyKey !== legacyKey) {
    throw new Error(`No current host-issued canonical lock authority for root: ${canonicalTeamRoot}`)
  }
  return registration.handle
}

export type CanonicalTeamLockDeadline = {
  deadlineMs: number; signal?: AbortSignal; pollIntervalMs?: number }

type FlockTestResult = { result: number; errno: number }
let flockAttemptForTests: ((fd: number, operation: number) => FlockTestResult) | null = null

export function __setCanonicalTeamLockFlockAttemptForTests(
  attempt: ((fd: number, operation: number) => FlockTestResult) | null,
): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('__setCanonicalTeamLockFlockAttemptForTests is only available in tests')
  }
  flockAttemptForTests = attempt
}

function abortError(): Error {
  const error = new Error('Canonical team lock acquisition was cancelled')
  error.name = 'AbortError'
  return error
}

async function boundedPause(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms)
    const aborted = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); reject(abortError()) }
    function done() { signal?.removeEventListener('abort', aborted); resolve() }
    signal?.addEventListener('abort', aborted, { once: true })
  })
}

function aggregate(primaryFailed: boolean, primary: unknown, secondary: unknown, message: string): unknown {
  if (!primaryFailed) return secondary
  return new AggregateError([primary, secondary], message)
}

function assertAcquisitionMayContinue(deadline: CanonicalTeamLockDeadline, busy: boolean): void {
  if (deadline.signal?.aborted) throw abortError()
  if (Date.now() >= deadline.deadlineMs) {
    throw new Error(busy
      ? 'Canonical team lock remained busy through its deadline'
      : 'Canonical team lock deadline expired before callback entry')
  }
}

function flockAttempt(api: NativeApi, fd: number, operation: number): FlockTestResult {
  if (flockAttemptForTests && operation === (LOCK_EX | LOCK_NB)) {
    return flockAttemptForTests(fd, operation)
  }
  const result = api.flock(fd, operation)
  return { result, errno: result < 0 ? api.errno() : 0 }
}

export async function withCanonicalTeamLock<T>(
  authority: CanonicalTeamLockAuthority,
  deadline: CanonicalTeamLockDeadline,
  fn: (rootFd: number) => Promise<T>,
): Promise<T> {
  const registration = requireRegistration(authority)
  const inherited = activeAuthority.getStore()
  if (inherited?.registration === registration && inherited.active) {
    throw new Error('Nested canonical team lock acquisition is not allowed')
  }
  if (!Number.isFinite(deadline.deadlineMs) || deadline.deadlineMs <= Date.now()) {
    throw new Error('Canonical team lock deadline has expired')
  }
  await assertRegistration(registration)
  const api = await nativeApi()
  const opened = await openAt(
    registration.anchorParentFd,
    registration.anchorName,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0) | requiredCloseOnExecFlag(),
  )
  if (opened.fd < 0) throw new Error(`Canonical team lock anchor open failed (errno ${opened.errno})`)
  let primaryError: unknown
  let primaryFailed = false
  let result!: T
  let acquired = false
  try {
    const fresh = fstatSync(opened.fd)
    const retained = fstatSync(registration.anchorFd)
    assertHostProtectedFile(fresh, 'Fresh canonical team lock descriptor')
    if (!sameIdentity(fresh, retained) || mountId(opened.fd) !== registration.binding.anchor.mountId) {
      throw new Error('Fresh canonical team lock descriptor has the wrong inode or mount identity')
    }
    await assertCloseOnExec(opened.fd, 'Fresh canonical team lock')
    let interrupted = 0
    for (;;) {
      assertAcquisitionMayContinue(deadline, false)
      const attempt = flockAttempt(api, opened.fd, LOCK_EX | LOCK_NB)
      if (attempt.result === 0) {
        acquired = true
        assertAcquisitionMayContinue(deadline, false)
        break
      }
      const errno = attempt.errno
      if (errno === EINTR) {
        if (++interrupted % 8 === 0) await boundedPause(0, deadline.signal)
        continue
      }
      if (errno !== EAGAIN) throw new Error(`Canonical team flock acquisition failed (errno ${errno})`)
      const remaining = deadline.deadlineMs - Date.now()
      if (remaining <= 0) throw new Error('Canonical team lock remained busy through its deadline')
      await boundedPause(Math.min(deadline.pollIntervalMs ?? 10, remaining), deadline.signal)
    }
    await assertRegistration(registration)
    assertAcquisitionMayContinue(deadline, false)
    const acquisition: ActiveAcquisition = { registration, active: true }
    let callbackError: unknown
    let callbackFailed = false
    try {
      result = await activeAuthority.run(acquisition, () => fn(registration.rootFd))
    } catch (error) {
      callbackError = error
      callbackFailed = true
    } finally {
      acquisition.active = false
    }
    try {
      await assertRegistration(registration)
    } catch (validationError) {
      if (callbackFailed) {
        throw new AggregateError(
          [callbackError, validationError],
          'Canonical team callback failed and its retained authority was lost',
        )
      }
      throw validationError
    }
    if (callbackFailed) throw callbackError
  } catch (error) {
    primaryError = error
    primaryFailed = true
  } finally {
    if (acquired && api.flock(opened.fd, LOCK_UN) !== 0) {
      primaryError = aggregate(primaryFailed, primaryError, new Error(`Canonical team flock release failed (errno ${api.errno()})`), 'Canonical team callback and release both failed')
      primaryFailed = true
    }
    try { closeSync(opened.fd) } catch (error) {
      primaryError = aggregate(primaryFailed, primaryError, error, 'Canonical team lock operation and descriptor close both failed')
      primaryFailed = true
    }
  }
  if (primaryFailed) throw primaryError
  return result
}

export function activeCanonicalTeamRootFd(authority: CanonicalTeamLockAuthority): number | null {
  const registration = requireRegistration(authority)
  const acquisition = activeAuthority.getStore()
  return acquisition?.registration === registration && acquisition.active
    ? registration.rootFd
    : null
}

export async function withValidatedCanonicalTeamRoot<T>(
  authority: CanonicalTeamLockAuthority,
  fn: (rootFd: number) => Promise<T>,
): Promise<T> {
  const registration = requireRegistration(authority)
  await assertRegistration(registration)
  const result = await fn(registration.rootFd)
  await assertRegistration(registration)
  return result
}
