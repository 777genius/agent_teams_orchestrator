import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, statSync } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isAbsolute, join, parse, resolve, sep } from 'node:path'

export const HOSTED_MEMBER_ADMISSION_FORMAT = 'agent-teams.hosted-opencode-member-admission/v1'
export const HOSTED_MEMBER_ADMISSION_POLICY_ID = 'hosted-opencode-member-v1'
const DOMAIN = Buffer.from(`${HOSTED_MEMBER_ADMISSION_FORMAT}\0`, 'utf8')
const HEX32 = /^[0-9a-f]{32}$/
const HEX64 = /^[0-9a-f]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const GRANT = /^grant_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/
const AUTH_GENERATION = /^authorization-generation_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/
const OWNER_SESSION = /^owner-session_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/
const MAX_WIRE_BYTES = 8_192
const MAX_RECORD_BYTES = 512
const CLOCK_SKEW_MS = 5_000

const PAYLOAD_KEYS = [
  'admissionId', 'authorizationGeneration', 'bootId', 'deploymentId', 'expiresAtMs',
  'format', 'grantId', 'grantRevision', 'issuedAtMs', 'laneId', 'memberId',
  'memberName', 'memberOrdinal', 'model', 'mountGeneration', 'operationId',
  'ownerGeneration', 'ownerSessionId', 'planGeneration', 'planSha256', 'policyId',
  'promptSha256', 'restoreGeneration', 'runId', 'teamId', 'workspaceId',
] as const

export type HostedMemberAdmissionPayload = Readonly<{
  admissionId: string
  authorizationGeneration: string
  bootId: string
  deploymentId: string
  expiresAtMs: number
  format: typeof HOSTED_MEMBER_ADMISSION_FORMAT
  grantId: string
  grantRevision: string
  issuedAtMs: number
  laneId: string
  memberId: string
  memberName: string
  memberOrdinal: number
  model: string
  mountGeneration: number
  operationId: string
  ownerGeneration: number
  ownerSessionId: string
  planGeneration: string
  planSha256: string
  policyId: string
  promptSha256: string
  restoreGeneration: number
  runId: string
  teamId: string
  workspaceId: string
}>

/** A separate root-owned Product/launcher channel must supply these exact current pins. */
export type LiveProductMemberAuthority = Readonly<Omit<HostedMemberAdmissionPayload,
  'format' | 'admissionId' | 'issuedAtMs' | 'expiresAtMs'>>

export type VerifiedHostedMemberAdmission = Readonly<{
  payload: HostedMemberAdmissionPayload
  envelopeSha256: string
}>

export type HostedMemberAdmissionClaim = Readonly<{
  admissionId: string
  envelopeSha256: string
}>

export type HostedMemberAdmissionRootConfig = Readonly<{
  /** Pinned DER SPKI obtained from root-owned deployment config, never from Owner RPC. */
  productPublicKeyDer?: Uint8Array
  /** Existing root-private durable directory; this module never creates it. */
  stateDirectory: string
  /** Independent Product/launcher observation; Owner HMAC is not sufficient. */
  readLiveProductAuthority?: () => Promise<LiveProductMemberAuthority | null>
  /** Synthetic fixtures only. Production root state must have root-owned, non-writable ancestors. */
  testOnlyAllowNonRoot?: boolean
  now?: () => number
}>

function invalid(): never { throw new Error('hosted-member-admission-invalid') }
function unavailable(): never { throw new Error('hosted-member-admission-unavailable') }
function sha(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return object(value) && Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key))
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.normalize('NFC') &&
    Buffer.byteLength(value, 'utf8') <= 256 && !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)
}

