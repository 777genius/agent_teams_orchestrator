import {test,expect,afterAll,spyOn} from 'bun:test';
import {mkdtemp,rm,readFile,writeFile,readdir,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {Sandbox,SOURCE,sha,isolatedEnvironment} from './sandbox';
import {nativeChildEnvironment} from './native';
import {collectTranscript,validatePages,transcriptPath,waitCatalog} from './collections';
import {decodeProtocol,validateRoundtrip,validateProtocol,loadTrust,OWNER_BASE,ACCEPTED_PLAN_SHA256,ACCEPTED_AMENDMENT_SHA256} from './protocol';
import {qualifyS3a,configFor} from './model';
import {qualifyProtocolObservation,seal,finalizeQualification} from './evidence';
import {observationSubject,acceptObservation,writeQualificationOutput} from './acceptance';
import {nativeSentinelReceipt} from './native';
import {validateSentinel,captureSentinelLeases,validateEffectiveConfig} from './protocol';
import {ANCHORS} from './artifacts';
const base=await mkdtemp(join(SOURCE,'.task-output/unit-roots/recipe-'));
afterAll(()=>rm(base,{recursive:true,force:true}));
const fresh=(id:string,caseID='S3a')=>Sandbox.create(join(base,'TEST-'+id),join(base,'evidence-'+id),caseID);
test('native child spawn receives dummy key; fresh env maps never inherit hostile options',async()=>{
 const s=await fresh('env'),old=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='TEST-AMBIENT';
 try {
  s.env().TEST_Q0_MODEL_API_KEY='lost mutation';
  const child=Bun.spawn(['/usr/bin/env'],{cwd:s.root,env:nativeChildEnvironment(s,'TEST-DUMMY-KEY'),stdout:'pipe'});
  const output=await new Response(child.stdout).text();expect(await child.exited).toBe(0);
  expect(output).toContain('TEST_Q0_MODEL_API_KEY=TEST-DUMMY-KEY');expect(output).not.toContain('TEST-AMBIENT');
  expect(s.env()).not.toHaveProperty('TEST_Q0_MODEL_API_KEY');
  expect(()=>nativeChildEnvironment(s,'secret' as any)).toThrow('dummy');
 }finally{if(old===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=old;}
});
const row=(id:string)=>({id,type:'assistant',content:[]});
test('cursor collector records actual empty end and opaque no-order continuation queries',async()=>{
 const observed:string[]=[],receipts:any[]=[];
 const responses=[{data:[row('one')],cursor:{next:'a+/= ?'}},{data:[]}];
 const result=await collectTranscript(async path=>{observed.push(path);return responses.shift();},'session/ID',async p=>{receipts.push(...p);});
 expect(result.map(m=>m.id)).toEqual(['one']);expect(observed).toEqual([transcriptPath('session/ID'),transcriptPath('session/ID','a+/= ?')]);
 expect(new URL(observed[1],'http://unit.test').searchParams.get('cursor')).toBe('a+/= ?');
 expect(new URL(observed[1],'http://unit.test').searchParams.has('order')).toBe(false);expect(receipts.at(-1).response.data).toEqual([]);
});
for(const [name,responses] of Object.entries({missing:[{data:[row('a')]}],emptyCursor:[{data:[row('a')],cursor:{next:''}}],nonstring:[{data:[row('a')],cursor:{next:1}}],duplicate:[{data:[row('a')],cursor:{next:'x'}},{data:[row('a')],cursor:{next:'y'}}],cycle:[{data:[row('a')],cursor:{next:'x'}},{data:[row('b')],cursor:{next:'x'}}],badRow:[{data:[{}],cursor:{next:'x'}}]})) {
 test('pagination rejects '+name+' and retains raw incomplete receipts',async()=>{
  const retained:any[]=[];let n=0;
  await expect(collectTranscript(async()=>responses[n++], 's',async p=>{retained.push(...p);})).rejects.toThrow();expect(retained.length).toBeGreaterThan(0);
 });
}
test('pagination budget exhaustion and cancellation cannot authorize completeness',async()=>{
 let n=0;const retained:any[]=[];
 await expect(collectTranscript(async()=>({data:[row('m'+n)],cursor:{next:'c'+n++}}),'s',async p=>{retained.push(...p);})).rejects.toThrow('count budget');
 expect(retained.length).toBe(100);
 const c=new AbortController();c.abort();await expect(collectTranscript(async()=>{throw Error('must not request');},'s',async()=>{},c.signal)).rejects.toThrow();
 await expect(collectTranscript(async()=>({data:[]}),'s',async()=>{},undefined,0)).rejects.toThrow('deadline');
 expect(()=>validatePages([{path:transcriptPath('s'),response:{data:[row('a')],cursor:{next:'b'}},elapsedMs:0,budgetMs:20000}],'s')).toThrow('empty');
});
test('catalog waits for provider AND upstream, retains raw timeline/error and deadline',async()=>{
 let n=0,receipt:any;
 const model={id:'q0-catalog',providerID:'test-model',modelID:'q0-upstream'};
 const catalog=await waitCatalog(async(_path,timeout)=>{expect(timeout).toBeLessThanOrEqual(1000);if(n++===0)throw Error('not ready');return {data:[n===2?{...model,modelID:'wrong'}:model]};},'v2',async r=>{receipt=r;});
 expect(catalog).toEqual({data:[model]});expect(receipt.timeline.length).toBe(3);expect(receipt.timeline[0].error).toContain('not ready');
 await expect(waitCatalog(async()=>({data:[]}), 'v2',async r=>{receipt=r;},undefined,30)).rejects.toThrow('deadline');
 expect(receipt.elapsedMs).toBeLessThan(300);expect(receipt.lastError).toContain('absent');
 const c=new AbortController();await expect(waitCatalog(async()=>{c.abort(Error('cancelled'));return {data:[]};},'v2',async()=>{},c.signal)).rejects.toThrow('cancelled');
});
test('fixture setup error after listener creation disposes the owned listener before sealing',async()=>{
 const s=await fresh('early-cleanup');await writeFile(join(s.root,'opencode.json'),'existing TEST config');
 await expect(qualifyS3a(s,ANCHORS[0],{} as any,'')).rejects.toThrow('EEXIST');
 const startup=JSON.parse(await readFile(join(s.evidence,'model-fixture-startup.json'),'utf8'));
 const probe=Bun.serve({hostname:'127.0.0.1',port:Number(new URL(startup.url).port),fetch:()=>new Response('unit disposal probe')});
 probe.stop(true);
 const cleanup=JSON.parse(await readFile(join(s.evidence,'cleanup.json'),'utf8'));
 expect(cleanup.modelFixtureStopped).toBe(true);expect(cleanup.nativeHostStopped).toBe(false);
 expect(await readFile(join(s.root,'opencode.json'),'utf8')).toBe('existing TEST config');
});
test('union decoder rejects mixed modes and invented inner identities; caller trust must be independent',async()=>{
 const p:any={schemaVersion:2,case:'S3a',status:'MISSING',ownerBase:'6132299836a89e58d633a0557e504243035e806b',planSha256:'0'.repeat(64),amendmentSha256:'1'.repeat(64),amendmentID:'a',sessionID:'s',terminalMessageID:'t',token:'q',nativeToolIDs:['a','b','c'],authority:{endpointEpoch:'unit'},auth:{},files:{},provenance:{mode:'native-bundled',route:{providerID:'test-model',catalogModelID:'q0-catalog',upstreamModelID:'q0-upstream',configuredSelector:'@ai-sdk/openai-compatible',reportedSelector:null,logicalImplementation:'native-openai-compatible-branch',executedModuleImportProved:false,configByteSha256Before:'0'.repeat(64),configByteSha256After:'0'.repeat(64)}}};
 for(const k of ['innerNpmName','innerNpmVersion','innerNpmSri'])p.provenance[k]={status:'unavailable',reason:'native-bundle-no-inner-npm-manifest'};
 const unitRef={file:'unit.json',sha256:'2'.repeat(64)};
 for(const k of ['producerSourceManifest','wire','transcript','sessionCreated','promptReceipt','cleanup'])p[k]=unitRef;
 for(const k of ['enclosing','inventory'])p.provenance[k]=unitRef;
 for(const k of ['ownerMarker','nativeIdentity','process','location','modelHost'])p.authority[k]=unitRef;
 p.auth.childEnvironment=unitRef;for(const k of ['seed','write','shell'])p.files[k]=unitRef;
 for(const k of ['configBefore','configAfter','modelCatalog','resolverEvidence','reviewAcceptance'])p.provenance.route[k]=unitRef;
 expect(decodeProtocol(p).status).toBe('MISSING');p.provenance.sdk={};expect(()=>decodeProtocol(p)).toThrow('mixed');delete p.provenance.sdk;
 p.provenance.innerNpmVersion={status:'available',value:'1.16.0'};expect(()=>decodeProtocol(p)).toThrow('invented');
 const s=await fresh('trust');await s.record('trust.json',{claim:'trust'});
 await expect(loadTrust({path:join(s.evidence,'trust.json'),sha256:sha(await readFile(join(s.evidence,'trust.json')))},s.root,s.evidence)).rejects.toThrow('own trust');
});
test('semantic join rejects count-preserving model, tool, terminal, usage and physical tampering',async()=>{
 const s=await fresh('join'),dir=join(SOURCE,'test/fixtures/opencode-generation-native/v1-1.16.0');
 const read=async(n:string)=>JSON.parse(await readFile(join(dir,n),'utf8'));
 const wire=await read('model-wire.json'),messages=await read('native-transcript.json');
 const token=messages.at(-1).parts.find((t:any)=>t.type==='text').text.slice('q0-terminal:'.length);
 const data:any={wire,messages,created:await read('native-session-created.json'),prompt:await read('native-prompt-receipt.json')};
 const files:any={};for(const [k,prefix] of [['seed','native-read'],['write','native-write'],['shell','native-shell']]) {
  const path=join(s.root,k+'.txt');await writeFile(path,`${prefix}:${token}\n`);data[k]={path,sha256:sha(await readFile(path))};files[k]={file:k};
 }
 const oldRoot=data.created.directory;
 const replace=(v:any):any=>typeof v==='string'?v.replaceAll(oldRoot+'/q0-seed.txt',data.seed.path).replaceAll(oldRoot+'/q0-written.txt',data.write.path).replaceAll(oldRoot+'/q0-shell.txt',data.shell.path).replaceAll(oldRoot,s.root):Array.isArray(v)?v.map(replace):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,replace(x)])):v;
 data.wire=replace(wire);data.messages=replace(messages);
 for(let i=0;i<3;i++) {
  const chunks=wire.streamedFrames[i].slice(0,-1).map((f:string)=>JSON.parse(f.slice(6,-2)));
  const calls=chunks.flatMap((c:any)=>c.choices.flatMap((choice:any)=>choice.delta.tool_calls??[]));
  const args=JSON.stringify(replace(JSON.parse(calls.map((c:any)=>c.function?.arguments??'').join('')))),mid=Math.floor(args.length/2);
  calls[1].function.arguments=args.slice(0,mid);calls[2].function.arguments=args.slice(mid);
  data.wire.streamedFrames[i]=[...chunks.map((c:any)=>'data: '+JSON.stringify(c)+'\n\n'),'data: [DONE]\n\n'];
 }

 for(let i=0;i<3;i++) {
  const d=data.wire.decisions[i],previous=d.id;d.id='call_'+sha(JSON.stringify({stage:i,args:d.args})).slice(0,24);
  data.wire=JSON.parse(JSON.stringify(data.wire).replaceAll(previous,d.id));data.messages=JSON.parse(JSON.stringify(data.messages).replaceAll(previous,d.id));
 }
 const p:any={sessionID:data.created.id,terminalMessageID:messages.at(-1).info.id,token,nativeToolIDs:data.wire.decisions.map((d:any)=>d.id),wire:{file:'wire'},transcript:{file:'messages'},sessionCreated:{file:'created'},promptReceipt:{file:'prompt'},files};
 const validate=()=>validateRoundtrip(p,{root:s.root,generation:'v1',ref:async r=>data[r.file]});
 await validate();
 const artifact:any={binary:join(s.root,'artifacts/unit-binary'),sha256:sha('unit binary'),generation:'v1',version:'1.16.0',packages:[{metadataSha256:'a',archiveSha256:'b'},{metadataSha256:'c',archiveSha256:'d',archiveSri:'unit'}]};
 await writeFile(artifact.binary,'unit binary');data.enclosing=artifact;
 const configPath=join(s.root,'opencode.json'),config=configFor(ANCHORS[0],'http://127.0.0.1:32126/v1');await writeFile(configPath,JSON.stringify(config));
 const configBytes=await readFile(configPath),fingerprint=sha(configBytes);
 data.before={configPath,config,fingerprint,rawBase64:configBytes.toString('base64')};data.after={config,fingerprint,rawBase64:configBytes.toString('base64')};
 data.catalog={all:[{id:'test-model',options:{baseURL:'http://127.0.0.1:32126/v1'},models:{'q0-catalog':{id:'q0-catalog',api:{id:'q0-upstream',npm:'@ai-sdk/openai-compatible'}}}}]};
 data.marker=s.marker;data.env={...isolatedEnvironment(s.root),TEST_Q0_MODEL_API_KEY:'TEST-DUMMY-KEY'};data.location={directory:s.root};
 const birth={format:'linux-start-ticks',value:'1',bootId:'unit-boot'};
 data.identity={executable:artifact.binary,sha256:artifact.sha256,identity:{version:'1.16.0'},pid:123,birth,port:32127,environmentKeyNames:Object.keys(data.env)};
 data.process={args:[artifact.binary],pid:123,birth,port:32127,auth:{epoch:'unit-epoch',endpoint:'http://127.0.0.1:32127',pid:123,birth},cleanup:[{pid:123,birth,result:'drained'}]};
 data.host={root:s.root,owner:s.marker.nonce,url:'http://127.0.0.1:32126/v1'};data.inventory=[];
 data.resolver={binarySha256:artifact.sha256,selectedExternalResolution:null,ranges:[{start:0,end:11,base64:Buffer.from('unit binary').toString('base64')}]};
 data.review={ruleID:'unit-rule',binarySha256:artifact.sha256,completeDispatchReview:true};
 const sentinel=await fresh('join-sentinel','S0-native-sentinel');
 data.cleanup={ownedPidDrained:true,sentinelUnchanged:true,modelFixtureStopped:true,nativeHostStopped:true,errors:[],nativeSentinel:{root:sentinel.root,evidence:sentinel.evidence,pid:456,birth,cleanup:{pid:456,birth,cleanup:[{pid:456,birth,result:'drained'}]},before:{directory:sentinel.root},after:{directory:sentinel.root},beforeFiles:[],afterFiles:[]}};
 const sourceFiles=['scripts/opencode-generation-contract-spike.ts',...(await readdir(join(SOURCE,'scripts/opencode-generation-spikes'))).sort().map(n=>'scripts/opencode-generation-spikes/'+n)];
 data.source={ownerBase:OWNER_BASE,files:await Promise.all(sourceFiles.map(async path=>({path,sha256:sha(await readFile(join(SOURCE,path)))})))};
 const reference=(file:string)=>({file,sha256:sha(JSON.stringify(data[file]))});
 const route:any={configuredSelector:'@ai-sdk/openai-compatible',reportedSelector:null,logicalImplementation:'native-openai-compatible-branch',providerID:'test-model',catalogModelID:'q0-catalog',upstreamModelID:'q0-upstream',modelBaseURL:data.host.url,configPath,configByteSha256Before:fingerprint,configByteSha256After:fingerprint,configBefore:reference('before'),configAfter:reference('after'),modelCatalog:reference('catalog'),resolverEvidence:reference('resolver'),reviewAcceptance:reference('review'),ruleID:'unit-rule',executedModuleImportProved:false};
 const unavailable={status:'unavailable',reason:'native-bundle-no-inner-npm-manifest'};
 const packet:any={...p,schemaVersion:2,case:'S3a',status:'MISSING',ownerBase:OWNER_BASE,planSha256:ACCEPTED_PLAN_SHA256,amendmentSha256:ACCEPTED_AMENDMENT_SHA256,amendmentID:'unit-amendment',producerSourceManifest:reference('source'),provenance:{mode:'native-bundled',enclosing:reference('enclosing'),inventory:reference('inventory'),route,innerNpmName:unavailable,innerNpmVersion:unavailable,innerNpmSri:unavailable},authority:{ownerMarker:reference('marker'),nativeIdentity:reference('identity'),process:reference('process'),location:reference('location'),modelHost:reference('host'),endpointEpoch:'unit-epoch',canonicalDirectory:s.root},auth:{source:'test-dummy',childEnvironment:reference('env'),requestAuthorizationChecked:true,ambientCredentialsExcluded:true},cleanup:reference('cleanup')};
 for(const k of ['wire','transcript','sessionCreated','promptReceipt'])packet[k]=reference(packet[k].file);
 for(const k of ['seed','write','shell'])packet.files[k]=reference(k);
 const access:any={root:s.root,dir:s.evidence,generation:'v1',version:'1.16.0',marker:s.marker,artifact,ref:async(r:any)=>data[r.file]};
 expect(await validateProtocol(decodeProtocol(packet),access)).toBe(false);
 for(const change of [()=>{data.env.OPENAI_API_KEY='ambient';},()=>{data.catalog.all[0].models['q0-catalog'].api.id='wrong';},()=>{data.review.completeDispatchReview=false;},()=>{data.resolver.ranges[0].base64=Buffer.from('wrong').toString('base64');},()=>{data.process.auth.epoch='foreign';},()=>{data.cleanup.errors=['host dispose failed'];},()=>{data.before.rawBase64=Buffer.from('{}').toString('base64');}]) {
  const saved=structuredClone(data);change();await expect(validateProtocol(packet,access)).rejects.toThrow();Object.assign(data,saved);
 }
 const trust:any={schemaVersion:1,ownerBase:OWNER_BASE,planSha256:packet.planSha256,amendmentSha256:packet.amendmentSha256,amendmentID:packet.amendmentID,sourceManifestSha256:packet.producerSourceManifest.sha256,pins:{}};
 expect(await validateProtocol(packet,access,trust)).toBe(false);
 trust.pins['1.16.0']={binarySha256:artifact.sha256,rootMetadataSha256:'substituted',platformMetadataSha256:'c',rootArchiveSha256:'b',platformArchiveSha256:'d',platformSri:'unit'};
 await expect(validateProtocol(packet,access,trust)).rejects.toThrow('controller native artifact');
 trust.pins['1.16.0']={binarySha256:artifact.sha256,rootMetadataSha256:'a',platformMetadataSha256:'c',rootArchiveSha256:'b',platformArchiveSha256:'d',platformSri:'unit',rule:{id:route.ruleID,mode:'native-bundled',configuredSelector:route.configuredSelector,reportedSelector:route.reportedSelector,logicalImplementation:route.logicalImplementation,resolverSha256:route.resolverEvidence.sha256,acceptanceSha256:route.reviewAcceptance.sha256,baseURLRequired:true,completeDispatchReview:true}};
 packet.observationKind='fresh-pending-acceptance';
 const producedRoot=await fresh('producer-pending'),resolverPath=join(base,'unit-resolver.json'),reviewPath=join(base,'unit-review.json');
 await writeFile(resolverPath,JSON.stringify(data.resolver));await writeFile(reviewPath,JSON.stringify(data.review));
 const names:any={'native-provider-config.json':'before','native-provider-config-after.json':'after','native-process.json':'process','native-transcript.json':'messages','native-artifact-integrity.json':'enclosing','provider-inventory.json':'inventory','native-model-catalog.json':'catalog','native-identity.json':'identity','native-location.json':'location','model-fixture-startup.json':'host','native-child-environment.json':'env','native-session-created.json':'created','native-prompt-receipt.json':'prompt','model-wire.json':'wire','physical-seed.json':'seed','physical-write.json':'write','physical-shell.json':'shell','cleanup.json':'cleanup'};
 for(const [name,key] of Object.entries(names))await producedRoot.record(name,data[key as string]);
 await producedRoot.record('provider-protocol-authenticity.json',{sessionID:packet.sessionID,terminalMessageID:packet.terminalMessageID,decisions:data.wire.decisions});
 const producerTrust=structuredClone(trust);producerTrust.sourceManifestSha256=sha(JSON.stringify(data.source,null,2)+'\n');Object.assign(producerTrust.pins['1.16.0'].rule,{resolverPath,acceptancePath:reviewPath});
 const producerTrustPath=join(base,'unit-producer-trust.json');await writeFile(producerTrustPath,JSON.stringify(producerTrust));
 const {produceProtocol}=await import('./producer');const produced=await produceProtocol(producedRoot,ANCHORS[0],{path:producerTrustPath,sha256:sha(JSON.stringify(producerTrust))});
 expect(produced.status).toBe('MISSING');expect(produced.observationKind).toBe('fresh-pending-acceptance');
 expect(JSON.parse(await readFile(join(producedRoot.evidence,'provider-protocol-authenticity.json'),'utf8'))).toEqual(produced);
 for(const [name,value] of Object.entries(data))await s.recordRaw(name,Buffer.from(JSON.stringify(value)));
 await s.record('provider-protocol-authenticity.json',packet);
 const report=await seal(s,'S3a','v1','1.16.0','MISSING','awaiting-independent-acceptance');
 const packetBytes=await readFile(join(s.evidence,'provider-protocol-authenticity.json')),sealBytes=await readFile(join(s.evidence,'case-report.json'));
 const diskAccess={...access,bytes:async(r:any)=>{const b=await readFile(join(s.evidence,r.file));if(sha(b)!==r.sha256)throw Error('unit sealed reference changed');return b;},ref:async(r:any)=>JSON.parse((await diskAccess.bytes(r)).toString())};
 const qualify=async(accepted?:any)=>{
  const spawn=spyOn(Bun,'spawn').mockImplementation(()=>{throw Error('replay attempted launch');}),serve=spyOn(Bun,'serve').mockImplementation(()=>{throw Error('replay attempted listener');}),create=spyOn(Sandbox,'create').mockImplementation(()=>{throw Error('replay attempted new root');});
  try {return await qualifyProtocolObservation(packet,diskAccess,report,packetBytes,sealBytes,trust,accepted);}finally{expect(spawn).toHaveBeenCalledTimes(0);expect(serve).toHaveBeenCalledTimes(0);expect(create).toHaveBeenCalledTimes(0);spawn.mockRestore();serve.mockRestore();create.mockRestore();}
 };
 const pending=await qualify();expect(pending.observationStatus).toBe('MISSING');expect(pending.qualificationStatus).toBe('MISSING');
 const acceptancePath=join(base,'controller-acceptance.json'),accepted={schemaVersion:1,kind:'fresh-schema2-observation-acceptance',decision:'accepted',subject:pending.subject};
 const acceptanceBytes=Buffer.from(JSON.stringify(accepted));await writeFile(acceptancePath,acceptanceBytes);const input={path:acceptancePath,sha256:sha(acceptanceBytes)};
 const derived=await qualify(input);expect(derived.observationStatus).toBe('MISSING');expect(derived.qualificationStatus).toBe('PASS');expect(await qualify(input)).toEqual(derived);
 for(const key of Object.keys(pending.subject)) {const wrong={...pending.subject,[key]:'foreign'};await expect(acceptObservation(input,wrong)).rejects.toThrow('subject');}
 await expect(qualify({...input,sha256:'0'.repeat(64)})).rejects.toThrow('digest');
 await expect(qualify({path:join(s.evidence,'controller.json'),sha256:input.sha256})).rejects.toThrow('producer');
 await expect(s.record('case-report.json',{status:'PASS'})).rejects.toThrow('immutable');await expect(seal(s,'S3a','v1','1.16.0','PASS','forged')).rejects.toThrow();
 const saved=await readFile(join(s.evidence,'env'));await writeFile(join(s.evidence,'env'),'{}');await expect(qualify(input)).rejects.toThrow();await writeFile(join(s.evidence,'env'),saved);
 const oldModel=await readFile(join(s.evidence,'catalog')),brokenCatalog=JSON.parse(oldModel.toString());brokenCatalog.all[0].models['q0-catalog'].api.id='wrong';
 await writeFile(join(s.evidence,'catalog'),JSON.stringify(brokenCatalog));const rebound=structuredClone(packet);rebound.provenance.route.modelCatalog.sha256=sha(JSON.stringify(brokenCatalog));
 await expect(qualifyProtocolObservation(rebound,diskAccess,report,Buffer.from(JSON.stringify(rebound)),sealBytes,trust,input)).rejects.toThrow('catalog');await writeFile(join(s.evidence,'catalog'),oldModel);
 const oldSource=trust.sourceManifestSha256;trust.sourceManifestSha256='0'.repeat(64);await expect(qualify(input)).rejects.toThrow('source');trust.sourceManifestSha256=oldSource;
 const oldRule=trust.pins['1.16.0'].rule;delete trust.pins['1.16.0'].rule;expect((await qualify(input)).qualificationStatus).toBe('MISSING');trust.pins['1.16.0'].rule=oldRule;
 const oldPacket={...packet};delete oldPacket.observationKind;const oldReport={...report};delete oldReport.observationKind;
 const historical=await qualifyProtocolObservation(oldPacket,diskAccess,oldReport,Buffer.from(JSON.stringify(oldPacket)),Buffer.from(JSON.stringify(oldReport)),trust,input);expect(historical.qualificationStatus).toBe('MISSING');
 await writeQualificationOutput(join(base,'qualification.json'),{...report,...derived});await writeQualificationOutput(join(base,'qualification.json'),{...report,...derived});await expect(writeQualificationOutput(join(s.evidence,'qualification.json'),{...report,...derived})).rejects.toThrow('inside');
 expect(await readFile(join(s.evidence,'provider-protocol-authenticity.json'))).toEqual(packetBytes);expect(await readFile(join(s.evidence,'case-report.json'))).toEqual(sealBytes);
 const external={...packet,provenance:{mode:'externally-resolved-sdk',enclosing:reference('enclosing'),inventory:reference('inventory'),route,sdk:{name:'@ai-sdk/openai-compatible',version:'1.0.0',path:'cache/unused'},selectedResolution:reference('review')}};
 await expect(validateProtocol(decodeProtocol(external),access)).rejects.toThrow('provider package');
 for(const change of [()=>{data.wire.requests[0].body.model='wrong';},()=>{data.messages.at(-1).info.finish='tool-calls';},()=>{data.messages.at(-1).info.tokens.input=18;},()=>{data.wire.requests[1].body.messages.find((m:any)=>m.role==='tool').tool_call_id='wrong';},()=>{data.messages.flatMap((m:any)=>m.parts).find((t:any)=>t.type==='tool').state.status='running';}]) {
  const saved=structuredClone(data);change();await expect(validate()).rejects.toThrow();Object.assign(data,saved);
 }
 await writeFile(data.write.path,'tampered');await expect(validate()).rejects.toThrow('physical');
});
test('producer cannot classify an unused cache or empty inventory without independent rule input',async()=>{
 const {produceProtocol}=await import('./producer');const s=await fresh('producer-untrusted');
 await s.record('provider-inventory.json',[{name:'@ai-sdk/openai-compatible',version:'1.0.0',path:'cache/unused'}]);
 await expect(produceProtocol(s,ANCHORS[0])).rejects.toThrow('MISSING');
 await expect(readFile(join(s.evidence,'provider-protocol-authenticity.json'))).rejects.toMatchObject({code:'ENOENT'});
 await s.record('provider-inventory.json',[]);await expect(produceProtocol(s,ANCHORS[0])).rejects.toThrow('MISSING');
});

