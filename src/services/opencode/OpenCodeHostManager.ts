import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'

import { sleep } from '../../utils/sleep.js'
import { openCodeProfileManager } from './OpenCodeProfileManager.js'

import type { OpenCodeHostHandle, OpenCodePreparedProfile } from './types.js'

const OPEN_CODE_HOST_HEALTH_TIMEOUT_MS = 15_000
const OPEN_CODE_HOST_HEALTH_POLL_MS = 250

type ManagedHostEntry = {
  handle: OpenCodeHostHandle
  child: ChildProcess
  refCount: number
}

type FetchJsonResult = {
  status: number
  data: unknown
}

type OpenCodeHostManagerDeps = {
  prepareProfile?: (projectPath?: string | null) => Promise<OpenCodePreparedProfile>
  allocateLoopbackPort?: () => Promise<number>
  fetchJson?: (url: string, init?: RequestInit) => Promise<FetchJsonResult>
  spawnHostProcess?: (profile: OpenCodePreparedProfile, port: number) => ChildProcess
  sleepMs?: (ms: number) => Promise<void>
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? '').digest('hex')
}

async function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate loopback port')))
        return
      }

      const port = address.port
      server.close(error => {
        if (error) {
          reject(error)
          return
        }
        resolve(port)
      })
    })
  })
}

async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<FetchJsonResult> {
  const response = await fetch(url, init)
  const text = await response.text()

  let data: unknown = null
  if (text.trim().length > 0) {
    try {
      data = JSON.parse(text) as unknown
    } catch {
      data = text
    }
  }

  return {
    status: response.status,
    data,
  }
}

export class OpenCodeHostManager {
  private readonly hosts = new Map<string, ManagedHostEntry>()
  private readonly pendingHosts = new Map<string, Promise<OpenCodeHostHandle>>()
  private readonly pendingRefCounts = new Map<string, number>()

  constructor(private readonly deps: OpenCodeHostManagerDeps = {}) {}

  private async prepareProfile(projectPath?: string | null): Promise<OpenCodePreparedProfile> {
    const prepareProfile = this.deps.prepareProfile
      ?? openCodeProfileManager.prepareProfile.bind(openCodeProfileManager)
    return prepareProfile(projectPath)
  }

  private async fetchJson(url: string, init?: RequestInit): Promise<FetchJsonResult> {
    return (this.deps.fetchJson ?? fetchJson)(url, init)
  }

  private async allocateLoopbackPort(): Promise<number> {
    return (this.deps.allocateLoopbackPort ?? allocateLoopbackPort)()
  }

  private async sleepMs(ms: number): Promise<void> {
    return (this.deps.sleepMs ?? ((delay: number) => sleep(delay)))(ms)
  }

  private async waitForHealthyHost(baseUrl: string): Promise<{ version: string | null }> {
    const startedAt = Date.now()

    while (Date.now() - startedAt < OPEN_CODE_HOST_HEALTH_TIMEOUT_MS) {
      try {
        const result = await this.fetchJson(`${baseUrl}/global/health`)
        const data = result.data as { healthy?: boolean; version?: string }
        if (result.status === 200 && data?.healthy === true) {
          return {
            version: typeof data.version === 'string' ? data.version : null,
          }
        }
      } catch {
        // Retry until the deadline expires.
      }

      await this.sleepMs(OPEN_CODE_HOST_HEALTH_POLL_MS)
    }

    throw new Error(
      `OpenCode host did not become healthy within ${OPEN_CODE_HOST_HEALTH_TIMEOUT_MS}ms`,
    )
  }

  private async getResolvedConfigFingerprint(baseUrl: string): Promise<string | null> {
    try {
      const [config, configProviders, agents, mcp] = await Promise.all([
        this.fetchJson(`${baseUrl}/config`),
        this.fetchJson(`${baseUrl}/config/providers`),
        this.fetchJson(`${baseUrl}/agent`),
        this.fetchJson(`${baseUrl}/mcp`),
      ])

      const fingerprintSource = {
        config: config.status === 200 ? config.data : null,
        configProviders: configProviders.status === 200 ? configProviders.data : null,
        agents: agents.status === 200 ? agents.data : null,
        mcp: mcp.status === 200 ? mcp.data : null,
      }

      if (
        fingerprintSource.config === null
        && fingerprintSource.configProviders === null
        && fingerprintSource.agents === null
        && fingerprintSource.mcp === null
      ) {
        return null
      }
      return hashJson(fingerprintSource)
    } catch {
      return null
    }
  }

