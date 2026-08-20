import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

export type Purpose = 'status' | 'catalog' | 'launch'
export type ProviderId = 'deepinfra' | 'kiro' | 'cursor'

export type Selection = {
  project: string
  provider: ProviderId
  model: string
  profile: string
  config: string
  auth: string
  binary: string
  plugin: string
  cacheGeneration: number
  mcp: string
}

export type Proof = Selection & { nonce: string; appMcp: true }

export type LedgerEvent = {
  seq: number
  purpose: Purpose | 'system'
  effect: 'route' | 'profile' | 'lock' | 'write' | 'cli' | 'host' | 'process' | 'plugin' |
    'proof' | 'member' | 'operation' | 'deadline' | 'persistence'
  action: string
  projectHash?: string
  provider?: ProviderId
  identityHash?: string
  pid?: number
  parentPid?: number | null
  generation?: number
  accepted?: boolean
  alive?: boolean
  attempt?: number
  at?: number
}

export type AcceptanceLedger = { schema: 1; events: LedgerEvent[] }

type Persisted = {
  version: 1
  caches: Array<{ identity: Selection; models: string[] }>
  claims: Array<{ key: string; state: 'remote-created' | 'committed' }>
  hosts: Array<{ hostId: string; selection: Selection; pid: number; retained: true }>
}

export type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
  cancel(): void
  readonly cancelled: boolean
  readonly cancelCount: number
  readonly lateCompletionCount: number
  onLateCompletion?: () => void
}

export type MemberCapability = { readonly __opaqueMemberCapability: unique symbol }

export type LaunchResult =
  | { ok: true; reason: 'accepted'; capability: MemberCapability }
  | { ok: false; reason: string; capability: null }