for(const version of ['2.0.0','2.0.21']) {
 test('measured V2 '+version+' raw rows flatten without alteration and semantic substitutions reject',async()=>{
  const s=await fresh('v2-'+version),dir=join(SOURCE,'test/fixtures/opencode-generation-native','v2-'+version);
  const read=async(n:string)=>JSON.parse(await readFile(join(dir,n),'utf8'));
  const messages=await read('native-transcript.json'),rawPages=await read('native-transcript-pages.json');
  const pages=rawPages.map((response:any,i:number)=>({response,path:transcriptPath(response.data[0]?.sessionID??messages[0].sessionID??'',i?rawPages[i-1].cursor?.next:undefined),elapsedMs:i,budgetMs:20000}));
  const created=await read('native-session-created.json'),session=created.data;
  pages.forEach((p:any,i:number)=>{p.path=transcriptPath(session.id,i?rawPages[i-1].cursor?.next:undefined);});
  expect(validatePages(pages,session.id)).toEqual(messages);
  const originalBytes=JSON.stringify(messages);let n=0,retained:any;
  expect(await collectTranscript(async()=>pages[n++].response,session.id,async p=>{retained=p;})).toEqual(messages);
  expect(retained.map((p:any)=>p.response)).toEqual(pages.map((p:any)=>p.response));expect(JSON.stringify(messages)).toBe(originalBytes);
  for(const change of [(m:any[])=>{m[0].text=undefined;},(m:any[])=>{m[0].content=[];},(m:any[])=>{m[1].content=undefined;},(m:any[])=>{m[0].type='unknown';}]) {
   const broken=structuredClone(pages);change(broken[0].response.data);expect(()=>validatePages(broken,session.id)).toThrow();
  }
  if(version==='2.0.0') {const broken=structuredClone(pages);broken[0].response.data.push({id:'idle',type:'idle',time:{created:1},outcome:'succeeded'});expect(()=>validatePages(broken,session.id,version)).toThrow();}
  const wire=await read('model-wire.json'),token=messages.find((m:any)=>m.finish==='stop').content.find((p:any)=>p.type==='text').text.slice('q0-terminal:'.length);
  const oldRoot=session.location.directory,data:any={wire,messages,created,prompt:await read('native-prompt-receipt.json'),pages};
  const replace=(v:any):any=>typeof v==='string'?v.replaceAll(oldRoot,s.root):Array.isArray(v)?v.map(replace):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,replace(x)])):v;
  Object.assign(data,replace(data));const files:any={};
  for(const [key,name,prefix] of [['seed','q0-seed.txt','native-read'],['write','q0-written.txt','native-write'],['shell','q0-shell.txt','native-shell']]) {const path=join(s.root,name);await writeFile(path,`${prefix}:${token}\n`);data[key]={path,sha256:sha(await readFile(path))};files[key]={file:key};}
  for(let stage=0;stage<3;stage++) {
   const d=data.wire.decisions[stage],previous=d.id;d.id='call_'+sha(JSON.stringify({stage,args:d.args})).slice(0,24);
   Object.assign(data,JSON.parse(JSON.stringify(data).replaceAll(previous,d.id)));
   const chunks=data.wire.streamedFrames[stage].slice(0,-1).map((f:string)=>JSON.parse(f.slice(6,-2))),calls=chunks.flatMap((c:any)=>c.choices.flatMap((x:any)=>x.delta.tool_calls??[]));
   const args=JSON.stringify(d.args),mid=Math.floor(args.length/2);calls[1].function.arguments=args.slice(0,mid);calls[2].function.arguments=args.slice(mid);
   data.wire.streamedFrames[stage]=[...chunks.map((c:any)=>'data: '+JSON.stringify(c)+'\n\n'),'data: [DONE]\n\n'];
  }
  data.pages[0].response.data=data.messages;
  const p:any={sessionID:session.id,terminalMessageID:data.messages.find((m:any)=>m.finish==='stop').id,token,nativeToolIDs:data.wire.decisions.map((d:any)=>d.id),wire:{file:'wire'},transcript:{file:'messages'},transcriptPages:{file:'pages'},sessionCreated:{file:'created'},promptReceipt:{file:'prompt'},files};
  const validate=async()=>{
   for(const [name,value] of Object.entries(data))await s.recordRaw(name,Buffer.from(JSON.stringify(value)));
   for(const r of [p.wire,p.transcript,p.transcriptPages,p.sessionCreated,p.promptReceipt,...Object.values(p.files)] as any[])r.sha256=sha(await readFile(join(s.evidence,r.file)));
   await s.record('authored-unit-scope.json',{unitOnly:true,nativeQualification:false,pin:version});await seal(s,'S3a','v2',version,'MISSING','resealed authored semantic fixture');
   return validateRoundtrip(p,{root:s.root,generation:'v2',version,ref:async r=>{const bytes=await readFile(join(s.evidence,r.file));expect(sha(bytes)).toBe(r.sha256);return JSON.parse(bytes.toString());}});
  };
  await validate();
  for(const change of [()=>{data.messages[1].model.id='wrong';},()=>{data.messages[1].model.providerID='wrong';},...[1,2,3].map(next=>()=>{const result=data.wire.requests[next].body.messages.find((m:any)=>m.role==='tool'&&m.tool_call_id===p.nativeToolIDs[0]);result.content='nonempty unrelated';}),...['', 'coupled unrelated substitution'].map(value=>()=>{
   const tool=data.messages.flatMap((m:any)=>m.content??[]).find((p:any)=>p.type==='tool'&&p.name==='read');tool.state.content=[{type:'text',text:value}];
   for(const req of data.wire.requests.slice(1))req.body.messages.find((m:any)=>m.role==='tool'&&m.tool_call_id===tool.id).content=value;
  })]) {const saved=structuredClone(data);change();data.pages[0].response.data=data.messages;await expect(validate()).rejects.toThrow();Object.assign(data,saved);}
 });
}

