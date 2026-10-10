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
}, 15_000)

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
    console.log('TEST startup registry boundary qualified')
  `
  const child = Bun.spawn([process.execPath, '-e', script], {
    cwd: import.meta.dir, stdout: 'pipe', stderr: 'pipe',
  })
  const [exit, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' })
  expect(stdout.trim()).toBe('TEST startup registry boundary qualified')
}, 15_000)