export type PortCall = {
  port: string
  purpose: Purpose
  provider?: ProviderId
  detail?: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Stable structured bytes. Values are represented as typed, length-delimited nodes. */
export function canonicalBytes(value: unknown): Uint8Array {
  const encode = (item: unknown): string => {
    if (item === null) return 'n0:'
    if (typeof item === 'string') return `s${encoder.encode(item).byteLength}:${item}`
    if (typeof item === 'number') {
      const text = String(item)
      return `d${text.length}:${text}`
    }
    if (typeof item === 'boolean') return item ? 'b1:1' : 'b1:0'
    if (Array.isArray(item)) {
      const body = item.map(encode).join('')
      return `a${encoder.encode(body).byteLength}:${body}`
    }
    if (typeof item === 'object') {
      const entries = Object.entries(item as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => encode(key) + encode(child))
        .join('')
      return `o${encoder.encode(entries).byteLength}:${entries}`
    }
    throw new Error(`unsupported canonical value: ${typeof item}`)
  }
  return encoder.encode(encode(value))
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
}

function hash(value: string | Uint8Array): string {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value
  return `h:${createHash('sha256').update(bytes).digest('hex')}`
}

export class VirtualScheduler {
  now = 0
  private sequence = 0
  private tasks: Array<{ at: number; sequence: number; run: () => void }> = []

  at(absoluteTime: number, run: () => void): void {
    this.tasks.push({ at: absoluteTime, sequence: this.sequence++, run })
  }

  advanceTo(absoluteTime: number): void {
    if (absoluteTime < this.now) throw new Error('virtual monotonic clock cannot go backwards')
    while (true) {
      const next = this.tasks
        .filter(item => item.at <= absoluteTime)
        .sort((a, b) => a.at - b.at || a.sequence - b.sequence)[0]
      if (!next) break
      this.tasks.splice(this.tasks.indexOf(next), 1)
      this.now = next.at
      next.run()
    }
    this.now = absoluteTime
  }
}

export class Barrier {
  private releasePromise: Promise<void>
  private releaseNow!: () => void
  arrivals = 0

  constructor(readonly parties: number) {
    this.releasePromise = new Promise(resolve => { this.releaseNow = resolve })
  }

  async arrive(): Promise<void> {
    this.arrivals += 1
    if (this.arrivals === this.parties) this.releaseNow()
    await this.releasePromise
  }
}

export class AtomicFakeFileSystem {
  private files = new Map<string, Uint8Array>()
  readonly writes: Array<{ pathHash: string; bytes: number }> = []

  read(file: string): Uint8Array | null {
    const bytes = this.files.get(file)
    return bytes ? bytes.slice() : null
  }

  atomicWrite(file: string, bytes: Uint8Array): void {
    const temporary = `${file}.tmp`
    this.files.set(temporary, bytes.slice())
    this.files.set(file, this.files.get(temporary)!.slice())
    this.files.delete(temporary)
    this.writes.push({ pathHash: hash(file), bytes: bytes.byteLength })
  }

  corrupt(file: string): void {
    this.files.set(file, encoder.encode('{corrupt'))
  }

  async claimOnce(key: string, barrier?: Barrier): Promise<boolean> {
    if (barrier) await barrier.arrive()
    const claimFile = `atomic-claim:${key}`
    if (this.files.has(claimFile)) return false
    this.atomicWrite(claimFile, encoder.encode('{"claimed":true}'))
    return true
  }

  /** A restart gets a new FS object, while the durable byte device is copied exactly. */
  rebootedDevice(): AtomicFakeFileSystem {
    const next = new AtomicFakeFileSystem()
    next.files = new Map([...this.files].map(([key, bytes]) => [key, bytes.slice()]))
    return next
  }
}

export class FakeProcessSupervisor {
  private nextPid = 61_000
  readonly alive = new Set<number>()
  readonly parents = new Map<number, number | null>()
  readonly ignoresTerm = new Set<number>()

  spawn(parent: number | null = null, ignoreTerm = false): number {
    const pid = this.nextPid++
    this.alive.add(pid)
    this.parents.set(pid, parent)
    if (ignoreTerm) this.ignoresTerm.add(pid)
    return pid
  }

  signal(pid: number, signal: 'TERM' | 'KILL'): void {
    if (!this.alive.has(pid)) return
    if (signal === 'TERM' && this.ignoresTerm.has(pid)) return
    this.alive.delete(pid)
  }

  descendants(root: number): number[] {
    const result: number[] = []
    const visit = (parent: number) => {
      for (const [pid, candidateParent] of this.parents) if (candidateParent === parent) {
        visit(pid)
        result.push(pid)
      }
    }
    visit(root)
    return result
  }
}

export type AcceptancePorts = {
  calls: PortCall[]
  fs: AtomicFakeFileSystem
  scheduler: VirtualScheduler
  processes: FakeProcessSupervisor
  profile(purpose: Purpose, selection: Selection): Promise<void>
  lock(purpose: Purpose, selection: Selection): Promise<void>
  write(purpose: Purpose, selection: Selection): Promise<void>
  cli(purpose: Purpose, selection: Selection, args: readonly string[]): Promise<void>
  retryCli(purpose: 'catalog', selection: Selection): Deferred<void>
  host(purpose: Purpose, selection: Selection, operation: string): Promise<void>
  plugin(purpose: Purpose, selection: Selection, provider: ProviderId): Promise<void>
  remoteCreate(selection: Selection, member: number): Promise<void>
}

export function createTrapPorts(fs = new AtomicFakeFileSystem()): AcceptancePorts & {
  hang(port: string): Deferred<void>
  deferredCliAttempts: Deferred<void>[]
} {
  const calls: PortCall[] = []
  const scheduler = new VirtualScheduler()
  const processes = new FakeProcessSupervisor()
  const hangs = new Map<string, Deferred<void>>()
  const deferredCliAttempts: Deferred<void>[] = []
  const makeDeferred = <T>(): Deferred<T> => {
    let resolvePromise!: (value: T) => void
    let rejectPromise!: (reason: unknown) => void
    let cancelled = false
    let cancelCount = 0
    let lateCompletionCount = 0
    let settled = false
    const promise = new Promise<T>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject })
    // Trap operations can intentionally remain unobserved; cancellation must still be safe.
    void promise.catch(() => undefined)
    const deferred: Deferred<T> = {
      promise,
      resolve: value => {
        if (settled) {
          lateCompletionCount += 1
          deferred.onLateCompletion?.()
          return
        }
        settled = true
        resolvePromise(value)
      },
      reject: reason => {
        if (settled) {
          lateCompletionCount += 1
          deferred.onLateCompletion?.()
          return
        }
        settled = true
        rejectPromise(reason)
      },
      cancel: () => {
        if (settled) return
        cancelCount += 1
        cancelled = true
        settled = true
        rejectPromise(new Error('fake operation cancelled'))
      },
      get cancelled() { return cancelled },
      get cancelCount() { return cancelCount },
      get lateCompletionCount() { return lateCompletionCount },
    }
    return deferred
  }
  const invoke = async (port: string, purpose: Purpose, selection: Selection, detail?: string) => {
    calls.push({ port, purpose, provider: selection.provider, detail })
    await hangs.get(port)?.promise
  }
  return {
    calls, fs, scheduler, processes, deferredCliAttempts,
    hang: port => {
      const deferred = makeDeferred<void>()
      hangs.set(port, deferred)
      return deferred
    },
    profile: (purpose, selection) => invoke('profile', purpose, selection),
    lock: (purpose, selection) => invoke('lock', purpose, selection),
    write: (purpose, selection) => invoke('write', purpose, selection),
    cli: (purpose, selection, args) => invoke(`cli:${selection.provider}`, purpose, selection, args.join(' ')),
    retryCli: (purpose, selection) => {
      calls.push({ port: `cli:${selection.provider}`, purpose, provider: selection.provider, detail: 'retry-catalog' })
      const deferred = makeDeferred<void>()
      deferredCliAttempts.push(deferred)
      return deferred
    },
    host: (purpose, selection, operation) => invoke('host', purpose, selection, operation),
    plugin: (purpose, selection, provider) => invoke(`plugin:${provider}`, purpose, selection, 'serve-startup'),
    remoteCreate: (selection, member) => invoke('remote-create', 'launch', selection, String(member)),
  }
}