test('actual producer sentinel cleanup shape crosses reader boundary without added path fields',async()=>{
 const owner=await fresh('sentinel-owner'),sentinel=await fresh('emitted-sentinel','S0-native-sentinel');
 const birth={format:'linux-start-ticks',value:'123',bootId:'unit-boot'},host={proc:{pid:123},birth};
 const file='config/owned.json';await writeFile(join(sentinel.root,file),'owned');const files=[{path:file,sha256:sha('owned')}];
 const emitted:any=nativeSentinelReceipt(sentinel,host,{directory:sentinel.root},{directory:sentinel.root},files,files);
 emitted.cleanup={pid:host.proc.pid,birth,cleanup:[{pid:host.proc.pid,birth,result:'drained'}]};
 await owner.record('cleanup.json',{nativeSentinel:emitted});const stored=JSON.parse(await readFile(join(owner.evidence,'cleanup.json'),'utf8')).nativeSentinel;
 expect(stored.evidence).toBe(sentinel.evidence);await validateSentinel(stored,owner.root,owner.marker);
 for(const change of [(x:any)=>{delete x.evidence;},(x:any)=>{x.evidence=owner.evidence;},(x:any)=>{x.cleanup.birth.value='wrong';},(x:any)=>{x.cleanup.cleanup[0].birth.value='wrong';},(x:any)=>{x.afterFiles=[];},(x:any)=>{x.cleanup.cleanup[0].result='unknown';}]) {const broken=structuredClone(stored);change(broken);await expect(validateSentinel(broken,owner.root,owner.marker)).rejects.toThrow();}
 await writeFile(join(sentinel.root,'.test-project-owner.json'),'{}');await expect(validateSentinel(stored,owner.root,owner.marker)).rejects.toThrow('owner');
});
test('public missing/forged status and historical sidecar never bypass cleanup or rewrite bytes',async()=>{
 const s=await fresh('historical');await s.record('provider-protocol-authenticity.json',{schemaVersion:1,status:'MISSING'});
 await seal(s,'S3a','v1','1.16.0','MISSING','historical');const before=await readFile(join(s.evidence,'case-report.json'));
 const result=await finalizeQualification(s.evidence,undefined,{path:join(base,'not-even-read.json'),sha256:'0'.repeat(64)});
 expect(result.observationStatus).toBe('MISSING');expect(result.qualificationStatus).toBe('MISSING');expect(await readFile(join(s.evidence,'case-report.json'))).toEqual(before);
 await s.record('cleanup.json',{ownedPidDrained:false,sentinelUnchanged:true});await seal(s,'S3a','v1','1.16.0','MISSING','bad cleanup');
 await expect(finalizeQualification(s.evidence)).rejects.toThrow('cleanup');
});

