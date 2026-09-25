import { afterEach, expect, test } from 'bun:test'
import { fstatSync, readSync } from 'node:fs'
import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { HostedQwenNetworkPolicy, withHostedQwenRegularInput,
  type HostedQwenCommandRunner } from './HostedQwenNetworkPolicy.js'

const networkId = '8a2f1f6db803d38c68a65ac64b4884198396a1829a9463754bd904934e0fdd71'
const containerId = 'a'.repeat(64)
const generation = 'b'.repeat(32)
const bridge = `br-${networkId.slice(0, 12)}`
const scratch: string[] = []
afterEach(async () => { for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true }) })

class FakeRunner implements HostedQwenCommandRunner {
  version = '29.8.1'
  occupied = false
  running = true
  ip = '172.18.0.2'
  endpointGateway = '172.18.0.1'
  labelGeneration = generation
  ifindex = 42
  nft = ''
  grantIp: string | null = null
  ufw = false
  throwAfterNftDelete = false
  calls: string[] = []

  async run(executable: string, args: readonly string[], input?: string): Promise<string> {
    this.calls.push(`${executable} ${args.join(' ')}`)
    if (executable === '/usr/bin/docker' && args[0] === 'version') return this.version
    if (executable === '/usr/bin/docker' && args[0] === 'network') return JSON.stringify({
      Id: networkId, Driver: 'bridge', Scope: 'local', Internal: true, EnableIPv6: false,
      Ingress: false, Options: {}, IPAM: { Config: [{ Subnet: '172.18.0.0/16', Gateway: '172.18.0.1' }] },
      Containers: this.occupied ? { [containerId]: { Name: 'hosted-test' } } : {},
    })
    if (executable === '/usr/bin/docker' && args[0] === 'inspect') return JSON.stringify({
      Id: containerId, HostConfig: { NetworkMode: networkId },
      Config: { Labels: { 'org.agentteams.hosted-opencode.generation': this.labelGeneration } },
      State: { Running: this.running, Pid: 1234 },
      NetworkSettings: { Networks: { private: { NetworkID: networkId, IPAddress: this.ip, Gateway: this.endpointGateway } } },
    })
    if (executable === '/usr/sbin/ip') return JSON.stringify([{
      ifname: bridge, ifindex: this.ifindex, addr_info: [{ family: 'inet', local: '172.18.0.1' }],
    }])
    if (executable === '/usr/sbin/nft') {
      if (args[0] === '-f') { this.nft = input ?? ''; return '' }
      if (args[0] === 'add' && args[1] === 'element') {
        if (this.grantIp) throw new Error('element-exists')
        this.grantIp = String(args[5]).replace(/[{} ]/g, '')
        return ''
      }
      if (args[0] === 'delete' && args[1] === 'element') {
        if (!this.grantIp) throw new Error('element-missing')
        this.grantIp = null
        if (this.throwAfterNftDelete) { this.throwAfterNftDelete = false; throw new Error('ambiguous-delete') }
        return ''
      }
      if (args[0] === '-j') return JSON.stringify({ nftables: [
        { table: { name: `hqw_${generation}`, rules: this.nft } },
        { set: { name: 'granted', table: `hqw_${generation}`, family: 'inet', type: 'ipv4_addr',
          elem: this.grantIp ? [this.grantIp] : [] } },
      ] })
      if (args[0] === 'delete') { this.nft = ''; this.grantIp = null; return '' }
    }
    if (executable === '/usr/sbin/iptables') {
      if (args.includes('-I')) { this.ufw = true; return '' }
      if (args.includes('-C')) { if (!this.ufw) throw new Error('missing'); return '' }
      if (args.includes('-D')) { this.ufw = false; return '' }
      if (args.includes('-S')) return this.ufw ?
        `-A ufw-user-input --comment "hqw_${generation}" -j ACCEPT` : ''
    }
    throw new Error(`unexpected command: ${executable} ${args.join(' ')}`)
  }
}

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hosted-qwen-policy-'))
  await chmod(dir, 0o700)
  scratch.push(dir)
  const runner = new FakeRunner()
  const policy = new HostedQwenNetworkPolicy({ networkId, generation, gatewayPort: 19443,
    stateDirectory: dir, runner, testOnlyAllowNonRoot: true })
  return { dir, runner, policy }
}