function parsePayload(value: unknown): HostedMemberAdmissionPayload {
  if (!exact(value, PAYLOAD_KEYS) || value.format !== HOSTED_MEMBER_ADMISSION_FORMAT ||
    typeof value.admissionId !== 'string' || !HEX32.test(value.admissionId) ||
    typeof value.grantRevision !== 'string' || !HEX64.test(value.grantRevision) ||
    typeof value.planSha256 !== 'string' || !HEX64.test(value.planSha256) ||
    typeof value.promptSha256 !== 'string' || !HEX64.test(value.promptSha256) ||
    typeof value.grantId !== 'string' || !GRANT.test(value.grantId) ||
    typeof value.authorizationGeneration !== 'string' || !AUTH_GENERATION.test(value.authorizationGeneration) ||
    typeof value.ownerSessionId !== 'string' || !OWNER_SESSION.test(value.ownerSessionId) ||
    value.planGeneration !== `plan-generation_${value.planSha256}` ||
    !positiveInteger(value.issuedAtMs) || !positiveInteger(value.expiresAtMs) ||
    value.expiresAtMs <= value.issuedAtMs || value.expiresAtMs - value.issuedAtMs > 60_000 ||
    !nonnegativeInteger(value.restoreGeneration) || !positiveInteger(value.ownerGeneration) ||
    !positiveInteger(value.mountGeneration) || !nonnegativeInteger(value.memberOrdinal) ||
    !validName(value.memberName) || typeof value.model !== 'string' || !MODEL.test(value.model) ||
    !['bootId', 'deploymentId', 'laneId', 'memberId', 'operationId',
      'policyId', 'runId', 'teamId', 'workspaceId'].every(key =>
      typeof value[key] === 'string' && ID.test(value[key]))) invalid()
  return Object.freeze(value) as HostedMemberAdmissionPayload
}

function canonical(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])))
}

function readCanonicalEnvelope(raw: Uint8Array): { payload: HostedMemberAdmissionPayload; signature: Buffer } {
  if (raw.byteLength < 1 || raw.byteLength > MAX_WIRE_BYTES) invalid()
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw) }
  catch { invalid() }
  let parsed: unknown
  try { parsed = JSON.parse(text) }
  catch { invalid() }
  if (!exact(parsed, ['payload', 'signature']) || typeof parsed.signature !== 'string' ||
    !/^[A-Za-z0-9_-]{86}$/.test(parsed.signature)) invalid()
  const payload = parsePayload(parsed.payload)
  const signature = Buffer.from(parsed.signature, 'base64url')
  if (signature.length !== 64 || signature.toString('base64url') !== parsed.signature ||
    text !== canonical({ payload: JSON.parse(canonical(payload as Record<string, unknown>)), signature: parsed.signature })) invalid()
  return { payload, signature }
}

class DurableOneShotRecords {
  private readonly pinned: Readonly<{ dev: number; ino: number }>

  constructor(readonly directory: string, private readonly testOnlyAllowNonRoot: boolean) {
    if (!isAbsolute(directory) || resolve(directory) !== directory) invalid()
    this.pinned = this.inspectDirectory()
  }

