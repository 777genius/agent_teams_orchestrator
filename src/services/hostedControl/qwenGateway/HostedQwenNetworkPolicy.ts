import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, unlink } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const SHA = /^[0-9a-f]{64}$/
const GENERATION = /^[0-9a-f]{32}$/
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/
const LABEL = 'org.agentteams.hosted-opencode.generation'
const COMMAND_OUTPUT_LIMIT = 1024 * 1024

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('hosted-qwen-inspect-invalid')
  return value as Record<string, unknown>
}

function ipv4(value: unknown): value is string {
  return typeof value === 'string' && IPV4.test(value) && value.split('.').every(part => Number(part) <= 255)
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }

function commandFailureKind(stderr: string): string {
  if (/permission denied|operation not permitted/i.test(stderr)) return 'permission'
  if (/device or resource busy|resource temporarily unavailable/i.test(stderr)) return 'busy'
  if (/operation not supported|not supported/i.test(stderr)) return 'unsupported'
  if (/file exists/i.test(stderr)) return 'exists'
  if (/no such file or directory/i.test(stderr)) return 'missing'
  if (/syntax error|parse error/i.test(stderr)) return 'syntax'
  if (/invalid argument/i.test(stderr)) return 'invalid-argument'
  return 'unknown'
}

/** nft requires a regular input file; Node's default child stdin is a socket. */
export async function withHostedQwenRegularInput<T>(
  directory: string, input: string, execute: (fd: number) => Promise<T>,
): Promise<T> {
  const filename = path.join(directory, `.nft-input-${randomBytes(16).toString('hex')}`)
  let created = false
  try {
    const writer = await open(filename,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    created = true
    try { await writer.writeFile(input) } finally { await writer.close() }
    const reader = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      await unlink(filename)
      created = false
      return await execute(reader.fd)
    } finally { await reader.close() }
  } finally {
    if (created) await unlink(filename)
  }
}

export interface HostedQwenCommandRunner {
  run(executable: string, args: readonly string[], input?: string): Promise<string>
}

/** Absolute binaries, bounded output and environment, no shell interpolation. */
export class HostedQwenSystemCommandRunner implements HostedQwenCommandRunner {
  constructor(private readonly stateDirectory: string) {}

  async run(executable: string, args: readonly string[], input?: string): Promise<string> {
    if (!['/usr/sbin/nft', '/usr/sbin/iptables', '/usr/bin/docker', '/usr/sbin/ip'].includes(executable)) {
      throw new Error('hosted-qwen-executable-invalid')
    }
    if (input === undefined) {
      const result = await execFileAsync(executable, [...args], {
        timeout: 5000, maxBuffer: COMMAND_OUTPUT_LIMIT, windowsHide: true,
        env: { PATH: '/usr/sbin:/usr/bin:/bin', HOME: '/root', DOCKER_HOST: 'unix:///var/run/docker.sock' },
      })
      return result.stdout.trim()
    }
    return await withHostedQwenRegularInput(this.stateDirectory, input, fd => new Promise<string>((resolve, reject) => {
      const operation = executable === '/usr/sbin/nft' && args[0] === '-f' && args[1] === '-' ?
        'nft-load' : 'input-command'
      const child = spawn(executable, [...args], {
        stdio: [fd, 'pipe', 'pipe'],
        env: { PATH: '/usr/sbin:/usr/bin:/bin', HOME: '/root', DOCKER_HOST: 'unix:///var/run/docker.sock' },
      })
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let outputExceeded = false
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 5000)
      child.stdout!.setEncoding('utf8').on('data', chunk => {
        stdout = (stdout + chunk).slice(0, COMMAND_OUTPUT_LIMIT + 1)
        if (stdout.length > COMMAND_OUTPUT_LIMIT) { outputExceeded = true; child.kill('SIGKILL') }
      })
      child.stderr!.setEncoding('utf8').on('data', chunk => {
        stderr = (stderr + chunk).slice(0, COMMAND_OUTPUT_LIMIT + 1)
        if (stderr.length > COMMAND_OUTPUT_LIMIT) { outputExceeded = true; child.kill('SIGKILL') }
      })
      child.on('error', error => {
        const code = (error as NodeJS.ErrnoException).code
        const kind = code === 'ENOENT' ? 'missing' : code === 'EACCES' || code === 'EPERM' ? 'permission' : 'spawn'
        reject(new Error(`hosted-qwen-command-failed:${operation}:${kind}:spawn`))
      })
      child.on('close', (code, signal) => {
        clearTimeout(timer)
        if (code === 0 && !timedOut && !outputExceeded) resolve(stdout.trim())
        else {
          const stderrKind = commandFailureKind(stderr)
          const kind = timedOut ? 'timeout' : outputExceeded ? 'output-limit' : stderrKind
          const status = Number.isInteger(code) && code !== null ? `exit-${code}` :
            signal === 'SIGKILL' ? 'signal-kill' : 'signal-other'
          reject(new Error(`hosted-qwen-command-failed:${operation}:${kind}:${status}`))
        }
      })
    }))
  }
}

