import {readOpenCodeAuthority,isKnownHostRegistry} from './OpenCodeAuthorityStoreRead.js'
import {stopRequestKey} from './OpenCodeStopRecovery.js'
import { test, expect } from 'bun:test'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import * as lockfile from '../../utils/lockfile.js'
import { OpenCodeSessionStore } from './OpenCodeSessionStore.js'
import { OpenCodeHostManager } from './OpenCodeHostManager.js'
import { OpenCodeSessionBridge } from './OpenCodeSessionBridge.js'
const record = (root:string) => ({teamId:'TEST-team',laneId:'primary',memberName:'TEST-member',providerId:'opencode' as const,
 selectedModel:'openai/TEST-model',projectPath:root,profileRootKey:'TEST-profile',hostKey:'TEST-host',resolvedBehaviorFingerprint:null,
 opencodeSessionId:'TEST-old-session',lastCanonicalCursor:null,lastKnownRawStatus:null,lastKnownDurableState:null,
 sourceAuthFingerprint:null,managedAuthFingerprint:null,projectBehaviorFingerprint:'TEST-behavior',staleReason:null,
 createdAt:'2026-10-01T00:00:00.000Z',updatedAt:'2026-10-01T00:00:00.000Z'})
test('replacement V1 session clears omitted recognized fields instead of inheriting old generation evidence',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'TEST-O1a-review-replace-'))
 try {
  const file=path.join(root,'TEST-session.json');const store=new OpenCodeSessionStore(file)
  const old={...record(root),selectedVariant:'TEST-old-variant',runId:'TEST-old-run',
   appManagedBootstrap:{schemaVersion:1 as const,messageID:'TEST-old-message',contextHash:'TEST-context',briefingHash:'TEST-briefing',injectionVerifiedAt:'2026-10-01T00:00:00.000Z'}}
  await store.upsert(old)
  const next={...record(root),opencodeSessionId:'TEST-new-session',updatedAt:'2026-10-02T00:00:00.000Z'}
  await store.upsert(next)
  const actual=await store.get('TEST-team','primary','TEST-member')
  console.info('TEST-replacement-receipt',JSON.stringify({next,actual}))
  expect(actual).toEqual(next)
 } finally {await rm(root,{recursive:true,force:true})}
})
for (const vetoAt of ['commit', 'winner-read']) test(`typed session authority veto at ${vetoAt} preserves the known-created session host lease`,async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'TEST-O1a-review-veto-'))
 try {
  const file=path.join(root,'TEST-session.json'),registry=path.join(root,'TEST-host.json')
  const unknown='{"schemaVersion":42,"records":{},"opaque":{"claim":"TEST-other-generation"}}\n'
  const peerLease={leaseKey:'TEST-peer::primary::TEST-peer',teamId:'TEST-peer',laneId:'primary',memberName:'TEST-peer',runId:'TEST-peer-run',sessionId:'TEST-peer-session',createdAt:'2026-10-01',updatedAt:'2026-10-01',opaque:{pin:'TEST-reference'}}
  const h={hostKey:'TEST-host',profileRootKey:'TEST-profile',projectPath:root,projectBehaviorFingerprint:'TEST-behavior',managedConfigFingerprint:'TEST-config',
   baseUrl:'http://127.0.0.1:9911',port:9911,pid:99001,processStartedAtMs:123,version:null,resolvedConfigFingerprint:null,updatedAt:'2026-10-01',leases:{[peerLease.leaseKey]:peerLease}}
  await writeFile(registry,JSON.stringify({schemaVersion:1,processIdentityFormat:'platform-native-v2',hosts:{'TEST-host':h},opaque:{pin:'TEST-peer'}}))
  let lockAcquisitions=0
  const publishUnknown=async()=>{
   const release=await lockfile.lock(file+'.lock')
   try{await writeFile(file,unknown)}finally{await release()}
  }
  const store=new OpenCodeSessionStore(file,{isProcessAlive:()=>false,readProcessStartTimeMs:async()=>null,
   lock:async(...args)=>{
    lockAcquisitions++
    if(vetoAt==='winner-read' && (lockAcquisitions===2 || lockAcquisitions===3)){
     if(lockAcquisitions===3) await publishUnknown()
     throw new Error('TEST known lock acquisition failure')
    }
    return await lockfile.lock(...args)
   }})
  const manager=new OpenCodeHostManager({persistentRegistryPath:registry,processAttributionDirectory:null,
   fetchJson:async()=>{throw Error('forbidden fetch')},killProcess:()=>{throw Error('forbidden kill')}})
  const profile={projectPath:root,canonicalProjectPath:root,workingDirectoryPath:root,scopeToken:null,profileRootKey:'TEST-profile',profileRootPath:root,
   projectBehaviorFingerprint:'TEST-behavior',behaviorSources:[],managedConfig:{},managedConfigFingerprint:'TEST-config',homePath:root,tmpPath:root,
   xdgConfigHome:root,xdgDataHome:root,xdgCacheHome:root,managedAuthPath:path.join(root,'TEST-unused-auth'),sourceAuthPath:null,
   sourceAuthFingerprint:null,managedAuthFingerprint:null,authState:'missing' as const,env:{}}
  const host={...h,profile,state:'healthy' as const,diagnostics:[]}
  let retainedSnapshot:any;let caught:any;let createCalls=0
  const retain=manager.retainHostLease.bind(manager)
  manager.retainHostLease=async (...args)=>{await retain(...args);retainedSnapshot=JSON.parse(await readFile(registry,'utf8'))}
  const bridge=new OpenCodeSessionBridge({sessionStore:store,hostManager:manager,clientFactory:{create:()=>({createSession:async()=>{
   createCalls++
   if(vetoAt==='commit') await publishUnknown()
   return {id:'TEST-created-session'}
  }})} as any})
  try {await bridge.materializeSessionOnHost({teamId:'TEST-team',laneId:'primary',memberName:'TEST-member',runId:'TEST-run',selectedModel:'openai/TEST-model',
   host,expectedBehaviorFingerprint:'TEST-behavior',expectedBootstrapForSession:()=>({messageID:'TEST-msg',contextHash:'TEST-context',briefingHash:'TEST-briefing',agent:'build'}),
   signal:new AbortController().signal,remainingMs:()=>10000})}catch(e){caught=e}
  const after=JSON.parse(await readFile(registry,'utf8'));const key='TEST-team::primary::TEST-member'
  console.info('TEST-swallowed-veto-receipt',JSON.stringify({error:caught?.name,retained:retainedSnapshot?.hosts['TEST-host'].leases[key],after:after.hosts['TEST-host'].leases[key]??null,sessionPreserved:await readFile(file,'utf8')===unknown,peer:after.hosts['TEST-host'].leases[peerLease.leaseKey]}))
  expect(await readFile(file,'utf8')).toBe(unknown)
  expect(after.hosts['TEST-host'].leases[peerLease.leaseKey]).toEqual(peerLease)
  expect(retainedSnapshot.hosts['TEST-host'].leases[key]).toBeDefined()
  expect(after.hosts['TEST-host'].leases[key]).toEqual(retainedSnapshot.hosts['TEST-host'].leases[key])
  expect(after).toEqual(retainedSnapshot)
  expect(caught).toMatchObject({name:'OpenCodeAuthorityVetoError',kind:'preserved_unknown'})
  await expect(bridge.materializeSessionOnHost({teamId:'TEST-team',laneId:'primary',memberName:'TEST-member',runId:'TEST-run',selectedModel:'openai/TEST-model',
   host,expectedBehaviorFingerprint:'TEST-behavior',expectedBootstrapForSession:()=>({messageID:'TEST-msg',contextHash:'TEST-context',briefingHash:'TEST-briefing',agent:'build'}),
   signal:new AbortController().signal,remainingMs:()=>10000})).rejects.toMatchObject({name:'OpenCodeAuthorityVetoError'})
  expect(createCalls).toBe(1)
  expect(JSON.parse(await readFile(registry,'utf8'))).toEqual(retainedSnapshot)
 }finally{await rm(root,{recursive:true,force:true})}
})