type UnsafeVariant = 'constant-status' | 'proof-leaking-host' | 'delimiter-collision' |
  'shared-map-restart' | 'log-only-cleanup' | 'log-only-cancel'

const stateFile = (sandbox: string) => path.join(sandbox, 'state', 'coordinator.json')

export class PortableOpenCodeAcceptanceHarness {
  readonly projects: { primary: string; secondary: string }
  readonly ledger: AcceptanceLedger = { schema: 1, events: [] }
  readonly adapter: {
    status(selection: Selection): Promise<{ state: 'fresh' | 'unknown'; generation: number | null }>
    catalog(selection: Selection, models: string[]): Promise<void>
    launch(selection: Selection, proof: Proof, rawNonce: string): Promise<LaunchResult>
  }
  private state: Persisted
  private seq = 0
  private capabilities = new WeakMap<object, { hostId: string; selection: Selection; valid: boolean }>()

  private constructor(
    readonly sandboxPath: string,
    readonly ports: AcceptancePorts,
    readonly variant?: UnsafeVariant,
  ) {
    this.projects = { primary: path.join(sandboxPath, 'project-a'), secondary: path.join(sandboxPath, 'project-b') }
    this.state = this.parseState()
    this.adapter = {
      status: selection => this.status(selection),
      catalog: (selection, models) => this.catalog(selection, models),
      launch: (selection, proof, rawNonce) => this.launch(selection, proof, rawNonce),
    }
    this.reconcileHosts()
  }

  static async create(options: { variant?: UnsafeVariant; ports?: AcceptancePorts } = {}): Promise<PortableOpenCodeAcceptanceHarness> {
    const tempBase = process.env.TMPDIR && path.isAbsolute(process.env.TMPDIR) ? process.env.TMPDIR : os.tmpdir()
    const sandbox = await mkdtemp(path.join(tempBase, 'opencode-phase0-contract-'))
    await mkdir(path.join(sandbox, 'project-a'))
    await mkdir(path.join(sandbox, 'project-b'))
    return new PortableOpenCodeAcceptanceHarness(sandbox, options.ports ?? createTrapPorts(), options.variant)
  }