export interface HostedQwenNetworkPolicyOptions {
  readonly networkId: string
  readonly generation: string
  readonly gatewayPort: number
  readonly stateDirectory: string
  readonly runner?: HostedQwenCommandRunner
  /** Test-only command injection. Production requires root and the real runner. */
  readonly testOnlyAllowNonRoot?: boolean
}

type BridgeIdentity = Readonly<{ name: string; ifindex: number; gateway: string }>

/**
 * Host firewall lease. Install deny before Docker Start; grant one container only
 * while the trusted bootstrap is still waiting for FD3. This class does not
 * start containers or authorize model/agent effects.
 */
export class HostedQwenNetworkPolicy {
  private readonly runner: HostedQwenCommandRunner
  private readonly table: string
  private readonly claimPath: string
  private bridge: BridgeIdentity | null = null
  private ruleDigest: string | null = null
  private containerId: string | null = null
  private containerIp: string | null = null
  private claimIdentity: string | null = null
  private revoked = false

  constructor(private readonly options: HostedQwenNetworkPolicyOptions) {
    if (!SHA.test(options.networkId) || !GENERATION.test(options.generation) ||
      !Number.isInteger(options.gatewayPort) || options.gatewayPort < 1024 || options.gatewayPort > 65535 ||
      !path.isAbsolute(options.stateDirectory)) {
      throw new Error('hosted-qwen-policy-options-invalid')
    }
    if (options.testOnlyAllowNonRoot) {
      if (process.env.NODE_ENV !== 'test' || !options.runner) throw new Error('hosted-qwen-test-mode-invalid')
    } else if (process.platform !== 'linux' || process.getuid?.() !== 0 || options.runner) {
      throw new Error('hosted-qwen-policy-root-required')
    }
    this.runner = options.runner ?? new HostedQwenSystemCommandRunner(options.stateDirectory)
    this.table = `hqw_${options.generation}`
    this.claimPath = path.join(options.stateDirectory, `qwen-${options.networkId}.claim`)
  }

  private run(executable: string, args: readonly string[], input?: string): Promise<string> {
    return this.runner.run(executable, args, input)
  }

  private comment(): string { return `hqw_${this.options.generation}` }

  private grantArgs(): string[] {
    if (!this.bridge || !this.containerIp) throw new Error('hosted-qwen-admission-invalid')
    return ['-i', this.bridge.name, '-s', this.containerIp, '-d', this.bridge.gateway,
      '-p', 'tcp', '--dport', String(this.options.gatewayPort),
      '-m', 'comment', '--comment', this.comment(), '-j', 'ACCEPT']
  }

  private async ufwGrantPresent(): Promise<boolean> {
    const rules = await this.run('/usr/sbin/iptables', ['-w', '2', '-S', 'ufw-user-input'])
    const tagged = rules.split('\n').filter(line =>
      new RegExp(`--comment "?${this.comment()}"?(?: |$)`).test(line))
    if (tagged.length > 1) throw new Error('hosted-qwen-ufw-drift')
    if (!tagged.length) return false
    await this.run('/usr/sbin/iptables', ['-w', '2', '-C', 'ufw-user-input', ...this.grantArgs()])
    return true
  }

