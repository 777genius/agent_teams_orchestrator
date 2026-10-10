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
