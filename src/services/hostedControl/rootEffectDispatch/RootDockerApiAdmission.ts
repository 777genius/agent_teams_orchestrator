import { lstatSync, realpathSync } from 'node:fs'
import { request } from 'node:http'
import path from 'node:path'

const DISPATCH_API = '1.47'
const MAX_RESPONSE = 256 * 1024
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:[-+][a-zA-Z0-9._-]+)?$/
const API_VERSION = /^(\d+)\.(\d+)$/
const DAEMON_ID = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{7,127}$/

type SocketIdentity = Readonly<{ dev: number; ino: number; uid: number }>

export type RootDockerApiPins = Readonly<{
  daemonId: string
  serverVersion: string
  apiVersion: string
  minApiVersion: string
}>

function apiNumber(value: string): number | null {
  const match = API_VERSION.exec(value)
  if (!match) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  return Number.isSafeInteger(major) && Number.isSafeInteger(minor) && minor < 1000
    ? major * 1000 + minor : null
}

function validPins(pins: RootDockerApiPins): boolean {
  const version = VERSION.exec(pins.serverVersion)
  const api = apiNumber(pins.apiVersion)
  const minimum = apiNumber(pins.minApiVersion)
  const dispatch = apiNumber(DISPATCH_API)!
  return DAEMON_ID.test(pins.daemonId) && !!version && Number(version[1]) >= 28 &&
    Number.isSafeInteger(Number(version[1])) && api !== null && minimum !== null &&
    minimum <= dispatch && dispatch <= api
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

/** Read-only, exact Docker daemon admission. The pins must come from trusted root-owned configuration. */
export class RootDockerApiAdmission {
  private constructor(private readonly socketPath: string, private readonly pins: RootDockerApiPins,
    private readonly ownerUid: number, private readonly test: boolean,
    private readonly timeoutMs: number) {}

  static create(options: { socketPath: string; pins: RootDockerApiPins; timeoutMs?: number;
    testOnlyAllowNonRoot?: boolean }): RootDockerApiAdmission {
    const test = options.testOnlyAllowNonRoot === true && process.env.NODE_ENV === 'test'
    const timeoutMs = options.timeoutMs ?? 2_000
    if (!path.isAbsolute(options.socketPath) || path.normalize(options.socketPath) !== options.socketPath ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000 ||
      !options.pins || !validPins(options.pins) ||
      (!test && (process.platform !== 'linux' || process.getuid?.() !== 0 ||
        !['/var/run/docker.sock', '/run/docker.sock'].includes(options.socketPath)))) {
      throw new Error('root-docker-api-admission-policy-invalid')
    }
    const ownerUid = test ? process.getuid?.() ?? -1 : 0
    return new RootDockerApiAdmission(options.socketPath, Object.freeze({ ...options.pins }),
      ownerUid, test, timeoutMs)
  }

  private socketIdentity(): SocketIdentity {
    const stat = lstatSync(this.socketPath)
    if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== this.ownerUid ||
      (stat.mode & 0o002) !== 0) throw new Error('root-docker-api-socket-untrusted')
    // Some runtimes cannot realpath a Unix socket itself. The leaf is not a symlink,
    // so resolving its parent gives the same canonical socket location.
    const resolved = path.join(realpathSync(path.dirname(this.socketPath)), path.basename(this.socketPath))
    if (!this.test) {
      if (!['/var/run/docker.sock', '/run/docker.sock'].includes(resolved)) {
        throw new Error('root-docker-api-socket-untrusted')
      }
      for (let current = path.dirname(resolved); ; current = path.dirname(current)) {
        const parent = lstatSync(current)
        if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0 ||
          (parent.mode & 0o022) !== 0) throw new Error('root-docker-api-socket-untrusted')
        if (current === path.dirname(current)) break
      }
    }
    return { dev: stat.dev, ino: stat.ino, uid: stat.uid }
  }

  private async getJson(uri: '/v1.47/version' | '/v1.47/info'): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>
      let socket: { destroy(): void } | undefined
      let responseStream: { destroy(): void } | undefined
      let settled = false
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        // Closing the underlying socket is required even if the server never finishes its body.
        responseStream?.destroy()
        socket?.destroy()
        req.destroy()
        if (error) reject(error)
        else resolve(value)
      }
      const req = request({ socketPath: this.socketPath, path: uri, method: 'GET', agent: false,
        headers: { Host: 'docker', Connection: 'close', Accept: 'application/json' } }, response => {
        responseStream = response
        if (response.statusCode !== 200) {
          finish(new Error('root-docker-api-response-invalid'))
          return
        }
        const chunks: Buffer[] = []
        let length = 0
        response.on('data', (chunk: Buffer) => {
          length += chunk.length
          if (length > MAX_RESPONSE) finish(new Error('root-docker-api-response-too-large'))
          else chunks.push(chunk)
        })
        response.once('end', () => {
          try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown) }
          catch { finish(new Error('root-docker-api-response-invalid')) }
        })
        response.once('error', finish)
      })
      timer = setTimeout(() => finish(new Error('root-docker-api-timeout')), this.timeoutMs)
      req.once('socket', attached => { socket = attached; if (settled) attached.destroy() })
      req.once('error', finish)
      req.end()
    })
  }

  /** Safe to pass as the network port's assertDockerApiCompatible callback; no Docker effect is sent. */
  async assertDockerApiCompatible(): Promise<boolean> {
    try {
      const before = this.socketIdentity()
      const version = record(await this.getJson('/v1.47/version'))
      if (!version || version.Version !== this.pins.serverVersion ||
        version.ApiVersion !== this.pins.apiVersion ||
        version.MinAPIVersion !== this.pins.minApiVersion) return false
      const middle = this.socketIdentity()
      if (middle.dev !== before.dev || middle.ino !== before.ino || middle.uid !== before.uid) return false
      const info = record(await this.getJson('/v1.47/info'))
      const after = this.socketIdentity()
      return after.dev === before.dev && after.ino === before.ino && after.uid === before.uid &&
        !!info && info.ID === this.pins.daemonId && info.ServerVersion === this.pins.serverVersion &&
        info.OSType === 'linux'
    } catch { return false }
  }
}
