import { expect, test } from 'bun:test'

async function isolated(script: string) {
  const child = Bun.spawn([process.execPath, '-e', script], { cwd: import.meta.dir, stdout: 'pipe', stderr: 'pipe' })
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' })
}
const bridge = import.meta.resolve('./OpenCodeV2TeamBridge.ts')
const factory = import.meta.resolve('./OpenCodeRuntimeAdapterFactory.ts')
const managed = import.meta.resolve('../OpenCodeManagedPaths.ts')
const prefix = `import {mock} from 'bun:test'; import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
const root=await mkdtemp(path.join(tmpdir(),'TEST-routing-'));process.env.CLAUDE_MULTIMODEL_DATA_HOME=root;
const f=await import(${JSON.stringify(factory)});let probes=0;
mock.module(${JSON.stringify(factory)},()=>({...f,inspectOpenCodeRuntimeAdapterSelection:async()=>{probes++;return {policy:{generation:'v1',version:'1.18.34'}}}}));
const {OpenCodeV2TeamBridge,executeSelectedOpenCodeBridgeCommandEnvelope:execute}=await import(${JSON.stringify(bridge)});
const envelope=(command,body)=>({schemaVersion:1,requestId:'TEST',command,cwd:root,startedAt:new Date().toISOString(),timeoutMs:1000,body});`

test('unsupported Windows architecture selects V1 without querying unavailable V2 authority', async () => {
  await isolated(`${prefix}
  try {
    Object.defineProperty(process,'platform',{value:'win32'});Object.defineProperty(process,'arch',{value:'arm64'});Object.defineProperty(process,'getuid',{value:undefined});
    let legacy=0;OpenCodeV2TeamBridge.prototype.discover=async()=>{throw Error('run_source_linux_required')};
    for(const command of ['opencode.launchTeam','opencode.sendMessage','opencode.stopTeam','opencode.observeMessageDelivery','opencode.reconcileTeam','opencode.getRuntimeTranscript']){
      const result=await execute(envelope(command,{teamId:'TEST',runId:'TEST-run'}),async()=>{legacy++;return 'V1'});assert.equal(result,'V1');
    }
    assert.equal(legacy,6);assert.equal(probes,6);
    mock.module(${JSON.stringify(factory)},()=>({...f,inspectOpenCodeRuntimeAdapterSelection:async()=>({policy:{generation:'unsupported',version:'2.0.1'}})}));
    const refused=await execute(envelope('opencode.sendMessage',{teamId:'TEST',runId:'unknown'}),async()=>{throw Error('unknown generation fallback')});assert.equal(refused.ok,false);
  } finally {await rm(root,{recursive:true,force:true})}`)
}, 15000)

// This source contract checks ordering/vetoes only. Actual native absence and
// original PID/birth recovery are exercised by windows-owner-probe.ts on x64.
test('Windows x64 discovers before V1 selection and UNKNOWN vetoes a bound handshake', async () => {
  await isolated(`${prefix}
  try {
    Object.defineProperty(process,'platform',{value:'win32'});Object.defineProperty(process,'arch',{value:'x64'});
    const order=[];let legacy=0;
    OpenCodeV2TeamBridge.prototype.discover=async()=>{order.push('discover');return null};
    mock.module(${JSON.stringify(factory)},()=>({...f,inspectOpenCodeRuntimeAdapterSelection:async()=>{order.push('select');return {policy:{generation:'v1',version:'1.19.0'}}}}));
    const input=envelope('opencode.handshake',{teamId:'TEST',expectedRunId:'TEST-fresh'});
    assert.equal(await execute(input,async()=>{order.push('V1');legacy++;return 'V1'}),'V1');
    assert.deepEqual(order,['discover','select','V1']);assert.equal(legacy,1);
    order.length=0;
    for(const code of ['run_control_selection_missing','run_state_endpoint_missing','run_state_start_changed','execution_path_alias']){
      OpenCodeV2TeamBridge.prototype.discover=async()=>{order.push('discover');throw Error(code)};
      assert.equal((await execute(input,async()=>{throw Error('UNKNOWN fallback')})).ok,false);
    }
    assert.deepEqual(order,['discover','discover','discover','discover']);assert.equal(legacy,1);
  } finally {await rm(root,{recursive:true,force:true})}`)
}, 15000)

