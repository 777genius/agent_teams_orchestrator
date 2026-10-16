import { expect, test } from 'bun:test'

test('launch waits for original native members under one deadline before returning the final projection', async () => {
  const target = import.meta.resolve('./OpenCodeV2TeamBridge.ts')
  const factory = import.meta.resolve('./OpenCodeRuntimeAdapterFactory.ts')
  const plans = import.meta.resolve('./OpenCodeV2LaunchPlan.ts')
  const control = import.meta.resolve('./OpenCodeV2RunControl.ts')
  const script = `
    import { mock } from 'bun:test'; import assert from 'node:assert/strict'
    let clock = 1000, scenario = 'ready', release
    Date.now = () => clock
    const binding = { teamId: 'TEST-launch', runId: 'TEST-run', controllerInstanceId: 'TEST-controller', ownerId: 'TEST-owner' }
    const qualification = { capabilitySnapshotId: 'TEST-capability', expectedBehaviorFingerprint: 'a'.repeat(64),
      binaryPath: '/TEST/native', binaryFingerprint: 'TEST-binary', version: '2.0.21' }
    const owner = { binding, deadline: 10000 }
    const members = ['one', 'two'].map(memberId => ({ memberId, laneId: 'primary', originalSessionId: 'ses_' + memberId,
      native: { version: '2.0.21' }, profile: { selection: { model: { providerID: 'TEST', id: 'model', variant: 'default' } } } }))
    const nativeMembers = members.map(member => ({ memberId: member.memberId, laneId: member.laneId,
      originalSessionId: member.originalSessionId, opencodeSessionId: member.originalSessionId, runtimeSessionId: member.originalSessionId,
      selectedModel: 'TEST/model', selectedVariant: 'default', pin: '2.0.21', runtimePid: member.memberId === 'one' ? 123 : 124,
      state: 'accepted', bootstrap: { verified: true, strategy: 'instruction-entry', missingNativeMessageID: true },
      controllerTools: { server: 'agent-teams', nativeNames: ['message_send'], schemasHash: 'b'.repeat(64) } }))
    let budgets = [], launches = 0, discoveries = 0
    const factoryModule = await import(${JSON.stringify(factory)})
    mock.module(${JSON.stringify(factory)}, () => ({ ...factoryModule,
      inspectOpenCodeRuntimeAdapterSelection: async () => ({ policy: { generation: 'v2', version: '2.0.21' } }) }))
    mock.module(${JSON.stringify(plans)}, () => ({ createOpenCodeV2LaunchPlan: async () => {
      clock += 20; return { binding, members, deadline: owner.deadline, qualification }
    }, inspectOpenCodeV2SourceAvailability: async () => { throw Error('TEST source requalification forbidden') },
      buildOpenCodeV2InternalRunPlan: async () => { throw Error('TEST probe launch forbidden') } }))
    const controlModule = await import(${JSON.stringify(control)})
    mock.module(${JSON.stringify(control)}, () => ({ ...controlModule,
      awaitOpenCodeV2RunMemberReadiness: async () => { throw Error('TEST obsolete member-wait path forbidden') },
      requestOpenCodeV2Run: async (record, request, timeout) => {
        assert.strictEqual(record, owner); assert.equal(request.operation, 'status'); budgets.push(timeout)
        if (scenario === 'ready' && budgets.length === 1) await new Promise(resolve => { release = resolve })
        if (scenario === 'foreignOwner') throw Error('run_control_foreign')
        if (['transientTimeout', 'transientDisconnected'].includes(scenario) && budgets.length === 1) {
          clock += 20; throw Error(scenario === 'transientTimeout' ? 'run_control_timeout' : 'run_control_disconnected')
        }
        clock += scenario === 'expired' ? timeout : 100
        const state = scenario === 'stopped' || scenario === 'startingThenStopped' && budgets.length > 1 ? 'stopped'
          : scenario === 'startingThenStopped' ? 'starting' : 'active'
        const observed = scenario === 'changed' ? nativeMembers.map(member => ({ ...member, originalSessionId: 'ses_replacement' }))
          : scenario === 'noPid' ? nativeMembers.map(member => ({ ...member, runtimePid: undefined })) : nativeMembers
        return { kind: 'status', state, deadline: owner.deadline, qualification, members: observed }
      },
    }))
    const { OpenCodeV2TeamBridge, executeSelectedOpenCodeBridgeCommandEnvelope: execute } = await import(${JSON.stringify(target)})
    OpenCodeV2TeamBridge.prototype.discover = async () => { discoveries++; assert.equal(discoveries, 1); return null }
    OpenCodeV2TeamBridge.prototype.launchExplicit = async () => { launches++; clock += 30; return owner }
    OpenCodeV2TeamBridge.prototype.call = async () => { throw Error('TEST endpoint-only readiness forbidden') }
    for (scenario of ['ready', 'stopped', 'expired', 'changed', 'startingThenStopped', 'noPid', 'transientTimeout', 'transientDisconnected', 'foreignOwner']) {
      clock = 1000; budgets = []; launches = 0; discoveries = 0; release = undefined
      let settled = false
      const pending = execute({ schemaVersion: 1, requestId: 'TEST-launch', command: 'opencode.launchTeam', cwd: '/TEST',
        startedAt: new Date().toISOString(), timeoutMs: 1000, body: { teamId: binding.teamId, runId: binding.runId } },
        async () => { throw Error('V1 fallback forbidden') }).then(result => { settled = true; return result })
      if (scenario === 'ready') {
        await new Promise(resolve => setTimeout(resolve, 10))
        assert.equal(settled, false, 'endpoint publication must not settle launch')
        assert.equal(typeof release, 'function'); release()
      }
      const result = await pending
      assert.equal(launches, 1)
      assert.equal(discoveries, 1)
      const retried = ['transientTimeout', 'transientDisconnected'].includes(scenario)
      assert.deepEqual(budgets, retried ? [950, 930] : scenario === 'startingThenStopped' ? [950, 850] : [950])
      if (scenario === 'ready' || retried) {
        assert.equal(result.ok, true)
        for (const [name, pid] of [['one', 123], ['two', 124]]) {
          assert.equal(result.data.members[name].launchState, 'confirmed_alive')
          assert.equal(result.data.members[name].runtimePid, pid)
          assert.equal(result.data.members[name].sessionId, 'ses_' + name)
        }
        assert.equal(result.data.expectedBehaviorFingerprint, qualification.expectedBehaviorFingerprint)
      } else {
        assert.equal(result.ok, false); assert.equal(result.error.retryable, false)
      }
    }
    console.log(JSON.stringify({ scenarios: 9 }))
  `
  const child = Bun.spawn([process.execPath, '-e', script], { cwd: import.meta.dir, stdout: 'pipe', stderr: 'pipe' })
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' })
  expect(JSON.parse(stdout)).toEqual({ scenarios: 9 })
}, 15_000)
