import { createHash } from 'node:crypto'
import { constants, closeSync, fsyncSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import path from 'node:path'

const API = '/v1.47'
const MAX_BODY = 256 * 1024
const MAX_RESPONSE = 1024 * 1024
const MAX_WRITE_MS = 500
const OPERATION_ID = /^[a-z][a-z0-9_-]{7,127}$/
const DOCKER_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/
const IMAGE_REF = /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/
const SHA = /^[a-f0-9]{64}$/
const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')

export type RootDockerOperation = Readonly<{
  operationId: string
  bodySha256: string
} & (
  | { kind: 'create_network'; body: string }
  | { kind: 'create_container'; containerName: string; body: string }
  | { kind: 'start_container' | 'inspect_container' | 'stop_container'; containerId: string }
  | { kind: 'inspect_network'; networkId: string }
  | { kind: 'inspect_image'; imageRef: string }
)>

export type RootDockerDispatchResult =
  | Readonly<{ outcome: 'responded'; statusCode: number; body: Buffer }>
  | Readonly<{ outcome: 'uncertain'; reason: string }>
  | Readonly<{ outcome: 'already_claimed' | 'claim_conflict' }>

/** The implementation must hold its current Product transaction through the entire callback. */
export interface RootCurrentMemberDecision<Binding> {
  withCurrentMemberDecision<T>(binding: Binding, kind: 'prepare' | 'start' | 'observe' | 'stop',
    callback: (current: unknown) => T): Promise<T>
}

/** Resolve the exact operation from root-owned state, using no caller-supplied body or Docker target. */
export type RootDockerOperationResolver<Binding> = (binding: Readonly<Binding>, current: unknown,
  operationId: string) => RootDockerOperation

function boundedSnapshot<T extends object>(value: T, maxBytes: number): Readonly<T> {
  const seen = new WeakSet<object>()
  let remaining = maxBytes
  let nodes = 0
  const charge = (text: string) => {
    remaining -= Buffer.byteLength(text)
    if (remaining < 0) throw new Error('root-docker-snapshot-too-large')
  }
  const copy = (input: unknown, depth: number): unknown => {
    if (depth > 8 || ++nodes > 256) throw new Error('root-docker-snapshot-too-complex')
    if (typeof input === 'string') { charge(input); return input }
    if (input === null || typeof input === 'boolean') return input
    if (typeof input === 'number' && Number.isFinite(input)) return input
    if (!input || typeof input !== 'object' || seen.has(input)) {
      throw new Error('root-docker-snapshot-invalid')
    }
    seen.add(input)
    if (Array.isArray(input)) {
      if (input.length > 128 || Reflect.ownKeys(input).length !== input.length + 1) {
        throw new Error('root-docker-snapshot-invalid')
      }
      const output: unknown[] = []
      for (let index = 0; index < input.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          throw new Error('root-docker-snapshot-invalid')
        }
        output.push(copy(descriptor.value, depth + 1))
      }
      return Object.freeze(output)
    }
    const prototype = Object.getPrototypeOf(input)
    if (prototype !== Object.prototype && prototype !== null) throw new Error('root-docker-snapshot-invalid')
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    const keys = Reflect.ownKeys(input)
    if (keys.length > 128 || keys.some(key => typeof key !== 'string')) {
      throw new Error('root-docker-snapshot-invalid')
    }
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key)
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        throw new Error('root-docker-snapshot-invalid')
      }
      charge(key)
      output[key] = copy(descriptor.value, depth + 1)
    }
    return Object.freeze(output)
  }
  return copy(value, 0) as Readonly<T>
}

function sameOperation(left: RootDockerOperation, right: RootDockerOperation): boolean {
  const serialize = (operation: RootDockerOperation) => JSON.stringify(Object.keys(operation).sort()
    .map(key => [key, (operation as unknown as Record<string, unknown>)[key]]))
  return serialize(left) === serialize(right)
}

type Route = Readonly<{ method: 'GET' | 'POST'; uri: string; decision: 'prepare' | 'start' | 'observe' | 'stop';
  body: Buffer; successStatus: readonly number[] }>