// Measured, dummy-only native response fixtures retained in the ordinary test suite.
const measuredReaderFixtures:any = {
  "1.16.0": {
    "birth": {
      "format": "linux-start-ticks",
      "value": "102591527",
      "bootId": "f12bc43a-9252-42d4-919d-85b846a176a8"
    },
    "pid": 1978239,
    "heartbeat": "state/opencode/locks/da928833e254b6a88cf73fa3091dafadb1592552.lock/heartbeat"
  },
  "1.18.34": {
    "birth": {
      "format": "linux-start-ticks",
      "value": "102593353",
      "bootId": "f12bc43a-9252-42d4-919d-85b846a176a8"
    },
    "pid": 1994779,
    "heartbeat": "state/opencode/locks/49f02f6ba4d653f1248a489efd373dc097069cf2.lock/heartbeat"
  },
  "2.0.0": {
    "effective": [
      {
        "type": "directory",
        "path": "/srv/workers/evidence/agent-teams-ai/opencode-dual-20261001/TEST-fresh-reviewed-native-four-1790938917048781481/TEST-v2-2.0.0/config/opencode"
      },
      {
        "type": "document",
        "path": "/srv/workers/evidence/agent-teams-ai/opencode-dual-20261001/TEST-fresh-reviewed-native-four-1790938917048781481/TEST-v2-2.0.0/opencode.json",
        "info": {
          "$schema": "https://opencode.ai/config.json",
          "model": {
            "providerID": "test-model",
            "model": "q0-catalog"
          },
          "update": "disable",
          "share": "disabled",
          "permissions": [
            {
              "action": "read",
              "resource": "*",
              "effect": "allow"
            },
            {
              "action": "edit",
              "resource": "*",
              "effect": "allow"
            },
            {
              "action": "shell",
              "resource": "*",
              "effect": "allow"
            }
          ],
          "providers": {
            "test-model": {
              "name": "TEST protocol",
              "env": [
                "TEST_Q0_MODEL_API_KEY"
              ],
              "package": "aisdk:@ai-sdk/openai-compatible",
              "settings": {
                "baseURL": "http://127.0.0.1:45077/v1",
                "apiKey": "TEST-DUMMY-KEY"
              },
              "models": {
                "q0-catalog": {
                  "modelID": "q0-upstream",
                  "name": "TEST native model",
                  "capabilities": {
                    "tools": true,
                    "input": [
                      "text"
                    ],
                    "output": [
                      "text"
                    ]
                  },
                  "cost": {
                    "input": 1,
                    "output": 1
                  },
                  "limit": {
                    "context": 32000,
                    "output": 2048
                  }
                }
              }
            }
          }
        }
      }
    ],
    "before": {
      "configPath": "/srv/workers/evidence/agent-teams-ai/opencode-dual-20261001/TEST-fresh-reviewed-native-four-1790938917048781481/TEST-v2-2.0.0/opencode.json",
      "fingerprint": "01e4541986651f6360f82ec79dc71e82ca693d73c048d10da44a13f0cf67cbe5",
      "rawBase64": "ewogICIkc2NoZW1hIjogImh0dHBzOi8vb3BlbmNvZGUuYWkvY29uZmlnLmpzb24iLAogICJtb2RlbCI6ICJ0ZXN0LW1vZGVsL3EwLWNhdGFsb2ciLAogICJzaGFyZSI6ICJkaXNhYmxlZCIsCiAgInVwZGF0ZSI6ICJkaXNhYmxlIiwKICAicGVybWlzc2lvbnMiOiBbCiAgICB7CiAgICAgICJhY3Rpb24iOiAicmVhZCIsCiAgICAgICJyZXNvdXJjZSI6ICIqIiwKICAgICAgImVmZmVjdCI6ICJhbGxvdyIKICAgIH0sCiAgICB7CiAgICAgICJhY3Rpb24iOiAiZWRpdCIsCiAgICAgICJyZXNvdXJjZSI6ICIqIiwKICAgICAgImVmZmVjdCI6ICJhbGxvdyIKICAgIH0sCiAgICB7CiAgICAgICJhY3Rpb24iOiAic2hlbGwiLAogICAgICAicmVzb3VyY2UiOiAiKiIsCiAgICAgICJlZmZlY3QiOiAiYWxsb3ciCiAgICB9CiAgXSwKICAicHJvdmlkZXJzIjogewogICAgInRlc3QtbW9kZWwiOiB7CiAgICAgICJwYWNrYWdlIjogImFpc2RrOkBhaS1zZGsvb3BlbmFpLWNvbXBhdGlibGUiLAogICAgICAiZW52IjogWwogICAgICAgICJURVNUX1EwX01PREVMX0FQSV9LRVkiCiAgICAgIF0sCiAgICAgICJuYW1lIjogIlRFU1QgcHJvdG9jb2wiLAogICAgICAic2V0dGluZ3MiOiB7CiAgICAgICAgImJhc2VVUkwiOiAiaHR0cDovLzEyNy4wLjAuMTo0NTA3Ny92MSIsCiAgICAgICAgImFwaUtleSI6ICJURVNULURVTU1ZLUtFWSIKICAgICAgfSwKICAgICAgIm1vZGVscyI6IHsKICAgICAgICAicTAtY2F0YWxvZyI6IHsKICAgICAgICAgICJtb2RlbElEIjogInEwLXVwc3RyZWFtIiwKICAgICAgICAgICJuYW1lIjogIlRFU1QgbmF0aXZlIG1vZGVsIiwKICAgICAgICAgICJjYXBhYmlsaXRpZXMiOiB7CiAgICAgICAgICAgICJ0b29scyI6IHRydWUsCiAgICAgICAgICAgICJpbnB1dCI6IFsKICAgICAgICAgICAgICAidGV4dCIKICAgICAgICAgICAgXSwKICAgICAgICAgICAgIm91dHB1dCI6IFsKICAgICAgICAgICAgICAidGV4dCIKICAgICAgICAgICAgXQogICAgICAgICAgfSwKICAgICAgICAgICJsaW1pdCI6IHsKICAgICAgICAgICAgImNvbnRleHQiOiAzMjAwMCwKICAgICAgICAgICAgIm91dHB1dCI6IDIwNDgKICAgICAgICAgIH0sCiAgICAgICAgICAiY29zdCI6IHsKICAgICAgICAgICAgImlucHV0IjogMSwKICAgICAgICAgICAgIm91dHB1dCI6IDEKICAgICAgICAgIH0KICAgICAgICB9CiAgICAgIH0KICAgIH0KICB9Cn0=",
      "config": {
        "$schema": "https://opencode.ai/config.json",
        "model": "test-model/q0-catalog",
        "share": "disabled",
        "update": "disable",
        "permissions": [
          {
            "action": "read",
            "resource": "*",
            "effect": "allow"
          },
          {
            "action": "edit",
            "resource": "*",
            "effect": "allow"
          },
          {
            "action": "shell",
            "resource": "*",
            "effect": "allow"
          }
        ],
        "providers": {
          "test-model": {
            "package": "aisdk:@ai-sdk/openai-compatible",
            "env": [
              "TEST_Q0_MODEL_API_KEY"
            ],
            "name": "TEST protocol",
            "settings": {
              "baseURL": "http://127.0.0.1:45077/v1",
              "apiKey": "TEST-DUMMY-KEY"
            },
            "models": {
              "q0-catalog": {
                "modelID": "q0-upstream",
                "name": "TEST native model",
                "capabilities": {
                  "tools": true,
                  "input": [
                    "text"
                  ],
                  "output": [
                    "text"
                  ]
                },
                "limit": {
                  "context": 32000,
                  "output": 2048
                },
                "cost": {
                  "input": 1,
                  "output": 1
                }
              }
            }
          }
        }
      },
      "credential": "TEST-only dummy key"
    },
    "after": {
      "fingerprint": "01e4541986651f6360f82ec79dc71e82ca693d73c048d10da44a13f0cf67cbe5",
      "rawBase64": "ewogICIkc2NoZW1hIjogImh0dHBzOi8vb3BlbmNvZGUuYWkvY29uZmlnLmpzb24iLAogICJtb2RlbCI6ICJ0ZXN0LW1vZGVsL3EwLWNhdGFsb2ciLAogICJzaGFyZSI6ICJkaXNhYmxlZCIsCiAgInVwZGF0ZSI6ICJkaXNhYmxlIiwKICAicGVybWlzc2lvbnMiOiBbCiAgICB7CiAgICAgICJhY3Rpb24iOiAicmVhZCIsCiAgICAgICJyZXNvdXJjZSI6ICIqIiwKICAgICAgImVmZmVjdCI6ICJhbGxvdyIKICAgIH0sCiAgICB7CiAgICAgICJhY3Rpb24iOiAiZWRpdCIsCiAgICAgICJyZXNvdXJjZSI6ICIqIiwKICAgICAgImVmZmVjdCI6ICJhbGxvdyIKICAgIH0sCiAgICB7CiAgICAgICJhY3Rpb24iOiAic2hlbGwiLAogICAgICAicmVzb3VyY2UiOiAiKiIsCiAgICAgICJlZmZlY3QiOiAiYWxsb3ciCiAgICB9CiAgXSwKICAicHJvdmlkZXJzIjogewogICAgInRlc3QtbW9kZWwiOiB7CiAgICAgICJwYWNrYWdlIjogImFpc2RrOkBhaS1zZGsvb3BlbmFpLWNvbXBhdGlibGUiLAogICAgICAiZW52IjogWwogICAgICAgICJURVNUX1EwX01PREVMX0FQSV9LRVkiCiAgICAgIF0sCiAgICAgICJuYW1lIjogIlRFU1QgcHJvdG9jb2wiLAogICAgICAic2V0dGluZ3MiOiB7CiAgICAgICAgImJhc2VVUkwiOiAiaHR0cDovLzEyNy4wLjAuMTo0NTA3Ny92MSIsCiAgICAgICAgImFwaUtleSI6ICJURVNULURVTU1ZLUtFWSIKICAgICAgfSwKICAgICAgIm1vZGVscyI6IHsKICAgICAgICAicTAtY2F0YWxvZyI6IHsKICAgICAgICAgICJtb2RlbElEIjogInEwLXVwc3RyZWFtIiwKICAgICAgICAgICJuYW1lIjogIlRFU1QgbmF0aXZlIG1vZGVsIiwKICAgICAgICAgICJjYXBhYmlsaXRpZXMiOiB7CiAgICAgICAgICAgICJ0b29scyI6IHRydWUsCiAgICAgICAgICAgICJpbnB1dCI6IFsKICAgICAgICAgICAgICAidGV4dCIKICAgICAgICAgICAgXSwKICAgICAgICAgICAgIm91dHB1dCI6IFsKICAgICAgICAgICAgICAidGV4dCIKICAgICAgICAgICAgXQogICAgICAgICAgfSwKICAgICAgICAgICJsaW1pdCI6IHsKICAgICAgICAgICAgImNvbnRleHQiOiAzMjAwMCwKICAgICAgICAgICAgIm91dHB1dCI6IDIwNDgKICAgICAgICAgIH0sCiAgICAgICAgICAiY29zdCI6IHsKICAgICAgICAgICAgImlucHV0IjogMSwKICAgICAgICAgICAgIm91dHB1dCI6IDEKICAgICAgICAgIH0KICAgICAgICB9CiAgICAgIH0KICAgIH0KICB9Cn0=",
      "config": {
        "$schema": "https://opencode.ai/config.json",
        "model": "test-model/q0-catalog",
        "share": "disabled",
        "update": "disable",
        "permissions": [
          {
            "action": "read",
            "resource": "*",
            "effect": "allow"
          },
          {
            "action": "edit",
            "resource": "*",
            "effect": "allow"
          },
          {
            "action": "shell",
            "resource": "*",
            "effect": "allow"
          }
        ],
        "providers": {
          "test-model": {
            "package": "aisdk:@ai-sdk/openai-compatible",
            "env": [
              "TEST_Q0_MODEL_API_KEY"
            ],
            "name": "TEST protocol",
            "settings": {
              "baseURL": "http://127.0.0.1:45077/v1",
              "apiKey": "TEST-DUMMY-KEY"
            },
            "models": {
              "q0-catalog": {
                "modelID": "q0-upstream",
                "name": "TEST native model",
                "capabilities": {
                  "tools": true,
                  "input": [
                    "text"
                  ],
                  "output": [
                    "text"
                  ]
                },
                "limit": {
                  "context": 32000,
                  "output": 2048
                },
                "cost": {
                  "input": 1,
                  "output": 1
                }
              }
            }
          }
        }
      }
    }
  },
  "2.0.21": {
    "effective": [
      {
        "type": "directory",
        "path": "/srv/workers/evidence/agent-teams-ai/opencode-dual-20261001/TEST-fresh-reviewed-native-four-1790938917048781481/TEST-v2-2.0.21/config/opencode"
      },
      {
        "type": "document",
        "path": "/srv/workers/evidence/agent-teams-ai/opencode-dual-20261001/TEST-fresh-reviewed-native-four-1790938917048781481/TEST-v2-2.0.21/opencode.json",
        "info": {
          "$schema": "https://opencode.ai/config.json",
          "model": {
            "providerID": "test-model",
            "model": "q0-catalog"
          },
          "update": "disable",
          "share": "disabled",
          "permissions": [
            {
              "action": "read",
              "resource": "*",
              "effect": "allow"
            },
            {
              "action": "edit",
              "resource": "*",
              "effect": "allow"
            },
            {
              "action": "shell",
              "resource": "*",
              "effect": "allow"
            }
          ],
          "providers": {
            "test-model": {
              "name": "TEST protocol",
              "env": [
                "TEST_Q0_MODEL_API_KEY"
              ],
              "package": "aisdk:@ai-sdk/openai-compatible",
              "settings": {
                "baseURL": "http://127.0.0.1:40631/v1",
                "apiKey": "TEST-DUMMY-KEY"
              },
              "models": {
                "q0-catalog": {
                  "modelID": "q0-upstream",
                  "name": "TEST native model",
                  "capabilities": {
                    "tools": true,
                    "input": [
                      "text"
                    ],
                    "output": [
                      "text"
                    ]
                  },
                  "cost": {
                    "input": 1,
                    "output": 1
                  },
                  "limit": {
                    "context": 32000,
                    "output": 2048
                  }
                }
              }
            }
          }
        }
      }
    ],
    "before": {
      "configPath": "/srv/workers/evidence/agent-teams-ai/opencode-dual-20261001/TEST-fresh-reviewed-native-four-1790938917048781481/TEST-v2-2.0.21/opencode.json",
      "fingerprint": "c4e1658657e3294c079facc47906b642618e8513075c568aa29ef1f5fcbb0de1",
      "rawBase64": "ewogICIkc2NoZW1hIjogImh0dHBzOi8vb3BlbmNvZGUuYWkvY29uZmlnLmpzb24iLAogICJtb2RlbCI6ICJ0ZXN0LW1vZGVsL3EwLWNhdGFsb2ciLAogICJzaGFyZSI6ICJkaXNhYmxlZCIsCiAgInVwZGF0ZSI6ICJkaXNhYmxlIiwKICAicGVybWlzc2lvbnMiOiBbCiAgICB7CiAgICAgICJhY3Rpb24iOiAicmVhZCIsCiAgICAgICJyZXNvdXJjZSI6ICIqIiwKICAgICAgImVmZmVjdCI6ICJhbGxvdyIKICAgIH0sCiAgICB7CiAgICAgICJhY3Rpb24iOiAiZWRpdCIsCiAgICAgICJyZXNvdXJjZSI6ICIqIiwKICAgICAgImVmZmVjdCI6ICJhbGxvdyIKICAgIH0sCiAgICB7CiAgICAgICJhY3Rpb24iOiAic2hlbGwiLAogICAgICAicmVzb3VyY2UiOiAiKiIsCiAgICAgICJlZmZlY3QiOiAiYWxsb3ciCiAgICB9CiAgXSwKICAicHJvdmlkZXJzIjogewogICAgInRlc3QtbW9kZWwiOiB7CiAgICAgICJwYWNrYWdlIjogImFpc2RrOkBhaS1zZGsvb3BlbmFpLWNvbXBhdGlibGUiLAogICAgICAiZW52IjogWwogICAgICAgICJURVNUX1EwX01PREVMX0FQSV9LRVkiCiAgICAgIF0sCiAgICAgICJuYW1lIjogIlRFU1QgcHJvdG9jb2wiLAogICAgICAic2V0dGluZ3MiOiB7CiAgICAgICAgImJhc2VVUkwiOiAiaHR0cDovLzEyNy4wLjAuMTo0MDYzMS92MSIsCiAgICAgICAgImFwaUtleSI6ICJURVNULURVTU1ZLUtFWSIKICAgICAgfSwKICAgICAgIm1vZGVscyI6IHsKICAgICAgICAicTAtY2F0YWxvZyI6IHsKICAgICAgICAgICJtb2RlbElEIjogInEwLXVwc3RyZWFtIiwKICAgICAgICAgICJuYW1lIjogIlRFU1QgbmF0aXZlIG1vZGVsIiwKICAgICAgICAgICJjYXBhYmlsaXRpZXMiOiB7CiAgICAgICAgICAgICJ0b29scyI6IHRydWUsCiAgICAgICAgICAgICJpbnB1dCI6IFsKICAgICAgICAgICAgICAidGV4dCIKICAgICAgICAgICAgXSwKICAgICAgICAgICAgIm91dHB1dCI6IFsKICAgICAgICAgICAgICAidGV4dCIKICAgICAgICAgICAgXQogICAgICAgICAgfSwKICAgICAgICAgICJsaW1pdCI6IHsKICAgICAgICAgICAgImNvbnRleHQiOiAzMjAwMCwKICAgICAgICAgICAgIm91dHB1dCI6IDIwNDgKICAgICAgICAgIH0sCiAgICAgICAgICAiY29zdCI6IHsKICAgICAgICAgICAgImlucHV0IjogMSwKICAgICAgICAgICAgIm91dHB1dCI6IDEKICAgICAgICAgIH0KICAgICAgICB9CiAgICAgIH0KICAgIH0KICB9Cn0=",
      "config": {
        "$schema": "https://opencode.ai/config.json",
        "model": "test-model/q0-catalog",
        "share": "disabled",
        "update": "disable",
        "permissions": [
          {
            "action": "read",
            "resource": "*",
            "effect": "allow"
          },
          {
            "action": "edit",
            "resource": "*",
            "effect": "allow"
          },
          {
            "action": "shell",
            "resource": "*",
            "effect": "allow"
          }
        ],
        "providers": {
          "test-model": {
            "package": "aisdk:@ai-sdk/openai-compatible",
            "env": [
              "TEST_Q0_MODEL_API_KEY"
            ],
            "name": "TEST protocol",
            "settings": {
              "baseURL": "http://127.0.0.1:40631/v1",
              "apiKey": "TEST-DUMMY-KEY"
            },
            "models": {
              "q0-catalog": {
                "modelID": "q0-upstream",
                "name": "TEST native model",
                "capabilities": {
                  "tools": true,
                  "input": [
                    "text"
                  ],
                  "output": [
                    "text"
                  ]
                },
                "limit": {
                  "context": 32000,
                  "output": 2048
                },
                "cost": {
                  "input": 1,
                  "output": 1
                }
              }
            }
          }
        }
      },
      "credential": "TEST-only dummy key"
    },
    "after": {
      "fingerprint": "c4e1658657e3294c079facc47906b642618e8513075c568aa29ef1f5fcbb0de1",
      "rawBase64": "ewogICIkc2NoZW1hIjogImh0dHBzOi8vb3BlbmNvZGUuYWkvY29uZmlnLmpzb24iLAogICJtb2RlbCI6ICJ0ZXN0LW1vZGVsL3EwLWNhdGFsb2ciLAogICJzaGFyZSI6ICJkaXNhYmxlZCIsCiAgInVwZGF0ZSI6ICJkaXNhYmxlIiwKICAicGVybWlzc2lvbnMiOiBbCiAgICB7CiAgICAgICJhY3Rpb24iOiAicmVhZCIsCiAgICAgICJyZXNvdXJjZSI6ICIqIiwKICAgICAgImVmZmVjdCI6ICJhbGxvdyIKICAgIH0sCiAgICB7CiAgICAgICJhY3Rpb24iOiAiZWRpdCIsCiAgICAgICJyZXNvdXJjZSI6ICIqIiwKICAgICAgImVmZmVjdCI6ICJhbGxvdyIKICAgIH0sCiAgICB7CiAgICAgICJhY3Rpb24iOiAic2hlbGwiLAogICAgICAicmVzb3VyY2UiOiAiKiIsCiAgICAgICJlZmZlY3QiOiAiYWxsb3ciCiAgICB9CiAgXSwKICAicHJvdmlkZXJzIjogewogICAgInRlc3QtbW9kZWwiOiB7CiAgICAgICJwYWNrYWdlIjogImFpc2RrOkBhaS1zZGsvb3BlbmFpLWNvbXBhdGlibGUiLAogICAgICAiZW52IjogWwogICAgICAgICJURVNUX1EwX01PREVMX0FQSV9LRVkiCiAgICAgIF0sCiAgICAgICJuYW1lIjogIlRFU1QgcHJvdG9jb2wiLAogICAgICAic2V0dGluZ3MiOiB7CiAgICAgICAgImJhc2VVUkwiOiAiaHR0cDovLzEyNy4wLjAuMTo0MDYzMS92MSIsCiAgICAgICAgImFwaUtleSI6ICJURVNULURVTU1ZLUtFWSIKICAgICAgfSwKICAgICAgIm1vZGVscyI6IHsKICAgICAgICAicTAtY2F0YWxvZyI6IHsKICAgICAgICAgICJtb2RlbElEIjogInEwLXVwc3RyZWFtIiwKICAgICAgICAgICJuYW1lIjogIlRFU1QgbmF0aXZlIG1vZGVsIiwKICAgICAgICAgICJjYXBhYmlsaXRpZXMiOiB7CiAgICAgICAgICAgICJ0b29scyI6IHRydWUsCiAgICAgICAgICAgICJpbnB1dCI6IFsKICAgICAgICAgICAgICAidGV4dCIKICAgICAgICAgICAgXSwKICAgICAgICAgICAgIm91dHB1dCI6IFsKICAgICAgICAgICAgICAidGV4dCIKICAgICAgICAgICAgXQogICAgICAgICAgfSwKICAgICAgICAgICJsaW1pdCI6IHsKICAgICAgICAgICAgImNvbnRleHQiOiAzMjAwMCwKICAgICAgICAgICAgIm91dHB1dCI6IDIwNDgKICAgICAgICAgIH0sCiAgICAgICAgICAiY29zdCI6IHsKICAgICAgICAgICAgImlucHV0IjogMSwKICAgICAgICAgICAgIm91dHB1dCI6IDEKICAgICAgICAgIH0KICAgICAgICB9CiAgICAgIH0KICAgIH0KICB9Cn0=",
      "config": {
        "$schema": "https://opencode.ai/config.json",
        "model": "test-model/q0-catalog",
        "share": "disabled",
        "update": "disable",
        "permissions": [
          {
            "action": "read",
            "resource": "*",
            "effect": "allow"
          },
          {
            "action": "edit",
            "resource": "*",
            "effect": "allow"
          },
          {
            "action": "shell",
            "resource": "*",
            "effect": "allow"
          }
        ],
        "providers": {
          "test-model": {
            "package": "aisdk:@ai-sdk/openai-compatible",
            "env": [
              "TEST_Q0_MODEL_API_KEY"
            ],
            "name": "TEST protocol",
            "settings": {
              "baseURL": "http://127.0.0.1:40631/v1",
              "apiKey": "TEST-DUMMY-KEY"
            },
            "models": {
              "q0-catalog": {
                "modelID": "q0-upstream",
                "name": "TEST native model",
                "capabilities": {
                  "tools": true,
                  "input": [
                    "text"
                  ],
                  "output": [
                    "text"
                  ]
                },
                "limit": {
                  "context": 32000,
                  "output": 2048
                },
                "cost": {
                  "input": 1,
                  "output": 1
                }
              }
            }
          }
        }
      }
    }
  }
};
for(const version of ['1.16.0','1.18.34'])test('measured V1 '+version+' scoped lease drains; unrelated deletion and foreign leases reject',async()=>{
 const owner=await fresh('lease-owner-'+version),sentinel=await fresh('lease-'+version,'S0-native-sentinel');
 const observed=measuredReaderFixtures[version];
 const birth=observed.birth,pid=observed.pid,heartbeat=observed.heartbeat;
 const metadata=heartbeat.replace(/heartbeat$/,'meta.json');
 // The sentinel metadata was removed by native cleanup; authored live metadata binds
 // its measured PID and is captured through the same public producer boundary.
 const raw=JSON.stringify({token:'c386044e-5e28-4500-aac8-d655742ee58a',pid,hostname:'unit-owned-host',createdAt:'2026-10-02T11:02:02.988Z'});
 await mkdir(join(sentinel.root,heartbeat.replace(/\/heartbeat$/,'')),{recursive:true});
 await writeFile(join(sentinel.root,heartbeat),'');await writeFile(join(sentinel.root,metadata),raw);
 const stable=[{path:'config/owned.json',sha256:sha('owned'),bytes:5},{path:'state/owned.json',sha256:sha('owned'),bytes:5}];
 for(const f of stable)await writeFile(join(sentinel.root,f.path),'owned');
 const beforeFiles=[...stable,{path:heartbeat,sha256:sha(''),bytes:0},{path:metadata,sha256:sha(raw),bytes:Buffer.byteLength(raw)}];
 const transientLeases=await captureSentinelLeases(sentinel.root,pid,version,beforeFiles);
 await sentinel.record('native-identity.json',{pid,birth,identity:{version}});
 const receipt:any={...nativeSentinelReceipt(sentinel,{proc:{pid},birth},{directory:sentinel.root},{directory:sentinel.root},beforeFiles,stable),transientLeases,cleanup:{pid,birth,cleanup:[{pid,birth,result:'drained'}]}};
 await expect(validateSentinel(receipt,owner.root,owner.marker)).rejects.toThrow('not drained');
 await rm(join(sentinel.root,heartbeat.replace(/\/heartbeat$/,'')),{recursive:true});
 await validateSentinel(receipt,owner.root,owner.marker);
 const rawBefore=JSON.stringify(beforeFiles);expect(receipt.beforeFiles).toEqual(beforeFiles);
 for(const change of [
  (x:any)=>{delete x.transientLeases;},(x:any)=>{x.transientLeases.leases[0].heartbeat='state/foreign/heartbeat';},
  (x:any)=>{x.transientLeases.leases[0].heartbeat=heartbeat.replace(/locks\/[0-9a-f]+/, 'locks/'+ 'a'.repeat(32));},
  (x:any)=>{x.transientLeases.version='2.0.0';},(x:any)=>{x.cleanup.cleanup[0].result='absent-or-changed';},
  (x:any)=>{x.cleanup.cleanup[0].birth.value='foreign';},(x:any)=>{x.afterFiles=[];},
  (x:any)=>{const text=JSON.stringify({...JSON.parse(raw),pid:pid+1});x.transientLeases.leases[0].rawBase64=Buffer.from(text).toString('base64');Object.assign(x.beforeFiles.find((f:any)=>f.path===metadata),{sha256:sha(text),bytes:Buffer.byteLength(text)});},
  (x:any)=>{x.transientLeases.leases.push(x.transientLeases.leases[0]);}
 ]) {const broken=structuredClone(receipt);change(broken);await expect(validateSentinel(broken,owner.root,owner.marker)).rejects.toThrow();}
 for(const file of stable) {await rm(join(sentinel.root,file.path));await expect(validateSentinel(receipt,owner.root,owner.marker)).rejects.toThrow();await writeFile(join(sentinel.root,file.path),'owned');}
 expect(JSON.stringify(beforeFiles)).toBe(rawBefore);
});
for(const version of ['2.0.0','2.0.21'])test('measured V2 '+version+' raw directory/document.info matches whole fingerprinted config; resealed substitutions reject',async()=>{
 const s=await fresh('effective-'+version),fixture=measuredReaderFixtures[version];
 const raw=Buffer.from(JSON.stringify(fixture.effective)),captured=JSON.parse(raw.toString());
 const before=fixture.before,after=fixture.after;
 expect(sha(Buffer.from(before.rawBase64,'base64'))).toBe(before.fingerprint);expect(after.fingerprint).toBe(before.fingerprint);expect(after.config).toEqual(before.config);
 // Raw immutable records stay raw; only owned absolute root paths are rebased.
 const entries=JSON.parse(raw.toString().replaceAll(before.configPath.replace(/\/opencode.json$/,''),s.root));
 const configPath=join(s.root,'opencode.json');await writeFile(configPath,Buffer.from(before.rawBase64,'base64'));await mkdir(join(s.root,'config/opencode'));
 const validate=async(value:any)=>{
  await s.record('effective-native-config.json',value);await seal(s,'S3a','v2',version,'MISSING','authored config decoder boundary only');
  const bytes=await readFile(join(s.evidence,'effective-native-config.json')),digest=sha(bytes);
  expect(sha(await readFile(configPath))).toBe(before.fingerprint);expect(sha(bytes)).toBe(digest);
  return validateEffectiveConfig(JSON.parse(bytes.toString()),s.root,configPath,JSON.parse(await readFile(configPath,'utf8')));
 };
 await validate(entries);expect(captured).not.toHaveProperty('data');
 for(const change of [
  (x:any)=>{x[1].path=join(s.root,'foreign.json');},(x:any)=>{x[0].path='/foreign/config/opencode';},
  (x:any)=>{x[1].info.model.model='q0-upstream';},(x:any)=>{x[1].info.model.providerID='foreign';},
  (x:any)=>{x[1].info.providers['test-model'].settings.apiKey='FOREIGN';},
  (x:any)=>{x[1].info.providers['test-model'].settings.baseURL='http://127.0.0.1:1/v1';},
  (x:any)=>{x[1].info.providers['test-model'].package='@opencode/ai/providers/openai-compatible';},
  (x:any)=>{x[1].info.permissions=[];},(x:any)=>{x[1].info.share='enabled';},(x:any)=>{x[1].info.update='enable';},
  (x:any)=>{x[1].info.providers['test-model'].models['q0-catalog'].cost.input=0;},
  (x:any)=>{x[1].info.providers['test-model'].models['q0-catalog'].capabilities.tools=false;},
  (x:any)=>{x[1].info.providers['test-model'].env=['OPENAI_API_KEY'];},
  (x:any)=>{x[0].type='unknown';},(x:any)=>{x[1].config=x[1].info;delete x[1].info;},
  (x:any)=>{x.push({type:'document',path:join(s.root,'defaults.json'),info:{model:'foreign'}});}
 ]) {const changed=structuredClone(entries);change(changed);await expect(validate(changed)).rejects.toThrow();}
 await expect(validate({data:entries})).rejects.toThrow();expect(Buffer.from(JSON.stringify(fixture.effective))).toEqual(raw);
});