  async cleanup(): Promise<void> {
    await rm(this.sandboxPath, { recursive: true, force: true })
  }

  private event(event: Omit<LedgerEvent, 'seq'>): void {
    this.ledger.events.push({ seq: ++this.seq, ...event })
  }

  private emptyState(): Persisted {
    return { version: 1, caches: [], claims: [], hosts: [] }
  }

  private parseState(): Persisted {
    const bytes = this.ports.fs.read(stateFile(this.sandboxPath))
    if (!bytes) return this.emptyState()
    try {
      const state = JSON.parse(decoder.decode(bytes)) as Persisted
      if (state.version !== 1 || !Array.isArray(state.caches) || !Array.isArray(state.claims) || !Array.isArray(state.hosts)) throw new Error('schema')
      return structuredClone(state)
    } catch {
      return this.emptyState()
    }
  }

  private persist(): void {
    const bytes = encoder.encode(JSON.stringify(this.state))
    this.ports.fs.atomicWrite(stateFile(this.sandboxPath), bytes)
    this.event({ purpose: 'system', effect: 'persistence', action: 'atomic-write' })
  }

  private same(left: Selection, right: Selection): boolean {
    if (this.variant === 'delimiter-collision') {
      const unsafe = (item: Selection) => Object.values(item).join('|')
      return unsafe(left) === unsafe(right)
    }
    return bytesEqual(canonicalBytes(left), canonicalBytes(right))
  }

  private cache(selection: Selection) {
    return this.state.caches.find(item => this.same(item.identity, selection))
  }

  private async status(selection: Selection): Promise<{ state: 'fresh' | 'unknown'; generation: number | null }> {
    this.event({ purpose: 'status', effect: 'route', action: 'status', projectHash: hash(selection.project), provider: selection.provider })
    if (this.variant === 'constant-status') return { state: 'unknown', generation: null }
    const cached = this.cache(selection)
    return cached ? { state: 'fresh', generation: cached.identity.cacheGeneration } : { state: 'unknown', generation: null }
  }

  private async catalog(selection: Selection, models: string[]): Promise<void> {
    this.event({ purpose: 'catalog', effect: 'route', action: 'catalog', projectHash: hash(selection.project), provider: selection.provider })
    await this.ports.cli('catalog', selection, ['models', '--provider', selection.provider])
    this.event({ purpose: 'catalog', effect: 'cli', action: 'scoped-models', projectHash: hash(selection.project), provider: selection.provider })
    this.state.caches = this.state.caches.filter(item => !this.same(item.identity, selection))
    this.state.caches.push({ identity: structuredClone(selection), models: [...models] })
    this.persist()
  }

  private proofMatches(selection: Selection, proof: Proof, rawNonce: string): boolean {
    if (rawNonce.trim() !== rawNonce || proof.nonce !== rawNonce || proof.appMcp !== true) return false
    const { nonce: _nonce, appMcp: _appMcp, ...proofSelection } = proof
    return this.same(selection, proofSelection)
  }