  private async network(empty: boolean): Promise<BridgeIdentity> {
    const row = object(JSON.parse(await this.run('/usr/bin/docker',
      ['network', 'inspect', '--format', '{{json .}}', this.options.networkId])))
    const ipam = object(row.IPAM)
    const configs = ipam.Config
    const options = object(row.Options ?? {})
    const name = `br-${this.options.networkId.slice(0, 12)}`
    if (row.Id !== this.options.networkId || row.Driver !== 'bridge' || row.Scope !== 'local' ||
      row.Internal !== true || row.EnableIPv6 !== false || row.Ingress === true ||
      options['com.docker.network.bridge.name'] !== undefined && options['com.docker.network.bridge.name'] !== name ||
      !Array.isArray(configs) || configs.length !== 1) {
      throw new Error('hosted-qwen-network-invalid')
    }
    const config = object(configs[0])
    if (!ipv4(config.Gateway)) throw new Error('hosted-qwen-gateway-invalid')
    const occupants = object(row.Containers ?? {})
    const occupantIds = Object.keys(occupants)
    if (empty && occupantIds.length !== 0 || !empty &&
      (occupantIds.length !== 1 || occupantIds[0] !== this.containerId)) {
      throw new Error('hosted-qwen-network-occupancy-invalid')
    }
    const links = JSON.parse(await this.run('/usr/sbin/ip', ['-j', 'addr', 'show', 'dev', name])) as unknown
    if (!Array.isArray(links) || links.length !== 1) throw new Error('hosted-qwen-bridge-invalid')
    const link = object(links[0])
    const addresses = link.addr_info
    if (link.ifname !== name || !Number.isInteger(link.ifindex) || Number(link.ifindex) <= 0 ||
      !Array.isArray(addresses) || !addresses.some(entry => {
        const address = object(entry)
        return address.family === 'inet' && address.local === config.Gateway
      })) {
      throw new Error('hosted-qwen-bridge-invalid')
    }
    return { name, ifindex: Number(link.ifindex), gateway: config.Gateway }
  }

  private async assertClaim(): Promise<void> {
    const stat = await lstat(this.claimPath)
    const expectedUid = this.options.testOnlyAllowNonRoot ? process.getuid?.() : 0
    if (!stat.isFile() || stat.uid !== expectedUid || (stat.mode & 0o777) !== 0o600 ||
      `${stat.dev}:${stat.ino}` !== this.claimIdentity) {
      throw new Error('hosted-qwen-claim-invalid')
    }
  }

  private async snapshotRules(): Promise<Readonly<{ digest: string; grantedIp: string | null }>> {
    const row = object(JSON.parse(await this.run('/usr/sbin/nft', ['-j', 'list', 'table', 'inet', this.table])))
    if (!Array.isArray(row.nftables)) throw new Error('hosted-qwen-policy-drift')
    let grantSeen = false
    let grantedIp: string | null = null
    const normalized = row.nftables.map((entry: unknown) => {
      const item = object(entry)
      if (!item.set) return item
      const set = object(item.set)
      if (set.name !== 'granted' || set.table !== this.table || set.family !== 'inet') return item
      if (grantSeen || set.type !== 'ipv4_addr') throw new Error('hosted-qwen-policy-drift')
      grantSeen = true
      const elements = set.elem ?? []
      if (!Array.isArray(elements) || elements.length > 1 ||
        elements.length === 1 && !ipv4(elements[0])) throw new Error('hosted-qwen-policy-drift')
      grantedIp = elements.length ? elements[0] as string : null
      const { elem: _elements, ...structure } = set
      return { set: structure }
    })
    if (!grantSeen) throw new Error('hosted-qwen-policy-drift')
    return { digest: hash(JSON.stringify(normalized)), grantedIp }
  }