  private inspectDirectory(): Readonly<{ dev: number; ino: number }> {
    const uid = process.getuid?.()
    if (this.testOnlyAllowNonRoot && process.env.NODE_ENV !== 'test') unavailable()
    if (uid === undefined || (!this.testOnlyAllowNonRoot && uid !== 0)) unavailable()
    const rootPath = parse(this.directory).root
    let ancestor = rootPath
    let parentTrusted = true
    for (const segment of this.directory.slice(rootPath.length).split(sep).filter(Boolean)) {
      ancestor = join(ancestor, segment)
      const entry = lstatSync(ancestor)
      if (entry.isSymbolicLink()) {
        if (!this.testOnlyAllowNonRoot || !parentTrusted || entry.uid !== 0 ||
          !statSync(ancestor).isDirectory()) unavailable()
      } else if (!entry.isDirectory()) unavailable()
      if (!entry.isSymbolicLink()) {
        const strict = entry.uid === 0 && (entry.mode & 0o022) === 0
        const testPrivate = this.testOnlyAllowNonRoot && entry.uid === uid && (entry.mode & 0o022) === 0
        const testSticky = this.testOnlyAllowNonRoot && entry.uid === 0 && (entry.mode & 0o1000) !== 0
        if (!strict && !testPrivate && !testSticky) unavailable()
        parentTrusted = strict
      } else parentTrusted = false
    }
    const pathStat = lstatSync(this.directory)
    if (!pathStat.isDirectory() || pathStat.isSymbolicLink() ||
      pathStat.uid !== uid || (pathStat.mode & 0o077) !== 0) unavailable()
    const fd = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      const opened = fstatSync(fd)
      if (opened.dev !== pathStat.dev || opened.ino !== pathStat.ino) unavailable()
      return { dev: opened.dev, ino: opened.ino }
    } finally { closeSync(fd) }
  }

  private async root() {
    const identity = this.inspectDirectory()
    if (identity.dev !== this.pinned.dev || identity.ino !== this.pinned.ino) unavailable()
    const handle = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const opened = await handle.stat()
    if (opened.dev !== this.pinned.dev || opened.ino !== this.pinned.ino) {
      await handle.close()
      unavailable()
    }
    return handle
  }

  private async assertRootStable(root: Awaited<ReturnType<DurableOneShotRecords['root']>>): Promise<void> {
    const [opened, current] = await Promise.all([root.stat(), lstat(this.directory)])
    if (!current.isDirectory() || current.isSymbolicLink() || opened.dev !== current.dev ||
      opened.ino !== current.ino || opened.dev !== this.pinned.dev ||
      opened.ino !== this.pinned.ino || opened.uid !== process.getuid?.() ||
      (opened.mode & 0o077) !== 0) unavailable()
  }

  async read(name: string): Promise<string | null> {
    const root = await this.root()
    try {
      let file
      try { file = await open(join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          await this.assertRootStable(root)
          return null
        }
        throw error
      }
      try {
        const stat = await file.stat()
        const pathStat = await lstat(join(this.directory, name))
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() ||
          (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > MAX_RECORD_BYTES ||
          stat.dev !== pathStat.dev || stat.ino !== pathStat.ino) unavailable()
        const value = await file.readFile('utf8')
        if (!/^[0-9a-f]{64}$/.test(value)) unavailable()
        await this.assertRootStable(root)
        return value
      } finally { await file.close() }
    } finally { await root.close() }
  }

  async create(name: string, digest: string): Promise<void> {
    const root = await this.root()
    try {
      const file = await open(join(this.directory, name),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try {
        await file.writeFile(digest)
        await file.sync()
        const [stat, pathStat] = await Promise.all([file.stat(), lstat(join(this.directory, name))])
        if (stat.dev !== pathStat.dev || stat.ino !== pathStat.ino || stat.nlink !== 1) unavailable()
        await this.assertRootStable(root)
        await root.sync()
      } finally { await file.close() }
    } finally { await root.close() }
  }
}

/** Inactive until production passes both a root-pinned Product key and independent liveness port. */
export class HostedMemberAdmissionVerifier {
  private readonly key: KeyObject | null
  private readonly files: DurableOneShotRecords
  private readonly liveClaims = new WeakSet<object>()
  private readonly now: () => number
  private readonly readLiveProductAuthority: (() => Promise<LiveProductMemberAuthority | null>) | undefined

  constructor(config: HostedMemberAdmissionRootConfig) {
    this.files = new DurableOneShotRecords(config.stateDirectory, config.testOnlyAllowNonRoot === true)
    this.now = config.now ?? Date.now
    this.readLiveProductAuthority = config.readLiveProductAuthority
    try {
      const key = config.productPublicKeyDer && createPublicKey({ key: Buffer.from(config.productPublicKeyDer),
        format: 'der', type: 'spki' })
      this.key = key?.asymmetricKeyType === 'ed25519' &&
        Buffer.from(key.export({ format: 'der', type: 'spki' })).equals(config.productPublicKeyDer!) ? key : null
    } catch { this.key = null }
  }

  verify(raw: Uint8Array): VerifiedHostedMemberAdmission {
    return this.verifySigned(raw, true)
  }

  private verifySigned(raw: Uint8Array, checkTime: boolean): VerifiedHostedMemberAdmission {
    if (!this.key || !this.readLiveProductAuthority) unavailable()
    const { payload, signature } = readCanonicalEnvelope(raw)
    const signed = Buffer.concat([DOMAIN, Buffer.from(canonical(payload as Record<string, unknown>), 'utf8')])
    if (!verify(null, signed, this.key, signature)) invalid()
    if (payload.policyId !== HOSTED_MEMBER_ADMISSION_POLICY_ID) invalid()
    if (checkTime) this.assertTime(payload)
    return { payload, envelopeSha256: sha(raw) }
  }

