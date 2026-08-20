import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export type OpenCodeRegressionTarget = 'status' | 'catalog' | 'launch'

export type FakeOpenCodeJournal = {
  commands: Array<{ target: OpenCodeRegressionTarget; args: string[] }>
  filesystemWrites: Array<{ target: OpenCodeRegressionTarget; path: string }>
  managedPlugins: Array<{
    target: OpenCodeRegressionTarget
    packageName: string
    action: 'catalog-prewarm' | 'serve-startup'
  }>
  httpRequests: Array<{ target: OpenCodeRegressionTarget; method: string; pathname: string }>
  childProcesses: Array<{
    target: OpenCodeRegressionTarget
    pid: number
    event: 'spawn' | 'cleanup'
  }>
  operations: Array<{
    target: OpenCodeRegressionTarget
    name: string
    event: 'started' | 'cancelled' | 'completed' | 'late-completion'
  }>
}

export type DeferredFakeOperation<T> = {
  promise: Promise<T>
  cancel: () => void
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

export type ObservedPromise<T> =
  | { state: 'pending' }
  | { state: 'fulfilled'; value: T }
  | { state: 'rejected'; reason: unknown }

type ScheduledTask = { at: number; sequence: number; callback: () => void }

/** A timer queue for regression tests. Advancing it never waits on wall-clock time. */
export class FakeOpenCodeClock {
  private nowValue = 0
  private nextSequence = 0
  private readonly tasks: ScheduledTask[] = []

  get now(): number {
    return this.nowValue
  }

  setTimeout(callback: () => void, delayMs: number): void {
    this.tasks.push({
      at: this.nowValue + Math.max(0, delayMs),
      sequence: this.nextSequence++,
      callback,
    })
  }

  advanceBy(ms: number): void {
    const end = this.nowValue + Math.max(0, ms)
    while (true) {
      const next = this.tasks
        .filter(task => task.at <= end)
        .sort((left, right) => left.at - right.at || left.sequence - right.sequence)[0]
      if (!next) break
      this.tasks.splice(this.tasks.indexOf(next), 1)
      this.nowValue = next.at
      next.callback()
    }
    this.nowValue = end
  }
}

export class FakeOpenCodeRegressionHarness {
  readonly clock = new FakeOpenCodeClock()
  readonly journal: FakeOpenCodeJournal = {
    commands: [],
    filesystemWrites: [],
    managedPlugins: [],
    httpRequests: [],
    childProcesses: [],
    operations: [],
  }

  private nextPid = 41_000
  private readonly hostResponses = new Map<string, unknown>()

  private constructor(
    readonly sandboxPath: string,
    readonly projectPath: string,
  ) {}

  static async create(): Promise<FakeOpenCodeRegressionHarness> {
    const sandboxPath = await mkdtemp(path.join(os.tmpdir(), 'fake-opencode-regression-'))
    const projectPath = path.join(sandboxPath, 'project')
    await mkdir(projectPath)
    return new FakeOpenCodeRegressionHarness(sandboxPath, projectPath)
  }

  async cleanup(): Promise<void> {
    await rm(this.sandboxPath, { recursive: true, force: true })
  }

  async writeSandboxFile(
    target: OpenCodeRegressionTarget,
    relativePath: string,
    contents = '',
  ): Promise<string> {
    const destination = path.resolve(this.sandboxPath, relativePath)
    const relative = path.relative(this.sandboxPath, destination)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Fake OpenCode write escaped the sandbox: ${destination}`)
    }
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, contents)
    this.journal.filesystemWrites.push({ target, path: destination })
    return destination
  }

  writeSandboxFileSync(
    target: OpenCodeRegressionTarget,
    relativePath: string,
    contents = '',
  ): string {
    const destination = path.resolve(this.sandboxPath, relativePath)
    const relative = path.relative(this.sandboxPath, destination)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Fake OpenCode write escaped the sandbox: ${destination}`)
    }
    mkdirSync(path.dirname(destination), { recursive: true })
    writeFileSync(destination, contents)
    this.journal.filesystemWrites.push({ target, path: destination })
    return destination
  }

  fakeCli(target: OpenCodeRegressionTarget) {
    return {
      exec: async (args: readonly string[]): Promise<{ stdout: string; stderr: string; code: number }> => {
        const copiedArgs = [...args]
        this.journal.commands.push({ target, args: copiedArgs })
        if (copiedArgs[0] === '--version') {
          return { stdout: '1.17.18\n', stderr: '', code: 0 }
        }
        if (copiedArgs.join(' ') === 'models --verbose') {
          return { stdout: 'openrouter/openai/gpt-5.4\n', stderr: '', code: 0 }
        }
        return { stdout: '', stderr: '', code: 0 }
      },
    }
  }

  fakeHostHttpApi(target: OpenCodeRegressionTarget) {
    return {
      setResponse: (method: string, pathname: string, response: unknown): void => {
        this.hostResponses.set(`${method.toUpperCase()} ${pathname}`, response)
      },
      request: async (method: string, pathname: string): Promise<unknown> => {
        const normalizedMethod = method.toUpperCase()
        this.journal.httpRequests.push({ target, method: normalizedMethod, pathname })
        const key = `${normalizedMethod} ${pathname}`
        if (!this.hostResponses.has(key)) {
          throw new Error(`Unexpected fake OpenCode host request: ${key}`)
        }
        return this.hostResponses.get(key)
      },
    }
  }

  recordManagedPlugin(
    target: OpenCodeRegressionTarget,
    action: 'catalog-prewarm' | 'serve-startup',
    packageName = 'opencode-kiro@0.4.0',
  ): void {
    this.journal.managedPlugins.push({ target, packageName, action })
  }

  spawnChild(target: OpenCodeRegressionTarget): { pid: number; cleanup: () => void } {
    const pid = this.nextPid++
    let cleaned = false
    this.journal.childProcesses.push({ target, pid, event: 'spawn' })
    return {
      pid,
      cleanup: () => {
        if (cleaned) return
        cleaned = true
        this.journal.childProcesses.push({ target, pid, event: 'cleanup' })
      },
    }
  }

  deferred<T>(target: OpenCodeRegressionTarget, name: string): DeferredFakeOperation<T> {
    let resolvePromise!: (value: T | PromiseLike<T>) => void
    let rejectPromise!: (reason?: unknown) => void
    let cancelled = false
    let settled = false
    const promise = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })
    this.journal.operations.push({ target, name, event: 'started' })
    const complete = (event: 'completed' | 'late-completion') => {
      if (settled) return false
      settled = true
      this.journal.operations.push({ target, name, event })
      return true
    }
    return {
      promise,
      cancel: () => {
        if (cancelled || settled) return
        cancelled = true
        this.journal.operations.push({ target, name, event: 'cancelled' })
      },
      resolve: value => {
        if (complete(cancelled ? 'late-completion' : 'completed')) resolvePromise(value)
      },
      reject: reason => {
        if (complete(cancelled ? 'late-completion' : 'completed')) rejectPromise(reason)
      },
    }
  }

  async observePromise<T>(promise: Promise<T>, microtaskTurns = 4): Promise<ObservedPromise<T>> {
    let observation: ObservedPromise<T> = { state: 'pending' }
    void promise.then(
      value => { observation = { state: 'fulfilled', value } },
      reason => { observation = { state: 'rejected', reason } },
    )
    for (let turn = 0; turn < microtaskTurns; turn += 1) await Promise.resolve()
    return observation
  }
}