  private async launch(selection: Selection, proof: Proof, rawNonce: string): Promise<LaunchResult> {
    this.event({ purpose: 'launch', effect: 'route', action: 'launch', projectHash: hash(selection.project), provider: selection.provider })
    if (!this.cache(selection)) return { ok: false, reason: 'catalog-miss', capability: null }
    await this.ports.profile('launch', selection)
    this.event({ purpose: 'launch', effect: 'profile', action: 'prepare', projectHash: hash(selection.project), provider: selection.provider })
    await this.ports.lock('launch', selection)
    this.event({ purpose: 'launch', effect: 'lock', action: 'acquire', projectHash: hash(selection.project), provider: selection.provider })
    await this.ports.write('launch', selection)
    this.event({ purpose: 'launch', effect: 'write', action: 'managed-config', projectHash: hash(selection.project), provider: selection.provider })
    await this.ports.plugin('launch', selection, selection.provider)
    this.event({ purpose: 'launch', effect: 'plugin', action: 'selected-provider', projectHash: hash(selection.project), provider: selection.provider, identityHash: hash(selection.plugin) })
    const pid = this.ports.processes.spawn(null)
    const hostId = hash(canonicalBytes({ selection, pid }))
    this.event({ purpose: 'launch', effect: 'host', action: 'start', projectHash: hash(selection.project), provider: selection.provider, identityHash: hostId, pid, alive: true })
    await this.ports.host('launch', selection, 'exact-proof')
    const accepted = this.proofMatches(selection, proof, rawNonce)
    this.event({ purpose: 'launch', effect: 'proof', action: accepted ? 'accepted' : 'denied', projectHash: hash(selection.project), provider: selection.provider, identityHash: hash(canonicalBytes(proof)), accepted })
    if (!accepted) {
      if (this.variant !== 'proof-leaking-host') {
        this.ports.processes.signal(pid, 'KILL')
        this.event({ purpose: 'launch', effect: 'host', action: 'release', projectHash: hash(selection.project), provider: selection.provider, identityHash: hostId, pid, alive: false })
        return { ok: false, reason: 'proof-denied', capability: null }
      }
    }
    const token = {} as MemberCapability
    this.capabilities.set(token, { hostId, selection: structuredClone(selection), valid: accepted })
    if (!accepted) return { ok: false, reason: 'proof-denied', capability: token as never }
    this.state.hosts.push({ hostId, selection: structuredClone(selection), pid, retained: true })
    this.persist()
    this.event({ purpose: 'launch', effect: 'host', action: 'retain', projectHash: hash(selection.project), provider: selection.provider, identityHash: hostId, pid, alive: true })
    return { ok: true, reason: 'accepted', capability: token }
  }

  async createMembers(capability: MemberCapability | null | undefined, members: number[], barrier?: Barrier): Promise<number[]> {
    const authority = capability && this.capabilities.get(capability)
    if (!authority?.valid) throw new Error('proof-authorized member capability required')
    const committed: number[] = []
    for (const member of members) {
      const key = hash(canonicalBytes({ project: authority.selection.project, member }))
      const claimed = await this.ports.fs.claimOnce(key, barrier)
      if (!claimed) continue
      this.event({ purpose: 'launch', effect: 'member', action: 'claim', projectHash: hash(authority.selection.project), identityHash: key })
      await this.ports.remoteCreate(authority.selection, member)
      this.event({ purpose: 'launch', effect: 'member', action: 'remote-create', projectHash: hash(authority.selection.project), identityHash: key })
      this.state.claims.push({ key, state: 'remote-created' })
      this.persist()
      this.state.claims.find(item => item.key === key)!.state = 'committed'
      this.persist()
      this.event({ purpose: 'launch', effect: 'member', action: 'commit', projectHash: hash(authority.selection.project), identityHash: key })
      committed.push(member)
    }
    return committed
  }

  async createMemberUntilRemote(capability: MemberCapability, member: number): Promise<void> {
    const authority = this.capabilities.get(capability)
    if (!authority?.valid) throw new Error('proof-authorized member capability required')
    const key = hash(canonicalBytes({ project: authority.selection.project, member }))
    if (!await this.ports.fs.claimOnce(key)) return
    this.event({ purpose: 'launch', effect: 'member', action: 'claim', projectHash: hash(authority.selection.project), identityHash: key })
    await this.ports.remoteCreate(authority.selection, member)
    this.event({ purpose: 'launch', effect: 'member', action: 'remote-create', projectHash: hash(authority.selection.project), identityHash: key })
    this.state.claims.push({ key, state: 'remote-created' })
    this.persist()
  }

  reconcileClaims(): number {
    let reconciled = 0
    for (const claim of this.state.claims) if (claim.state === 'remote-created') {
      claim.state = 'committed'
      reconciled += 1
      this.event({ purpose: 'system', effect: 'member', action: 'reconcile', identityHash: claim.key })
    }
    if (reconciled > 0) this.persist()
    return reconciled
  }

  /** Abrupt crash intentionally performs no cancellation, host release, or process cleanup. */
  crash(): void {
    this.event({ purpose: 'system', effect: 'operation', action: 'abrupt-crash' })
  }

