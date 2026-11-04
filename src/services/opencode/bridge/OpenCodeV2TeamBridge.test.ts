import { resolveOpenCodeV2RunBinding } from './OpenCodeV2TeamBridge.js'
import { describe, expect, test, spyOn } from 'bun:test'
import { OpenCodeV2TeamBridge, createV2ProtocolQueueIntent, projectV2DeliveryObservation,
  type OpenCodeV2RunControlPorts } from './OpenCodeV2TeamBridge.js'
import type { BridgeEnvelope } from './OpenCodeBridgeProtocol.js'
import type { RunControlRecord, RunControlResult } from './OpenCodeV2RunTypes.js'
import type { OpenCodeV2TurnProjection } from './OpenCodeV2TurnProjection.js'

const record: RunControlRecord = {
  schema: 1, protocol: 1, binding: { teamId: 'TEST', runId: 'run', controllerInstanceId: 'controller', ownerId: 'owner' },
  process: { pid: 123, startTicks: '123', bootId: 'boot', executablePath: '/synthetic/bun', executableSha256: 'a'.repeat(64) },
  directory: '/synthetic', socketPath: '/synthetic/control.sock', socketDevice: 1, socketInode: 2,
  deadline: Date.now() + 10000, uid: 1000, sourceSha256: 'b'.repeat(64),
}
const envelope: BridgeEnvelope = { schemaVersion: 1, requestId: 'request', command: 'opencode.sendMessage',
  cwd: '/TEST', startedAt: '2026-10-09T00:00:00Z', timeoutMs: 1000,
  body: { teamId: 'TEST', runId: 'run', laneId: 'primary', memberName: 'worker', text: 'hello',
    messageId: 'inbound', deliveryAttemptId: 'attempt' } }
const terminal: OpenCodeV2TurnProjection = { state: 'succeeded', reason: 'native terminal', assistantMessageIds: ['assistant'],
  text: '', toolEffects: [], visibleReplies: [] }

function ports(found: RunControlRecord | null, result: RunControlResult, counts: { launched: number; requested: number }): OpenCodeV2RunControlPorts {
  return { discover: async () => found,
    request: async () => { counts.requested++; return result },
    launch: async () => { counts.launched++; throw new Error('replacement launch forbidden') } }
}

