export type NativeIngressPhase = 'setup' | 'host-admission' | 'private-argv' | 'unauthorized-config' |
  'unauthorized-body' | 'authorized-config' | 'stop' | 'dead-receipt' | 'lifecycle-drain' | 'cleanup' | 'complete'
type CleanupState = 'unavailable' | 'ready' | 'pending' | 'confirmed' | 'unconfirmed'
type IngressEvent = 'begin' | 'settled' | 'close' | 'cleanup-start' | 'cleanup-end' | 'complete'
export type NativeIngressDiagnostic = {
  phase: NativeIngressPhase; event: IngressEvent; closed: boolean; pendingStages: number; cleanup: CleanupState
}

/** TEST-only ownership. A framework timeout closes admission; it never cancels a Promise or proves child death. */
export class NativeIngressFixture {
  private readonly controller = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private phase: NativeIngressPhase = 'setup'
  private closed = false
  private unknown = false
  private complete = false
  private bodySettled = false
  private acquired = false
  private dispose?: () => Promise<boolean>
  private disposal?: Promise<boolean>
  private cleanupState: CleanupState = 'unavailable'
  private restore?: () => void
  private restored = false

  constructor(private readonly report: (diagnostic: NativeIngressDiagnostic) => void = () => undefined) {}

  get signal(): AbortSignal { return this.controller.signal }
  get settledSuccessfully(): boolean { return this.complete && this.bodySettled && !this.unknown }

  private trace(event: IngressEvent, phase = this.phase): void {
    try { this.report({ phase, event, closed: this.closed, pendingStages: this.pending.size, cleanup: this.cleanupState }) }
    catch { /* Finite diagnostics never alter ownership or cleanup. */ }
  }
  private assertOpen(): void {
    if (this.closed) throw new Error('TEST_native_ingress_closed')
  }
  captureScopeRestore(restore: () => void): void {
    this.assertOpen()
    if (this.restore) throw new Error('TEST_native_ingress_scope_already_owned')
    this.restore = restore
  }
  captureCleanup(dispose: () => Promise<boolean>): void {
    this.assertOpen()
    if (this.dispose) throw new Error('TEST_native_ingress_cleanup_already_owned')
    this.dispose = dispose
  }
  async adopt<T>(resource: T): Promise<T> {
    if (!this.dispose || this.acquired) throw new Error('TEST_native_ingress_adoption_invalid')
    this.acquired = true
    this.cleanupState = 'ready'
    // A late launch result belongs only to this captured cleanup, never a later test body.
    if (this.closed) await this.cleanup()
    this.assertOpen()
    return resource
  }
  stage<T>(phase: NativeIngressPhase, work: () => Promise<T>): Promise<T> {
    this.assertOpen()
    this.phase = phase
    // Register the actual operation before its factory runs, including synchronous failures.
    const operation = Promise.resolve().then(() => { this.assertOpen(); return work() })
    this.pending.add(operation)
    this.trace('begin', phase)
    return operation.then(value => { this.assertOpen(); return value }).finally(() => {
      this.pending.delete(operation)
      this.trace('settled', phase)
    })
  }
  cleanup(): Promise<boolean> {
    if (this.disposal) return this.disposal
    // Do not memoize a false result before a pending launch can hand back its original host.
    if (!this.acquired || !this.dispose) return Promise.resolve(false)
    const dispose = this.dispose
    this.phase = 'cleanup'
    this.cleanupState = 'pending'
    this.disposal = Promise.resolve().then(dispose).then(confirmed => {
      this.cleanupState = confirmed === true ? 'confirmed' : 'unconfirmed'
      if (confirmed !== true) this.unknown = true
      this.trace('cleanup-end')
      return confirmed === true
    }, error => {
      this.cleanupState = 'unconfirmed'
      this.unknown = true
      this.trace('cleanup-end')
      throw error
    })
    this.trace('cleanup-start')
    // afterAll and a late body share this exact operation; neither retries a rejected Stop.
    void this.disposal.catch(() => undefined)
    return this.disposal
  }
  close(): void {
    if (!this.complete) this.unknown = true
    if (this.closed) return
    this.closed = true
    this.controller.abort(new Error('TEST_native_ingress_closed'))
    this.trace('close')
  }
  async run(body: () => Promise<void>): Promise<void> {
    this.assertOpen()
    let failed = false, failure: unknown
    try { await body(); this.assertOpen() }
    catch (error) { failed = true; failure = error; this.unknown = true }
    try {
      if (!await this.cleanup()) throw new Error('TEST_native_ingress_cleanup_unconfirmed')
    } catch (error) {
      if (!failed) failure = error
      failed = true; this.unknown = true
    }
    if (this.pending.size > 0) {
      if (!failed) failure = new Error('TEST_native_ingress_pending')
      failed = true; this.unknown = true
    }
    // No restored environment may race a pending factory or an unconfirmed cleanup.
    if (this.cleanupState === 'confirmed' && this.pending.size === 0 && !this.restored) {
      this.restored = true
      try { this.restore?.() }
      catch (error) {
        if (!failed) failure = error
        failed = true; this.unknown = true
      }
    }
    this.bodySettled = true
    if (!failed && !this.unknown && !this.closed && this.pending.size === 0 &&
      this.cleanupState === 'confirmed' && this.restored) {
      this.complete = true
      this.phase = 'complete'
      this.trace('complete')
    } else if (!failed) {
      failed = true; failure = new Error('TEST_native_ingress_closed')
    }
    this.close()
    if (failed) throw failure
  }
}

/** The prior owner survives a failing beforeEach and its subsequently invoked afterEach. */
export class NativeIngressFixtureCases {
  readonly attempts: NativeIngressFixture[] = []
  private active?: NativeIngressFixture
  private hookOwner?: NativeIngressFixture

  private assertPriorSettled(): void {
    if (this.active && !this.active.settledSuccessfully) throw new Error('TEST_native_ingress_prior_unknown')
  }
  beforeEach(): void {
    this.assertPriorSettled()
    this.hookOwner = undefined
  }
  afterEach(): void { this.hookOwner?.close() }
  owns(owner: NativeIngressFixture): boolean { return this.active === owner }
  begin(report?: (diagnostic: NativeIngressDiagnostic) => void): NativeIngressFixture {
    this.assertPriorSettled()
    const owner = new NativeIngressFixture(report)
    this.active = owner
    this.hookOwner = owner
    this.attempts.push(owner)
    return owner
  }
}

