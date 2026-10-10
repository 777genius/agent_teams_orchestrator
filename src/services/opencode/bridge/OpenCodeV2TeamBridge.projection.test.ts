import {expect,test} from 'bun:test'

test('original-owner reconcile maps pending, confirmed, and terminal failure for Product',async()=>{
 const target=import.meta.resolve('./OpenCodeV2TeamBridge.ts')
 const factory=import.meta.resolve('./OpenCodeRuntimeAdapterFactory.ts')
 const script=`
  import {mock} from 'bun:test';import assert from 'node:assert/strict'
  const factory=await import(${JSON.stringify(factory)})
  mock.module(${JSON.stringify(factory)},()=>({...factory,inspectOpenCodeRuntimeAdapterSelection:async()=>({policy:{generation:'v2',version:'2.0.0'}})}))
  const {OpenCodeV2TeamBridge,executeSelectedOpenCodeBridgeCommandEnvelope:execute}=await import(${JSON.stringify(target)})
  let current
  OpenCodeV2TeamBridge.prototype.discover=async()=>({})
  OpenCodeV2TeamBridge.prototype.call=async(request)=>{assert.equal(request.operation,'status');return current}
  const base={kind:'status',deadline:Date.now()+60_000,qualification:{capabilitySnapshotId:'TEST-capability',
   expectedBehaviorFingerprint:'b'.repeat(64),binaryPath:'/TEST/native',binaryFingerprint:'TEST-binary',version:'2.0.0'}}
  const member={memberId:'worker',laneId:'primary',pin:'2.0.0',selectedModel:'groq/c41-upstream',
   originalSessionId:'ses_TEST',opencodeSessionId:'ses_TEST',runtimeSessionId:'ses_TEST'}
  let productChecks=0
  for(const [state,qualified,expectedMember,expectedProduct] of [
   ['starting',false,'created','partial_pending'],
   ['active',true,'confirmed_alive','clean_success'],
   ['cleanup_unknown',false,'failed','partial_failure'],
  ]){
   current={...base,state,members:[{...member,state:qualified?'accepted':'unknown',...(qualified?{
    bootstrap:{verified:true,strategy:'instruction-entry',missingNativeMessageID:true},
    controllerTools:{server:'agent-teams',nativeNames:['message_send'],schemasHash:'a'.repeat(64)}}:{})}]}
   const response=await execute({schemaVersion:1,requestId:'TEST-reconcile',command:'opencode.reconcileTeam',cwd:'/TEST',
    startedAt:new Date().toISOString(),timeoutMs:8000,body:{teamId:'TEST',runId:'TEST-run',laneId:'primary'}},
    async()=>{throw Error('V1 fallback forbidden')})
   assert.equal(response.ok,true)
   const projection=response.data
   assert.equal(projection.runId,'TEST-run')
   if(process.env.TEST_PRODUCT_RUNTIME_ADAPTER){
    const {OpenCodeTeamRuntimeAdapter}=await import(process.env.TEST_PRODUCT_RUNTIME_ADAPTER)
    const adapter=new OpenCodeTeamRuntimeAdapter({
     checkOpenCodeTeamLaunchReadiness:async()=>{throw Error('Unexpected readiness/probe')},
     reconcileOpenCodeTeam:async input=>{
      assert.equal(input.runId,'TEST-run');assert.equal(input.teamName,'TEST')
      return projection
     },
    })
    const mapped=await adapter.reconcile({runId:'TEST-run',teamName:'TEST',laneId:'primary',
     expectedMembers:[{name:'worker',role:'worker',workflow:'Implement TEST task',cwd:'/TEST',providerId:'opencode',model:'groq/c41-upstream'}],
     previousLaunchState:null,reason:'TEST'})
    assert.equal(mapped.teamLaunchState,expectedProduct)
    assert.equal(mapped.launchPhase,state==='starting'?'active':'finished')
    productChecks++
   }
   assert.equal(projection.teamLaunchState,state==='cleanup_unknown'?'failed':'launching')
   assert.equal(projection.members.worker.sessionId,'ses_TEST')
   assert.equal(projection.members.worker.launchState,expectedMember)
   assert.deepEqual(projection.durableCheckpoints,[])
  }
  console.log(JSON.stringify({states:3,productChecks}))
 `
 const child=Bun.spawn([process.execPath,'-e',script],{cwd:import.meta.dir,stdout:'pipe',stderr:'pipe'})
 const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()])
 expect({exit,stderr}).toEqual({exit:0,stderr:''})
 expect(JSON.parse(stdout)).toEqual({states:3,productChecks:process.env.TEST_PRODUCT_RUNTIME_ADAPTER?3:0})
},15_000)
