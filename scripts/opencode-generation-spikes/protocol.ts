import { readFile, lstat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { canonical, within, sha, SOURCE, TASK, isolatedEnvironment } from './sandbox';
import { object, selectedModel, validatePages, nativeRow } from './collections';
import { verifyProviderPackages, unpackArchive } from './artifacts';
export const ACCEPTED_PLAN_SHA256='fb4f8ed4fc4db9c62a555ad7b0fc27c8096acd2fd3a6905e5111e58ab2245d66';
export const ACCEPTED_AMENDMENT_SHA256='5ca9ca5116daefe48fb8ebc0dd753876d31628958977aebe76760a7e6970d72e';
export const OWNER_BASE='6132299836a89e58d633a0557e504243035e806b';
export type EvidenceRef={file:string;sha256:string};
export type Unavailable={status:'unavailable';reason:'native-bundle-no-inner-npm-manifest'};
export type Route={configuredSelector:string;reportedSelector:string|null;logicalImplementation:string;
  providerID:'test-model';catalogModelID:'q0-catalog';upstreamModelID:'q0-upstream';modelBaseURL:string;
  configPath:string;configByteSha256Before:string;configByteSha256After:string;
  configBefore:EvidenceRef;configAfter:EvidenceRef;modelCatalog:EvidenceRef;providerObservation?:EvidenceRef;effectiveConfig?:EvidenceRef;
  resolverEvidence:EvidenceRef;reviewAcceptance:EvidenceRef;ruleID:string;executedModuleImportProved:false};
export type Provenance={mode:'native-bundled';enclosing:EvidenceRef;route:Route;innerNpmName:Unavailable;innerNpmVersion:Unavailable;innerNpmSri:Unavailable;inventory:EvidenceRef}
  |{mode:'externally-resolved-sdk';enclosing:EvidenceRef;route:Route;selectedResolution:EvidenceRef;sdk:Record<string,unknown>;inventory:EvidenceRef};
export type ProtocolV2={schemaVersion:2;case:'S3a';status:'PASS'|'FAIL'|'MISSING';observationKind?:'fresh-pending-acceptance';ownerBase:typeof OWNER_BASE;
  amendmentID:string;producerSourceManifest:EvidenceRef;planSha256:string;amendmentSha256:string;provenance:Provenance;
  authority:{ownerMarker:EvidenceRef;nativeIdentity:EvidenceRef;process:EvidenceRef;location:EvidenceRef;modelHost:EvidenceRef;endpointEpoch:string;canonicalDirectory:string};
  auth:{source:'test-dummy';childEnvironment:EvidenceRef;requestAuthorizationChecked:true;ambientCredentialsExcluded:true};
  sessionID:string;sessionCreated:EvidenceRef;promptReceipt:EvidenceRef;wire:EvidenceRef;transcript:EvidenceRef;transcriptPages?:EvidenceRef;
  terminalMessageID:string;nativeToolIDs:[string,string,string];token:string;
  files:{seed:EvidenceRef;write:EvidenceRef;shell:EvidenceRef};cleanup:EvidenceRef};
// Acceptance MUST be supplied by a controller, not discovered from producer evidence.
// Digest is pinned by the caller; a producer-authored manifest is never automatically trusted.
export type TrustInput={path:string;sha256:string};
export type TrustManifest={schemaVersion:1;ownerBase:string;planSha256:string;amendmentSha256:string;amendmentID:string;
  sourceManifestSha256:string;pins:Record<string,{binarySha256:string;rootMetadataSha256:string;platformMetadataSha256:string;
    rootArchiveSha256:string;platformArchiveSha256:string;platformSri:string;
    rule:{id:string;mode:Provenance['mode'];configuredSelector:string;reportedSelector:string|null;logicalImplementation:string;
      resolverSha256:string;acceptanceSha256:string;baseURLRequired:true;completeDispatchReview:true;
      resolverPath?:string;acceptancePath?:string;selectedResolutionPath?:string;sdk?:Record<string,unknown>};
    sdkMetadataSha256?:string;selectedResolutionSha256?:string;acceptedProtocolSha256?:string}>};
const hex=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
export function equal(a:unknown,b:unknown,message:string) {if(stable(a)!==stable(b))throw new Error(message);}
function stable(v:any):string {return JSON.stringify(v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(stable(v[k]))])):Array.isArray(v)?v.map(x=>JSON.parse(stable(x))):v);}
function text(v:unknown,label:string):asserts v is string {if(typeof v!=='string'||!v||v.length>8192)throw new Error('invalid '+label);}
export function decodeProtocol(value:unknown):ProtocolV2 {
  const p=object(value),prov=object(p.provenance),route=object(prov.route);
  if(p.schemaVersion!==2||p.case!=='S3a'||p.ownerBase!==OWNER_BASE||!['PASS','FAIL','MISSING'].includes(p.status))throw new Error('invalid protocol schema');
  if(p.observationKind!==undefined&&(p.observationKind!=='fresh-pending-acceptance'||p.status!=='MISSING'))throw new Error('invalid fresh observation state');
  if(!['native-bundled','externally-resolved-sdk'].includes(prov.mode)||route.executedModuleImportProved!==false||
    route.providerID!=='test-model'||route.catalogModelID!=='q0-catalog'||route.upstreamModelID!=='q0-upstream')throw new Error('unknown provenance/route');
  for(const k of ['amendmentID','sessionID','terminalMessageID','token'])text(p[k],k);
  if(!hex(p.planSha256)||!hex(p.amendmentSha256)||!hex(route.configByteSha256Before)||!hex(route.configByteSha256After))throw new Error('invalid protocol digest');
  if(!Array.isArray(p.nativeToolIDs)||p.nativeToolIDs.length!==3||new Set(p.nativeToolIDs).size!==3||p.nativeToolIDs.some((id:any)=>typeof id!=='string'||!id))throw new Error('invalid tool identities');
  if(prov.mode==='native-bundled') {
    if('sdk' in prov||'selectedResolution' in prov)throw new Error('mixed provenance modes');
    for(const k of ['innerNpmName','innerNpmVersion','innerNpmSri'])equal(prov[k],{status:'unavailable',reason:'native-bundle-no-inner-npm-manifest'},'invented bundled npm identity');
  }else if(['innerNpmName','innerNpmVersion','innerNpmSri'].some(k=>k in prov)||!prov.sdk||!prov.selectedResolution)throw new Error('mixed/incomplete external provenance');
  if(!['@ai-sdk/openai-compatible','aisdk:@ai-sdk/openai-compatible'].includes(route.configuredSelector)||
    !['native-openai-compatible-branch','@opencode/ai/providers/openai-compatible'].includes(route.logicalImplementation)||
    (route.reportedSelector!==null&&typeof route.reportedSelector!=='string'))throw new Error('unqualified route');
  const authority=object(p.authority),auth=object(p.auth),files=object(p.files);
  text(authority.endpointEpoch,'endpoint epoch');
  const refs=[p.producerSourceManifest,prov.enclosing,prov.inventory,p.wire,p.transcript,p.sessionCreated,p.promptReceipt,p.cleanup,
    authority.ownerMarker,authority.nativeIdentity,authority.process,authority.location,authority.modelHost,auth.childEnvironment,
    files.seed,files.write,files.shell,route.configBefore,route.configAfter,route.modelCatalog,route.resolverEvidence,route.reviewAcceptance,
    ...[p.transcriptPages,route.providerObservation,route.effectiveConfig,prov.selectedResolution].filter(x=>x!==undefined)];
  for(const value of refs) {const ref=object(value);if(typeof ref.file!=='string'||! /^[A-Za-z0-9_.-]+$/.test(ref.file)||!hex(ref.sha256))throw new Error('invalid evidence reference');}
  return p as ProtocolV2;
}
export async function loadTrust(input:TrustInput|undefined,root:string,dir:string):Promise<TrustManifest|undefined> {
  if(!input)return undefined;
  if(!hex(input.sha256)||within(root,input.path)||within(dir,input.path))throw new Error('producer cannot supply its own trust');
  await canonical(input.path);if(!(await lstat(input.path)).isFile())throw new Error('nonregular controller trust');
  if((await lstat(input.path)).size>4*1024*1024)throw new Error('controller trust byte budget');
  const bytes=await readFile(input.path);if(sha(bytes)!==input.sha256)throw new Error('controller trust digest mismatch');
  const t=object(JSON.parse(bytes.toString()));
  if(t.schemaVersion!==1||t.ownerBase!==OWNER_BASE||![t.planSha256,t.amendmentSha256,t.sourceManifestSha256].every(hex))throw new Error('invalid controller trust');
  object(t.pins);if(Object.keys(t.pins).some(pin=>!['1.16.0','1.18.34','2.0.0','2.0.21'].includes(pin)))throw new Error('unknown controller pin');
  return t as TrustManifest;
}
export type PacketAccess={root:string;dir:string;generation:string;version:string;marker:any;
  ref:(ref:EvidenceRef)=>Promise<any>;bytes:(ref:EvidenceRef)=>Promise<Buffer>;artifact:any};