test('nft input is a private regular file and is removed after execution', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hosted-qwen-input-'))
  scratch.push(dir)
  const input = 'table inet qwen_test {}\n'
  await withHostedQwenRegularInput(dir, input, async fd => {
    const stat = fstatSync(fd)
    expect(stat.isFile()).toBe(true)
    expect(stat.mode & 0o777).toBe(0o600)
    const content = Buffer.alloc(input.length)
    expect(readSync(fd, content, 0, content.length, 0)).toBe(input.length)
    expect(content.toString()).toBe(input)
    expect(await readdir(dir)).toEqual([])
  })
  expect(await readdir(dir)).toEqual([])
  await expect(withHostedQwenRegularInput(dir, input, async () => {
    throw new Error('diagnostic-failure')
  })).rejects.toThrow('diagnostic-failure')
  expect(await readdir(dir)).toEqual([])
})

test('deny is installed before one exact container can be admitted; drift fails closed', async () => {
  const { runner, policy } = await setup()
  expect(await policy.prepare()).toEqual({ gateway: '172.18.0.1', bridge })
  expect(runner.nft).toContain(`iifname "${bridge}" drop`)
  expect(runner.nft).toContain(`oifname "${bridge}" drop`)
  expect(runner.nft).not.toContain('ct state established,related accept')
  expect(runner.ufw).toBe(false)
  runner.occupied = true
  expect(await policy.admitContainer(containerId)).toBe('172.18.0.2')
  expect(runner.ufw).toBe(true)
  expect(runner.nft).toContain(`ip saddr @granted ip daddr 172.18.0.1 tcp dport 19443`)
  expect(runner.nft).toContain('ct state new,established accept')
  expect(runner.grantIp).toBe('172.18.0.2')
  await policy.attest()
  runner.ifindex++
  await expect(policy.attest()).rejects.toThrow('hosted-qwen-policy-drift')
})

test('internal endpoint with no default gateway admits only the verified bridge IP', async () => {
  const { runner, policy } = await setup()
  runner.endpointGateway = ''
  await policy.prepare()
  runner.occupied = true
  expect(await policy.admitContainer(containerId)).toBe(runner.ip)
  await policy.attest()
  expect(runner.grantIp).toBe(runner.ip)
})

test('unexpected endpoint gateway fails closed before installing a grant', async () => {
  const { runner, policy } = await setup()
  runner.endpointGateway = '172.18.0.254'
  await policy.prepare()
  runner.occupied = true
  await expect(policy.admitContainer(containerId)).rejects.toThrow('hosted-qwen-container-endpoint-invalid')
  expect(runner.ufw).toBe(false)
  expect(runner.grantIp).toBeNull()
})

test('network claim remains while container exists; cleanup removes grant before deny', async () => {
  const { dir, runner, policy } = await setup()
  await policy.prepare()
  runner.occupied = true
  await policy.admitContainer(containerId)
  await expect(policy.close()).rejects.toThrow('hosted-qwen-network-occupancy-invalid')
  expect((await readdir(dir)).length).toBe(1)
  runner.occupied = false
  await policy.close()
  expect(runner.ufw).toBe(false)
  expect(runner.nft).toBe('')
  expect(await readdir(dir)).toEqual([])
  const deleteGrant = runner.calls.findIndex(call => call.includes('iptables -w 2 -D'))
  const deleteDeny = runner.calls.findIndex(call => call.includes('nft delete table'))
  expect(deleteGrant).toBeGreaterThan(-1)
  expect(deleteDeny).toBeGreaterThan(deleteGrant)
})