function route(operation: RootDockerOperation): Route {
  if (!operation || typeof operation.operationId !== 'string' ||
    !OPERATION_ID.test(operation.operationId) || typeof operation.bodySha256 !== 'string' ||
    !SHA.test(operation.bodySha256)) {
    throw new Error('root-docker-operation-invalid')
  }
  const expectedFields: Readonly<Record<RootDockerOperation['kind'], readonly string[]>> = {
    create_network: ['operationId', 'bodySha256', 'kind', 'body'],
    create_container: ['operationId', 'bodySha256', 'kind', 'containerName', 'body'],
    start_container: ['operationId', 'bodySha256', 'kind', 'containerId'],
    inspect_container: ['operationId', 'bodySha256', 'kind', 'containerId'],
    stop_container: ['operationId', 'bodySha256', 'kind', 'containerId'],
    inspect_network: ['operationId', 'bodySha256', 'kind', 'networkId'],
    inspect_image: ['operationId', 'bodySha256', 'kind', 'imageRef'],
  }
  if (!Object.hasOwn(expectedFields, operation.kind) ||
    Object.keys(operation).sort().join(',') !== [...expectedFields[operation.kind]].sort().join(',')) {
    throw new Error('root-docker-operation-invalid')
  }
  let uri: string
  let method: 'GET' | 'POST'
  let decision: Route['decision']
  let body: Buffer = Buffer.alloc(0)
  let successStatus: readonly number[]
  switch (operation.kind) {
    case 'create_network':
      uri = `${API}/networks/create`; method = 'POST'; decision = 'prepare'; successStatus = [201]
      body = validatedBody(operation.body)
      break
    case 'create_container':
      if (typeof operation.containerName !== 'string' || !DOCKER_ID.test(operation.containerName)) {
        throw new Error('root-docker-target-invalid')
      }
      uri = `${API}/containers/create?name=${encodeURIComponent(operation.containerName)}`
      method = 'POST'; decision = 'prepare'; successStatus = [201]
      body = validatedBody(operation.body)
      break
    case 'start_container':
    case 'inspect_container':
    case 'stop_container':
      if (typeof operation.containerId !== 'string' || !DOCKER_ID.test(operation.containerId)) {
        throw new Error('root-docker-target-invalid')
      }
      uri = `${API}/containers/${operation.containerId}/${operation.kind === 'inspect_container' ? 'json' :
        operation.kind === 'start_container' ? 'start' : 'stop'}`
      method = operation.kind === 'inspect_container' ? 'GET' : 'POST'
      decision = operation.kind === 'inspect_container' ? 'observe' :
        operation.kind === 'start_container' ? 'start' : 'stop'
      successStatus = operation.kind === 'inspect_container' ? [200] : [204]
      break
    case 'inspect_network':
      if (typeof operation.networkId !== 'string' || !DOCKER_ID.test(operation.networkId)) {
        throw new Error('root-docker-target-invalid')
      }
      uri = `${API}/networks/${operation.networkId}`
      method = 'GET'; decision = 'observe'; successStatus = [200]
      break
    case 'inspect_image':
      if (typeof operation.imageRef !== 'string' || operation.imageRef.length > 256 ||
        !IMAGE_REF.test(operation.imageRef)) throw new Error('root-docker-target-invalid')
      uri = `${API}/images/${encodeURIComponent(operation.imageRef)}/json`
      method = 'GET'; decision = 'observe'; successStatus = [200]
      break
    default:
      throw new Error('root-docker-operation-invalid')
  }
  if (sha(body) !== operation.bodySha256) throw new Error('root-docker-body-hash-mismatch')
  return { method, uri, decision, body, successStatus }
}

function validatedBody(value: unknown): Buffer {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > MAX_BODY) {
    throw new Error('root-docker-body-invalid')
  }
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('root-docker-body-invalid')
  }
  return Buffer.from(value)
}