describe('V2 semantic control adapter', () => {
  test('missing owner cannot launch during observation or stop', async () => {
    const counts = { launched: 0, requested: 0 }
    const bridge = new OpenCodeV2TeamBridge('/TEST', { teamId: 'TEST', runId: 'run' }, ports(null,
      { kind: 'status', state: 'cleanup_unknown', members: [], deadline: record.deadline }, counts))
    await expect(bridge.call({ operation: 'stop' }, 1000)).rejects.toThrow('run_owner_unknown')
    await expect(bridge.call({ operation: 'status' }, 1000)).rejects.toThrow('run_owner_unknown')
    expect(counts).toEqual({ launched: 0, requested: 0 })
  })
  test('foreign run record cannot acquire control authority', async () => {
    const counts = { launched: 0, requested: 0 }
    const bridge = new OpenCodeV2TeamBridge('/TEST', { teamId: 'TEST', runId: 'different-run' }, ports(record,
      { kind: 'status', state: 'active', members: [], deadline: record.deadline }, counts))
    await expect(bridge.call({ operation: 'stop' }, 1000)).rejects.toThrow('run_owner_unknown')
    expect(counts.requested).toBe(0)
  })
  test('expired run retains a bounded stop budget rather than a one millisecond native budget', async () => {
    const expired = { ...record, deadline: Date.now() - 1000 }
    const budgets: number[] = []
    const bridge = new OpenCodeV2TeamBridge('/TEST', record.binding, {
      discover: async () => expired,
      launch: async () => { throw new Error('replacement forbidden') },
      request: async (_record, request, timeout) => {
        expect(timeout).toBeDefined()
        if (timeout === undefined) throw new Error('missing control deadline')
        budgets.push(timeout)
        expect(request.operation).toBe('stop')
        return { kind: 'stop', state: 'cleanup_unknown', members: [] }
      },
    })
    const now = spyOn(Date, 'now').mockReturnValue(Date.now())
    try {
      await bridge.call({ operation: 'stop' }, 5000)
      expect(budgets).toEqual([5000])
    } finally { now.mockRestore() }
  })
  for (const operation of ['send', 'stop'] as const) for (const timeoutMs of [1000, 500]) test(`${operation} preserves the caller ${timeoutMs}ms deadline across owner discovery`, async () => {
    let clock = 1000, requests = 0
    const budgets: number[] = []
    const now = spyOn(Date, 'now').mockImplementation(() => clock)
    const bridge = new OpenCodeV2TeamBridge('/TEST', record.binding, {
      discover: async () => { clock += 600; return record },
      launch: async () => { throw new Error('replacement forbidden') },
      request: async (_record, _request, budget) => {
        requests++; budgets.push(budget!)
        return { kind: 'status', state: 'active', members: [], deadline: record.deadline }
      },
    })
    const request = operation === 'stop' ? { operation } : { operation, memberId: 'worker', originalSessionId: 'ses_original',
      intent: createV2ProtocolQueueIntent(envelope) }
    try {
      if (timeoutMs > 600) {
        await bridge.call(request, timeoutMs)
        expect(budgets).toEqual([400])
      } else {
        await expect(bridge.call(request, timeoutMs)).rejects.toThrow('operation_timeout')
        expect(requests).toBe(0)
      }
    } finally { now.mockRestore() }
  })
  test('changed original session and stopped run cannot obtain send target', async () => {
    const counts = { launched: 0, requested: 0 }
    const active: RunControlResult = { kind: 'status', state: 'active', qualification: { capabilitySnapshotId: 'TEST-original', expectedBehaviorFingerprint: 'a'.repeat(64), binaryPath: '/TEST/native', binaryFingerprint: 'b'.repeat(64), version: '2.0.32' }, deadline: record.deadline,
      members: [{ memberId: 'worker', laneId: 'primary', originalSessionId: 'ses_original', selectedModel: 'test/model',
        opencodeSessionId: 'ses_original', runtimeSessionId: 'ses_original', profileEpoch: 'TEST', profileRoot: '/TEST', pin: '2.0.32',
        state: 'accepted', bootstrap: null }] }
    const bridge = new OpenCodeV2TeamBridge('/TEST', { teamId: 'TEST', runId: 'run' }, ports(record, active, counts))
    await expect(bridge.resolveMember('worker', 'primary', 'ses_changed', 1000)).rejects.toThrow('original_session_changed')
    const stopped = new OpenCodeV2TeamBridge('/TEST', { teamId: 'TEST', runId: 'run' }, ports(record,
      { ...active, state: 'stopped' }, counts))
    await expect(stopped.resolveMember('worker', 'primary', null, 1000)).rejects.toThrow('run_stopped_or_unknown')
    expect(counts.launched).toBe(0)
  })
  test('same delivery keeps original native input identity; noReply cannot imitate silent context', () => {
    const first = createV2ProtocolQueueIntent(envelope)
    expect(createV2ProtocolQueueIntent(envelope).identity).toEqual(first.identity)
    expect(createV2ProtocolQueueIntent({ ...envelope, body: { ...envelope.body, text: 'changed' } }).identity.nativeInputID)
      .toBe(first.identity.nativeInputID)
    expect(() => createV2ProtocolQueueIntent({ ...envelope, body: { ...envelope.body, noReply: true } }))
      .toThrow('unsupported_v1_input')
  })
  test('public attachments preserve V1 validation and native URI identity', () => {
    const uri = 'data:image/png;base64,YQ=='
    expect(createV2ProtocolQueueIntent({ ...envelope, body: { ...envelope.body, fileParts: [
      { type: 'file', mime: 'image/png', url: uri, filename: 'image.png' },
    ] } }).input.files).toEqual([{ uri, name: 'image.png' }])
    expect(() => createV2ProtocolQueueIntent({ ...envelope, body: { ...envelope.body, fileParts: [
      { type: 'file', mime: 'image/png', url: 'file:///foreign', filename: 'image.png' },
    ] } })).toThrow('matching data URL')
  })
  test('taskdone and foreign MCP lineage cannot become a visible DM', () => {
    const task: OpenCodeV2TurnProjection = { ...terminal, toolEffects: [{ assistantMessageId: 'assistant', toolCallId: 'task',
      toolName: 'agent-teams_task_done', kind: 'task', input: {}, content: [], result: { accepted: true } }] }
    expect(projectV2DeliveryObservation(task, 'msg_original', 'inbound').state).toBe('responded_non_visible_tool')
    const foreign: OpenCodeV2TurnProjection = { ...terminal, visibleReplies: [{ nativeInputId: 'msg_foreign',
      assistantMessageId: 'assistant', toolCallId: 'foreign', toolName: 'agent-teams_message_send',
      inboundMessageId: 'inbound', visibleReplyMessageId: 'reply' }] }
    expect(projectV2DeliveryObservation(foreign, 'msg_original', 'inbound').visibleReplyMessageId).toBeNull()
    expect(projectV2DeliveryObservation({ ...foreign, state: 'pending' }, 'msg_foreign', 'inbound').visibleReplyMessageId).toBeNull()
  })
})