  restart(): PortableOpenCodeAcceptanceHarness {
    if (this.variant === 'shared-map-restart') {
      const next = new PortableOpenCodeAcceptanceHarness(this.sandboxPath, this.ports, this.variant)
      next.state = this.state
      return next
    }
    const rebootedPorts = { ...this.ports, fs: this.ports.fs.rebootedDevice() }
    return new PortableOpenCodeAcceptanceHarness(this.sandboxPath, rebootedPorts, this.variant)
  }

  private reconcileHosts(): void {
    for (const host of this.state.hosts) if (this.ports.processes.alive.has(host.pid)) {
      this.event({ purpose: 'system', effect: 'host', action: 'reconcile-retained', projectHash: hash(host.selection.project), provider: host.selection.provider, identityHash: host.hostId, pid: host.pid, alive: true })
    }
  }

  cleanupTree(root: number): void {
    const pids = [...this.ports.processes.descendants(root), root]
    for (const pid of pids) {
      this.ports.processes.signal(pid, 'TERM')
      this.event({ purpose: 'system', effect: 'process', action: 'TERM', pid, parentPid: this.ports.processes.parents.get(pid) ?? null, alive: this.ports.processes.alive.has(pid) })
    }
    if (this.variant !== 'log-only-cleanup') for (const pid of pids) if (this.ports.processes.alive.has(pid)) {
      this.ports.processes.signal(pid, 'KILL')
      this.event({ purpose: 'system', effect: 'process', action: 'KILL', pid, parentPid: this.ports.processes.parents.get(pid) ?? null, alive: false })
    }
  }

  async retryCatalog(selection: Selection, deadline: number, cleanupReserve: number): Promise<{ attempts: number; timedOut: boolean }> {
    let attempts = 0
    let authoritative = true
    let active: Deferred<void> | null = null
    const cutoff = deadline - cleanupReserve
    const run = async (): Promise<void> => {
      while (authoritative && attempts < 3) {
        attempts += 1
        this.event({ purpose: 'catalog', effect: 'operation', action: 'attempt', attempt: attempts, at: this.ports.scheduler.now, provider: selection.provider })
        try {
          active = this.ports.retryCli('catalog', selection)
          active.onLateCompletion = () => {
            this.event({ purpose: 'catalog', effect: 'operation', action: 'late-completion-ignored', attempt: attempts, at: this.ports.scheduler.now, provider: selection.provider })
          }
          await active.promise
          if (authoritative) this.event({ purpose: 'catalog', effect: 'operation', action: 'accepted-completion', attempt: attempts, at: this.ports.scheduler.now, provider: selection.provider })
          else this.event({ purpose: 'catalog', effect: 'operation', action: 'late-completion-ignored', attempt: attempts, at: this.ports.scheduler.now, provider: selection.provider })
          return
        } catch {
          if (authoritative) this.event({ purpose: 'catalog', effect: 'operation', action: 'retry', attempt: attempts, at: this.ports.scheduler.now, provider: selection.provider })
        }
      }
    }
    const running = run()
    const timeout = new Promise<void>(resolve => this.ports.scheduler.at(cutoff, () => {
      authoritative = false
      this.event({ purpose: 'catalog', effect: 'deadline', action: 'cancel', attempt: attempts, at: cutoff, provider: selection.provider })
      if (this.variant !== 'log-only-cancel') active?.cancel()
      this.event({ purpose: 'system', effect: 'deadline', action: 'cleanup-reserve', at: cutoff })
      resolve()
    }))
    await Promise.race([running, timeout])
    return { attempts, timedOut: !authoritative }
  }

  machineLedgerBytes(): Uint8Array {
    validateLedger(this.ledger)
    return encoder.encode(JSON.stringify(this.ledger))
  }
}