function requestBytes(route: Route): Buffer {
  const headers = `${route.method} ${route.uri} HTTP/1.1\r\nHost: docker\r\n` +
    'Connection: close\r\nAccept: application/json\r\n' +
    `Content-Type: application/json\r\nContent-Length: ${route.body.length}\r\n\r\n`
  return Buffer.concat([Buffer.from(headers, 'ascii'), route.body])
}

/** Never queue a write for a future drain. A partial write completes under the same Product lock. */
export function writeCompleteSync(fd: number, bytes: Buffer, writer: typeof writeSync = writeSync): void {
  const start = performance.now()
  let offset = 0
  while (offset < bytes.length) {
    if (performance.now() - start > MAX_WRITE_MS) throw new Error('root-docker-sync-write-timeout')
    const count = writer(fd, bytes, offset, bytes.length - offset)
    if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - offset) {
      throw new Error('root-docker-sync-write-incomplete')
    }
    offset += count
  }
}

function pinnedFd(socket: Socket): number {
  // Bun/Node's connected Unix socket FD is private; absence fails closed. There is no async write fallback.
  const handle = (socket as Socket & { _handle?: { fd?: unknown } })._handle
  const fd = handle?.fd
  if (!Number.isSafeInteger(fd) || (fd as number) < 0 || !fstatSync(fd as number).isSocket()) {
    throw new Error('root-docker-pinned-socket-unavailable')
  }
  return fd as number
}

function parseResponse(raw: Buffer): Readonly<{ statusCode: number; body: Buffer }> {
  const split = raw.indexOf('\r\n\r\n')
  if (split < 0 || split > 16 * 1024) throw new Error('root-docker-response-invalid')
  const lines = raw.subarray(0, split).toString('latin1').split('\r\n')
  const status = /^HTTP\/1\.[01] ([1-5][0-9]{2})(?: .*)?$/.exec(lines.shift() ?? '')
  if (!status) throw new Error('root-docker-response-invalid')
  const headers = new Map<string, string>()
  for (const line of lines) {
    const match = /^([a-zA-Z0-9-]+):\s*([^\r\n]*)$/.exec(line)
    if (!match) throw new Error('root-docker-response-invalid')
    const key = match[1].toLowerCase()
    if (headers.has(key)) throw new Error('root-docker-response-invalid')
    headers.set(key, match[2])
  }
  const body = raw.subarray(split + 4)
  if (headers.has('transfer-encoding')) {
    if (headers.get('transfer-encoding') !== 'chunked' || headers.has('content-length')) {
      throw new Error('root-docker-response-invalid')
    }
    let offset = 0
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const end = body.indexOf('\r\n', offset)
      if (end < 0 || end - offset > 16) throw new Error('root-docker-response-invalid')
      const sizeText = body.subarray(offset, end).toString('ascii')
      if (!/^[0-9a-fA-F]+$/.test(sizeText)) throw new Error('root-docker-response-invalid')
      const size = Number.parseInt(sizeText, 16)
      offset = end + 2
      if (size === 0) {
        if (body.subarray(offset).toString('ascii') !== '\r\n') throw new Error('root-docker-response-invalid')
        break
      }
      if (!Number.isSafeInteger(size) || size > MAX_RESPONSE - total ||
        offset + size + 2 > body.length || body.toString('ascii', offset + size, offset + size + 2) !== '\r\n') {
        throw new Error('root-docker-response-invalid')
      }
      chunks.push(body.subarray(offset, offset + size))
      total += size
      offset += size + 2
    }
    return { statusCode: Number(status[1]), body: Buffer.concat(chunks) }
  }
  const length = headers.get('content-length')
  if (length !== undefined && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) !== body.length)) {
    throw new Error('root-docker-response-invalid')
  }
  return { statusCode: Number(status[1]), body }
}

function connectedSocket(socketPath: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path: socketPath })
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('root-docker-connect-timeout')) }, timeoutMs)
    const onError = (error: Error) => { clearTimeout(timer); socket.destroy(); reject(error) }
    socket.once('connect', () => { clearTimeout(timer); socket.off('error', onError); resolve(socket) })
    socket.once('error', onError)
  })
}

