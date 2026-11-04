import { expect, test } from 'bun:test'

test('default command dispatch selects V2 and preserves the V1 callback and cancellation signal', async () => {
  const command = import.meta.resolve('./runtimeOpenCodeCommand.ts')
  const legacy = import.meta.resolve('../../services/opencode/OpenCodeBridgeCommandHandler.ts')
  const selected = import.meta.resolve('../../services/opencode/bridge/OpenCodeV2TeamBridge.ts')
  // A subprocess keeps module substitutes isolated from all other command tests.
  const script = `
    import {mock} from 'bun:test'
    import assert from 'node:assert/strict'
    const selectedCalls=[],legacyCalls=[],payloads=[],exits=[]
    mock.module(${JSON.stringify(legacy)}, () => ({executeOpenCodeBridgeCommandEnvelope: async (input,options) => {
      legacyCalls.push({input,signal:options.signal})
      return {lane:'v1'}
    }}))
    mock.module(${JSON.stringify(selected)}, () => ({executeSelectedOpenCodeBridgeCommandEnvelope: async (input,executeV1) => {
      selectedCalls.push(input)
      return input.lane==='v1' ? executeV1(input) : {lane:'v2'}
    }}))
    const {runtimeOpenCodeCommand}=await import(${JSON.stringify(command)})
    for(const lane of ['v2','v1']) await runtimeOpenCodeCommand({input:'TEST-routing'},{
      readInput:async()=>JSON.stringify({lane}),
      writePayload:async(_opts,payload)=>payloads.push(JSON.parse(payload)),
      drainCleanup:async()=>{},onSignal:()=>{},offSignal:()=>{},exit:code=>exits.push(code)
    })
    assert.deepEqual(selectedCalls,[{lane:'v2'},{lane:'v1'}])
    assert.equal(legacyCalls.length,1)
    assert.deepEqual(legacyCalls[0].input,selectedCalls[1])
    assert(legacyCalls[0].signal instanceof AbortSignal)
    assert.equal(legacyCalls[0].signal.aborted,false)
    assert.deepEqual(payloads,[{lane:'v2'},{lane:'v1'}])
    assert.deepEqual(exits,[0,0])
    console.log('TEST default selector V2/V1 routing qualified')
  `
  const child = Bun.spawn([process.execPath, '-e', script], {
    cwd: import.meta.dir, stdout: 'pipe', stderr: 'pipe',
  })
  const [exit, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' })
  expect(stdout.trim()).toBe('TEST default selector V2/V1 routing qualified')
}, 45_000)

test('startup registry cleanup is binary-independent and cannot accept V2 run targets', async () => {
  const selected = import.meta.resolve('../../services/opencode/bridge/OpenCodeV2TeamBridge.ts')
  const factory = import.meta.resolve('../../services/opencode/bridge/OpenCodeRuntimeAdapterFactory.ts')
  const script = `
    import {mock} from 'bun:test'
    import assert from 'node:assert/strict'
    const factory = await import(${JSON.stringify(factory)})
    let selections=0,discoveries=0,legacyCalls=0
    mock.module(${JSON.stringify(factory)}, () => ({...factory,
      inspectOpenCodeRuntimeAdapterSelection: async () => { selections++; throw Error('TEST native selection forbidden') }
    }))
    const {OpenCodeV2TeamBridge,executeSelectedOpenCodeBridgeCommandEnvelope:execute}=await import(${JSON.stringify(selected)})
    OpenCodeV2TeamBridge.prototype.discover=async()=>{discoveries++;throw Error('TEST owner discovery forbidden')}
    const envelope={schemaVersion:1,requestId:'TEST-startup',command:'opencode.cleanupStartupHosts',
      cwd:'/TEST',startedAt:new Date().toISOString(),timeoutMs:30000,body:{deadlineUnixMs:Date.now()+30000}}
    const response={ok:true,source:'legacy-registry'}
    const legacy=async input=>{legacyCalls++;assert.equal(input,envelope);return response}
    assert.equal(await execute(envelope,legacy),response)
    for(const body of [
      {teamId:'TEST',runId:'run'}, {runId:'partial'}, {expectedRunId:''}, {expectedRunId:null},
      {teamId:'TEST',runId:'one',expectedRunId:'two'}
    ]) {
      const refusal=await execute({...envelope,body:{...envelope.body,...body}},legacy)
      assert.equal(refusal.ok,false)
      assert.equal(refusal.error.kind,'runtime_not_ready')
    }
    assert.deepEqual({selections,discoveries,legacyCalls},{selections:0,discoveries:0,legacyCalls:1})
    console.log('TEST startup registry boundary qualified'); process.exit(0)
  `
  const child = Bun.spawn([process.execPath, '-e', script], {
    cwd: import.meta.dir, stdout: 'pipe', stderr: 'pipe',
  })
  const [exit, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' })
  expect(stdout.trim()).toBe('TEST startup registry boundary qualified')
}, 45_000)


test('selection cleanup refusal projects finite helper evidence without raw causes', async () => {
  const selected=import.meta.resolve('../../services/opencode/bridge/OpenCodeV2TeamBridge.ts')
  const factory=import.meta.resolve('../../services/opencode/bridge/OpenCodeRuntimeAdapterFactory.ts')
  const probe=import.meta.resolve('../../services/opencode/compatibility/OpenCodeVersionProbe.ts')
  const script=`
    import {mock} from 'bun:test'
    import assert from 'node:assert/strict'
    const {OpenCodeVersionProbeCleanupError}=await import(${JSON.stringify(probe)})
    const factory=await import(${JSON.stringify(factory)})
    const helperCause={stage:'process_lookup',category:'ArgumentException',hresult:-2147024809,nativeErrorCode:null}
    const helperFailure={operation:'birth',reason:'helper_nonzero',exitCode:1,elapsedMs:35,
      helperCause:{...helperCause,privatePath:'TEST-PRIVATE-HELPER'},privateStderr:'TEST-PRIVATE-STDERR'}
    const terminalDiagnostic={phase:'candidate_validation',guard:'candidate_unknown',closed:true,ended:true,exitCode:0,
      birthsCount:0,candidatesCount:1,pendingCount:0,lastGroupCount:1,lastSurvivorCount:null,remainingMs:7200}
    let includeHelper=true
    mock.module(${JSON.stringify(factory)},()=>({...factory,inspectOpenCodeRuntimeAdapterSelection:async()=>{
      throw new OpenCodeVersionProbeCleanupError(new Error('TEST-PRIVATE-PATH-AND-STDERR'),
        includeHelper?helperFailure:null,{...terminalDiagnostic,privatePath:'TEST-PRIVATE-TERMINAL'})
    }}))
    const {executeSelectedOpenCodeBridgeCommandEnvelope:execute}=await import(${JSON.stringify(selected)})
    let legacyCalls=0
    for(includeHelper of [true,false]) {
      const result=await execute({schemaVersion:1,requestId:'TEST-diagnostic',command:'opencode.commandStatus',
        cwd:'/TEST',startedAt:new Date().toISOString(),timeoutMs:30000,body:{originalRequestId:'absent'}},
        async()=>{legacyCalls++;throw Error('TEST legacy forbidden')})
      assert.equal(result.ok,false)
      assert.deepEqual(result.error,{kind:'runtime_not_ready',message:'cleanup_unknown',retryable:false})
      assert.deepEqual(result.diagnostics.map(event=>event.data),[...(includeHelper?[{code:'opencode_version_probe_helper_failed',evidence:'last_observed',
        operation:'birth',reason:'helper_nonzero',exitCode:1,elapsedMs:35,helperCause}]:[]),
        {code:'opencode_version_probe_cleanup_unknown',...terminalDiagnostic}])
      for(const event of result.diagnostics) {
        assert.equal(event.providerId,'opencode')
        assert.equal(event.type,event.data.code)
        assert.equal(event.severity,'error')
        assert.equal(typeof event.message,'string')
        assert(event.message.trim())
        assert(Number.isFinite(Date.parse(event.createdAt)))
      }
      assert(!JSON.stringify(result).includes('TEST-PRIVATE'))
    }
    assert.equal(legacyCalls,0)
    console.log('TEST finite cleanup refusal diagnostic qualified'); process.exit(0)
  `
  const child=Bun.spawn([process.execPath,'-e',script],{cwd:import.meta.dir,stdout:'pipe',stderr:'pipe'})
  const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()])
  expect({exit,stderr}).toEqual({exit:0,stderr:''})
  expect(stdout.trim()).toBe('TEST finite cleanup refusal diagnostic qualified')
},45000)
