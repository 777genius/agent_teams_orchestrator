import { mock } from 'bun:test'
import { resolve, dirname } from 'node:path'

// Run the real handler in a separate process, without loading provider code or
// reading user configuration. The handler path also permits testing a base copy.
const handlerPath = process.argv[2]!
const scenario = process.argv[3]!
const dependency = (path: string) => resolve(dirname(handlerPath), path)
const unused = () => { throw new Error('Unexpected provider call in offline fixture') }

for (const [file, name] of [
  ['OpenCodeExecutionProbe', 'openCodeExecutionProbe'],
  ['OpenCodeHostManager', 'openCodeHostManager'],
  ['OpenCodeProvisioningProbe', 'openCodeProvisioningProbe'],
  ['OpenCodeSessionBridge', 'openCodeSessionBridge'],
  ['OpenCodeSessionStore', 'openCodeSessionStore'],
  ['OpenCodeBridgeCommandHandler', 'executeOpenCodeBridgeCommandEnvelope'],
  ['OpenCodeLedgerBridgeService', 'openCodeLedgerBridgeService'],
]) {
  mock.module(dependency(`../../services/opencode/${file}.js`), () => ({ [name!]: unused }))
}
mock.module(dependency('../../features/runtimeProviderManagement/index.js'), () =>
  Object.fromEntries([
    'clearProviderProjectDefaultModel', 'connectProviderWithApiKey', 'connectProvider',
    'configureProviderModelLimits', 'forgetManagedProvider', 'loadProviderDirectory',
    'loadProviderModels', 'loadProviderManagementView', 'loadProviderSetupForm',
    'openCodeProviderManagementAdapter', 'setProviderDefaultModel', 'testProviderModel',
  ].map(name => [name, unused])),
)
mock.module(dependency('../../utils/slowOperations.js'), () => ({ jsonStringify: JSON.stringify }))

mock.module(dependency('../../services/runtimeBackends/registry.js'), () => ({
  getUnifiedRuntimeStatusPayload: (provider: string, _deps: unknown, options: { detailLevel: string }) => {
    if (provider !== 'opencode') throw new Error('Incorrect provider filter')
    if (scenario === 'throw') throw new Error('offline inventory failure')
    if (scenario === 'reject' || scenario.startsWith('stderr-')) {
      return Promise.reject(new Error('offline inventory failure'))
    }
    if (scenario === 'reject-string') return Promise.reject('offline inventory failure')
    if (scenario === 'reject-delayed') {
      return new Promise((_resolve, reject) => setTimeout(() => reject(new Error('offline inventory failure')), 20))
    }
    if (scenario === 'noise') process.stdout.write('inventory diagnostic\n')
    return Promise.resolve({
      schemaVersion: 2,
      providers: {
        opencode: {
          providerId: 'opencode',
          models: scenario === 'large' ? ['x'.repeat(2 * 1024 * 1024)] : [],
          detailMessage: options.detailLevel,
        },
      },
    })
  },
}))

if (scenario === 'write-error') {
  process.stdout.write = ((_chunk: unknown, callback: (error: Error) => void) => {
    callback(new Error('offline stdout failure'))
    return false
  }) as typeof process.stdout.write
}
if (scenario === 'write-no-callback') {
  process.stdout.write = (() => false) as typeof process.stdout.write
}

if (scenario === 'stderr-delayed') {
  const write = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string, callback: () => void) => {
    setTimeout(() => write(chunk, callback), 100).unref()
    return false
  }) as typeof process.stderr.write
}
if (scenario === 'stderr-no-callback') {
  const write = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string) => write(chunk)) as typeof process.stderr.write
}

// Production setupGracefulShutdown observes rejections for telemetry without
// making them fatal; entrypoints/cli.tsx starts with `void main()`.
process.on('unhandledRejection', () => {})
const { runtimeStatus } = await import(handlerPath)
void runtimeStatus({
  provider: 'opencode',
  json: true,
  text: process.argv.includes('--text'),
  summary: process.argv.includes('--summary'),
})