async function physical(root:string,path:string,digest:string) {
  if(!within(root,path)||!hex(digest))throw new Error('foreign physical evidence');
  await canonical(path);if(!(await lstat(path)).isFile())throw new Error('nonregular physical evidence');
  const b=await readFile(path);if(sha(b)!==digest)throw new Error('physical evidence changed');return b;
}
export async function validateProtocol(p:ProtocolV2,a:PacketAccess,trust?:TrustManifest):Promise<boolean> {
  const {root,generation,version,ref,artifact}=a,prov=p.provenance,r=prov.route;
  if(!['1.16.0','1.18.34','2.0.0','2.0.21'].includes(version)||generation!==(version.startsWith('1.')?'v1':'v2')||process.platform!=='linux'||process.arch!=='x64')throw new Error('unqualified native pin/platform');
  if(!artifact)throw new Error('enclosing artifact missing');equal(await ref(prov.enclosing),artifact,'enclosing artifact mismatch');
  const source=await ref(p.producerSourceManifest);
  if(source.ownerBase!==OWNER_BASE||!Array.isArray(source.files)||!source.files.length)throw new Error('source manifest missing');
  const sourceNames=new Set<string>();
  for(const f of source.files) {
    if(typeof f.path!=='string'||!(f.path==='scripts/opencode-generation-contract-spike.ts'||/^scripts\/opencode-generation-spikes\/[A-Za-z0-9_.-]+$/.test(f.path))||sourceNames.has(f.path))throw new Error('foreign/duplicate source manifest');
    sourceNames.add(f.path);await physical(SOURCE,join(SOURCE,f.path),f.sha256);
  }
  const {readdir}=await import('node:fs/promises');
  const expected=['scripts/opencode-generation-contract-spike.ts',...(await readdir(join(SOURCE,'scripts/opencode-generation-spikes'))).map(n=>'scripts/opencode-generation-spikes/'+n)];
  equal([...sourceNames].sort(),expected.sort(),'incomplete producer source manifest');
  equal(await ref(p.authority.ownerMarker),a.marker,'owner marker mismatch');
  if(a.marker.task!==TASK||a.marker.case!=='S3a'||typeof a.marker.nonce!=='string'||!a.marker.nonce||a.marker.root!==root||p.authority.canonicalDirectory!==root)throw new Error('owner authority mismatch');
  const identity=await ref(p.authority.nativeIdentity),proc=await ref(p.authority.process),location=await ref(p.authority.location);
  if(location.directory!==root||identity.executable!==artifact.binary||identity.sha256!==artifact.sha256||identity.identity?.version!==version||proc.args?.[0]!==artifact.binary||proc.pid!==identity.pid||!Number.isSafeInteger(proc.pid)||proc.pid<=0)throw new Error('native authority identity mismatch');
  equal(proc.birth,identity.birth,'process birth mismatch');
  if(proc.birth?.format!=='linux-start-ticks'||!/^\d+$/.test(proc.birth.value)||typeof proc.birth.bootId!=='string'||!proc.birth.bootId)throw new Error('unknown process birth');
  if(proc.auth?.epoch!==p.authority.endpointEpoch||proc.auth?.pid!==proc.pid||proc.auth?.endpoint!==`http://127.0.0.1:${proc.port}`||identity.port!==proc.port)throw new Error('endpoint authority mismatch');
  equal(proc.auth.birth,proc.birth,'auth birth mismatch');
  if(!Array.isArray(proc.cleanup)||!proc.cleanup.some((c:any)=>c.pid===proc.pid&&['drained','forced-drained'].includes(c.result))||proc.cleanup.some((c:any)=>!['drained','forced-drained','absent-or-changed'].includes(c.result)||!c.birth||!Number.isSafeInteger(c.pid)))throw new Error('native cleanup unknown');
  equal(proc.cleanup.find((c:any)=>c.pid===proc.pid).birth,proc.birth,'native ledger birth mismatch');
  if(/server password(?! \[REDACTED\])/i.test(proc.stdout??'')||/Basic [A-Za-z0-9+/=]+/.test(JSON.stringify(proc)))throw new Error('durable native credential');
  equal(p.auth.source,'test-dummy','unknown auth source');if(p.auth.requestAuthorizationChecked!==true||p.auth.ambientCredentialsExcluded!==true)throw new Error('auth unproved');
  const env=await ref(p.auth.childEnvironment);
  equal(env,{...isolatedEnvironment(root),TEST_Q0_MODEL_API_KEY:'TEST-DUMMY-KEY'},'ambient child credential/options or state path');
  if(!identity.environmentKeyNames?.includes('TEST_Q0_MODEL_API_KEY'))throw new Error('actual native child key absent');
  const before=await ref(r.configBefore),after=await ref(r.configAfter);
  if(before.configPath!==r.configPath||before.fingerprint!==r.configByteSha256Before||r.configByteSha256Before!==r.configByteSha256After)throw new Error('config fingerprint mismatch');
  for(const [fact,digest] of [[before,r.configByteSha256Before],[after,r.configByteSha256After]] as const) {
    if(typeof fact.rawBase64!=='string'||sha(Buffer.from(fact.rawBase64,'base64'))!==digest||fact.fingerprint!==digest)throw new Error('raw config bytes mismatch');
  }
  const config=JSON.parse((await physical(root,r.configPath,r.configByteSha256After)).toString());
  equal(config,before.config,'physical config mismatch');equal(config,after.config,'config rewritten');
  if(config.$schema!=='https://opencode.ai/config.json'||config.model!=='test-model/q0-catalog')throw new Error('config schema/route changed');
  const provider=generation==='v1'?config.provider?.['test-model']:config.providers?.['test-model'];
  const settings=generation==='v1'?provider?.options:provider?.settings;
  if((generation==='v1'?provider?.npm:provider?.package)!==r.configuredSelector||settings?.baseURL!==r.modelBaseURL||settings?.apiKey!=='TEST-DUMMY-KEY')throw new Error('selected config mapping mismatch');
  const fixture=await ref(p.authority.modelHost);if(fixture.url!==r.modelBaseURL||fixture.owner!==a.marker.nonce||fixture.root!==root)throw new Error('model host authority mismatch');
  const baseURL=new URL(r.modelBaseURL);if(baseURL.hostname!=='127.0.0.1'||baseURL.protocol!=='http:'||baseURL.pathname!=='/v1'||baseURL.username||baseURL.password)throw new Error('foreign model host');
  const model=selectedModel(await ref(r.modelCatalog),generation);if(!model)throw new Error('selected catalog missing');
  if(generation==='v1') {if(!(await ref(r.modelCatalog)).all?.some((p:any)=>p.id==='test-model'&&p.options?.baseURL===r.modelBaseURL))throw new Error('V1 catalog settings mismatch');}
  else {
    if(model.package!==r.reportedSelector||model.settings?.baseURL!==r.modelBaseURL||!r.providerObservation||!r.effectiveConfig)throw new Error('actual model route mismatch');
    const observed=await ref(r.providerObservation);if(observed.data?.id!=='test-model'||observed.data?.package!==r.reportedSelector||observed.data?.settings?.baseURL!==r.modelBaseURL)throw new Error('actual provider route mismatch');
    await validateEffectiveConfig(await ref(r.effectiveConfig),root,r.configPath,config);
  }
  if(r.configuredSelector!==(generation==='v1'?'@ai-sdk/openai-compatible':'aisdk:@ai-sdk/openai-compatible')||r.reportedSelector!==(generation==='v1'?null:version==='2.0.0'?'aisdk:@ai-sdk/openai-compatible':'@opencode/ai/providers/openai-compatible'))throw new Error('pin reported route mismatch');
  const inventory=await ref(prov.inventory);await verifyProviderPackages(root,inventory);
  const resolver=await ref(r.resolverEvidence),acceptance=await ref(r.reviewAcceptance);
  if(resolver.binarySha256!==artifact.sha256||!Array.isArray(resolver.ranges)||!resolver.ranges.length||resolver.ranges.length>32||acceptance.ruleID!==r.ruleID||acceptance.binarySha256!==artifact.sha256||acceptance.completeDispatchReview!==true)throw new Error('resolver binding incomplete');
  const binary=await readFile(artifact.binary);let resolverBytes=0;
  for(const range of resolver.ranges) {
    if(!Number.isSafeInteger(range.start)||!Number.isSafeInteger(range.end)||range.start<0||range.end<=range.start||range.end>binary.length||typeof range.base64!=='string')throw new Error('invalid resolver range');
    const bytes=Buffer.from(range.base64,'base64');resolverBytes+=bytes.length;if(resolverBytes>256*1024||!bytes.equals(binary.subarray(range.start,range.end)))throw new Error('resolver bytes mismatch');
  }
  if(prov.mode==='externally-resolved-sdk') {
    const selected=await ref(prov.selectedResolution),sdk=prov.sdk as any;
    await verifyProviderPackages(root,[sdk]);
    if(selected.binarySha256!==artifact.sha256||selected.providerID!=='test-model'||selected.modelID!=='q0-catalog'||selected.installedPath!==join(root,sdk.path)||typeof selected.resolvedEntryPath!=='string'||!within(selected.installedPath,selected.resolvedEntryPath)||selected.sessionID!==p.sessionID)throw new Error('external selected resolution absent');
    const entry=await physical(root,selected.resolvedEntryPath,selected.resolvedEntrySha256);
    const archive=unpackArchive(await readFile(join(root,'artifacts',`ai-sdk-${sdk.version}.tgz`)));
    if(!archive.get(relative(selected.installedPath,selected.resolvedEntryPath))?.equals(entry))throw new Error('selected SDK entry is not in official archive');
  } else if(resolver.selectedExternalResolution!==null)throw new Error('conflicting external selection');
  await validateRoundtrip(p,a);
  const cleanup=await ref(p.cleanup);
  if(!cleanup.ownedPidDrained||!cleanup.sentinelUnchanged||!cleanup.nativeSentinel||!cleanup.modelFixtureStopped||!cleanup.nativeHostStopped||cleanup.errors?.length)throw new Error('cleanup incomplete');
  await validateSentinel(cleanup.nativeSentinel,root,a.marker);
  if(!trust)return false;
  if(trust.planSha256!==ACCEPTED_PLAN_SHA256||trust.amendmentSha256!==ACCEPTED_AMENDMENT_SHA256)throw new Error('unaccepted plan/amendment');
  if(trust.planSha256!==p.planSha256||trust.amendmentSha256!==p.amendmentSha256||trust.amendmentID!==p.amendmentID||trust.sourceManifestSha256!==p.producerSourceManifest.sha256)throw new Error('controller source/plan/amendment mismatch');
  const pin=trust.pins[version];if(!pin)return false;
  for(const [value,expected] of [[artifact.sha256,pin.binarySha256],[artifact.packages[0].metadataSha256,pin.rootMetadataSha256],[artifact.packages[1].metadataSha256,pin.platformMetadataSha256],[artifact.packages[0].archiveSha256,pin.rootArchiveSha256],[artifact.packages[1].archiveSha256,pin.platformArchiveSha256],[artifact.packages[1].archiveSri,pin.platformSri]])if(value!==expected)throw new Error('controller native artifact mismatch');
  const rule=pin.rule;if(!rule)return false;
  if(rule.id!==r.ruleID||rule.mode!==prov.mode||rule.configuredSelector!==r.configuredSelector||rule.reportedSelector!==r.reportedSelector||rule.logicalImplementation!==r.logicalImplementation||rule.resolverSha256!==r.resolverEvidence.sha256||rule.acceptanceSha256!==r.reviewAcceptance.sha256||rule.baseURLRequired!==true||rule.completeDispatchReview!==true)throw new Error('controller resolver rule mismatch');
  if(prov.mode==='externally-resolved-sdk'&&(pin.sdkMetadataSha256!==(prov.sdk as any).metadataSha256||pin.selectedResolutionSha256!==prov.selectedResolution.sha256))throw new Error('controller SDK metadata mismatch');
  return true; // Static route trust; observation acceptance is a separate reader predicate.
}
// Shared semantic boundary: rederive streamed decisions and persisted native results.
// It never returns native PASS and cannot substitute for the enclosing reader/trust checks.
export async function validateRoundtrip(p:ProtocolV2,a:Pick<PacketAccess,'generation'|'root'|'ref'> & {version?:string}) {
  const {ref,generation,root}=a,wire=await ref(p.wire),messages=await ref(p.transcript);
  if(!Array.isArray(messages)||!messages.length||!Array.isArray(wire.requests)||wire.requests.length!==4||!Array.isArray(wire.streamedFrames)||wire.streamedFrames.length!==4||!Array.isArray(wire.decisions)||wire.decisions.length!==3||!Array.isArray(wire.failures)||wire.failures.length)throw new Error('native roundtrip incomplete');
  if(generation==='v2') {
    if(!p.transcriptPages)throw new Error('native pages missing');equal(validatePages(await ref(p.transcriptPages),p.sessionID,a.version),messages,'transcript flatten mismatch');
  }
  const created=await ref(p.sessionCreated),session=generation==='v1'?created:created.data;
  if(session?.id!==p.sessionID||(generation==='v2'&&(session.location?.directory!==root||session.model?.providerID!=='test-model'||session.model?.id!=='q0-catalog')))throw new Error('session route mismatch');
  const prompt=await ref(p.promptReceipt);if(generation==='v1'&&prompt!==null||generation==='v2'&&(prompt.error||prompt.data?.sessionID&&prompt.data.sessionID!==p.sessionID))throw new Error('prompt receipt incomplete');
  const ids=new Set<string>(),tools:any[]=[];let terminal:any;const users=new Set(messages.filter((m:any)=>(generation==='v1'?m.info?.role:m.type)==='user').map((m:any)=>generation==='v1'?m.info.id:m.id));
  for(const message of messages) {
    const info=generation==='v1'?object(message.info):nativeRow(message,a.version),parts=generation==='v1'?message.parts:message.type==='assistant'?message.content:[];
    if(typeof info.id!=='string'||ids.has(info.id)||!Array.isArray(parts))throw new Error('invalid/duplicate transcript');ids.add(info.id);
    if(generation==='v1'&&(info.sessionID!==p.sessionID||info.role==='assistant'&&!users.has(info.parentID)))throw new Error('V1 session/parent mismatch');
    for(const part of parts) {if(part.type==='tool')tools.push(part);if(['question','permission'].includes(part.type))throw new Error('unresolved interaction');}
    if((generation==='v1'?info.role:info.type)==='assistant') {
      if(info.error||!Number.isFinite(info.time?.completed)||info.time.completed<info.time.created)throw new Error('native assistant incomplete');
      if(generation==='v1'?(info.providerID!=='test-model'||info.modelID!=='q0-catalog'):(info.model?.providerID!=='test-model'||info.model?.id!=='q0-catalog'))throw new Error('persisted model mismatch');
      const t=info.tokens;if(t?.input!==17||t?.output!==5||t.reasoning!==0||t.cache?.read!==0||t.cache?.write!==0||t.total!==undefined&&t.total!==22||!Number.isFinite(info.cost)||Math.abs(info.cost-0.000022)>1e-12)throw new Error('persisted usage mismatch');
      if(info.id===p.terminalMessageID) {if(info.finish!=='stop'||!parts.some((t:any)=>t.type==='text'&&t.text===`q0-terminal:${p.token}`))throw new Error('terminal mismatch');terminal=info;}
    }
  }
  if(!terminal||tools.length!==3)throw new Error('terminal/tools missing');
  const fileFacts:Record<string,any>={};
  for(const [key,prefix] of [['seed','native-read'],['write','native-write'],['shell','native-shell']]) {
    const f=await ref(p.files[key as keyof ProtocolV2['files']]);fileFacts[key]=f;
    const bytes=await physical(root,f.path,f.sha256);if(bytes.toString()!==`${prefix}:${p.token}\n`)throw new Error('native physical content mismatch');
  }
  for(let stage=0;stage<4;stage++) {
    const request=object(wire.requests[stage]),body=object(request.body),frames=wire.streamedFrames[stage];
    if(request.endpoint!=='/v1/chat/completions'||request.method!=='POST'||request.authorization!=='TEST dummy key (redacted)'||body.model!=='q0-upstream'||body.stream!==true||!Array.isArray(body.messages)||!Array.isArray(body.tools))throw new Error('wire route/auth mismatch');
    if(!Array.isArray(frames)||frames.at(-1)!=='data: [DONE]\n\n')throw new Error('SSE DONE missing');
    const chunks=frames.slice(0,-1).map((f:any)=>{if(typeof f!=='string'||!f.startsWith('data: ')||!f.endsWith('\n\n'))throw new Error('invalid SSE frame');return object(JSON.parse(f.slice(6,-2)));});
    if(chunks.some((c:any)=>c.model!=='q0-upstream'||c.object!=='chat.completion.chunk'||c.id!==chunks[0].id||!Array.isArray(c.choices)))throw new Error('SSE identity mismatch');
    const finishes=chunks.flatMap((c:any)=>c.choices).filter((c:any)=>c.finish_reason!==null&&c.finish_reason!==undefined).map((c:any)=>c.finish_reason);
    equal(finishes,[stage<3?'tool_calls':'stop'],'SSE finish mismatch');
    const usage=chunks.filter((c:any)=>c.usage);if(usage.length!==1||usage[0].choices.length)throw new Error('SSE usage frame missing');
    equal(usage[0].usage,{prompt_tokens:17,completion_tokens:5,total_tokens:22,prompt_tokens_details:{cached_tokens:0},completion_tokens_details:{reasoning_tokens:0}},'SSE usage mismatch');
    const calls=chunks.flatMap((c:any)=>c.choices.flatMap((choice:any)=>choice.delta?.tool_calls??[]));
    if(stage===3) {if(calls.length||chunks.flatMap((c:any)=>c.choices.map((x:any)=>x.delta?.content??'')).join('')!==`q0-terminal:${p.token}`)throw new Error('SSE terminal mismatch');}
    else {
      const decision=object(wire.decisions[stage]);
      if(calls.length!==3||calls[0].index!==0||calls[0].id!==decision.id||calls[0].function?.name!==decision.tool||calls[0].function?.arguments!==''||calls.slice(1).some((c:any)=>c.index!==0||c.id!==undefined||typeof c.function?.arguments!=='string'||!c.function.arguments))throw new Error('SSE split decision mismatch');
      const args=JSON.parse(calls.map((c:any)=>c.function?.arguments??'').join(''));equal(args,decision.args,'SSE arguments mismatch');
      if(decision.id!==p.nativeToolIDs[stage]||decision.id!=='call_'+sha(JSON.stringify({stage,args})).slice(0,24))throw new Error('content-derived decision mismatch');
      const tool=body.tools.find((t:any)=>t.type==='function'&&t.function?.name===decision.tool);
      if(!tool?.function?.parameters?.properties||!Array.isArray(tool.function.parameters.required)||tool.function.parameters.required.some((k:any)=>!(k in args))||Object.keys(args).some(k=>!(k in tool.function.parameters.properties)))throw new Error('native tool schema mismatch');
      const props=tool.function.parameters.properties,expectedArgs:Record<string,unknown>={};
      if(stage<2) {
        const key=['filePath','path','file_path'].find(k=>k in props);if(!key)throw new Error('unsupported native path schema');
        expectedArgs[key]=fileFacts[stage===0?'seed':'write'].path;if(stage===1)expectedArgs.content=`native-write:${p.token}\n`;
      }else {
        const quote=(x:string)=>"'"+x.replace(/'/g,"'\\''")+"'";
        expectedArgs.command=`printf '%s\\n' ${quote('native-shell:'+p.token)} > ${quote(fileFacts.shell.path)}`;
        if('description' in props)expectedArgs.description='Write isolated TEST shell evidence';if('workdir' in props)expectedArgs.workdir=root;
      }
      equal(args,expectedArgs,'unsafe/incorrect semantic tool input');
      const persisted=tools.find(t=>(generation==='v1'?t.callID:t.id)===decision.id);
      if(!persisted||(generation==='v1'?persisted.tool:persisted.name)!==decision.tool||persisted.state?.status!=='completed')throw new Error('persisted tool mismatch');
      equal(persisted.state.input,args,'persisted input mismatch');
      const output=generation==='v1'?persisted.state.output:measuredToolOutput(persisted.state.content);
      if(typeof output!=='string'||!output.trim()||stage===0&&!output.includes(`native-read:${p.token}`))throw new Error('persisted read/result content missing');
      if(stage<2) {
        if(decision.tool!==['read','write'][stage]||!Object.values(args).includes(fileFacts[stage===0?'seed':'write'].path)||stage===1&&args.content!==`native-write:${p.token}\n`)throw new Error('tool file semantic mismatch');
      } else if(!['bash','shell'].includes(decision.tool)||typeof args.command!=='string'||!args.command.includes(fileFacts.shell.path)||!args.command.includes(`native-shell:${p.token}`)||persisted.state.metadata?.exit!==undefined&&persisted.state.metadata.exit!==0)throw new Error('shell semantic mismatch');
      for(let next=stage+1;next<4;next++) {
        const result=wire.requests[next].body.messages.filter((m:any)=>m.role==='tool'&&m.tool_call_id===decision.id);
        if(result.length!==1||typeof result[0].content!=='string'||/error|denied|not found/i.test(result[0].content))throw new Error('native tool result missing/error');
        if(!result[0].content.trim()||stage===0&&!result[0].content.includes(`native-read:${p.token}`))throw new Error('wire read/result content missing');
        if(!result[0].content.includes(output)&&!output.includes(result[0].content))throw new Error('wire vs persisted result mismatch');
      }
    }
  }
}
// V2 persists text part arrays, and forwards their newline-joined text to the wire.
function measuredToolOutput(value:unknown):string {
 if(!Array.isArray(value)||!value.length||value.some(p=>!p||p.type!=='text'||typeof p.text!=='string'))throw new Error('invalid measured tool content');
 return value.map(p=>p.text).join('\n');
}
// Raw V2 /api/config: exactly the owned search directory and selected document.
// Whole-document equality permits only the measured model selector normalization.
export async function validateEffectiveConfig(value:unknown,root:string,configPath:string,config:any) {
  if(configPath!==join(root,'opencode.json'))throw new Error('effective config selected path');
  await canonical(configPath);await canonical(join(root,'config/opencode'));
  if(!Array.isArray(value)||value.length!==2)throw new Error('effective config records');
  const directory=value.find(e=>e?.type==='directory'),document=value.find(e=>e?.type==='document');
  if(!directory||!document||directory.path!==join(root,'config/opencode')||document.path!==configPath)throw new Error('effective config entries mismatch');
  equal(Object.keys(directory).sort(),['path','type'],'effective directory fields');
  equal(Object.keys(document).sort(),['info','path','type'],'effective document fields');
  if(config.model!=='test-model/q0-catalog')throw new Error('effective selected model');
  equal(document.info,{...config,model:{providerID:'test-model',model:'q0-catalog'}},'effective config semantic mismatch');
}
// Native V1 lease IDs in BOTH immutable observations are 40 hex (not 32).
// Only the empty heartbeat and its exact PID-owned metadata companion are transient.
const leaseHeartbeat=/^state\/opencode\/locks\/[0-9a-f]{40}\.lock\/heartbeat$/;
export async function captureSentinelLeases(root:string,pid:number,version:string,files:any[]) {
  if(!['1.16.0','1.18.34'].includes(version))return undefined;
  const heartbeats=files.filter(f=>leaseHeartbeat.test(f.path));
  if(heartbeats.length>1)throw new Error('sentinel lease count limit');
  const leases=[];
  for(const heartbeat of heartbeats) {
    const path=heartbeat.path.replace(/heartbeat$/,'meta.json'),metadata=files.find(f=>f.path===path);
    if(!metadata||metadata.bytes>1024)throw new Error('sentinel lease metadata missing/budget');
    const bytes=await physical(root,join(root,path),metadata.sha256),info=JSON.parse(bytes.toString());
    if(info.pid!==pid||heartbeat.bytes!==0||heartbeat.sha256!==sha(''))throw new Error('foreign sentinel lease');
    leases.push({heartbeat:heartbeat.path,metadata:path,rawBase64:bytes.toString('base64')});
  }
  return {kind:'native-v1-owned-transient-lease',version,leases};
}
async function sentinelTransientPaths(sentinel:any):Promise<Set<string>> {
  const paths=new Set<string>(),receipt=sentinel.transientLeases;
  if(receipt===undefined)return paths;
  if(receipt.kind!=='native-v1-owned-transient-lease'||!['1.16.0','1.18.34'].includes(receipt.version)||!Array.isArray(receipt.leases)||receipt.leases.length>1)throw new Error('unknown sentinel lease classification');
  const identity=JSON.parse(await readFile(join(sentinel.evidence,'native-identity.json'),'utf8'));
  if(identity.pid!==sentinel.pid||identity.identity?.version!==receipt.version)throw new Error('sentinel lease native identity');
  equal(identity.birth,sentinel.birth,'sentinel lease birth');
  for(const lease of receipt.leases) {
    if(typeof lease.heartbeat!=='string'||!leaseHeartbeat.test(lease.heartbeat)||lease.metadata!==lease.heartbeat.replace(/heartbeat$/,'meta.json')||typeof lease.rawBase64!=='string')throw new Error('malformed sentinel lease path');
    await canonical(join(sentinel.root,'state/opencode/locks'));
    if([lease.heartbeat,lease.metadata].some(path=>sentinel.beforeFiles.filter((f:any)=>f.path===path).length!==1))throw new Error('duplicate sentinel lease inventory');
    const heartbeat=sentinel.beforeFiles.find((f:any)=>f.path===lease.heartbeat),metadata=sentinel.beforeFiles.find((f:any)=>f.path===lease.metadata),bytes=Buffer.from(lease.rawBase64,'base64');
    if(!heartbeat||heartbeat.bytes!==0||heartbeat.sha256!==sha('')||!metadata||metadata.bytes!==bytes.length||bytes.length>1024||sha(bytes)!==metadata.sha256)throw new Error('sentinel lease inventory binding');
    const info=JSON.parse(bytes.toString());
    equal(Object.keys(info).sort(),['createdAt','hostname','pid','token'],'sentinel lease metadata fields');
    if(info.pid!==sentinel.pid||typeof info.token!=='string'||! /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(info.token)||typeof info.hostname!=='string'||!info.hostname||!Number.isFinite(Date.parse(info.createdAt)))throw new Error('foreign sentinel lease owner');
    for(const path of [lease.heartbeat,lease.metadata]) {
      const after=sentinel.afterFiles.filter((f:any)=>f.path===path);
      if(after.length>1||after.length===1&&!sentinel.beforeFiles.some((f:any)=>f.path===path&&f.sha256===after[0].sha256&&f.bytes===after[0].bytes))throw new Error('sentinel lease changed before drain');
      paths.add(path);
    }
    // Exact classified directory must disappear after the already-validated PID/birth drain.
    try {await lstat(join(sentinel.root,lease.heartbeat.replace(/\/heartbeat$/,'')));throw new Error('sentinel lease not drained');}
    catch(e:any) {if(e.code!=='ENOENT')throw e;}
  }
  return paths;
}
export async function validateSentinel(sentinel:any,root:string,marker:any) {
  if(!sentinel||!Number.isSafeInteger(sentinel.pid)||sentinel.pid<=0||sentinel.birth?.format!=='linux-start-ticks'||!/^\d+$/.test(sentinel.birth.value)||typeof sentinel.birth.bootId!=='string'||!sentinel.birth.bootId)throw new Error('sentinel birth unknown');
  equal(sentinel.before,sentinel.after,'native sentinel changed');
  if(sentinel.root===root||within(root,sentinel.root)||typeof sentinel.root!=='string'||!sentinel.root.split('/').at(-1)?.startsWith('TEST-')||within(SOURCE,sentinel.root)&&!within(join(SOURCE,'.task-output/unit-roots'),sentinel.root))throw new Error('foreign sentinel');
  if(typeof sentinel.evidence!=='string'||within(root,sentinel.evidence)||within(sentinel.root,sentinel.evidence)||sentinel.evidence===sentinel.root)throw new Error('foreign sentinel evidence');
  await canonical(sentinel.root);await canonical(sentinel.evidence);
  const sentinelMarker=JSON.parse(await readFile(join(sentinel.root,'.test-project-owner.json'),'utf8'));
  equal(sentinelMarker,JSON.parse(await readFile(join(sentinel.evidence,'.test-project-owner.json'),'utf8')),'sentinel owner mismatch');
  if(sentinelMarker.task!==TASK||sentinelMarker.case!=='S0-native-sentinel'||!sentinelMarker.nonce||sentinelMarker.root!==sentinel.root||sentinelMarker.evidence!==sentinel.evidence||sentinelMarker.nonce===marker.nonce)throw new Error('sentinel authority mismatch');
  if(sentinel.before.directory!==sentinel.root||sentinel.cleanup?.pid!==sentinel.pid||!sentinel.cleanup?.cleanup?.some((c:any)=>c.pid===sentinel.pid&&['drained','forced-drained'].includes(c.result))||sentinel.cleanup.cleanup.some((c:any)=>!['drained','forced-drained','absent-or-changed'].includes(c.result)||!c.birth||!Number.isSafeInteger(c.pid)))throw new Error('sentinel cleanup unknown');
  equal(sentinel.cleanup.cleanup.find((c:any)=>c.pid===sentinel.pid).birth,sentinel.birth,'sentinel ledger birth mismatch');
  equal(sentinel.cleanup.birth,sentinel.birth,'sentinel cleanup birth mismatch');
  if(!Array.isArray(sentinel.beforeFiles)||!Array.isArray(sentinel.afterFiles))throw new Error('native sentinel inventory missing');
  const transient=await sentinelTransientPaths(sentinel);
  for(const f of sentinel.beforeFiles)if(!f.path.startsWith('data/')&&!f.path.startsWith('cache/')&&!transient.has(f.path))await physical(sentinel.root,join(sentinel.root,f.path),f.sha256);
  for(const f of sentinel.beforeFiles.filter((f:any)=>!f.path.startsWith('data/')&&!f.path.startsWith('cache/')&&!transient.has(f.path)))if(!sentinel.afterFiles.some((g:any)=>g.path===f.path&&g.sha256===f.sha256))throw new Error('sentinel physical inventory changed');
}
