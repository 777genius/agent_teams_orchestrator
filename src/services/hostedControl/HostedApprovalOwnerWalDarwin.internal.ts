import { constants } from 'node:fs'

const DARWIN_EINTR = 4
const DARWIN_EEXIST = 17
const DARWIN_WAIT_EINTR_RETRIES = 64

export type DarwinSpawnNative = {
  initActions: () => { actions: unknown; error: number }
  addChdir: (actions: unknown, parentFd: number) => number
  addOpen: (actions: unknown, targetFd: number, name: string, flags: number, mode: number) => number
  spawn: (actions: unknown, executable: string) => { error: number; pid: number }
  waitPid: (pid: number) => { result: number; status: number; errno: number }
  destroyActions: (actions: unknown) => number
}

export function createRegularNodeAtDarwin(
  parentFd: number, name: string, native: DarwinSpawnNative, removeCreated: () => void,
): boolean {
  // Darwin restricts mknod(2) to privileged callers. A spawn file action is a
  // fixed-argument libc API that performs the real variadic open(2) inside
  // libSystem after changing the child to the retained directory descriptor.
  const initialized = native.initActions()
  if (initialized.error !== 0) {
    throw new Error('Hosted approval namespace spawn actions unavailable')
  }
  const actions = initialized.actions
  let created = false
  let outcome = false
  let failure: unknown
  try {
    if (native.addChdir(actions, parentFd) !== 0) {
      throw new Error('Hosted approval namespace retained spawn directory unavailable')
    }
    const flags = constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0)
    if (native.addOpen(actions, 0, name, flags, 0o600) !== 0) {
      throw new Error('Hosted approval namespace spawn create action unavailable')
    }
    const child = native.spawn(actions, '/usr/bin/true')
    if (child.error === DARWIN_EEXIST) {
      outcome = false
    } else if (child.error !== 0 || child.pid <= 0) {
      throw new Error('Hosted approval namespace creator spawn failed')
    } else {
      let waited = native.waitPid(child.pid)
      let retries = 0
      while (waited.result === -1 && waited.errno === DARWIN_EINTR && retries < DARWIN_WAIT_EINTR_RETRIES) {
        retries += 1
        waited = native.waitPid(child.pid)
      }
      if (waited.result !== child.pid) throw new Error('Hosted approval namespace creator wait failed')
      if (waited.status === 0) {
        created = true
        outcome = true
      } else {
        const signal = waited.status & 0x7f
        const exitCode = (waited.status >>> 8) & 0xff
        if (signal !== 0) {
          const detail = signal === 0x7f ? 'stopped' : `signal ${signal}`
          throw new Error(`Hosted approval namespace creator ${detail}`)
        }
        if (exitCode !== 0) throw new Error(`Hosted approval namespace creator exited ${exitCode}`)
        throw new Error('Hosted approval namespace creator wait status ambiguous')
      }
    }
  } catch (error) {
    failure = error
  }
  const destroyError = native.destroyActions(actions)
  if (destroyError !== 0 && failure === undefined) {
    failure = new Error('Hosted approval namespace spawn actions destroy failed')
  }
  if (failure !== undefined) {
    if (created) {
      try { removeCreated() } catch { /* best-effort cleanup of the proven O_EXCL-created node */ }
    }
    throw failure
  }
  return outcome
}