// Public protocol1 existing-owner identity, with no native selection or effects.
test('expectedRunId routes only the original owner and contradictory run IDs fail closed', () => {
  expect(resolveOpenCodeV2RunBinding({ teamId: 'TEST', expectedRunId: 'original' })).toEqual({ teamId: 'TEST', runId: 'original' })
  expect(resolveOpenCodeV2RunBinding({ teamId: 'TEST' })).toBeNull()
  expect(() => resolveOpenCodeV2RunBinding({ teamId: 'TEST', runId: 'replacement', expectedRunId: 'original' })).toThrow('run_identity_conflict')
})

describe('bounded original-owner status recovery', () => {
  test('transient status failures retain the same record and never retry stop', async () => {
    let discovered=0,requested=0,launched=0; const budgets:number[]=[];
    const status:RunControlResult={kind:'status',state:'active',members:[],deadline:record.deadline};
    const bridge=new OpenCodeV2TeamBridge('/TEST',record.binding,{
      discover:async()=>{discovered++;return record},launch:async()=>{launched++;throw Error('TEST forbidden')},
      request:async(original,request,timeout)=>{expect(original).toBe(record);expect(request.operation).toBe('status');budgets.push(timeout!);requested++;if(requested<=2)throw Error(requested===1?'run_control_timeout':'run_control_disconnected');return status},
    });
    expect(await bridge.call({operation:'status'},1000)).toBe(status);
    expect({discovered,requested,launched}).toEqual({discovered:1,requested:3,launched:0});
    expect(budgets.every((v,i)=>v>0&&v<=1000&&(i===0||v<=budgets[i-1]!))).toBe(true);
    let stopped=0;const stop=new OpenCodeV2TeamBridge('/TEST',record.binding,{discover:async()=>record,launch:async()=>{throw Error('TEST forbidden')},request:async()=>{stopped++;throw Error('run_control_timeout')}});
    await expect(stop.call({operation:'stop'},1000)).rejects.toThrow('run_control_timeout');expect(stopped).toBe(1);
  });
  test('identity and framing failures reject immediately; persistent transport loss respects absolute expiry',async()=>{
    for(const code of ['run_control_changed','run_control_foreign','run_control_invalid','run_process_changed','TEST secret run_control_timeout']){
      let count=0;const bridge=new OpenCodeV2TeamBridge('/TEST',record.binding,{discover:async()=>record,launch:async()=>{throw Error('TEST forbidden')},request:async()=>{count++;throw Error(code)}});
      await expect(bridge.call({operation:'status'},1000)).rejects.toThrow(code);expect(count).toBe(1);
    }
    let clock=1000,count=0;const now=spyOn(Date,'now').mockImplementation(()=>clock);
    try{
      const bridge=new OpenCodeV2TeamBridge('/TEST',record.binding,{discover:async()=>{clock+=100;return record},launch:async()=>{throw Error('TEST forbidden')},request:async(_record,_request,budget)=>{expect(budget).toBeLessThanOrEqual(1900);count++;clock+=1000;throw Error('run_control_timeout')}});
      await expect(bridge.call({operation:'status'},2000)).rejects.toThrow('run_control_timeout');expect(count).toBe(2);expect(clock).toBe(3100);
    }finally{now.mockRestore()}
  });
  test('public reconcile projects its single authenticated original status inside the caller cap',async()=>{
    const target=import.meta.resolve('./OpenCodeV2TeamBridge.ts');
    const script=`import assert from 'node:assert/strict';const {OpenCodeV2TeamBridge,executeSelectedOpenCodeBridgeCommandEnvelope:execute}=await import(${JSON.stringify(target)});let calls=0;OpenCodeV2TeamBridge.prototype.discover=async()=>({});OpenCodeV2TeamBridge.prototype.call=async(request,budget)=>{assert.equal(request.operation,'status');assert(budget>0&&budget<=1000);calls++;return {kind:'status',state:'starting',deadline:Date.now()+10000,members:[{memberId:'worker',originalSessionId:'ses_TEST',selectedModel:'TEST/model',pin:'2.0.0',state:'unknown',bootstrap:null}]}};const result=await execute({schemaVersion:1,requestId:'TEST-status',command:'opencode.reconcileTeam',cwd:'/TEST',startedAt:new Date().toISOString(),timeoutMs:1000,body:{teamId:'TEST',runId:'run'}},async()=>{throw Error('TEST V1 forbidden')});assert.equal(result.ok,true);assert.equal(result.data.members.worker.sessionId,'ses_TEST');assert.equal(result.data.members.worker.launchState,'created');assert.equal(calls,1);let clock=1000;Date.now=()=>clock;OpenCodeV2TeamBridge.prototype.call=async()=>({kind:'status',state:'starting',deadline:10000,get qualification(){clock=2001;return undefined},members:[]});const expired=await execute({schemaVersion:1,requestId:'TEST-expired',command:'opencode.reconcileTeam',cwd:'/TEST',startedAt:new Date().toISOString(),timeoutMs:1000,body:{teamId:'TEST',runId:'run'}},async()=>{throw Error('TEST V1 forbidden')});assert.equal(expired.ok,false);assert.equal(expired.error.message,'operation_timeout');console.log('TEST single original status qualified');`;
    const child=Bun.spawn([process.execPath,'-e',script],{cwd:import.meta.dir,stdout:'pipe',stderr:'pipe'});
    const [exit,stderr]=await Promise.all([child.exited,new Response(child.stderr).text()]);expect({exit,stderr}).toEqual({exit:0,stderr:''});
  },15000);
});

test('V2 certifies only a successful full non-response without tools or mixed assistant output', () => {
  const turn = { ...terminal, observedToolCallCount: 0, successfulCatalogToolCallCount: 0, text: '[[AGENT_TEAMS_NO_REPLY]]' }
  const observe = (value: OpenCodeV2TurnProjection) => projectV2DeliveryObservation(value, 'native', 'physical')
  expect(observe(turn).reason).toBe('assistant_child_completed_with_non_response_text')
  for (const value of [
    { ...turn, state: 'pending' as const }, { ...turn, state: 'failed' as const },
    { ...turn, text: 'No reply needed; result is 42.' },
    { ...turn, text: 'No reply needed' + ' '.repeat(500) + ' result is 42.' },
    { ...turn, assistantMessageIds: [] },
    { ...turn, observedToolCallCount: 1 }, { ...turn, observedToolCallCount: undefined },
    { ...turn, toolEffects: [{ assistantMessageId: 'assistant', toolCallId: 'tool', toolName: 'read', kind: 'other' as const, input: {}, content: [], result: null }] },
  ]) expect(observe(value).reason).not.toBe('assistant_child_completed_with_non_response_text')
})