function responseFrom(socket: Socket, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    let length = 0
    const timer = setTimeout(() => finish(new Error('root-docker-response-timeout')), timeoutMs)
    const finish = (error?: Error) => {
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('end', onEnd)
      socket.removeListener('error', onError)
      socket.destroy()
      if (error) reject(error); else resolve(Buffer.concat(parts))
    }
    const onData = (chunk: Buffer) => {
      length += chunk.length
      if (length > MAX_RESPONSE + 16 * 1024) finish(new Error('root-docker-response-too-large'))
      else parts.push(chunk)
    }
    const onEnd = () => finish()
    const onError = (error: Error) => finish(error)
    socket.on('data', onData)
    socket.once('end', onEnd)
    socket.once('error', onError)
  })
}

/** Inactive until a trusted Product binding and root-owned operation resolver are composed into production. */
export class RootDockerEngineDispatcher<Binding extends object> {
  private constructor(private readonly stateDir: string, private readonly socketPath: string,
    private readonly decision: RootCurrentMemberDecision<Binding>,
    private readonly resolveAuthorizedOperation: RootDockerOperationResolver<Binding>, private readonly timeoutMs: number,
    private readonly ownerUid: number, private readonly directoryIdentity: Readonly<{ dev: number; ino: number }>) {}

  static create<Binding extends object>(options: { stateDir: string; socketPath: string;
    decision: RootCurrentMemberDecision<Binding>;
    resolveAuthorizedOperation: RootDockerOperationResolver<Binding>;
    timeoutMs?: number; testOnlyAllowNonRoot?: boolean }): RootDockerEngineDispatcher<Binding> {
    const test = options.testOnlyAllowNonRoot === true && process.env.NODE_ENV === 'test'
    if (!test && (process.platform !== 'linux' || process.getuid?.() !== 0 ||
      !['/var/run/docker.sock', '/run/docker.sock'].includes(options.socketPath)) ||
      !path.isAbsolute(options.stateDir) || path.normalize(options.stateDir) !== options.stateDir ||
      !path.isAbsolute(options.socketPath) || typeof options.resolveAuthorizedOperation !== 'function' ||
      typeof options.decision?.withCurrentMemberDecision !== 'function') {
      throw new Error('root-docker-dispatch-policy-invalid')
    }
    const timeoutMs = options.timeoutMs ?? 10_000
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      throw new Error('root-docker-dispatch-policy-invalid')
    }
    const ownerUid = process.getuid?.() ?? -1
    if (!test) {
      let ancestor = path.dirname(options.stateDir)
      for (;;) {
        const stat = lstatSync(ancestor)
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 ||
          (stat.mode & 0o022) !== 0 || realpathSync(ancestor) !== ancestor) {
          throw new Error('root-docker-state-ancestor-invalid')
        }
        const parent = path.dirname(ancestor)
        if (parent === ancestor) break
        ancestor = parent
      }
    }
    // State must pre-exist; sync its metadata and parent entry before any effect can be claimed.
    const state = lstatSync(options.stateDir)
    if (!state.isDirectory() || state.isSymbolicLink() || state.uid !== ownerUid ||
      (state.mode & 0o077) !== 0 || realpathSync(options.stateDir) !== options.stateDir) {
      throw new Error('root-docker-state-dir-invalid')
    }
    const stateFd = openSync(options.stateDir, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const opened = fstatSync(stateFd)
      if (opened.dev !== state.dev || opened.ino !== state.ino) {
        throw new Error('root-docker-state-dir-substituted')
      }
      fsyncSync(stateFd)
    } finally { closeSync(stateFd) }
    const parentFd = openSync(path.dirname(options.stateDir), constants.O_RDONLY | constants.O_NOFOLLOW)
    try { fsyncSync(parentFd) } finally { closeSync(parentFd) }
    return new RootDockerEngineDispatcher(options.stateDir, options.socketPath, options.decision,
      options.resolveAuthorizedOperation, timeoutMs, ownerUid, { dev: state.dev, ino: state.ino })
  }

  async dispatch(operation: RootDockerOperation, binding: Binding): Promise<RootDockerDispatchResult> {
    const stableOperation = boundedSnapshot(operation, MAX_BODY + 4096) as RootDockerOperation
    const stableBinding = boundedSnapshot(binding, 16 * 1024) as Binding
    const target = route(stableOperation)
    let socket: Socket | undefined
    try {
      socket = await connectedSocket(this.socketPath, this.timeoutMs)
      const fd = pinnedFd(socket)
      const response = responseFrom(socket, this.timeoutMs)
      void response.catch(() => {}) // A rejected guard still closes the socket without awaiting its response.
      // The Product callback is synchronous. Claim publication and the only kernel
      // socket write both occur while its BEGIN IMMEDIATE still fences revokers.
      const claim = await this.decision.withCurrentMemberDecision(stableBinding, target.decision, current => {
        const resolved: unknown = this.resolveAuthorizedOperation(stableBinding, current,
          stableOperation.operationId)
        if (resolved && typeof resolved === 'object' && 'then' in resolved) {
          throw new Error('root-docker-async-operation-resolver-forbidden')
        }
        const authorized = boundedSnapshot(resolved as RootDockerOperation, MAX_BODY + 4096) as RootDockerOperation
        route(authorized)
        if (!sameOperation(stableOperation, authorized)) throw new Error('root-docker-operation-not-authorized')
        if (pinnedFd(socket!) !== fd) throw new Error('root-docker-socket-substituted')
        const prior = this.claim(stableOperation, stableBinding, target)
        if (prior) return prior
        writeCompleteSync(fd, requestBytes(target))
        return null
      })
      if (claim) return claim
      const parsed = parseResponse(await response)
      if (!target.successStatus.includes(parsed.statusCode)) {
        return { outcome: 'uncertain', reason: `docker-status-${parsed.statusCode}` }
      }
      return { outcome: 'responded', statusCode: parsed.statusCode, body: parsed.body }
    } catch (error) {
      return { outcome: 'uncertain', reason: error instanceof Error ? error.message : 'unknown' }
    } finally { socket?.destroy() }
  }

  private claim(operation: RootDockerOperation, binding: Binding, target: Route): RootDockerDispatchResult | null {
    const directory = lstatSync(this.stateDir)
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== this.ownerUid ||
      (directory.mode & 0o077) !== 0 || directory.dev !== this.directoryIdentity.dev ||
      directory.ino !== this.directoryIdentity.ino || realpathSync(this.stateDir) !== this.stateDir) {
      throw new Error('root-docker-state-dir-substituted')
    }
    const claimPath = path.join(this.stateDir, `${sha(operation.operationId)}.claim`)
    const record = JSON.stringify({ operationId: operation.operationId, kind: operation.kind,
      method: target.method, uri: target.uri, bodySha256: operation.bodySha256,
      bindingSha256: sha(JSON.stringify(binding)) })
    let fd: number
    try {
      fd = openSync(claimPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const stat = lstatSync(claimPath)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== this.ownerUid ||
        (stat.mode & 0o077) !== 0 || stat.size > 2048) throw new Error('root-docker-claim-substituted')
      const existingFd = openSync(claimPath, constants.O_RDONLY | constants.O_NOFOLLOW)
      let existing: string
      try {
        const opened = fstatSync(existingFd)
        if (opened.dev !== stat.dev || opened.ino !== stat.ino) {
          throw new Error('root-docker-claim-substituted')
        }
        existing = readFileSync(existingFd, { encoding: 'utf8' })
      } finally { closeSync(existingFd) }
      return { outcome: existing === record ? 'already_claimed' : 'claim_conflict' }
    }
    try {
      writeCompleteSync(fd, Buffer.from(record))
      fsyncSync(fd)
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== this.ownerUid) {
        throw new Error('root-docker-claim-substituted')
      }
    } finally { closeSync(fd) }
    const dirFd = openSync(this.stateDir, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const opened = fstatSync(dirFd)
      if (opened.dev !== this.directoryIdentity.dev || opened.ino !== this.directoryIdentity.ino) {
        throw new Error('root-docker-state-dir-substituted')
      }
      fsyncSync(dirFd)
    } finally { closeSync(dirFd) }
    return null
  }
}
