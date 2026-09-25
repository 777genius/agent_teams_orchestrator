import { afterEach, expect, test } from 'bun:test'
import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { HostedProductCurrentMember, HostedProductMemberBinding } from
  '../productAuthority/HostedProductCurrentMemberDecision.js'
import type { HostedQwenContainerBinding } from './HostedQwenGateway.js'
import type { HostedQwenCommandRunner } from './HostedQwenNetworkPolicy.js'
import { HostedRootQwenMemberComposition, type HostedRootQwenMemberAuthority } from
  './HostedRootQwenMemberComposition.js'

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

class FirewallFixture implements HostedQwenCommandRunner {
  occupied = false
  nft = ''
  grant: string | null = null
  ufw = false
  failUfwInsert = false
  readonly calls: string[] = []
  readonly networkId: string
  readonly generation: string
  readonly containerId: string
  readonly gateway: string
  readonly ip: string

  constructor(index: number) {
    this.networkId = String(index).repeat(64)
    this.generation = String(index).repeat(32)
    this.containerId = String(index + 2).repeat(64)
    this.gateway = `172.${index}.0.1`
    this.ip = `172.${index}.0.2`
  }

  async run(executable: string, args: readonly string[], input?: string): Promise<string> {
    this.calls.push(`${executable} ${args.join(' ')}`)
    if (executable === '/usr/bin/docker' && args[0] === 'version') return '29.8.1'
    if (executable === '/usr/bin/docker' && args[0] === 'network') return JSON.stringify({
      Id: this.networkId, Driver: 'bridge', Scope: 'local', Internal: true,
      EnableIPv6: false, Ingress: false, Options: {},
      IPAM: { Config: [{ Gateway: this.gateway }] },
      Containers: this.occupied ? { [this.containerId]: {} } : {},
    })
    if (executable === '/usr/bin/docker' && args[0] === 'inspect') return JSON.stringify({
      Id: this.containerId, HostConfig: { NetworkMode: this.networkId },
      Config: { Labels: { 'org.agentteams.hosted-opencode.generation': this.generation } },
      State: { Running: true, Pid: 1234 },
      NetworkSettings: { Networks: { private: { NetworkID: this.networkId,
        IPAddress: this.ip, Gateway: '' } } },
    })
    if (executable === '/usr/sbin/ip') return JSON.stringify([{
      ifname: `br-${this.networkId.slice(0, 12)}`, ifindex: 40 + Number(this.generation[0]),
      addr_info: [{ family: 'inet', local: this.gateway }],
    }])
    if (executable === '/usr/sbin/nft') {
      if (args[0] === '-f') { this.nft = input ?? ''; return '' }
      if (args[0] === '-j') return JSON.stringify({ nftables: [
        { table: { name: `hqw_${this.generation}`, rules: this.nft } },
        { set: { name: 'granted', table: `hqw_${this.generation}`, family: 'inet',
          type: 'ipv4_addr', elem: this.grant ? [this.grant] : [] } },
      ] })
      if (args[0] === 'add') { this.grant = this.ip; return '' }
      if (args[0] === 'delete' && args[1] === 'element') { this.grant = null; return '' }
      if (args[0] === 'delete' && args[1] === 'table') { this.nft = ''; return '' }
    }
    if (executable === '/usr/sbin/iptables') {
      if (args.includes('-I')) {
        if (this.failUfwInsert) throw new Error('synthetic-ufw-insert-failure')
        this.ufw = true; return ''
      }
      if (args.includes('-D')) { this.ufw = false; return '' }
      if (args.includes('-C')) { if (!this.ufw) throw new Error('missing'); return '' }
      if (args.includes('-S')) return this.ufw
        ? `-A ufw-user-input --comment "hqw_${this.generation}" -j ACCEPT` : ''
    }
    throw new Error(`unexpected synthetic command: ${executable} ${args.join(' ')}`)
  }
}

function memberFor(index: number): HostedProductMemberBinding {
  return Object.freeze({
    runId: `run_${'a'.repeat(32)}`, memberId: `member_${String(index).repeat(32)}`,
    teamId: `team_${'c'.repeat(32)}`, laneId: `lane_${'d'.repeat(32)}`,
    deploymentId: 'deployment_test1234', runtimeWorkspaceId: `workspace_${'e'.repeat(32)}`,
    planSha256: 'f'.repeat(64), rosterBindingSha256: 'a'.repeat(64),
    restoreGeneration: 0, mountGeneration: 1,
  })
}

