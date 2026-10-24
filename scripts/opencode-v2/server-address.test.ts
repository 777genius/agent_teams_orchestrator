import { expect, test } from 'bun:test'
import { createServer } from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyOpenCodeV2ServerGraph } from '../../src/services/opencode/host/OpenCodeV2ServerGraph.js'
import { openCodeV2ServerLoopbackUrl } from '../../src/services/opencode/host/OpenCodeV2ServerAddress.js'
import { openCodeV2StagedVersions, openCodeV2Wire } from '../../src/services/opencode/compatibility/OpenCodeV2Registry.js'
import manifest from '../../package.json' with { type: 'json' }

const staged = openCodeV2StagedVersions(manifest.dependencies)

for (const pin of staged) test(`${pin} actual listener address retains exact loopback authority`, async () => {
  const graph = await verifyOpenCodeV2ServerGraph(pin)
  const { Effect }: typeof import('effect') = await import(pathToFileURL(graph.effectPath).href)
  const entry = Bun.resolveSync('@effect/platform-node/NodeHttpServer', path.dirname(graph.modulePath))
  const http: typeof import('@effect/platform-node/NodeHttpServer') = await import(pathToFileURL(entry).href)
  const address = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    return (yield* http.make(() => createServer(), { host: '127.0.0.1', port: 0 })).address
  })))
  expect(openCodeV2ServerLoopbackUrl(pin, address)).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d*$/)
  const other = staged.find(version => openCodeV2Wire(version) !== openCodeV2Wire(pin))!
  expect(() => openCodeV2ServerLoopbackUrl(other, address)).toThrow('execution_server_address_invalid')
  for (const port of [0, -1, 65536, 1.5, '1234'])
    expect(() => openCodeV2ServerLoopbackUrl(pin, { ...address, port })).toThrow('execution_server_address_invalid')
  for (const _tag of ['InetAddressV6', 'UnixPathAddress'])
    expect(() => openCodeV2ServerLoopbackUrl(pin, { ...address, _tag })).toThrow('execution_server_address_invalid')
  expect(() => openCodeV2ServerLoopbackUrl(pin, { ...address, hostname: '0.0.0.0',
    address: { _tag: 'Ipv4Address', toString: () => '0.0.0.0' } })).toThrow('execution_server_address_invalid')
})