for (const index of ['__proto__', 'constructor', 'toString']) test(`retains own ${index} lease through public reconciliation without native cleanup`,async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'TEST-O1a-review-key-'))
 try {
  const file=path.join(root,'TEST-host.json');const lease={leaseKey:index,teamId:'TEST-peer',laneId:'primary',memberName:'TEST-peer',runId:'TEST-peer-run',sessionId:'TEST-peer-session',createdAt:'2026-10-01',updatedAt:'2026-10-01',opaque:{pin:'TEST-peer'}}
  const host={hostKey:'TEST-host',profileRootKey:'TEST-profile',projectPath:root,projectBehaviorFingerprint:'TEST-behavior',baseUrl:'http://127.0.0.1:9911',port:9911,pid:99001,processStartedAtMs:123,version:null,resolvedConfigFingerprint:null,updatedAt:'2026-10-01',leases:Object.fromEntries([[index,lease]])}
  const bytes=JSON.stringify({schemaVersion:1,processIdentityFormat:'platform-native-v2',hosts:{'TEST-host':host}});await writeFile(file,bytes)
  const classification=await readOpenCodeAuthority(file,isKnownHostRegistry)
  let alive=true;const effects:any[]=[];const manager=new OpenCodeHostManager({persistentRegistryPath:file,processAttributionDirectory:null,isProcessAlive:()=>alive,
   readProcessStartTimeMs:async()=>123,fetchJson:async(url)=>{effects.push({url});return {status:200,data:{ok:true}}},
   killProcess:(pid,signal)=>{effects.push({pid,signal});alive=false},sleepMs:async()=>{}})
  let caught:any,result:any;try{result=await manager.reconcilePersistentHosts({mode:'stale'})}catch(e){caught=e}
  const after=await readFile(file,'utf8').catch(e=>'missing:'+e.code)
  console.info('TEST-map-key-receipt',JSON.stringify({readKind:classification.kind,error:caught?.name,result,effects,preserved:after===bytes,after}))
  expect(classification.kind).toBe('known');expect(caught).toBeUndefined()
  expect(effects).toEqual([]);expect(after).toBe(bytes)
  expect(result.cleaned).toBe(0);expect(result.hosts[0].leaseCount).toBe(1)
  expect(Object.hasOwn(JSON.parse(after).hosts['TEST-host'].leases,index)).toBe(true)
  expect(JSON.parse(after).hosts['TEST-host'].leases[index]).toEqual(lease)
 }finally{await rm(root,{recursive:true,force:true})}
})

