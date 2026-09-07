import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import path from 'node:path'
import type { OpenCodePreparedProfile } from './types.js'

type Descriptor = {
  version: number
  hostPid: number
  hostGeneration: string
  profileScopeToken: string
  controlUrl: string
  controlToken: string
}

type StopOptions = { signal?: AbortSignal; remainingMs?: () => number }
type ControlProfile = Pick<OpenCodePreparedProfile, 'env'>
type ControlFetch = (url: string, init: RequestInit) => Promise<Response>

async function readDescriptor(profile: ControlProfile, pid: number): Promise<Descriptor> {
  const directory = profile.env.AGENT_TEAMS_CURSOR_CONTROL_DIR
  const scope = profile.env.AGENT_TEAMS_CURSOR_PROFILE_SCOPE
  if (!directory || !scope || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('Cursor native Stop control is unavailable for this host')
  }
  const dir = await lstat(directory)
  if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) !== 0
    || (process.getuid && dir.uid !== process.getuid())) {
    throw new Error('Cursor native Stop control directory is not private')
  }
  const file = await open(path.join(directory, `${pid}.json`), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await file.stat()
    if (!metadata.isFile() || metadata.size > 16_384 || (metadata.mode & 0o077) !== 0
      || (process.getuid && metadata.uid !== process.getuid())) {
      throw new Error('Cursor native Stop descriptor is not private')
    }
    const descriptor = JSON.parse(await file.readFile('utf8')) as Descriptor
    if (descriptor.version !== 1 || descriptor.hostPid !== pid || descriptor.profileScopeToken !== scope
      || typeof descriptor.hostGeneration !== 'string' || descriptor.hostGeneration.length < 16
      || typeof descriptor.controlToken !== 'string' || descriptor.controlToken.length < 32) {
      throw new Error('Cursor native Stop descriptor does not match the retained host')
    }
    const url = new URL(descriptor.controlUrl)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
      || url.username || url.password || url.search || url.hash
      || url.pathname !== '/agent-teams/cursor/stop') {
      throw new Error('Cursor native Stop endpoint is invalid')
    }
    return descriptor
  } finally {
    await file.close()
  }
}

/** Terminal team Stop only. Normal transport cancellation must not seal a session. */
export async function stopCursorSessionWithNativeCleanup(input: {
  profile: ControlProfile
  runtimePid: number | null
  sessionId: string
  abortTransport: () => Promise<boolean>
  options?: StopOptions
  fetch?: ControlFetch
}): Promise<boolean> {
  const options = input.options ?? {}
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(Math.max(1, Math.min(15_000, options.remainingMs?.() ?? 15_000))),
  ])
  const request = async (descriptor: Descriptor, body: Record<string, string>) => {
    const response = await (input.fetch ?? fetch)(descriptor.controlUrl, {
      method: 'POST', redirect: 'error', signal,
      headers: { authorization: `Bearer ${descriptor.controlToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, hostGeneration: descriptor.hostGeneration, profileScopeToken: descriptor.profileScopeToken }),
    })
    if (!response.ok) throw new Error('Cursor native Stop control did not confirm cleanup')
    return response.json() as Promise<Record<string, unknown>>
  }
  let descriptor: Descriptor, stopToken: string
  try {
    descriptor = await readDescriptor(input.profile, input.runtimePid ?? 0)
    const result = await request(descriptor, { action: 'begin', sessionId: input.sessionId })
    if (typeof result.stopToken !== 'string' || result.stopToken.length < 16) {
      throw new Error('Cursor native Stop seal was not acknowledged')
    }
    stopToken = result.stopToken
  } catch {
    // Containment is still useful, but transport cancellation alone cannot prove Stop.
    await input.abortTransport().catch(() => false)
    throw new Error('Cursor native Stop could not seal the session; cleanup is unconfirmed')
  }
  let abortAccepted = false
  let transportFailed = false
  try { abortAccepted = await input.abortTransport() } catch { transportFailed = true }
  const result = await request(descriptor, { action: 'wait', stopToken })
  if (result.cleanupCompleted !== true) throw new Error('Cursor native process cleanup is unconfirmed')
  if (transportFailed) throw new Error('Cursor native cleanup completed, but OpenCode cancellation failed')
  return abortAccepted
}