test('retained V1 stop ownership survives current binary loss; V2 fences and unrelated runs do not fall back', async () => {
  await isolated(`${prefix}
  try {
    await mkdir(path.join(root,'opencode'));
    const record={teamId:'TEST',runId:'original',laneId:'primary',memberName:'worker',providerId:'opencode',selectedModel:'groq/TEST',projectPath:root,
      profileRootKey:'TEST-profile',hostKey:'TEST-host',opencodeSessionId:'ses_TEST',projectBehaviorFingerprint:'TEST-fingerprint',createdAt:'TEST',updatedAt:'TEST'};
    await writeFile(path.join(root,'opencode/session-store.json'),JSON.stringify({schemaVersion:1,records:{'TEST::primary::worker':record}}));
    OpenCodeV2TeamBridge.prototype.discover=async()=>null;
    mock.module(${JSON.stringify(factory)},()=>({...f,inspectOpenCodeRuntimeAdapterSelection:async()=>{probes++;throw Error('selected CLI removed')}}));
    let legacy=0;
    for(const command of ['opencode.stopTeam','opencode.stopOutcome','opencode.reconcileStop','opencode.commandStatus']){
      assert.equal(await execute(envelope(command,{teamId:'TEST',runId:'original',laneId:'primary'}),async()=>{legacy++;return 'V1'}),'V1');
    }
    assert.equal(probes,0);assert.equal(legacy,4);
    for(const requiredCommand of ['opencode.stopOutcome','opencode.reconcileStop']){
      assert.equal(await execute(envelope('opencode.handshake',{teamId:'TEST',laneId:'primary',expectedRunId:null,requiredCommand}),async()=>{legacy++;return 'V1-recovery-contract'}),'V1-recovery-contract');
    }
    assert.equal(probes,0);assert.equal(legacy,6);
    for(const [teamId,laneId,cwd] of [['foreign','primary',root],['TEST','foreign',root],['TEST','primary',path.join(root,'foreign')]]){
      assert.equal((await execute({...envelope('opencode.handshake',{teamId,laneId,expectedRunId:null,requiredCommand:'opencode.stopOutcome'}),cwd},async()=>{throw Error('unknown lane recovery handshake')})).ok,false);
    }
    assert.equal((await execute(envelope('opencode.handshake',{teamId:'TEST',laneId:'primary',expectedRunId:null,requiredCommand:'opencode.launchTeam'}),async()=>{throw Error('launch authority fallback')})).ok,false);
    for(const body of [{teamId:'TEST',runId:'foreign',laneId:'primary'},{teamId:'TEST',runId:'original',laneId:'foreign'}]){
      assert.equal((await execute(envelope('opencode.stopTeam',body),async()=>{throw Error('foreign legacy target')})).ok,false);
    }
    OpenCodeV2TeamBridge.prototype.discover=async()=>{throw Error('run_control_foreign')};
    assert.equal((await execute(envelope('opencode.stopTeam',{teamId:'TEST',runId:'original',laneId:'primary'}),async()=>{throw Error('V2 fence fallback')})).ok,false);
    OpenCodeV2TeamBridge.prototype.discover=async()=>null;
    await writeFile(path.join(root,'opencode/session-store.json'),'{invalid');
    assert.equal((await execute(envelope('opencode.stopTeam',{teamId:'TEST',runId:'original',laneId:'primary'}),async()=>{throw Error('unknown legacy fallback')})).ok,false);
  } finally {await rm(root,{recursive:true,force:true})}`)
}, 15000)


test('journal recovery selects the current generation even when a saved V1 lane exists', async () => {
 await isolated(`${prefix}
 try {
  await mkdir(path.join(root,'opencode'));
  const record={teamId:'TEST',runId:'original',laneId:'primary',memberName:'worker',providerId:'opencode',selectedModel:'groq/TEST',projectPath:root,
    profileRootKey:'TEST-profile',hostKey:'TEST-host',opencodeSessionId:'ses_TEST',projectBehaviorFingerprint:'TEST-fingerprint',createdAt:'TEST',updatedAt:'TEST'};
  await writeFile(path.join(root,'opencode/session-store.json'),JSON.stringify({schemaVersion:1,records:{'TEST::primary::worker':record}}));
  OpenCodeV2TeamBridge.prototype.discover=async()=>null;let legacy=0;
  const legacyExecutor=async()=>{legacy++;return 'V1'};
  for(const version of ['2.0.0','2.0.32']){
   mock.module(${JSON.stringify(factory)},()=>({...f,inspectOpenCodeRuntimeAdapterSelection:async()=>({policy:{generation:'v2',version}})}));
   const result=await execute(envelope('opencode.recoverDeliveryJournal',{teamId:'TEST',runId:'original',laneId:'primary'}),legacyExecutor);
   assert.equal(result.ok,true);assert.equal(result.runtime.version,version);assert.equal(legacy,0);
  }
  for(const select of [async()=>({policy:{generation:'unsupported',version:'2.0.1'}}),async()=>{throw Error('selection_unavailable')}]){
   mock.module(${JSON.stringify(factory)},()=>({...f,inspectOpenCodeRuntimeAdapterSelection:select}));
   const result=await execute(envelope('opencode.recoverDeliveryJournal',{teamId:'TEST',runId:'original',laneId:'primary'}),legacyExecutor);
   assert.equal(result.ok,false);assert.equal(legacy,0);
  }
  mock.module(${JSON.stringify(factory)},()=>({...f,inspectOpenCodeRuntimeAdapterSelection:async()=>({policy:{generation:'v1',version:'1.18.34'}})}));
  assert.equal(await execute(envelope('opencode.recoverDeliveryJournal',{teamId:'TEST',runId:'original',laneId:'primary'}),legacyExecutor),'V1');assert.equal(legacy,1);
 } finally {await rm(root,{recursive:true,force:true})}`)
},15000)