const rec=(root:string)=>({teamId:'TEST-team',laneId:'primary',memberName:'TEST-member',providerId:'opencode' as const,selectedModel:'openai/TEST-model',projectPath:root,profileRootKey:'TEST-profile',hostKey:'TEST-host',resolvedBehaviorFingerprint:null,opencodeSessionId:'TEST-session',lastCanonicalCursor:null,lastKnownRawStatus:null,lastKnownDurableState:null,sourceAuthFingerprint:null,managedAuthFingerprint:null,projectBehaviorFingerprint:'TEST-behavior',staleReason:null,createdAt:'2026-10-01',updatedAt:'2026-10-01'})
test('unrelated public session write preserves opaque claims, token/process extensions and owner migration fences',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'TEST-O1a-independent-v1-'))
 try{
  const file=path.join(root,'TEST-session.json'),key='TEST-team::primary::TEST-member',r=rec(root)
  const claims={'TEST-peer::primary::TEST-peer':'TEST-opaque-attempt  { peer reference }'}
  const processIdentity={pid:99001,startedAtMs:null,opaque:{operation:'TEST-peer'}}
  const owner={attemptId:'TEST-owner',sessionId:r.opencodeSessionId,opaque:{pin:'TEST-peer'}}
  const before={schemaVersion:1,records:{[key]:{...r,opaque:{pin:'TEST-record'}}},materializationClaims:claims,
   materializationOwners:{[key]:owner},materializationOwnerVersions:{[key]:4},materializationOwnerProcesses:{[key]:processIdentity},outerOpaque:{reference:'TEST-retention'}}
  const bytes=JSON.stringify(before,null,3)+'\n';await writeFile(file,bytes)
  const store=new OpenCodeSessionStore(file,{isProcessAlive:()=>{throw Error('forbidden process probe')},readProcessStartTimeMs:async()=>{throw Error('forbidden birth')}})
  const observed=await store.observeMaterialization(r);expect(observed?.ownerToken).toMatchObject({attemptId:'TEST-owner',sessionId:r.opencodeSessionId,version:5,opaque:owner.opaque})
  expect(await readFile(file,'utf8')).toBe(bytes)
  await expect(store.upsert({...r,updatedAt:'2026-10-02'})).rejects.toThrow('fenced')
  await store.upsert({...r,updatedAt:'2026-10-02'},observed!.ownerToken!)
  const after=JSON.parse(await readFile(file,'utf8'));expect(after.materializationClaims).toEqual(claims);expect(after.materializationOwners[key]).toEqual({...owner,version:5});expect(after.materializationOwnerVersions[key]).toBe(5);expect(after.materializationOwnerProcesses[key]).toEqual(processIdentity);expect(after.records[key].opaque).toEqual({pin:'TEST-record'});expect(after.outerOpaque).toEqual(before.outerOpaque)
  console.info('TEST-independent-session-roundtrip',JSON.stringify(after))
 }finally{await rm(root,{recursive:true,force:true})}
})
test('last dead host removal retains V1 outer references and peer lease/host extensions across lease edit',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'TEST-O1a-independent-host-'))
 try{
  const file=path.join(root,'TEST-host.json');const key='TEST-team::primary::TEST-member';const lease={leaseKey:key,teamId:'TEST-team',laneId:'primary',memberName:'TEST-member',runId:'TEST-run',sessionId:'TEST-session',createdAt:'2026-10-01',updatedAt:'2026-10-01',opaque:{pin:'TEST-peer'}}
  const host={hostKey:'TEST-host',profileRootKey:'TEST-profile',projectPath:root,projectBehaviorFingerprint:'TEST-behavior',baseUrl:'http://127.0.0.1:9911',port:9911,pid:99001,processStartedAtMs:123,version:null,resolvedConfigFingerprint:null,updatedAt:'2026-10-01',leases:{[key]:lease},opaque:{operations:['TEST-peer']}}
  const outerOpaque={reference:'TEST-peer-envelope'};await writeFile(file,JSON.stringify({schemaVersion:1,hosts:{'TEST-host':host},outerOpaque}))
  const manager=new OpenCodeHostManager({persistentRegistryPath:file,processAttributionDirectory:null,isProcessAlive:()=>false,
   killProcess:()=>{throw Error('forbidden signal')},fetchJson:async()=>{throw Error('forbidden fetch')}})
  await manager.retainHostLease('TEST-host',lease)
  const after=JSON.parse(await readFile(file,'utf8'));expect(after.outerOpaque).toEqual(outerOpaque);expect(after.hosts['TEST-host'].opaque).toEqual(host.opaque);expect(after.hosts['TEST-host'].leases[key].opaque).toEqual(lease.opaque)
  const result=await manager.reconcilePersistentHosts({mode:'stale'});expect(result.cleaned).toBe(1)
  const removed=JSON.parse(await readFile(file,'utf8'));expect(removed.hosts).toEqual({});expect(removed.outerOpaque).toEqual(outerOpaque)
  console.info('TEST-independent-host-roundtrip',JSON.stringify({after,removed}))
 }finally{await rm(root,{recursive:true,force:true})}
})

