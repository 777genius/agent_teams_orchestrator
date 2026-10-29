import { expect, test } from 'bun:test'

// Keep the probe stand-in and simulated platform inside a child process. This
// exercises the public consumers without launching a native server or model.
// Windows stat has no POSIX ownership/mode evidence, so its runner exercises
// native Windows policy. POSIX runners also cover case-sensitive identities.
const platforms = process.platform === 'win32' ? ['win32'] as const : ['win32', 'linux', 'darwin'] as const
for (const platform of platforms) for (const surface of ['model test', 'connection receipts'] as const) {
  test(`V2 ${surface} respects ${platform} project identity`, async () => {
    const script = `
      import { mock } from 'bun:test'
      import assert from 'node:assert/strict'
      import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
      import path from 'node:path'
      import { tmpdir } from 'node:os'
      const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-v2-project-identity-')))
      const project = path.join(root, 'MixedCaseProject')
      await mkdir(project)
      process.env.CLAUDE_MULTIMODEL_DATA_HOME = root
      const launchPath = ${JSON.stringify(import.meta.resolve('../../../../services/opencode/bridge/OpenCodeV2LaunchPlan.ts'))}
      const launch = await import(launchPath)
      mock.module(launchPath, () => ({ ...launch, inspectOpenCodeV2SourceAvailability: async () => ({}) }))
      const probePath = ${JSON.stringify(import.meta.resolve('../../../../services/opencode/bridge/OpenCodeV2ExecutionProbe.ts'))}
      const probeModule = await import(probePath)
      let probe, calls = 0
      mock.module(probePath, () => ({ ...probeModule, resolveOpenCodeV2ExecutionProbe: async () => { calls++; return probe } }))
      const { testOpenCodeV2ProviderModel } = await import(${JSON.stringify(import.meta.resolve('./OpenCodeV2ProviderManagement.ts'))})
      const { readOpenCodeV2ConnectedProviders, openCodeV2ProviderConnectionsDirectory } =
        await import(${JSON.stringify(import.meta.resolve('../../../../services/opencode/catalog/OpenCodeV2KeyIntegrations.ts'))})
      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
      const platform = ${JSON.stringify(platform)}
      const surface = ${JSON.stringify(surface)}
      Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform })
      try {
        // Proofs store a lowercased identity on Windows; filesystem canonical
        // paths deliberately retain their spelling on every platform.
        const proofProject = platform === 'win32' ? project.toLowerCase() : project
        if (surface === 'model test') {
        const modelId = 'opencode-go/GLM-5.3-Flash'
        const input = { runtimeId: 'opencode', providerId: 'opencode-go', modelId, projectPath: project }
        const check = async (proofPath, expected, state = 'available', proofModel = modelId) => {
          probe = { state, proof: { projectPath: proofPath, modelId: proofModel } }
          const before = calls
          const result = await testOpenCodeV2ProviderModel(input)
          assert.equal(calls, before + 1)
          assert.equal(result.ok, true)
          assert.equal(result.value.ok, expected)
          assert.equal(result.value.availability, expected ? 'available' : 'unknown')
        }
        await check(proofProject, true)
        await check(proofProject + '-other-project', false)
        await check(proofProject, false, 'available', 'opencode-go/other-model')
        await check(proofProject, false, 'pending')
        await check(proofProject, false, 'failed')
        if (platform !== 'win32') await check(project.toLowerCase(), false)
        } else {
        const directory = openCodeV2ProviderConnectionsDirectory()
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const receipt = (providerId, projectPath, state = 'complete', version = '2.1.4') => JSON.stringify({ state,
          connection: { providerId, state: 'connected' }, proof: { projectPath, opencodeVersion: version } })
        const write = (name, content) => writeFile(path.join(directory, name.repeat(64) + '.json'), content, { mode: 0o600 })
        await write('a', receipt('opencode-go', proofProject))
        await write('b', receipt('foreign-project', proofProject + '-other-project'))
        await write('c', receipt('pending-provider', proofProject, 'pending'))
        await write('d', receipt('foreign-version', proofProject, 'complete', '2.0.32'))
        if (platform !== 'win32') await write('e', receipt('case-distinct-project', project.toLowerCase()))
        assert.deepEqual(await readOpenCodeV2ConnectedProviders(project, '2.1.4'), [
          { id: 'opencode-go', authHint: 'api', source: 'credentials', credentialScopes: ['managed'] }
        ])
        }
      } finally {
        Object.defineProperty(process, 'platform', originalPlatform)
        await rm(root, { recursive: true, force: true })
      }
    `
    const env: Record<string, string> = { PATH: process.env.PATH ?? '', NODE_ENV: 'test',
      OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1' }
    for (const name of ['TEMP', 'TMP', 'SystemRoot', 'USERPROFILE']) {
      const value = process.env[name]
      if (value !== undefined) env[name] = value
    }
    const child = Bun.spawn([process.execPath, '-e', script], {
      cwd: import.meta.dir, stdout: 'pipe', stderr: 'pipe',
      env,
    })
    const [exit, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    expect({ exit, output: stdout + stderr }).toEqual({ exit: 0, output: '' })
  }, 15_000)
}
