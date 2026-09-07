import { expect, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalHostedApprovalJson } from './OpenCodeClientFactory.js'
import { buildManagedConfigFingerprint } from './OpenCodeManagedConfigFingerprint.js'
import * as endpointIdentity from './OpenCodeLoopbackEndpointIdentity.js'
import type { OpenCodeConnectedSocketIdentity } from './OpenCodeLoopbackEndpointIdentity.js'
import { resolveExecutingOpenCodeArtifactDigest } from './OpenCodeArtifactDigest.js'
import { createOpenCodeRawRetention, type OpenCodeRawObservation,
  type OpenCodeRawRetentionSink } from './OpenCodeHostedRawRetention.js'
import { createOpenCodeSupervisedCustodyAcquirer, type ExpectedSupervisedOpenCode,
  type OpenCodeSupervisorAdmissionSource } from './OpenCodeSupervisedHostCustody.js'
import type { OpenCodePreparedProfile } from './types.js'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
export const supervisedLease = { teamId: 'team_test', laneId: 'primary', memberName: 'worker',
  runId: 'run_test', sessionId: 'ses_test' }

export async function supervisedTestWait<T>(pending: Promise<T>, label: string, ms = 10_000): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms)
    })])
  } finally { clearTimeout(timer) }
}

/** A failed exchange must not leave a test waiting forever for an unreached stage. */
export function supervisedTestStage(stage: Promise<void>, exchange: Promise<unknown>, label: string) {
  return supervisedTestWait(Promise.race([stage, exchange.then(result => {
    throw new Error(`Exchange settled before ${label}`, { cause: result })
  })]), label, 30_000)
}

type ObservedConnection = {
  socket: Socket; chunks: Buffer[]; closed: Promise<void>
  // Snapshot before close clears the runtime Socket's address properties.
  identity: OpenCodeConnectedSocketIdentity
}
type ObservedRequest = {
  method: string; url: string; headers: Record<string, string>; body: Buffer; connection: ObservedConnection
}

/** Small response writer for this fixture. Every path uses the genuine TCP
 * socket; no Bun HTTP-server connection events or HTTP socket facades. */
class FixtureResponse {
  statusCode = 200
  private headers = new Map<string, string>()
  private sent = false
  private chunked = false
  constructor(private socket: Socket) {}
  setHeader(name: string, value: string) { this.headers.set(name.toLowerCase(), value) }
  private head(length?: number): Buffer {
    this.sent = true
    this.headers.set('connection', 'close')
    if (!this.headers.has('content-length')) {
      if (length !== undefined) this.headers.set('content-length', String(length))
      else { this.headers.set('transfer-encoding', 'chunked'); this.chunked = true }
    }
    return Buffer.from(`HTTP/1.1 ${this.statusCode} Fixture\r\n` +
      [...this.headers].map(([name, value]) => `${name}: ${value}\r\n`).join('') + '\r\n', 'latin1')
  }
  write(value: string | Uint8Array) {
    const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value)
    if (!this.sent) this.socket.write(this.head())
    if (bytes.length) this.socket.write(this.chunked
      ? Buffer.concat([Buffer.from(`${bytes.length.toString(16)}\r\n`), bytes, Buffer.from('\r\n')]) : bytes)
  }
  end(value: string | Uint8Array = '') {
    const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value)
    if (!this.sent) { this.socket.end(Buffer.concat([this.head(bytes.length), bytes])); return }
    this.write(bytes)
    this.socket.end(this.chunked ? '0\r\n\r\n' : undefined)
  }
  destroy() { this.socket.destroy() }
}

/** Local server fixture owns its actual listener/process expectation. This is
 * explicitly test infrastructure, not a production supervisor admission provider.
 */