  private assertTime(payload: HostedMemberAdmissionPayload): void {
    const now = this.now()
    if (!Number.isSafeInteger(now) || payload.issuedAtMs > now + CLOCK_SKEW_MS ||
      payload.expiresAtMs <= now) invalid()
  }

  private async assertLive(payload: HostedMemberAdmissionPayload): Promise<void> {
    const read = this.readLiveProductAuthority
    if (!read) unavailable()
    const authority = await read()
    if (!authority || !exact(authority, PAYLOAD_KEYS.filter(key =>
      !['format', 'admissionId', 'issuedAtMs', 'expiresAtMs'].includes(key)))) unavailable()
    for (const key of Object.keys(authority) as (keyof LiveProductMemberAuthority)[]) {
      if (authority[key] !== payload[key]) unavailable()
    }
    this.assertTime(payload)
  }

  /** Creates durable one-shot markers before any prepare or external effect. No retry after an ambiguous crash. */
  async claim(raw: Uint8Array): Promise<HostedMemberAdmissionClaim> {
    const admission = this.verify(raw)
    await this.assertLive(admission.payload)
    const { admissionId, operationId, teamId, runId, laneId, memberId } = admission.payload
    const scope = sha(Buffer.from(JSON.stringify([operationId, teamId, runId, laneId, memberId])))
    const claimName = `admission-${admissionId}.claim`
    const scopeName = `scope-${scope}.claim`
    if (await this.files.read(`admission-${admissionId}.revoked`) ||
      await this.files.read(`scope-${scope}.revoked`) || await this.files.read(claimName) ||
      await this.files.read(scopeName)) unavailable()
    await this.files.create(claimName, admission.envelopeSha256)
    await this.files.create(scopeName, admission.envelopeSha256)
    if (await this.files.read(`admission-${admissionId}.revoked`) ||
      await this.files.read(`scope-${scope}.revoked`)) unavailable()
    await this.assertLive(admission.payload)
    const token = Object.freeze({ admissionId, envelopeSha256: admission.envelopeSha256 })
    this.liveClaims.add(token)
    return token
  }

  /** Must be called immediately before prepare and again at every external effect boundary. */
  async assertCurrent(raw: Uint8Array, claim: HostedMemberAdmissionClaim): Promise<HostedMemberAdmissionPayload> {
    if (!this.liveClaims.has(claim)) unavailable()
    const admission = this.verify(raw)
    if (claim.admissionId !== admission.payload.admissionId ||
      claim.envelopeSha256 !== admission.envelopeSha256) unavailable()
    await this.assertLive(admission.payload)
    const { admissionId, operationId, teamId, runId, laneId, memberId } = admission.payload
    const scope = sha(Buffer.from(JSON.stringify([operationId, teamId, runId, laneId, memberId])))
    if (await this.files.read(`admission-${admissionId}.revoked`) ||
      await this.files.read(`scope-${scope}.revoked`) ||
      await this.files.read(`admission-${admissionId}.claim`) !== admission.envelopeSha256 ||
      await this.files.read(`scope-${scope}.claim`) !== admission.envelopeSha256) unavailable()
    await this.assertLive(admission.payload)
    return admission.payload
  }

  /** Revocation is durable even before claim; an ambiguous partial tombstone fails closed. */
  async revoke(raw: Uint8Array): Promise<void> {
    const admission = this.verifySigned(raw, false)
    const { admissionId, operationId, teamId, runId, laneId, memberId } = admission.payload
    const scope = sha(Buffer.from(JSON.stringify([operationId, teamId, runId, laneId, memberId])))
    for (const name of [`admission-${admissionId}.revoked`, `scope-${scope}.revoked`]) {
      const existing = await this.files.read(name)
      if (existing && existing !== admission.envelopeSha256) unavailable()
      if (!existing) {
        try { await this.files.create(name, admission.envelopeSha256) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST' ||
            await this.files.read(name) !== admission.envelopeSha256) throw error
        }
      }
    }
  }
}