test('Stop receipt extensions roundtrip and remaining public mutation/operation entrypoints veto future stores',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'TEST-O1a-independent-stop-'))
 try{
  const file=path.join(root,'TEST-session.json'),hostFile=path.join(root,'TEST-host.json');const r=rec(root)
  const runtime={providerId:'opencode' as const,binaryPath:null,binaryFingerprint:null,version:null,capabilitySnapshotId:`opencode:${'a'.repeat(32)}`}
  const request={contractVersion:1 as const,originalRequestId:'TEST-request',idempotencyKey:'TEST-stop-key',target:{teamId:r.teamId,laneId:'primary',runId:'TEST-run',projectPath:root,capabilitySnapshotId:runtime.capabilitySnapshotId,expectedBehaviorFingerprint:'b'.repeat(64),members:[{memberName:r.memberName,sessionId:r.opencodeSessionId}]}}
  const receipt={request,binding:[{memberName:r.memberName,sessionId:r.opencodeSessionId,hostKey:r.hostKey,createdAt:r.createdAt,opaque:{pin:'TEST-binding'}}],runtime:{...runtime,opaque:{pin:'TEST-runtime'}},status:'inflight',opaque:{reference:'TEST-stop'}}
  const data={runId:'TEST-run',stopped:false,members:{[r.memberName]:{sessionId:r.opencodeSessionId,stopped:false,diagnostics:[]}},warnings:[],diagnostics:[],manifestHighWatermark:null,runtimeStoreManifestHighWatermark:null}
  await writeFile(file,JSON.stringify({schemaVersion:1,records:{},stopReceipts:{[stopRequestKey(request)]:receipt},opaque:{pin:'TEST-outer'}}))
  const store=new OpenCodeSessionStore(file,{isProcessAlive:()=>{throw Error('forbidden liveness')},readProcessStartTimeMs:async()=>{throw Error('forbidden birth')}})
  expect(await store.lookupStop(request)).toEqual({status:'inflight'})
  await store.completeStop(request,data)
  const after=JSON.parse(await readFile(file,'utf8'));expect(after.stopReceipts[stopRequestKey(request)]).toEqual({...receipt,status:'completed',data});expect(after.opaque).toEqual({pin:'TEST-outer'})
  const unknown='{"schemaVersion":42,"opaque":{"reference":"TEST-future"}}\n';await writeFile(file,unknown);await writeFile(hostFile,unknown)
  await expect(store.completeStop(request,data)).rejects.toMatchObject({name:'OpenCodeAuthorityVetoError',kind:'preserved_unknown'})
  await expect(store.retireAbsentRuntimeIfSession(r,'TEST-next-run')).rejects.toMatchObject({name:'OpenCodeAuthorityVetoError',kind:'preserved_unknown'})
  let called=false;const manager=new OpenCodeHostManager({persistentRegistryPath:hostFile,processAttributionDirectory:null})
  await expect(manager.withHostOperation({hostKey:'TEST-host',pid:99001,baseUrl:'http://127.0.0.1:9911',processStartedAtMs:123},null,async()=>{called=true})).rejects.toMatchObject({name:'OpenCodeAuthorityVetoError',kind:'preserved_unknown'})
  expect(called).toBe(false);expect(await readFile(file,'utf8')).toBe(unknown);expect(await readFile(hostFile,'utf8')).toBe(unknown)
 }finally{await rm(root,{recursive:true,force:true})}
})