  private spawnHost(
    profile: OpenCodePreparedProfile,
    port: number,
  ): ChildProcess {
    if (this.deps.spawnHostProcess) {
      return this.deps.spawnHostProcess(profile, port)
    }

    return spawn(
      Bun.which('opencode') ?? 'opencode',
      ['serve', '--hostname', '127.0.0.1', '--port', String(port)],
      {
        cwd: profile.projectPath,
        env: profile.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
  }

  private bindHostLifecycle(hostKey: string, entry: ManagedHostEntry): void {
    const pushDiagnostic = (message: string): void => {
      entry.handle.diagnostics.push(message)
      if (entry.handle.diagnostics.length > 20) {
        entry.handle.diagnostics.splice(0, entry.handle.diagnostics.length - 20)
      }
    }

    entry.child.once('error', error => {
      pushDiagnostic(`process error: ${error instanceof Error ? error.message : String(error)}`)
    })

    entry.child.once('exit', (code, signal) => {
      if (this.hosts.get(hostKey) !== entry) {
        return
      }

      if (entry.handle.state !== 'disposed') {
        entry.handle.state = 'degraded'
        pushDiagnostic(
          `process exited${typeof code === 'number' ? ` with code ${code}` : ''}${signal ? ` (${signal})` : ''}`,
        )
      }

      this.hosts.delete(hostKey)
      this.pendingHosts.delete(hostKey)
    })
  }

  private async createHost(
    hostKey: string,
    profile: OpenCodePreparedProfile,
  ): Promise<OpenCodeHostHandle> {
    const port = await this.allocateLoopbackPort()
    const baseUrl = `http://127.0.0.1:${port}`
    const child = this.spawnHost(profile, port)

    const diagnostics: string[] = []
    const captureOutput = (source: 'stdout' | 'stderr') => (chunk: Buffer | string) => {
      const message = chunk.toString('utf8').trim()
      if (!message) {
        return
      }
      diagnostics.push(`${source}: ${message}`)
      if (diagnostics.length > 20) {
        diagnostics.splice(0, diagnostics.length - 20)
      }
    }

    child.stdout?.on('data', captureOutput('stdout'))
    child.stderr?.on('data', captureOutput('stderr'))

    const handle: OpenCodeHostHandle = {
      hostKey,
      profileRootKey: profile.profileRootKey,
      projectPath: profile.projectPath,
      projectBehaviorFingerprint: profile.projectBehaviorFingerprint,
      baseUrl,
      port,
      pid: child.pid ?? -1,
      version: null,
      state: 'starting',
      profile,
      resolvedConfigFingerprint: null,
      diagnostics,
    }

    const entry: ManagedHostEntry = {
      handle,
      child,
      refCount: this.pendingRefCounts.get(hostKey) ?? 1,
    }
    this.hosts.set(hostKey, entry)
    this.bindHostLifecycle(hostKey, entry)

    try {
      const health = await this.waitForHealthyHost(baseUrl)
      handle.version = health.version
      handle.resolvedConfigFingerprint = await this.getResolvedConfigFingerprint(baseUrl)
      handle.state = 'healthy'
      return handle
    } catch (error) {
      handle.state = 'degraded'
      diagnostics.push(error instanceof Error ? error.message : String(error))
      this.hosts.delete(hostKey)
      child.kill('SIGTERM')
      throw error
    }
  }

  async ensureHost(params: {
    projectPath?: string | null
    hostKey?: string | null
  } = {}): Promise<OpenCodeHostHandle> {
    const profile = await this.prepareProfile(params.projectPath)
    const hostKey =
      params.hostKey?.trim()
      || `${profile.projectPath}::${profile.profileRootKey}::${profile.projectBehaviorFingerprint}`
    const existing = this.hosts.get(hostKey)
    if (existing && existing.handle.state === 'healthy') {
      existing.refCount += 1
      return existing.handle
    }

    const pending = this.pendingHosts.get(hostKey)
    if (pending) {
      const pendingEntry = this.hosts.get(hostKey)
      if (pendingEntry) {
        pendingEntry.refCount += 1
      } else {
        this.pendingRefCounts.set(hostKey, (this.pendingRefCounts.get(hostKey) ?? 0) + 1)
      }
      return pending
    }

    this.pendingRefCounts.set(hostKey, 1)
    const createPromise = this.createHost(hostKey, profile).finally(() => {
      this.pendingHosts.delete(hostKey)
      this.pendingRefCounts.delete(hostKey)
    })
    this.pendingHosts.set(hostKey, createPromise)
    return createPromise
  }

  getHost(hostKey: string): OpenCodeHostHandle | null {
    return this.hosts.get(hostKey)?.handle ?? null
  }

  async refreshResolvedConfigFingerprint(hostKey: string): Promise<string | null> {
    const entry = this.hosts.get(hostKey)
    if (!entry) {
      return null
    }

    const fingerprint = await this.getResolvedConfigFingerprint(entry.handle.baseUrl)
    entry.handle.resolvedConfigFingerprint = fingerprint
    return fingerprint
  }

  async disposeHost(hostKey: string): Promise<boolean> {
    const entry = this.hosts.get(hostKey)
    if (!entry) {
      return false
    }

    try {
      await this.fetchJson(`${entry.handle.baseUrl}/global/dispose`, {
        method: 'POST',
      })
    } catch {
      // Best effort.
    }

    entry.child.kill('SIGTERM')
    entry.handle.state = 'disposed'
    this.hosts.delete(hostKey)
    this.pendingHosts.delete(hostKey)
    return true
  }

  async releaseHost(hostKey: string): Promise<void> {
    const entry = this.hosts.get(hostKey)
    if (!entry) {
      return
    }

    entry.refCount = Math.max(0, entry.refCount - 1)
    if (entry.refCount === 0) {
      await this.disposeHost(hostKey)
    }
  }
}

export const openCodeHostManager = new OpenCodeHostManager()