const PURPOSES = new Set(['status', 'catalog', 'launch', 'system'])
const EFFECTS = new Set(['route', 'profile', 'lock', 'write', 'cli', 'host', 'process', 'plugin', 'proof', 'member', 'operation', 'deadline', 'persistence'])
const ACTIONS = new Set([
  'status', 'catalog', 'launch', 'scoped-models', 'atomic-write', 'prepare', 'acquire',
  'managed-config', 'selected-provider', 'start', 'accepted', 'denied', 'release',
  'retain', 'claim', 'remote-create', 'commit', 'reconcile', 'abrupt-crash',
  'reconcile-retained', 'TERM', 'KILL', 'attempt', 'accepted-completion', 'retry',
  'cancel', 'cleanup-reserve', 'late-completion-ignored',
])
const EVENT_KEYS = new Set([
  'seq', 'purpose', 'effect', 'action', 'projectHash', 'provider', 'identityHash', 'pid',
  'parentPid', 'generation', 'accepted', 'alive', 'attempt', 'at',
])
const HASH_PATTERN = /^h:[0-9a-f]{64}$/

export function validateLedger(value: unknown): asserts value is AcceptanceLedger {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid acceptance ledger schema')
  const ledger = value as Record<string, unknown>
  if (Object.keys(ledger).some(key => key !== 'schema' && key !== 'events') || Object.keys(ledger).length !== 2) throw new Error('invalid acceptance ledger keys')
  if (ledger.schema !== 1 || !Array.isArray(ledger.events)) throw new Error('invalid acceptance ledger schema')
  let expected = 1
  if (ledger.events.length > 10_000) throw new Error('acceptance ledger too large')
  for (const rawEvent of ledger.events) {
    if (!rawEvent || typeof rawEvent !== 'object' || Array.isArray(rawEvent)) throw new Error('invalid acceptance ledger event')
    const event = rawEvent as Record<string, unknown>
    if (Object.keys(event).some(key => !EVENT_KEYS.has(key))) throw new Error('unknown acceptance ledger event field')
    if (!Number.isSafeInteger(event.seq) || event.seq !== expected++) throw new Error('invalid acceptance ledger sequence')
    if (typeof event.purpose !== 'string' || !PURPOSES.has(event.purpose)) throw new Error('invalid acceptance ledger purpose')
    if (typeof event.effect !== 'string' || !EFFECTS.has(event.effect)) throw new Error('invalid acceptance ledger effect')
    if (typeof event.action !== 'string' || event.action.length < 1 || event.action.length > 64 || !ACTIONS.has(event.action)) throw new Error('invalid acceptance ledger action')
    for (const key of ['projectHash', 'identityHash'] as const) {
      if (event[key] !== undefined && (typeof event[key] !== 'string' || !HASH_PATTERN.test(event[key]))) throw new Error(`invalid ${key}`)
    }
    if (event.provider !== undefined && (typeof event.provider !== 'string' || !['deepinfra', 'kiro', 'cursor'].includes(event.provider))) throw new Error('invalid provider')
    for (const key of ['pid', 'generation', 'attempt', 'at'] as const) {
      if (event[key] !== undefined && (!Number.isSafeInteger(event[key]) || (event[key] as number) < 0)) throw new Error(`invalid ${key}`)
    }
    if (event.parentPid !== undefined && event.parentPid !== null && (!Number.isSafeInteger(event.parentPid) || (event.parentPid as number) < 0)) throw new Error('invalid parentPid')
    for (const key of ['accepted', 'alive'] as const) if (event[key] !== undefined && typeof event[key] !== 'boolean') throw new Error(`invalid ${key}`)
  }
}

export const selectionFor = (project: string, overrides: Partial<Selection> = {}): Selection => ({
  project,
  provider: 'deepinfra',
  model: 'deepinfra/meta-llama/Llama-3.3-70B-Instruct',
  profile: 'strict-profile',
  config: 'config-generation-1',
  auth: 'auth-generation-1',
  binary: 'binary-generation-1',
  plugin: 'deepinfra-managed@1',
  cacheGeneration: 1,
  mcp: 'app-mcp-generation-1',
  ...overrides,
})

export const proofFor = (selection: Selection, nonce = 'raw-nonce'): Proof => ({ ...selection, nonce, appMcp: true })

export type { UnsafeVariant }