export async function supervisedFixture(options: {
  initialManagedConfig?: OpenCodePreparedProfile['managedConfig']
  encode?: (observation: OpenCodeRawObservation, expected: ExpectedSupervisedOpenCode) => ReturnType<OpenCodeRawRetentionSink['encode']>
  handle?: (request: ObservedRequest, response: FixtureResponse) => void
  rawResponse?: (request: ObservedRequest, socket: Socket) => void
  sync?: (observation: OpenCodeRawObservation | undefined) => Promise<void>
  write?: (bytes: Uint8Array, offset: number, length: number, observation: OpenCodeRawObservation | undefined) => Promise<number>
  mutateBundle?: (bundle: Awaited<ReturnType<OpenCodeSupervisorAdmissionSource['acquire']>>) => void
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'opencode-w1-a-'))
  const observations: OpenCodeRawObservation[] = []
  const requests: ObservedRequest[] = []
  // Count TCP bytes even when no complete HTTP request can be parsed.
  const connections: ObservedConnection[] = []
  const acceptedWaiters = new Set<() => void>()
  const proofs: Array<{ connection: ObservedConnection; identity: OpenCodeConnectedSocketIdentity }> = []
  let live = true
  let lose!: () => void
  const lost = new Promise<void>(resolve => { lose = resolve })
  const fence = () => {
    let used = false
    return { consume() { if (used) return false; used = true; return live } }
  }
  const hosted = { schemaVersion: 2 as const, protocol: 'agent-teams-hosted-approval-v2' as const,
    authentication: 'opencode-basic' as const, runtimeInstanceId: `runtime_instance_${'1'.repeat(32)}`,
    configGeneration: `config_generation_${'2'.repeat(32)}` }
  const config = { config: {}, configProviders: {}, agents: [], mcp: [] }
  const server = createTcpServer(socket => {
    const chunks: Buffer[] = []
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()))
    const connection = { socket, chunks, closed, identity: {
      localAddress: socket.remoteAddress!, localPort: socket.remotePort!,
      remoteAddress: socket.localAddress!, remotePort: socket.localPort!,
    } }
    connections.push(connection)
    socket.on('error', () => {})
    for (const accepted of acceptedWaiters) accepted()
    let bytes = Buffer.alloc(0)
    let delivered = false
    socket.on('data', chunk => {
      chunks.push(Buffer.from(chunk))
      if (delivered) return
      bytes = Buffer.concat([bytes, chunk])
      if (bytes.length > 2 * 1024 * 1024) { socket.destroy(); return }
      const boundary = bytes.indexOf('\r\n\r\n')
      if (boundary < 0) return
      const [line, ...fields] = bytes.subarray(0, boundary).toString('ascii').split('\r\n')
      const [method, url] = line!.split(' ')
      const headers: Record<string, string> = {}
      for (const field of fields) {
        const colon = field.indexOf(':')
        const name = field.slice(0, colon).toLowerCase()
        if (colon <= 0 || headers[name] !== undefined) { socket.destroy(); return }
        headers[name] = field.slice(colon + 1).trim()
      }
      const length = Number(headers['content-length'] ?? 0)
      if (!method || !url || !Number.isSafeInteger(length) || length < 0 || length > 1024 * 1024) {
        socket.destroy(); return
      }
      if (bytes.length < boundary + 4 + length) return
      delivered = true
      const request = { method, url, headers, connection,
        body: Buffer.from(bytes.subarray(boundary + 4, boundary + 4 + length)) }
      requests.push(request)
      if (options.rawResponse) { options.rawResponse(request, socket); return }
      const response = new FixtureResponse(socket)
      if (options.handle) { options.handle(request, response); return }
      const data = request.url === '/global/health' ? { healthy: true } :
        request.url === '/agent' ? [] : request.url.endsWith('hosted-approval-capability') ? hosted : {}
      response.end(canonicalHostedApprovalJson(data))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as AddressInfo).port
  const proc = `/proc/${process.pid}`
  const processStat = await readFile(`${proc}/stat`, 'utf8')
  const startTicks = processStat.slice(processStat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]!
  const exe = await stat(`${proc}/exe`, { bigint: true })
  const executableDigest = resolveExecutingOpenCodeArtifactDigest(process.pid)!
  const managedConfig = structuredClone(options.initialManagedConfig ?? {})
  const profile: OpenCodePreparedProfile = {
    projectPath: directory, profileRootKey: 'fixture', profileRootPath: directory,
    projectBehaviorFingerprint: hash(''), managedConfigFingerprint: buildManagedConfigFingerprint(managedConfig), behaviorSources: [],
    managedConfig, homePath: directory, tmpPath: directory, xdgConfigHome: directory,
    xdgDataHome: directory, xdgCacheHome: directory, managedAuthPath: join(directory, 'absent-auth.json'),
    sourceAuthPath: null, sourceAuthSources: [], sourceAuthFingerprint: null, managedAuthFingerprint: null,
    authState: 'missing', env: {},
  }
  const expected: ExpectedSupervisedOpenCode = {
    endpoint: { protocol: 'http:', address: '127.0.0.1', port, baseUrl: `http://127.0.0.1:${port}` },
    process: { pid: process.pid, startTicks, startIdentity: `start_${hash(`${process.pid}\0proc:${startTicks}`)}`,
      supervisorProcessStartToken: hash('supervisor-spawn'),
      pidNamespaceInode: (await stat(`${proc}/ns/pid`, { bigint: true })).ino.toString(),
      networkNamespaceInode: (await stat(`${proc}/ns/net`, { bigint: true })).ino.toString() },
    executable: { device: exe.dev.toString(), inode: exe.ino.toString(), size: exe.size.toString(),
      sha256: executableDigest.slice(7), artifactManifestSha256: hash('fixture manifest'), moduleSha256: hash('fixture module') },
    profile: { projectPath: directory, profileRootKey: profile.profileRootKey, profileRootPath: directory,
      projectBehaviorFingerprint: profile.projectBehaviorFingerprint,
      managedConfigFingerprint: profile.managedConfigFingerprint,
      resolvedConfigFingerprint: hash(JSON.stringify(config)), sourceAuthFingerprint: null,
      managedAuthFingerprint: null, sourceAuthSources: [], toolApprovalMode: 'manual' },
    hosted, activation: { controllerNonce: hash('controller'), runId: hash('run'),
      stackManifestSha256: hash('stack'), bootstrapDigest: hash('bootstrap'),
      admissionDocumentDigest: `sha256:${hash('admission')}`, ownerArtifactDigest: `sha256:${hash('owner')}`,
      ownerGeneration: 1, ownerSessionId: 'owner-session_fixture' }, serverAuthId: 'fixture-private-auth',
  }
  const sink: OpenCodeRawRetentionSink = {
    encode(observation) {
      observations.push(observation)
      if (options.encode) return options.encode(observation, expected)
      const bytes = Buffer.from(JSON.stringify(observation))
      return { bytes, recordId: hash(bytes.toString('utf8')) }
    },
    isCurrent: () => live,
    write: (bytes, offset, length) => options.write?.(bytes, offset, length, observations.at(-1)) ?? Promise.resolve(length),
    sync: () => options.sync?.(observations.at(-1)) ?? Promise.resolve(),
    close: async () => {},
  }
  const rawRetention = createOpenCodeRawRetention(sink)
  const source: OpenCodeSupervisorAdmissionSource = {
    expected,
    async acquire() {
      const bundle = {
        expected: structuredClone(expected), serverAuth: { id: expected.serverAuthId,
          username: 'opencode', password: 'fixture-secret' }, rawRetention,
        readPreparedProfile: async () => structuredClone(profile),
        prepareEffectToken: async () => live ? fence() : null,
        prepareLeaseToken: async (lease: { teamId: string; laneId?: string | null; memberName: string;
          runId?: string | null; sessionId?: string | null }) =>
          lease.teamId === supervisedLease.teamId && lease.memberName === supervisedLease.memberName &&
            (lease.laneId ?? 'primary') === 'primary' && (lease.sessionId
              ? lease.sessionId === supervisedLease.sessionId : lease.runId === supervisedLease.runId) ? fence() : null,
        prepareOperationToken: async () => live ? fence() : null,
        lost, closeOwnerResources: async () => {},
      }
      options.mutateBundle?.(bundle)
      return bundle
    },
  }
  const waitForConnection = async (identity: OpenCodeConnectedSocketIdentity) => {
    const matches = () => connections.filter(value =>
      Object.entries(identity).every(([key, part]) => value.identity[key as keyof typeof identity] === part))
    let accepted!: () => void
    const ready = new Promise<void>(resolve => { accepted = () => { if (matches().length) resolve() } })
    acceptedWaiters.add(accepted)
    try {
      accepted()
      await supervisedTestWait(ready, `TCP accept for authorized local port ${identity.localPort}`)
      expect(matches()).toHaveLength(1)
      return matches()[0]!
    } finally { acceptedWaiters.delete(accepted) }
  }
  // Observe the actual verifier's input/result and always run its original OS
  // proof. This is not a substitute proof or a custody/factory override. The
  // rendezvous makes the accepted descriptor authoritative on pinned Bun too.
  const prove = endpointIdentity.captureOpenCodeEstablishedPeerIdentity
  const proofSpy = spyOn(endpointIdentity, 'captureOpenCodeEstablishedPeerIdentity')
    .mockImplementation(async (...args: Parameters<typeof prove>) => {
      const identity = { ...args[2] }
      if (identity.remotePort !== port || !server.listening) return prove(...args)
      const connection = await waitForConnection(identity)
      expect(connection.chunks).toHaveLength(0)
      const peer = await prove(...args)
      if (peer) {
        expect(peer.pid).toBe(expected.process.pid)
        expect(peer.startIdentity).toBe(expected.process.startIdentity)
        expect(peer.port).toBe(port)
        expect(connection.chunks).toHaveLength(0)
        proofs.push({ connection, identity })
      }
      return peer
    })
  const assertSocketCustody = () => {
    for (const request of requests) {
      const authorized = proofs.filter(proof => proof.connection === request.connection)
      expect(authorized.length).toBeGreaterThan(0)
      for (const proof of authorized) expect(request.connection.identity).toEqual(proof.identity)
      expect(request.connection.identity.localPort).toBeGreaterThan(0)
      expect(request.connection.identity.remotePort).toBe(port)
      expect(requests.filter(other => other.connection === request.connection)).toHaveLength(1)
      const wire = Buffer.concat(request.connection.chunks)
      const boundary = wire.indexOf('\r\n\r\n')
      expect(boundary).toBeGreaterThan(0)
      expect(wire.subarray(boundary + 4)).toEqual(request.body)
      expect(request.headers.connection).toBe('close')
    }
    // No unparsed partial HTTP bytes may escape on an unproved connection.
    for (const connection of connections.filter(value => value.chunks.length)) {
      expect(proofs.some(proof => proof.connection === connection)).toBe(true)
      expect(requests.filter(request => request.connection === connection)).toHaveLength(1)
    }
  }
  return { expected, profile, source, sink, rawRetention, requests, observations, server, connections,
    waitForConnection, assertSocketCustody,
    acquire: createOpenCodeSupervisedCustodyAcquirer(source),
    revoke() { live = false; lose() },
    async close() {
      try { assertSocketCustody() } finally {
        proofSpy.mockRestore()
        live = false; lose()
        for (const connection of connections) connection.socket.destroy()
        await rawRetention.close()
        await new Promise<void>(resolve => server.close(() => resolve()))
        await rm(directory, { recursive: true, force: true })
      }
    },
  }
}
