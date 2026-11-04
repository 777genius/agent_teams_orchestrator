import type { ChildProcess } from 'node:child_process'

import { killProcessTree } from '../../utils/processKill.js'

export type CodexNativeRunnerLifecycle = {
  submissionMayHaveStarted: boolean
  turnTerminal: boolean
  childStopped: boolean
}

/** Evidence for the conversation owner; never infer retry safety from prose. */
export class CodexNativeRunnerError extends Error {
  readonly lifecycle: Readonly<CodexNativeRunnerLifecycle>

  constructor(error: unknown, lifecycle: CodexNativeRunnerLifecycle) {
    super(error instanceof Error ? error.message : String(error), { cause: error })
    this.name = 'CodexNativeRunnerError'
    this.lifecycle = { ...lifecycle }
  }
}

export function assertCodexNativeContinuationOptions(options: {
  resumeThreadId?: string
  sessionsDirectory?: string
  ephemeral?: boolean
}): void {
  if (options.resumeThreadId !== undefined &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.resumeThreadId)) {
    throw new Error('Codex native resume requires an exact thread UUID.')
  }
  if (options.resumeThreadId !== undefined && !options.sessionsDirectory) {
    throw new Error('Codex native resume requires owned session storage.')
  }
  if ((options.sessionsDirectory || options.resumeThreadId) && options.ephemeral !== false) {
    throw new Error('Codex native continuation requires a persistent thread.')
  }
}

type NativeChild = Pick<ChildProcess, 'once' | 'stdin' | 'pid' | 'kill'>
type NativeExit = { code: number | null; signal: NodeJS.Signals | null }

/** Observe termination immediately after spawn, before any input can be admitted. */
export function observeCodexNativeChild(child: NativeChild) {
  let stopped = false
  let failedToSpawn = false
  let shutdownPromise: Promise<boolean> | null = null
  const closed = new Promise<NativeExit>(resolve => {
    child.once('close', (code, signal) => {
      stopped = true
      resolve({ code, signal })
    })
    child.once('error', () => {
      // Failed spawn has no process to stop or admit input. Do not depend on a
      // later close event, or confuse an existing process's error with exit.
      if (child.pid !== undefined) return
      failedToSpawn = true
      stopped = true
      resolve({ code: null, signal: null })
    })
  })
  const signal = (value: NodeJS.Signals): void => {
    if (stopped) return
    try {
      if (child.pid && child.pid > 1) {
        if (process.platform !== 'win32') {
          try {
            process.kill(-child.pid, value)
            return
          } catch { /* Not a detached group, or it has already gone. */ }
        }
        killProcessTree(child.pid, value)
      } else {
        child.kill(value)
      }
    } catch { /* A signal result alone does not confirm shutdown. */ }
  }
  const wait = async (ms: number): Promise<boolean> => {
    if (stopped) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        closed.then(() => true),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms) }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  const shutdown = (graceMs = 250): Promise<boolean> => {
    if (stopped) return Promise.resolve(true)
    if (shutdownPromise) return shutdownPromise
    shutdownPromise = (async () => {
      try {
        if (child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end()
      } catch { /* Continue bounded termination even if stdin has failed. */ }
      if (await wait(graceMs)) return true
      signal('SIGTERM')
      if (await wait(1_000)) return true
      // child.killed only means a signal was sent; it does not prove exit.
      signal('SIGKILL')
      return wait(1_000)
    })()
    return shutdownPromise
  }
  return { closed, isStopped: () => stopped, didFailToSpawn: () => failedToSpawn, signal, shutdown }
}