  async prepare(): Promise<Readonly<{ gateway: string; bridge: string }>> {
    if (this.bridge || this.claimIdentity) throw new Error('hosted-qwen-already-prepared')
    // Docker 26+ includes the fix for embedded-DNS forwarding from --internal
    // networks (GHSA-mq39-4gv4-mvpx). A later inert DNS-negative canary is still
    // required before enabling agent effects.
    const version = await this.run('/usr/bin/docker', ['version', '--format', '{{.Server.Version}}'])
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
    if (!match || Number(match[1]) < 26) throw new Error('hosted-qwen-docker-dns-unverified')
    const directory = await lstat(this.options.stateDirectory)
    const expectedUid = this.options.testOnlyAllowNonRoot ? process.getuid?.() : 0
    if (!directory.isDirectory() || directory.uid !== expectedUid || (directory.mode & 0o077) !== 0) {
      throw new Error('hosted-qwen-state-directory-invalid')
    }
    const bridge = await this.network(true)
    const file = await open(this.claimPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    try {
      await file.writeFile(`${this.options.generation}\n`)
      await file.sync()
      const stat = await file.stat()
      this.claimIdentity = `${stat.dev}:${stat.ino}`
    } finally { await file.close() }
    const b = bridge.name
    const gateway = bridge.gateway
    const port = this.options.gatewayPort
    // An independent base chain runs before Docker/UFW. accept here does not
    // bypass UFW's later default drop; a separate exact UFW grant is required.
    const rules = `table inet ${this.table} {\n` +
      ` set granted { type ipv4_addr; }\n` +
      ` chain inbound { type filter hook input priority -151; policy accept;\n` +
      `  iifname "${b}" ip saddr @granted ip daddr ${gateway} tcp dport ${port} ct state new,established accept\n` +
      `  iifname "${b}" drop\n` +
      `  ip daddr ${gateway} tcp dport ${port} drop\n` +
      ` }\n` +
      ` chain transit { type filter hook forward priority -151; policy accept;\n` +
      `  iifname "${b}" drop\n` +
      `  oifname "${b}" drop\n` +
      ` }\n}\n`
    try {
      await this.run('/usr/sbin/nft', ['-f', '-'], rules)
      this.bridge = bridge
      const snapshot = await this.snapshotRules()
      if (snapshot.grantedIp !== null) throw new Error('hosted-qwen-policy-drift')
      this.ruleDigest = snapshot.digest
      await this.attest()
      return { gateway, bridge: b }
    } catch (error) {
      // Keep the root claim on uncertain firewall outcomes. Reconciliation must
      // inspect and remove it explicitly; a second lease cannot silently start.
      throw error
    }
  }

  private async inspectContainer(id: string): Promise<string> {
    const row = object(JSON.parse(await this.run('/usr/bin/docker', ['inspect', '--format', '{{json .}}', id])))
    const host = object(row.HostConfig)
    const settings = object(row.NetworkSettings)
    const networks = object(settings.Networks)
    const attached = Object.values(networks)
    const labels = object(object(row.Config).Labels)
    const state = object(row.State)
    if (row.Id !== id || host.NetworkMode !== this.options.networkId || attached.length !== 1 ||
      labels[LABEL] !== this.options.generation || state.Running !== true ||
      !Number.isInteger(state.Pid) || Number(state.Pid) < 1) {
      throw new Error('hosted-qwen-container-invalid')
    }
    const endpoint = object(attached[0])
    // Docker reports an empty endpoint gateway for an --internal network because
    // the container has no default route. The bridge still has the IPAM gateway
    // verified by network() and can serve the explicitly granted host port.
    if (endpoint.NetworkID !== this.options.networkId || !ipv4(endpoint.IPAddress) ||
      endpoint.Gateway !== '' && endpoint.Gateway !== this.bridge?.gateway) {
      throw new Error('hosted-qwen-container-endpoint-invalid')
    }
    return endpoint.IPAddress
  }

  async admitContainer(id: string): Promise<string> {
    if (!SHA.test(id) || !this.bridge || this.containerId || !this.ruleDigest) {
      throw new Error('hosted-qwen-admission-invalid')
    }
    await this.assertClaim()
    const before = await this.snapshotRules()
    if (before.digest !== this.ruleDigest || before.grantedIp !== null) throw new Error('hosted-qwen-policy-drift')
    const ip = await this.inspectContainer(id)
    this.containerId = id
    this.containerIp = ip
    try {
      const current = await this.network(false)
      if (current.name !== this.bridge.name || current.ifindex !== this.bridge.ifindex ||
        current.gateway !== this.bridge.gateway) throw new Error('hosted-qwen-policy-drift')
      await this.run('/usr/sbin/nft', ['add', 'element', 'inet', this.table, 'granted', `{ ${ip} }`])
      const granted = await this.snapshotRules()
      if (granted.digest !== this.ruleDigest || granted.grantedIp !== ip) throw new Error('hosted-qwen-policy-drift')
      await this.run('/usr/sbin/iptables', ['-w', '2', '-I', 'ufw-user-input', '1', ...this.grantArgs()])
      await this.attest()
      return ip
    } catch (error) {
      // A partial insertion retains the claim and denies a fresh lease.
      throw error
    }
  }

  async attest(): Promise<void> {
    if (!this.bridge || !this.ruleDigest) throw new Error('hosted-qwen-policy-unprepared')
    await this.assertClaim()
    const current = await this.network(this.containerId === null)
    const rules = await this.snapshotRules()
    if (current.name !== this.bridge.name || current.ifindex !== this.bridge.ifindex ||
      current.gateway !== this.bridge.gateway || rules.digest !== this.ruleDigest ||
      rules.grantedIp !== (this.revoked ? null : this.containerIp)) {
      throw new Error('hosted-qwen-policy-drift')
    }
    if (this.containerId && this.containerIp) {
      if (await this.inspectContainer(this.containerId) !== this.containerIp) {
        throw new Error('hosted-qwen-container-drift')
      }
      if (await this.ufwGrantPresent() === this.revoked) throw new Error('hosted-qwen-ufw-drift')
    }
  }

  /** The listener may bind only to this lease's live bridge IP and port. */
  async assertBridgeBind(address: string, port: number, generation: string): Promise<void> {
    if (address !== this.bridge?.gateway || port !== this.options.gatewayPort ||
      generation !== this.options.generation) throw new Error('hosted-qwen-bind-mismatch')
    await this.attest()
  }

  /** Root may admit only the source pinned by this exact network lease. */
  assertContainerSource(networkId: string, containerId: string, containerIp: string,
    generation: string): void {
    if (!this.bridge || this.revoked || networkId !== this.options.networkId ||
      containerId !== this.containerId || containerIp !== this.containerIp ||
      generation !== this.options.generation) throw new Error('hosted-qwen-source-mismatch')
  }

  /** Remove the kernel grant while the exact container still exists. Safe to retry after an uncertain command result. */
  async revokeContainer(): Promise<void> {
    if (!this.bridge || !this.containerId || !this.containerIp || !this.ruleDigest) {
      throw new Error('hosted-qwen-admission-invalid')
    }
    await this.assertClaim()
    const current = await this.network(false)
    if (current.name !== this.bridge.name || current.ifindex !== this.bridge.ifindex ||
      current.gateway !== this.bridge.gateway ||
      await this.inspectContainer(this.containerId) !== this.containerIp) {
      throw new Error('hosted-qwen-policy-drift')
    }
    const before = await this.snapshotRules()
    if (before.digest !== this.ruleDigest ||
      before.grantedIp !== null && before.grantedIp !== this.containerIp) {
      throw new Error('hosted-qwen-policy-drift')
    }
    if (before.grantedIp) {
      await this.run('/usr/sbin/nft', ['delete', 'element', 'inet', this.table,
        'granted', `{ ${this.containerIp} }`])
    }
    const denied = await this.snapshotRules()
    if (denied.digest !== this.ruleDigest || denied.grantedIp !== null) {
      throw new Error('hosted-qwen-policy-drift')
    }
    if (await this.ufwGrantPresent()) {
      await this.run('/usr/sbin/iptables', ['-w', '2', '-D', 'ufw-user-input', ...this.grantArgs()])
    }
    if (await this.ufwGrantPresent()) throw new Error('hosted-qwen-ufw-drift')
    this.revoked = true
    await this.attest()
  }

  /** Caller must stop and remove the container first. Unknown cleanup retains the claim. */
  async close(): Promise<void> {
    if (!this.bridge) return
    await this.assertClaim()
    await this.network(true)
    const rules = await this.snapshotRules()
    if (rules.digest !== this.ruleDigest ||
      rules.grantedIp !== (this.revoked ? null : this.containerIp)) {
      throw new Error('hosted-qwen-policy-drift')
    }
    if (this.containerIp) {
      if (await this.ufwGrantPresent()) {
        await this.run('/usr/sbin/iptables', ['-w', '2', '-D', 'ufw-user-input', ...this.grantArgs()])
      }
    }
    await this.run('/usr/sbin/nft', ['delete', 'table', 'inet', this.table])
    await unlink(this.claimPath)
    this.bridge = null
    this.ruleDigest = null
    this.containerId = null
    this.containerIp = null
    this.claimIdentity = null
    this.revoked = false
  }
}
