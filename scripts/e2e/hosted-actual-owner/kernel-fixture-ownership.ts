import type { ChildProcessWithoutNullStreams } from 'node:child_process'

/** Register immediately after spawn, before the first observation or assertion. */
export class OwnedKernelChild {
  readonly exited: Promise<void>
  stderr = ''
  terminal = false
  error: Error | undefined
  constructor(readonly child: ChildProcessWithoutNullStreams, readonly group = false) {
    this.exited = new Promise(resolve => {
      const finish = () => { this.terminal = true; resolve() }
      child.once('exit', finish)
      child.on('error', error => { this.error = error; if (!child.pid) finish() })
      child.once('close', finish)
    })
    child.stderr.on('data', bytes => { this.stderr = (this.stderr + String(bytes)).slice(-65536) })
    child.stdin.on('error', error => { this.error ??= error })
  }
  get alive(): boolean { return !this.terminal && this.child.exitCode === null && this.child.signalCode === null }
  async wait(milliseconds: number): Promise<boolean> {
    if (!this.alive) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([this.exited.then(() => true), new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), milliseconds)
    })]) } finally { clearTimeout(timer) }
  }
  async stop(grace = 3500): Promise<void> {
    if (this.alive) this.child.stdin.end()
    for (const [delay, signal] of [[grace, 'SIGTERM'], [1500, 'SIGKILL']] as const) {
      if (await this.wait(delay)) break
      try {
        if (this.group && this.child.pid) process.kill(-this.child.pid, signal)
        else this.child.kill(signal)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    }
    if (!await this.wait(500)) throw new Error(`Owned fixture did not exit: ${this.child.pid}`)
    this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy()
  }
}

export class KernelChannel {
  private queue: any[] = []
  private queuedBytes = 0
  private failure: Error | undefined
  private waiting?: { resolve(value: unknown): void; reject(error: Error): void }
  constructor(readonly owner: OwnedKernelChild) {
    const child = owner.child
    let buffered = ''
    const fail = (error: Error) => {
      this.failure ??= error
      const waiting = this.waiting; this.waiting = undefined; waiting?.reject(this.failure)
    }
    child.once('error', fail)
    child.stdin.on('error', fail)
    child.once('exit', () => fail(new Error(`Kernel helper exited (${child.exitCode ?? child.signalCode}): ${owner.stderr}`)))
    child.stdout.once('end', () => fail(new Error('Kernel helper output closed: ' + owner.stderr)))
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (this.failure) return
      try {
        if (buffered.length + chunk.length > 1024 * 1024) throw new Error('Kernel observation line overflow')
        buffered += chunk
        for (let newline; (newline = buffered.indexOf('\n')) >= 0;) {
          const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1)
          if (this.queue.length >= 64 || this.queuedBytes + line.length > 2 * 1024 * 1024) throw new Error('Kernel observation queue overflow')
          const value = JSON.parse(line)
          if (this.waiting) { const waiting = this.waiting; this.waiting = undefined; waiting.resolve(value) }
          else { this.queue.push({ value, size: line.length }); this.queuedBytes += line.length }
        }
      } catch (error) { fail(error as Error) }
    })
  }
  send(value: unknown): void {
    if (this.failure || !this.owner.alive) throw this.failure ?? new Error('Kernel helper is terminal')
    const line = JSON.stringify(value) + '\n'
    if (line.length + this.owner.child.stdin.writableLength > 2 * 1024 * 1024) throw new Error('Kernel command queue overflow')
    this.owner.child.stdin.write(line)
  }
  async next(): Promise<any> {
    if (this.queue.length) { const row = this.queue.shift(); this.queuedBytes -= row.size; return row.value }
    if (this.failure || !this.owner.alive) throw this.failure ?? new Error('Kernel helper is terminal')
    if (this.waiting) throw new Error('Concurrent kernel observation wait')
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await new Promise((resolve, reject) => {
      this.waiting = { resolve, reject }
      timer = setTimeout(() => { this.waiting = undefined; reject(new Error('Kernel fixture observation timeout: ' + this.owner.stderr)) }, 12000)
    }) } finally { clearTimeout(timer) }
  }
}
