import { expect, test } from 'bun:test'

test('public V2 owner handshake and group send bind the exact member before journal/native admission', async () => {
  const bridge = import.meta.resolve('./OpenCodeV2TeamBridge.ts')
  const group = import.meta.resolve('./OpenCodeV2GroupChat.ts')
  const legacy = import.meta.resolve('../OpenCodeBridgeCommandHandler.ts')
  const contracts = import.meta.resolve('../execution/OpenCodeV2ExecutionContracts.ts')
  const script = `
    import assert from 'node:assert/strict'
    const {OpenCodeV2TeamBridge,executeSelectedOpenCodeBridgeCommandEnvelope:execute}=await import(${JSON.stringify(bridge)})
    const {buildOpenCodeV2GroupProof}=await import(${JSON.stringify(group)})
    const {createBridgeServerIdentity}=await import(${JSON.stringify(legacy)})
    const {executionHash}=await import(${JSON.stringify(contracts)})
    const binding={teamId:'TEST-team',runId:'TEST-run'}
    const member={memberId:'kimi',laneId:'secondary:kimi',pin:'2.0.32',selectedModel:'kimi/model',runtimePid:123,
      state:'accepted',originalSessionId:'ses_TEST',opencodeSessionId:'ses_TEST',runtimeSessionId:'ses_TEST',
      bootstrap:{verified:true,strategy:'instruction-entry',missingNativeMessageID:true},
      controllerTools:{server:'agent-teams',nativeNames:['agent-teams_group_chat_list','agent-teams_group_chat_send'],schemasHash:'a'.repeat(64)}}
    const tools={...member.controllerTools,tools:[{name:'group_chat_list'},{name:'group_chat_send'}]}
    const proof=buildOpenCodeV2GroupProof(binding,member,tools)
    const status={kind:'status',state:'active',deadline:Date.now()+60000,members:[member],
      qualification:{capabilitySnapshotId:'TEST-cap',expectedBehaviorFingerprint:'a'.repeat(64),binaryPath:'/TEST',binaryFingerprint:'TEST',version:'2.0.32'}}
    let sends=0,proofs=0,wrongProof=false,missingTools=false
    OpenCodeV2TeamBridge.prototype.discover=async()=>({})
    OpenCodeV2TeamBridge.prototype.call=async request=>request.operation==='groupProof'
      ? (proofs++,{kind:'groupProof',proof:missingTools?null:wrongProof?{...proof,runtimePid:999}:proof}):status
    OpenCodeV2TeamBridge.prototype.send=async(request)=>{sends++;assert.equal(request.intent.group.groupRunKey,'TEST-run');assert.match(request.intent.input.text,/queued GROUP CHAT message/);return{delivered:true}}
    const client=createBridgeServerIdentity(null);client.peer='claude_team'
    const body={...binding,teamName:'TEST-team',laneId:'secondary:kimi',memberName:'kimi',runtimeSessionId:'ses_TEST',client,
      requiredCommand:'opencode.sendMessage',expectedRunId:'TEST-run',expectedCapabilitySnapshotId:'TEST-cap',
      messageId:'22222222-2222-4222-8222-222222222222:g:12345678',deliveryAttemptId:'TEST-attempt',text:'TEST group text',
      groupChatId:'11111111-1111-4111-8111-111111111111',groupMessageId:'22222222-2222-4222-8222-222222222222',
      groupRunKey:'TEST-run',groupChatProtocolVersion:1,from:'user',timestamp:new Date().toISOString()}
    const run=async(command,changes={})=>execute({schemaVersion:1,requestId:'TEST-request',command,cwd:'/TEST',
      timeoutMs:8000,startedAt:new Date().toISOString(),body:{...body,...changes}},async()=>{throw Error('V1 forbidden')})
    const handshake=await run('opencode.handshake');assert.equal(handshake.ok,true)
    assert.equal(handshake.data.server.bridgeProtocol.groupChatProtocolVersion,1)
    assert.deepEqual(handshake.data.server.runtime.groupChatRunProof,proof)
    const {identityHash,...unsigned}=handshake.data;assert.equal(identityHash,executionHash(unsigned))
    for(const changes of [{from:undefined},{groupRunKey:'wrong'},{laneId:'wrong'},{runtimeSessionId:'ses_wrong'},{memberName:'other'}]){
      const result=await run('opencode.sendMessage',changes);assert.equal(result.ok,false);assert.equal(sends,0)
    }
    wrongProof=true;assert.equal((await run('opencode.sendMessage')).ok,false);assert.equal(sends,0)
    wrongProof=false;missingTools=true
    const dmHandshake=await run('opencode.handshake');assert.equal(dmHandshake.ok,true)
    assert.equal(dmHandshake.data.server.bridgeProtocol.groupChatProtocolVersion,undefined)
    assert.equal(dmHandshake.data.server.runtime.groupChatRunProof,undefined)
    assert.equal((await run('opencode.sendMessage')).ok,false);assert.equal(sends,0)
    missingTools=false;assert.equal((await run('opencode.sendMessage')).ok,true);assert.equal(sends,1);assert.ok(proofs>=2)
    status.state='stopped'
    const cleanupHandshake=await run('opencode.handshake');assert.equal(cleanupHandshake.ok,true)
    assert.equal(cleanupHandshake.data.server.bridgeProtocol.groupChatProtocolVersion,undefined)
    assert.equal(cleanupHandshake.data.server.runtime.groupChatRunProof,undefined)
    assert.equal((await run('opencode.sendMessage')).ok,false);assert.equal(sends,1)
    console.log('TEST V2 group boundary PASS')
  `
  const child = Bun.spawn([process.execPath, '--eval', script], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
  expect(stdout).toContain('TEST V2 group boundary PASS')
}, 30_000)