test('bridge bind requires the exact prepared address, port and generation', async () => {
  const { policy } = await setup()
  await policy.prepare()
  await policy.assertBridgeBind('172.18.0.1', 19443, generation)
  await expect(policy.assertBridgeBind('0.0.0.0', 19443, generation)).rejects.toThrow('hosted-qwen-bind-mismatch')
  await expect(policy.assertBridgeBind('172.18.0.1', 19444, generation)).rejects.toThrow('hosted-qwen-bind-mismatch')
  await expect(policy.assertBridgeBind('172.18.0.1', 19443, 'c'.repeat(32))).rejects.toThrow('hosted-qwen-bind-mismatch')
})

test('source admission belongs to the same exact network and generation lease', async () => {
  const { runner, policy } = await setup()
  await policy.prepare()
  runner.occupied = true
  await policy.admitContainer(containerId)
  policy.assertContainerSource(networkId, containerId, '172.18.0.2', generation)
  expect(() => policy.assertContainerSource('c'.repeat(64), containerId, '172.18.0.2', generation))
    .toThrow('hosted-qwen-source-mismatch')
  expect(() => policy.assertContainerSource(networkId, 'd'.repeat(64), '172.18.0.2', generation))
    .toThrow('hosted-qwen-source-mismatch')
  expect(() => policy.assertContainerSource(networkId, containerId, '172.18.0.3', generation))
    .toThrow('hosted-qwen-source-mismatch')
  expect(() => policy.assertContainerSource(networkId, containerId, '172.18.0.2', 'c'.repeat(32)))
    .toThrow('hosted-qwen-source-mismatch')
  await policy.revokeContainer()
  expect(() => policy.assertContainerSource(networkId, containerId, '172.18.0.2', generation))
    .toThrow('hosted-qwen-source-mismatch')
})

test('revocation denies a live container before deleting its tagged UFW grant and can retry ambiguity', async () => {
  const { runner, policy } = await setup()
  await policy.prepare()
  runner.occupied = true
  await policy.admitContainer(containerId)
  runner.throwAfterNftDelete = true
  await expect(policy.revokeContainer()).rejects.toThrow('ambiguous-delete')
  expect(runner.grantIp).toBeNull()
  expect(runner.ufw).toBe(true)
  await policy.revokeContainer()
  expect(runner.ufw).toBe(false)
  await policy.revokeContainer()
  await policy.attest()
  const nftDelete = runner.calls.findIndex(call => call.includes('nft delete element'))
  const ufwDelete = runner.calls.findIndex(call => call.includes('iptables -w 2 -D'))
  expect(nftDelete).toBeGreaterThan(-1)
  expect(ufwDelete).toBeGreaterThan(nftDelete)
  runner.occupied = false
  await policy.close()
})

test('revocation refuses changed source IP or container generation before touching the grant', async () => {
  const { runner, policy } = await setup()
  await policy.prepare()
  runner.occupied = true
  await policy.admitContainer(containerId)
  runner.ip = '172.18.0.3'
  await expect(policy.revokeContainer()).rejects.toThrow('hosted-qwen-policy-drift')
  runner.ip = '172.18.0.2'
  runner.labelGeneration = 'c'.repeat(32)
  await expect(policy.revokeContainer()).rejects.toThrow('hosted-qwen-container-invalid')
  expect(runner.grantIp).toBe('172.18.0.2')
  expect(runner.ufw).toBe(true)
})

test('foreign firewall changes are left for reconciliation without deleting another rule', async () => {
  const { runner, policy } = await setup()
  await policy.prepare()
  runner.occupied = true
  await policy.admitContainer(containerId)
  runner.nft += '\nforeign-rule'
  const before = runner.calls.length
  await expect(policy.revokeContainer()).rejects.toThrow('hosted-qwen-policy-drift')
  expect(runner.calls.slice(before).some(call => call.includes('delete element') ||
    call.includes('iptables -w 2 -D'))).toBe(false)
  expect(runner.grantIp).toBe('172.18.0.2')
})

test('vulnerable Docker DNS versions never install a lease', async () => {
  const { dir, runner, policy } = await setup()
  runner.version = '25.0.4'
  await expect(policy.prepare()).rejects.toThrow('hosted-qwen-docker-dns-unverified')
  expect(await readdir(dir)).toEqual([])
  expect(runner.nft).toBe('')
})
