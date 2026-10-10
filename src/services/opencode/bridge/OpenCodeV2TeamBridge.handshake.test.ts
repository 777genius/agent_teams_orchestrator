import {expect,test} from 'bun:test'

test('fresh and original-owner handshakes bind all returned fields in the identity hash',async()=>{
 const target=import.meta.resolve('./OpenCodeV2TeamBridge.ts')
 const factory=import.meta.resolve('./OpenCodeRuntimeAdapterFactory.ts')
 const plan=import.meta.resolve('./OpenCodeV2LaunchPlan.ts')
 const probe=import.meta.resolve('./OpenCodeV2ExecutionProbe.ts')
 const legacy=import.meta.resolve('../OpenCodeBridgeCommandHandler.ts')
 const contracts=import.meta.resolve('../execution/OpenCodeV2ExecutionContracts.ts')
 const script=`
  import {mock} from 'bun:test';import assert from 'node:assert/strict'
  const factory=await import(${JSON.stringify(factory)})
  mock.module(${JSON.stringify(factory)},()=>({...factory,inspectOpenCodeRuntimeAdapterSelection:async()=>({policy:{generation:'v2',version:'2.0.0'}})}))
  const plan=await import(${JSON.stringify(plan)})
  mock.module(${JSON.stringify(plan)},()=>({...plan,inspectOpenCodeV2SourceAvailability:async()=>({
   native:{version:'2.0.0',executablePath:'/TEST/native'},model:{providerID:'groq',id:'c41-upstream'},
   capabilitySnapshotId:'TEST-capability',installedGraphSHA256:'a'.repeat(64),installedGraphFiles:1,
  })}))
  const proof={capabilitySnapshotId:'TEST-capability',binaryPath:'/TEST/native',binaryFingerprint:'TEST-binary',
   opencodeVersion:'2.0.0',expectedBehaviorEvidence:{expectedBehaviorFingerprint:'b'.repeat(64)}}
  const probe=await import(${JSON.stringify(probe)})
  mock.module(${JSON.stringify(probe)},()=>({...probe,resolveOpenCodeV2ExecutionProbe:async()=>({proof,reason:null})}))
  const {createBridgeServerIdentity}=await import(${JSON.stringify(legacy)})
  const {executionHash}=await import(${JSON.stringify(contracts)})
  const {OpenCodeV2TeamBridge,executeSelectedOpenCodeBridgeCommandEnvelope:execute}=await import(${JSON.stringify(target)})
  const client=createBridgeServerIdentity(null);client.peer='claude_team'
  let originalOwner=false
  OpenCodeV2TeamBridge.prototype.discover=async()=>originalOwner?{}:null
  OpenCodeV2TeamBridge.prototype.call=async()=>({kind:'status',state:'active',deadline:Date.now()+10_000,
   qualification:{capabilitySnapshotId:'TEST-capability',expectedBehaviorFingerprint:'b'.repeat(64),
    binaryPath:'/TEST/native',binaryFingerprint:'TEST-binary',version:'2.0.0'},
   members:[{pin:'2.0.0',state:'accepted',selectedModel:'groq/c41-upstream',originalSessionId:'ses_TEST',
    opencodeSessionId:'ses_TEST',runtimeSessionId:'ses_TEST',bootstrap:{verified:true,strategy:'instruction-entry',missingNativeMessageID:true},
    controllerTools:{server:'agent-teams',nativeNames:['message_send'],schemasHash:'a'.repeat(64)}}]})
  let productChecks=0
  for(const owned of [false,true]){
   originalOwner=owned
   const response=await execute({schemaVersion:1,requestId:'TEST-handshake',command:'opencode.handshake',cwd:'/TEST',
    startedAt:new Date().toISOString(),timeoutMs:8000,body:{client,selectedModel:'groq/c41-upstream',...(owned?{teamId:'TEST',runId:'TEST-run'}:{})}},
    async()=>{throw Error('V1 fallback forbidden')})
   assert.equal(response.ok,true);const handshake=response.data
   if(process.env.TEST_PRODUCT_HANDSHAKE_CONTRACT){
    const {validateOpenCodeBridgeHandshake:validate}=await import(process.env.TEST_PRODUCT_HANDSHAKE_CONTRACT)
    const input={handshake,expectedClient:client,requiredCommand:'opencode.launchTeam',expectedCapabilitySnapshotId:'TEST-capability',expectedManifestHighWatermark:null,expectedRunId:owned?'TEST-run':null}
    assert.deepEqual(validate(input),{ok:true})
    assert.equal(validate({...input,handshake:{...handshake,expectedBehaviorFingerprint:'c'.repeat(64)}}).ok,false)
    productChecks++
   }
   const {identityHash,...unsigned}=handshake
   assert.equal(identityHash,executionHash(unsigned))
   assert.notEqual(identityHash,executionHash({...unsigned,sourceCapabilities:{...unsigned.sourceCapabilities,teamLaunch:!unsigned.sourceCapabilities.teamLaunch}}))
  }
  console.log(JSON.stringify({branches:2,productChecks}))
 `
 const child=Bun.spawn([process.execPath,'-e',script],{cwd:import.meta.dir,stdout:'pipe',stderr:'pipe'})
 const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()])
 expect({exit,stderr}).toEqual({exit:0,stderr:''})
 expect(JSON.parse(stdout)).toEqual({branches:2,productChecks:process.env.TEST_PRODUCT_HANDSHAKE_CONTRACT?2:0})
},15_000)
