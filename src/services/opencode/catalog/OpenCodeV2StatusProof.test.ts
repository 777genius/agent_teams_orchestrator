import { expect, test } from 'bun:test'

test('full V2 status revalidates only owned current-model proof and never executes on refresh', async () => {
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
    import path from 'node:path'
    import os from 'node:os'
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-v2-status-proof-')))
    Object.assign(process.env, { HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root,
      CLAUDE_MULTIMODEL_DATA_HOME: path.join(root, 'runtime') })
    const project = path.join(root, 'TEST-project'); await mkdir(project)
    const { executionHash } = await import(${JSON.stringify(import.meta.resolve('../execution/OpenCodeV2ExecutionContracts.ts'))})
    const { collectProjectBehaviorMetadata } = await import(${JSON.stringify(import.meta.resolve('../OpenCodeProfileManager.ts'))})
    const behavior = await collectProjectBehaviorMetadata(project)
    const native = { generation: 'v2', version: '2.1.4', dialect: 'v2-2.1.4',
      executablePath: path.join(root, 'TEST-binary'), executableSha256: 'a'.repeat(64), packageName: '@opencode/cli-linux-x64' }
    const selected = { native, model: { providerID: 'opencode', id: 'TEST-free' }, project,
      scope: { scopeToken: 'TEST-current-scope', selectedAuthIdentity: 'absent' }, behaviorFingerprint: 'b'.repeat(64),
      installedGraphSHA256: 'c'.repeat(64), capabilitySnapshotId: 'TEST-current-capability' }
    let current = selected, inspectionError = false, inspections = 0, resolutions = 0
    let delayInspection = false, cancelled = false, cleanupFinished = false
    const launchModule = ${JSON.stringify(import.meta.resolve('../bridge/OpenCodeV2LaunchPlan.ts'))}
    const launch = await import(launchModule), inspectOriginal = launch.inspectOpenCodeV2SourceAvailability
    mock.module(launchModule, () => ({ ...launch, inspectOpenCodeV2SourceAvailability: async (envelope, budget) => {
      inspections++; assert.equal(envelope.body.requireExecutionProbe, false)
      assert(budget.signal instanceof AbortSignal); assert(budget.deadlineMs <= Date.now() + 15000)
      if (delayInspection) {
        try { await new Promise((_, reject) => {
          const abort = () => { cancelled = true; reject(budget.signal.reason) }
          if (budget.signal.aborted) abort()
          else budget.signal.addEventListener('abort', abort, { once: true })
        }) }
        finally { await new Promise(resolve => setTimeout(resolve, 25)); cleanupFinished = true }
      }
      assert.equal(envelope.body.selectedModel, 'opencode/TEST-free'); assert.equal(envelope.cwd, project)
      if (inspectionError) throw new Error('TEST changed source')
      return current
    } }))
    const probeModule = ${JSON.stringify(import.meta.resolve('../bridge/OpenCodeV2ExecutionProbe.ts'))}
    const probe = await import(probeModule), resolveOriginal = probe.resolveOpenCodeV2ExecutionProbe
    mock.module(probeModule, () => ({ ...probe, resolveOpenCodeV2ExecutionProbe: async (envelope, selection, run, options) => {
      resolutions++; assert.equal(run, false); assert(options.signal instanceof AbortSignal)
      return resolveOriginal(envelope, selection, run, options)
    } }))
    const { buildOpenCodeExecutionProof } = await import(${JSON.stringify(import.meta.resolve('../OpenCodeExecutionProof.ts'))})
    const { ensureOpenCodeV2ProbeStore } = await import(${JSON.stringify(import.meta.resolve('../bridge/OpenCodeV2ProbeStore.ts'))})
    const { emptyOpenCodeV2ReadStatus, readModel, readProvider } = await import(${JSON.stringify(import.meta.resolve('./OpenCodeV2ReadStatus.ts'))})
    const { openCodeV2InventorySnapshot } = await import(${JSON.stringify(import.meta.resolve('./OpenCodeV2InventoryService.ts'))})
    const { readOpenCodeV2StatusProof } = await import(${JSON.stringify(import.meta.resolve('./OpenCodeV2StatusProof.ts'))})
    const { buildOpenCodeV2RuntimeStatusWithProof } = await import(${JSON.stringify(import.meta.resolve('./OpenCodeV2RuntimeStatus.ts'))})
    const row = { id: 'TEST-free', modelID: 'TEST-upstream', providerID: 'opencode', name: 'TEST free', enabled: true,
      status: 'active', cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }], variants: [],
      capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 8192, output: 512 } }
    const read = { ...emptyOpenCodeV2ReadStatus(native, project), catalog: 'ready',
      providers: [readProvider({ id: 'opencode', integrationID: 'opencode', activation: 'enabled', settings: { apiKey: 'public' } })],
      models: [readModel(row), readModel({ ...row, id: 'TEST-other' })] }
    const inventory = openCodeV2InventorySnapshot(native, project, read)
    const profile = { projectPath: project, canonicalProjectPath: project, profileRootKey: 'TEST-profile',
      profileRootPath: root, projectBehaviorFingerprint: behavior.projectBehaviorFingerprint,
      managedConfigFingerprint: 'd'.repeat(64), managedAuthFingerprint: 'e'.repeat(64),
      managedAuthPath: path.join(root, 'TEST-auth.json'), env: {} }
    const proof = await buildOpenCodeExecutionProof({ selectedModel: 'opencode/TEST-free', capabilitySnapshotId: selected.capabilitySnapshotId,
      snapshot: { profile, projectPath: project, hostHealthy: true,
        host: { version: native.version, resolvedConfigFingerprint: 'f'.repeat(64) } } }, {
      readCredential: async () => null, resolveBinaryPath: () => native.executablePath, resolveBinaryIdentity: async () => 'a'.repeat(64),
    })
    const sourceKey = executionHash({ project, scopeToken: selected.scope.scopeToken, selectedAuthIdentity: selected.scope.selectedAuthIdentity,
      source: selected.behaviorFingerprint, graph: selected.installedGraphSHA256, projectBehavior: behavior.projectBehaviorFingerprint, variant: 'default' })
    let cases = 0
    try {
      assert.equal(await readOpenCodeV2StatusProof(inventory), null); assert.equal(inspections, 0); cases++
      const store = await ensureOpenCodeV2ProbeStore(process.env.CLAUDE_MULTIMODEL_DATA_HOME)
      // More old directories than the previous scan budget must not hide a new success.
      for (let index = 0; index < 520; index++)
        await mkdir(path.join(store.probeRoot, index.toString(16).padStart(64, '0')), { mode: 0o700 })
      const directory = path.join(store.probeRoot, sourceKey); await mkdir(directory, { mode: 0o700 })
      const file = path.join(directory, 'probe.json')
      const record = { sourceKey, binding: { teamId: 'TEST-team', runId: 'TEST-run', controllerInstanceId: 'TEST-controller', ownerId: 'TEST-owner' },
        sessionID: 'ses_TESToriginal', intent: { identity: { requestId: 'TEST-request', deliveryAttemptId: 'TEST-attempt',
          localMessageId: 'TEST-local', nativeInputID: 'msg_TESTinput' }, delivery: 'queue',
          input: { nativeInputID: 'msg_TESTinput', resume: true, text: 'TEST readiness' } },
        submitted: true, retired: true, proof, failure: null }
      const save = value => writeFile(file, JSON.stringify(value), { mode: 0o600 })
      await save(record)
      // The real producer's cached-success branch publishes the discovery hint.
      await resolveOriginal({ schemaVersion: 1, requestId: 'TEST-publish-hint', command: 'opencode.readiness', cwd: project,
        startedAt: new Date().toISOString(), timeoutMs: 60000, body: { effort: 'default' } }, selected, true)
      const status = await buildOpenCodeV2RuntimeStatusWithProof(inventory)
      assert.equal(status.modelCatalog.models[0].metadata.opencode.proofState, 'verified')
      assert.equal(status.modelCatalog.models[0].metadata.opencode.routeKind, 'builtin_free')
      assert.equal(status.modelCatalog.models[0].metadata.opencode.requiresExecutionProof, true)
      assert.equal(status.modelCatalog.models[1].metadata.opencode.proofState, 'needs_probe')
      assert.equal(status.authenticated, false); assert.equal(status.capabilities.teamLaunch, false)
      assert.equal(status.capabilities.oneShot, false); assert.equal(status.modelCatalog.defaultLaunchModel, null)
      assert.equal(resolutions, 1); cases++
      for (const change of [
        { proof: { ...proof, expiresAt: new Date(Date.now() - 1).toISOString() } },
        { proof: { ...proof, projectPath: path.join(root, 'TEST-other-project') } },
        { proof: { ...proof, binaryPath: path.join(root, 'TEST-other-binary') } },
        { proof: { ...proof, opencodeVersion: '2.0.0' } },
        { submitted: false }, { retired: false }, { failure: 'native_execution_failed' },
      ]) {
        const before = inspections; await save({ ...record, ...change })
        assert.equal(await readOpenCodeV2StatusProof(inventory), null); assert.equal(inspections, before); cases++
      }
      await save(record)
      for (const change of [
        { scope: { ...selected.scope, selectedAuthIdentity: 'known:TEST-changed-auth' } },
        { scope: { ...selected.scope, scopeToken: 'TEST-changed-config' } },
        { behaviorFingerprint: '1'.repeat(64) }, // Includes selected model/config/MCP identity.
        { installedGraphSHA256: '2'.repeat(64) },
      ]) {
        current = { ...selected, ...change }
        assert.equal(await readOpenCodeV2StatusProof(inventory), null); cases++
      }
      current = selected; inspectionError = true
      assert.equal(await readOpenCodeV2StatusProof(inventory), null); cases++
      inspectionError = false
      assert.equal((await readOpenCodeV2StatusProof(inventory)).proofHash, proof.proofHash); cases++
      delayInspection = true
      const started = Date.now(), timed = await buildOpenCodeV2RuntimeStatusWithProof(inventory, null, 20)
      assert.equal(timed.modelCatalog.status, 'ready'); assert.equal(timed.modelCatalog.models[0].metadata.opencode.proofState, 'needs_probe')
      assert(cancelled && cleanupFinished, 'Status waits for cooperative cancellation/cleanup, not an abandoned race')
      assert(Date.now() - started < 1000); delayInspection = false; cases++
      const before = inspections
      assert.equal((await buildOpenCodeV2RuntimeStatusWithProof(inventory, null, 0)).modelCatalog.models[0].metadata.opencode.proofState, 'needs_probe')
      assert.equal(inspections, before); cases++
      const stopped = new AbortController(), reason = new Error('TEST-aborted-before-native')
      stopped.abort(reason)
      await assert.rejects(inspectOriginal({}, { signal: stopped.signal, deadlineMs: Date.now() }), error => error === reason)
      await assert.rejects(resolveOriginal({}, selected, false, { signal: stopped.signal }), error => error === reason)
      const { createOpenCodeV2ExecutionReceipt } = await import(${JSON.stringify(import.meta.resolve('../profile/OpenCodeV2ExecutionReceipt.ts'))})
      await assert.rejects(createOpenCodeV2ExecutionReceipt('', native, undefined, undefined, stopped.signal), error => error === reason)
      await assert.rejects(collectProjectBehaviorMetadata(project, process.env, stopped.signal), error => error === reason); cases++
      const apiSelection = { ...selected, scope: { ...selected.scope, selectedAuthIdentity: 'known:TEST-api-key' } }
      const apiProof = await buildOpenCodeExecutionProof({ selectedModel: proof.modelId, capabilitySnapshotId: selected.capabilitySnapshotId,
        snapshot: { profile, projectPath: project, hostHealthy: true, host: { version: native.version, resolvedConfigFingerprint: 'f'.repeat(64) } } }, {
        readCredential: async () => ({ type: 'api', key: 'TEST-key' }), resolveBinaryPath: () => native.executablePath,
        resolveBinaryIdentity: async () => 'a'.repeat(64),
      })
      const apiKey = executionHash({ project, scopeToken: apiSelection.scope.scopeToken, selectedAuthIdentity: apiSelection.scope.selectedAuthIdentity,
        source: apiSelection.behaviorFingerprint, graph: apiSelection.installedGraphSHA256, projectBehavior: behavior.projectBehaviorFingerprint, variant: 'default' })
      const apiDirectory = path.join(store.probeRoot, apiKey); await mkdir(apiDirectory, { mode: 0o700 })
      await writeFile(path.join(apiDirectory, 'probe.json'), JSON.stringify({ ...record, sourceKey: apiKey, proof: apiProof }), { mode: 0o600 })
      await resolveOriginal({ schemaVersion: 1, requestId: 'TEST-publish-key-hint', command: 'opencode.readiness', cwd: project,
        startedAt: new Date().toISOString(), timeoutMs: 60000, body: { effort: 'default' } }, apiSelection, true)
      current = apiSelection
      const apiStatus = await buildOpenCodeV2RuntimeStatusWithProof(inventory)
      assert.equal(apiStatus.modelCatalog.models[0].metadata.opencode.proofState, 'verified')
      assert.equal(apiStatus.modelCatalog.models[0].metadata.opencode.routeKind, 'catalog_provider', 'Key-backed proof cannot claim verified anonymous access')
      cases++
      // Changed source keys may have locks, but refresh cannot write another probe or start a run.
      let records = 0
      for (const name of await readdir(store.probeRoot)) {
        try { await readFile(path.join(store.probeRoot, name, 'probe.json')); records++ } catch { }
      }
      assert.equal(records, 2)
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), record)
      assert.equal(await readdir(path.join(process.env.CLAUDE_MULTIMODEL_DATA_HOME, 'opencode/v2')).then(rows => rows.includes('runs')), false)
    } finally { await rm(root, { recursive: true, force: true }) }
    console.log(JSON.stringify({ cases, inspections, resolutions, fixtureRemoved: true }))
  `
  const child = Bun.spawn([process.execPath, '-e', script], { cwd: import.meta.dir, stdout: 'pipe', stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      NODE_ENV: 'test', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1' } })
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' })
  expect(JSON.parse(stdout)).toEqual({ cases: 19, inspections: 9, resolutions: 7, fixtureRemoved: true })
}, 30_000)