async function fixture(index: number, failListener = false) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'root-qwen-member-'))
  await chmod(dir, 0o700)
  dirs.push(dir)
  const firewall = new FirewallFixture(index)
  const member = memberFor(index)
  const events: string[] = []
  let admission: unknown = null
  let current: HostedQwenContainerBinding | null = null
  let failContainerStopOnce = false
  let failListenerStopOnce = false
  const container: HostedQwenContainerBinding = Object.freeze({ containerId: firewall.containerId,
    networkId: firewall.networkId, containerGeneration: index, containerIp: firewall.ip })
  const authority: HostedRootQwenMemberAuthority = {
    async withCurrentMemberDecision<T>(binding: HostedProductMemberBinding, _kind: 'start' | 'observe',
      callback: (value: HostedProductCurrentMember) => T): Promise<T> {
      expect(binding).toEqual(member)
      return callback({ ...member, model: 'local-llama/qwen3-8b' } as HostedProductCurrentMember)
    },
    currentContainer: () => current,
  }
  const composition = new HostedRootQwenMemberComposition({ member, networkId: firewall.networkId,
    generation: firewall.generation, gatewayPort: 19440 + index, stateDirectory: dir,
    authority, container: {
      async start() {
        expect(firewall.nft).toContain(' drop')
        expect(events).toContain('listen')
        events.push('container-start')
        firewall.occupied = true
        current = container
        return firewall.containerId
      },
      async prove(id) { expect(id).toBe(firewall.containerId); events.push('docker-proof'); return container },
      async stopAndRemove(id) {
        expect(id).toBe(firewall.containerId)
        expect(firewall.grant).toBeNull()
        expect(firewall.ufw).toBe(false)
        events.push('container-stop')
        if (failContainerStopOnce) {
          failContainerStopOnce = false
          throw new Error('synthetic-container-stop-failure')
        }
        firewall.occupied = false
        current = null
      },
    },
    testOnly: { runner: firewall, gateway: (address, policy) => {
      expect(address).toBe(firewall.gateway)
      return {
      async start() { events.push('listen'); if (failListener) throw new Error('synthetic-listen-failure') },
      admitClient(value) {
        if (typeof value === 'string') throw new Error('unexpected loopback-only admission')
        policy.assertContainerSource(value.container.networkId, value.container.containerId,
          value.container.containerIp, firewall.generation)
        events.push('gateway-admit')
        admission = value
      },
      revokeClient() { events.push('gateway-revoke'); admission = null },
      async stop() {
        events.push('listener-stop')
        if (failListenerStopOnce) {
          failListenerStopOnce = false
          throw new Error('synthetic-listener-stop-failure')
        }
      },
      }
    } },
  })
  return { composition, firewall, dir, events, admitted: () => admission,
    failNextContainerStop: () => { failContainerStopOnce = true },
    failNextListenerStop: () => { failListenerStopOnce = true } }
}

test('deny precedes Docker start, and only exact proof grants one member until revoke', async () => {
  const a = await fixture(1)
  const b = await fixture(2)
  await a.composition.start()
  await b.composition.start()
  expect(a.firewall.grant).toBe(a.firewall.ip)
  expect(b.firewall.grant).toBe(b.firewall.ip)
  expect(a.firewall.nft).toContain('19441')
  expect(b.firewall.nft).toContain('19442')
  expect(a.admitted()).not.toBeNull()
  await a.composition.stop()
  expect(a.admitted()).toBeNull()
  expect(a.firewall.nft).toBe('')
  expect(b.firewall.grant).toBe(b.firewall.ip)
  expect(a.events.indexOf('gateway-revoke')).toBeLessThan(a.events.indexOf('container-stop'))
  expect(a.firewall.calls.findIndex(call => call.includes('nft delete element'))).toBeLessThan(
    a.firewall.calls.findIndex(call => call.includes('nft delete table')))
  await b.composition.stop()
  expect(await readdir(a.dir)).toEqual([])
  expect(await readdir(b.dir)).toEqual([])
})

test('listener failure cleans an installed deny without starting Docker', async () => {
  const h = await fixture(3, true)
  await expect(h.composition.start()).rejects.toThrow('synthetic-listen-failure')
  expect(h.events).not.toContain('container-start')
  expect(h.firewall.nft).toBe('')
  expect(await readdir(h.dir)).toEqual([])
})

test('partial firewall grant is revoked before container cleanup', async () => {
  const h = await fixture(4)
  h.firewall.failUfwInsert = true
  await expect(h.composition.start()).rejects.toThrow('synthetic-ufw-insert-failure')
  expect(h.events).toContain('container-stop')
  expect(h.events).not.toContain('gateway-admit')
  expect(h.firewall.grant).toBeNull()
  expect(h.firewall.nft).toBe('')
  expect(await readdir(h.dir)).toEqual([])
})

test('start failure keeps cleanup retryable when Docker removal fails once', async () => {
  const h = await fixture(5)
  h.firewall.failUfwInsert = true
  h.failNextContainerStop()
  await expect(h.composition.start()).rejects.toThrow('hosted-root-qwen-cleanup-unresolved')
  expect(h.firewall.occupied).toBe(true)
  expect(h.firewall.grant).toBeNull()
  expect(h.firewall.nft).toContain(' drop')
  expect((await readdir(h.dir)).some(name => name.endsWith('.claim'))).toBe(true)
  await h.composition.stop()
  expect(h.firewall.occupied).toBe(false)
  expect(h.firewall.nft).toBe('')
  expect(await readdir(h.dir)).toEqual([])
  expect(h.events.filter(event => event === 'container-stop')).toHaveLength(2)
})

test('normal stop retries Docker removal without repeating proven firewall revocation', async () => {
  const h = await fixture(6)
  await h.composition.start()
  h.failNextContainerStop()
  await expect(h.composition.stop()).rejects.toThrow('synthetic-container-stop-failure')
  expect(h.firewall.occupied).toBe(true)
  expect(h.firewall.grant).toBeNull()
  expect(h.firewall.ufw).toBe(false)
  const revokeCount = h.firewall.calls.filter(call => call.includes('nft delete element')).length
  await h.composition.stop()
  expect(h.firewall.calls.filter(call => call.includes('nft delete element'))).toHaveLength(revokeCount)
  expect(h.firewall.occupied).toBe(false)
  expect(await readdir(h.dir)).toEqual([])
})

test('listener stop retry does not remove the container twice', async () => {
  const h = await fixture(7)
  await h.composition.start()
  h.failNextListenerStop()
  await expect(h.composition.stop()).rejects.toThrow('synthetic-listener-stop-failure')
  expect(h.firewall.occupied).toBe(false)
  expect(h.firewall.nft).toContain(' drop')
  await h.composition.stop()
  expect(h.events.filter(event => event === 'container-stop')).toHaveLength(1)
  expect(h.events.filter(event => event === 'listener-stop')).toHaveLength(2)
  expect(await readdir(h.dir)).toEqual([])
})