for (const replacement of [false, true]) test(`full V1 upsert clears omitted optional fields with opaque retention (replacement=${replacement})`, async () => {
 const root=await mkdtemp(path.join(os.tmpdir(),'TEST-O1a-full-record-'))
 try {
  const file=path.join(root,'TEST-session.json'),key='TEST-team::primary::TEST-member'
  const optional={runId:'TEST-old-run',selectedVariant:'TEST-old-variant',laneId:'primary',
   stopAuthority:{expectedBehaviorFingerprint:'TEST-expected',runtime:{providerId:'opencode',binaryPath:null,binaryFingerprint:null,version:null,capabilitySnapshotId:'TEST-capability'}},
   profileScope:{purpose:'catalog',providerId:'opencode',configFingerprint:'TEST-config',selectedAuthIdentity:'absent',scopeToken:'TEST-scope'},
   toolApprovalMode:'manual',runtimePid:99001,managedConfigFingerprint:'TEST-config',managedConfigSectionFingerprints:{model:'TEST-model'},
   expectedBehaviorFingerprint:'TEST-expected',opencodeVersion:'1.18.34',bootstrapMode:'app_managed_context',bootstrapEvidenceSource:'app_managed_bootstrap',
   appManagedBootstrap:{schemaVersion:1,messageID:'TEST-old-message',contextHash:'TEST-context',briefingHash:'TEST-briefing',injectionVerifiedAt:'2026-10-01'}}
  const opaque={peer:{pin:'TEST-opaque'}}
  const old={...record(root),...optional,opaque}
  const bytes=JSON.stringify({schemaVersion:1,records:{[key]:old}},null,3)+'\n'
  await writeFile(file,bytes)
  const store=new OpenCodeSessionStore(file)
  expect(await store.upsert(old as any)).toBe('unchanged')
  expect(await readFile(file,'utf8')).toBe(bytes)
  const next=record(root);delete (next as any).laneId
  if (replacement) next.opencodeSessionId='TEST-replacement'
  expect(await store.upsert(next)).toBe('updated')
  const expected={...next,opaque}
  expect(await store.get('TEST-team','primary','TEST-member')).toEqual(expected)
  const after=await readFile(file,'utf8')
  expect(await store.upsert(next)).toBe('unchanged')
  expect(await readFile(file,'utf8')).toBe(after)
 } finally {await rm(root,{recursive:true,force:true})}
})

