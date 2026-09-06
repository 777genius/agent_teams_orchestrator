import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalHostedApprovalJson } from './OpenCodeClientFactory.js'
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

type ObservedRequest = { method: string; url: string; headers: IncomingMessage['headers']; body: Buffer }

/** Local server fixture owns its actual listener/process expectation. This is
 * explicitly test infrastructure, not a production supervisor admission provider.
 */
export async function supervisedFixture(options: {
  handle?: (request: IncomingMessage, response: ServerResponse) => void
  // Use a genuine TCP listener for wire framing tests; an HTTP server's socket
  // facade may interpret end() as response finalization instead of raw bytes.
  rawResponse?: (request: ObservedRequest, socket: Socket) => void
  sync?: (observation: OpenCodeRawObservation | undefined) => Promise<void>
  write?: (bytes: Uint8Array, offset: number, length: number, observation: OpenCodeRawObservation | undefined) => Promise<number>
  mutateBundle?: (bundle: Awaited<ReturnType<OpenCodeSupervisorAdmissionSource['acquire']>>) => void
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'opencode-w1-a-'))
  const observations: OpenCodeRawObservation[] = []
  const requests: ObservedRequest[] = []
  // Count TCP bytes even when no complete HTTP request can be parsed.
  const connections: Array<{ socket: Socket; chunks: Buffer[]; closed: Promise<void> }> = []
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
  const server = options.rawResponse ? createTcpServer(socket => {
    let bytes = Buffer.alloc(0)
    let delivered = false
    socket.on('data', chunk => {
      if (delivered) return
      bytes = Buffer.concat([bytes, chunk])
      const boundary = bytes.indexOf('\r\n\r\n')
      if (boundary < 0) return
      const [line, ...fields] = bytes.subarray(0, boundary).toString('ascii').split('\r\n')
      const [method, url] = line!.split(' ')
      const headers: IncomingMessage['headers'] = {}
      for (const field of fields) {
        const colon = field.indexOf(':')
        headers[field.slice(0, colon).toLowerCase()] = field.slice(colon + 1).trim()
      }
      const length = Number(headers['content-length'] ?? 0)
      if (!method || !url || !Number.isSafeInteger(length) || length < 0 || length > 16 * 1024) {
        socket.destroy(); return
      }
      if (bytes.length < boundary + 4 + length) return
      delivered = true
      const request = { method, url, headers, body: Buffer.from(bytes.subarray(boundary + 4, boundary + 4 + length)) }
      requests.push(request)
      options.rawResponse!(request, socket)
    })
  }) : createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      requests.push({ method: request.method!, url: request.url!, headers: request.headers, body: Buffer.concat(chunks) })
      if (options.handle) { options.handle(request, response); return }
      const data = request.url === '/global/health' ? { healthy: true } :
        request.url === '/agent' ? [] : request.url?.endsWith('hosted-approval-capability') ? hosted : {}
      response.end(canonicalHostedApprovalJson(data))
    })
  })
  server.on('connection', socket => {
    const chunks: Buffer[] = []
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()))
    socket.on('error', () => {})
    socket.on('data', chunk => chunks.push(Buffer.from(chunk)))
    connections.push({ socket, chunks, closed })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as AddressInfo).port
  const proc = `/proc/${process.pid}`
  const processStat = await readFile(`${proc}/stat`, 'utf8')
  const startTicks = processStat.slice(processStat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]!
  const exe = await stat(`${proc}/exe`, { bigint: true })
  const executableDigest = resolveExecutingOpenCodeArtifactDigest(process.pid)!
  const profile: OpenCodePreparedProfile = {
    projectPath: directory, profileRootKey: 'fixture', profileRootPath: directory,
    projectBehaviorFingerprint: hash(''), managedConfigFingerprint: hash('{}'), behaviorSources: [],
    managedConfig: {}, homePath: directory, tmpPath: directory, xdgConfigHome: directory,
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
  return { expected, profile, source, sink, rawRetention, requests, observations, server, connections,
    acquire: createOpenCodeSupervisedCustodyAcquirer(source),
    revoke() { live = false; lose() },
    async close() {
      live = false; lose()
      await rawRetention.close()
      for (const connection of connections) connection.socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    },
  }
}