test('legacy own lease indexes migrate without losing extensions or promoting/revoking a complete reap marker',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'TEST-O1a-legacy-lease-'))
 try{
  const file=path.join(root,'TEST-host.json')
  const indexes=['__proto__','constructor','toString']
  const legacy={teamId:'TEST-peer',laneId:'primary',memberName:'TEST-peer',createdAt:'2026-10-01',updatedAt:'2026-10-01',opaque:{pin:'TEST-legacy'}}
  const host={hostKey:'TEST-host',profileRootKey:'TEST-profile',projectPath:root,projectBehaviorFingerprint:'TEST-behavior',
   baseUrl:'http://127.0.0.1:9911',port:9911,pid:99001,processStartedAtMs:123,version:null,resolvedConfigFingerprint:null,
   updatedAt:'2026-10-01',cursorAgentReapContractVersion:1,leases:Object.fromEntries(indexes.map(key=>[key,legacy]))}
  await writeFile(file,JSON.stringify({schemaVersion:1,processIdentityFormat:'platform-native-v2',hosts:{'TEST-host':host}}))
  const effects:string[]=[]
  const manager=new OpenCodeHostManager({persistentRegistryPath:file,processAttributionDirectory:null,
   fetchJson:async()=>{effects.push('fetch');throw Error('forbidden fetch')},killProcess:()=>{effects.push('kill');throw Error('forbidden kill')}})
  const input={teamId:'TEST-new',laneId:'primary',memberName:'TEST-new',runId:'TEST-run',sessionId:'TEST-session'}
  await manager.retainHostLease('TEST-host',input)
  const after=JSON.parse(await readFile(file,'utf8')).hosts['TEST-host']
  for(const key of indexes){
   expect(Object.hasOwn(after.leases,key)).toBe(true)
   expect(after.leases[key]).toEqual({...legacy,leaseKey:key,runId:null,sessionId:null})
  }
  expect(after.cursorAgentReapContractVersion).toBe(1)
  expect(await manager.releaseHostLeaseStrict('TEST-host',input)).toBe(true)
  const remaining=JSON.parse(await readFile(file,'utf8')).hosts['TEST-host']
  expect(Object.keys(remaining.leases).sort()).toEqual(indexes.sort())
  expect(remaining.cursorAgentReapContractVersion).toBe(1)
  expect(effects).toEqual([])
 }finally{await rm(root,{recursive:true,force:true})}
})
