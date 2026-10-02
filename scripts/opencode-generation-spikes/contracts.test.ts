import { test, expect, afterAll } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Sandbox, SOURCE, TASK, sha, processBirth, terminate } from './sandbox';
import { unpackArchive, verifySri, verifyElf, responseBytes } from './artifacts';
import { seal, readQualification } from './evidence';

const base=await mkdtemp(join(process.env.Q0_TEST_TMP??join(SOURCE,'.task-output','unit-roots'),'q0-contract-'));
afterAll(async()=>{await rm(base,{recursive:true,force:true});});
const fresh=(id:string,caseID='contract')=>Sandbox.create(join(base,'TEST-'+id),join(base,'evidence-'+id),caseID);
test('source, existing/non-TEST and symlinked parent roots are refused before Git writes',async()=>{
  await expect(Sandbox.create(join(SOURCE,'TEST-unowned'),join(base,'source-evidence'),'contract')).rejects.toThrow('source');
  await expect(Sandbox.create(join(base,'real-project'),join(base,'other-evidence'),'contract')).rejects.toThrow('TEST');
  await mkdir(join(base,'TEST-existing'));
  await expect(Sandbox.create(join(base,'TEST-existing'),join(base,'existing-evidence'),'contract')).rejects.toThrow('existing');
  await mkdir(join(base,'outside'));await symlink(join(base,'outside'),join(base,'alias'));
  await expect(Sandbox.create(join(base,'alias','TEST-escape'),join(base,'escape-evidence'),'contract')).rejects.toThrow('symlink');
});
test('actual Git root has exact identity; ownership changes and escaped state paths veto calls',async()=>{
  const s=await fresh('identity');
  expect((await s.command('/usr/bin/git',['config','user.name'])).stdout.trim()).toBe('iliya');
  expect((await s.command('/usr/bin/git',['config','user.email'])).stdout.trim()).toBe('iliyazelenkog@gmail.com');
  await expect(s.path(join(base,'outside'))).rejects.toThrow('escaped');
  await rm(join(s.root,'config'),{recursive:true});await symlink(join(base,'outside'),join(s.root,'config'));
  await expect(s.validate()).rejects.toThrow('symlink');
  await rm(join(s.root,'config'));await mkdir(join(s.root,'config'));
  await writeFile(join(s.root,'.test-project-owner.json'),'{}');
  await expect(s.validate()).rejects.toThrow('ownership');
});
test('hostile inherited credentials/config never reach child environment',async()=>{
  const s=await fresh('env');
  const injected={ANTHROPIC_API_KEY:'TEST-CANARY',OPENAI_API_KEY:'TEST-CANARY',NODE_OPTIONS:'--throw-deprecation',OPENCODE_CONFIG:'/foreign',CODEX_HOME:'/foreign',HOME:'/foreign'};
  const old=Object.fromEntries(Object.keys(injected).map(k=>[k,process.env[k]]));
  try {
    Object.assign(process.env,injected);
    const child=await s.command('/usr/bin/env',[]);
    expect(child.code).toBe(0);expect(child.stdout).not.toContain('TEST-CANARY');expect(child.stdout).not.toContain('/foreign');
    expect(child.stdout).not.toContain('NODE_OPTIONS');expect(child.stdout).toContain('APPDATA='+join(s.root,'appdata'));
    expect(child.stdout).toContain('HOME='+join(s.root,'home'));
  }finally{for(const [k,v] of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});
test('cleanup drains only the recorded PID and birth; foreign token cannot kill sentinel',async()=>{
  const s=await fresh('process');
  const child=Bun.spawn(['/bin/sleep','60'],{cwd:s.root,env:s.env()}),sentinel=Bun.spawn(['/bin/sleep','60'],{cwd:s.root,env:s.env()});
  const a=await processBirth(child.pid),b=await processBirth(sentinel.pid);
  try {
    expect(await terminate(sentinel.pid,{...b,value:b.value+'-foreign'})).toBe('absent-or-changed');
    expect(sentinel.exitCode).toBe(null);
    expect(await terminate(child.pid,a)).toMatch(/drained/);await child.exited;
    expect(sentinel.exitCode).toBe(null);
  }finally{await terminate(child.pid,a);await terminate(sentinel.pid,b);await sentinel.exited;}
});
function tar(entries:Array<{name:string;type?:string;content?:string}>) {
  const chunks:Buffer[]=[];
  for(const e of entries) {
    const h=Buffer.alloc(512),b=Buffer.from(e.content??'');h.write(e.name);h.write('0000700\0',100);h.write('0000000\0',108);h.write('0000000\0',116);
    h.write(b.length.toString(8).padStart(11,'0')+'\0',124);h.write('00000000000\0',136);h.fill(32,148,156);h.write(e.type??'0',156);h.write('ustar\0',257);
    const checksum=h.reduce((a,b)=>a+b,0);h.write(checksum.toString(8).padStart(6,'0')+'\0 ',148);chunks.push(h,b,Buffer.alloc((512-b.length%512)%512));
  }
  return gzipSync(Buffer.concat([...chunks,Buffer.alloc(1024)]));
}
test('SRI verification rejects modified archive bytes and non-sha512 identities',()=>{
  const b=tar([{name:'package/bin/opencode',content:'actual bytes'}]);
  const sri='sha512-'+createHash('sha512').update(b).digest('base64');verifySri(b,sri);
  expect(()=>verifySri(Buffer.concat([b,Buffer.from('changed')]),sri)).toThrow('mismatch');
  expect(()=>verifySri(b,'sha1-abc')).toThrow('sha512');
});
test('archive parser refuses traversal, symlink, PAX overrides and duplicate files',()=>{
  expect(unpackArchive(tar([{name:'package/package.json',content:'{"name":"test"}'}])).get('package.json')?.toString()).toContain('test');
  for(const entries of [ [{name:'package/../../escape'}],[{name:'package/link',type:'2'}],[{name:'package/PaxHeader',type:'x'}],[{name:'package/file'},{name:'package/file'}] ])
    expect(()=>unpackArchive(tar(entries))).toThrow();
  expect(()=>unpackArchive(tar([{name:'package/bin/opencode',content:'data'}]).subarray(0,40))).toThrow();
  expect(()=>verifyElf(Buffer.from('#!/usr/bin/env node\nconsole.log("2.0.0")'))).toThrow('native ELF');
  expect(()=>verifyElf(Buffer.from('echo postinstall not run'))).toThrow('native ELF');
});
test('download cap counts streamed bytes and rejects declared HTTP failures',async()=>{
  const r=new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(12));c.enqueue(new Uint8Array(12));c.close();}}),{headers:{'Content-Length':'1'}});
  await expect(responseBytes(r,16)).rejects.toThrow('cap');
  await expect(responseBytes(new Response('unavailable',{status:404}),100)).rejects.toThrow('HTTP 404');
});
test('public reader preserves MISSING, catches modified bytes and refuses forged PASS',async()=>{
  const s=await fresh('reader','S0');await s.record('attempt.json',{observed:'registry unavailable',nativeExecution:false});
  await seal(s,'S0','v2','2.0.0','MISSING','registry unavailable');
  expect((await readQualification(s.evidence)).status).toBe('MISSING');
  await writeFile(join(s.evidence,'attempt.json'),'modified');
  await expect(readQualification(s.evidence)).rejects.toThrow('byte hash');
  await seal(s,'S0','v2','2.0.0','PASS','authored status cannot prove native');
  await expect(readQualification(s.evidence)).rejects.toThrow('required native evidence missing');
});
test('streaming model fixture correlates split tool calls/results and rejects missing results',async()=>{
  const {ModelFixture,UPSTREAM}=await import('./model');const s=await fresh('model');
  const f=new ModelFixture(s.root,join(s.root,'seed'),join(s.root,'output'),join(s.root,'shell'),'TEST-TOKEN');
  const tools=[{type:'function',function:{name:'read',parameters:{properties:{filePath:{type:'string'}},required:['filePath']}}},
    {type:'function',function:{name:'write',parameters:{properties:{filePath:{type:'string'},content:{type:'string'}},required:['filePath','content']}}},
    {type:'function',function:{name:'shell',parameters:{properties:{command:{type:'string'},description:{type:'string'}},required:['command','description']}}}];
  const messages:any[]=[{role:'user',content:'authored protocol contract input'}];
  const request=()=>new Request('http://127.0.0.1/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer TEST-DUMMY-KEY'},body:JSON.stringify({model:UPSTREAM,stream:true,messages,tools})});
  for(let stage=0;stage<4;stage++) {
    const response=await f.respond(request());expect(response.status).toBe(200);expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    const text=await response.text(),frames=text.split('\n\n').filter(x=>x.startsWith('data: ')&&x!=='data: [DONE]').map(x=>JSON.parse(x.slice(6)));
    expect(text).toContain('data: [DONE]');expect(frames.at(-1).usage.total_tokens).toBe(22);
    if(stage<3) {
      const parts=frames.flatMap(x=>x.choices.flatMap((c:any)=>c.delta.tool_calls??[]));
      const argumentsText=parts.map((p:any)=>p.function?.arguments??'').join('');
      const parsed=JSON.parse(argumentsText);
      expect(parts[0].function.name).toBe(['read','write','shell'][stage]);expect(parts[0].id).toMatch(/^call_[0-9a-f]{24}$/);
      if(stage===0)expect(parsed.filePath).toBe(join(s.root,'seed'));
      if(stage===1){expect(parsed.filePath).toBe(join(s.root,'output'));expect(parsed.content).toBe('native-write:TEST-TOKEN\n');}
      if(stage===2){expect(parsed.command).toContain(join(s.root,'shell'));expect(parsed.command).toContain('native-shell:TEST-TOKEN');}
      messages.push({role:'tool',tool_call_id:parts[0].id,content:stage===0?'native-read:TEST-TOKEN':'authored successful tool result'});
    }else expect(text).toContain('q0-terminal:TEST-TOKEN');
  }
  const bad=new ModelFixture(s.root,'seed','output','shell','TEST-TOKEN');
  const make=()=>new Request('http://127.0.0.1/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer TEST-DUMMY-KEY'},body:JSON.stringify({model:UPSTREAM,stream:true,messages:[],tools})});
  expect((await bad.respond(make())).status).toBe(200);
  const failure=await bad.respond(make());expect(failure.status).toBe(400);expect(await failure.text()).toContain('tool result absent');

});
test('owned descendant ledger drains actual shell child and preserves unrelated process',async()=>{
  const {OwnedProcessTree}=await import('./sandbox');const s=await fresh('tree');
  const parent=Bun.spawn(['/bin/sh','-c','sleep 60 & wait'],{cwd:s.root,env:s.env()}),sentinel=Bun.spawn(['/bin/sleep','60'],{cwd:s.root,env:s.env()});
  const tree=new OwnedProcessTree(parent.pid,await processBirth(parent.pid)),b=await processBirth(sentinel.pid);tree.start();
  try {
    for(let i=0;i<30&&tree.processes.size<2;i++){await tree.capture();await Bun.sleep(10);}
    expect(tree.processes.size).toBeGreaterThanOrEqual(2);
    const results=await tree.stop();await parent.exited;
    expect(results.every(r=>/drained|absent/.test(r.result))).toBe(true);expect(sentinel.exitCode).toBe(null);
  }finally{await tree.stop();await terminate(sentinel.pid,b);await sentinel.exited;}
});
test('artifact acquisition refuses unattested offline bundles and substituted root metadata',async()=>{
  const {acquire,ANCHORS}=await import('./artifacts');const s=await fresh('offline'),bundle=join(base,'bundle');await mkdir(bundle);
  await expect(acquire(s,ANCHORS[0],bundle)).rejects.toThrow('controller-pinned');
  await writeFile(join(bundle,'root.metadata.json'),JSON.stringify({name:'opencode-ai',version:'1.16.0',dist:{integrity:'sha512-'+Buffer.alloc(64).toString('base64')}}));
  await expect(acquire(s,ANCHORS[0],bundle,undefined,'0'.repeat(64))).rejects.toThrow('immutable accepted pin');
  await expect(readFile(join(s.root,'artifacts','native-opencode'))).rejects.toMatchObject({code:'ENOENT'});
});
test('evidence writer refuses escaped output symlinks and preserves unrelated sentinel bytes',async()=>{
  const s=await fresh('evidence-sink');const sentinel=join(base,'unowned-evidence-sentinel');
  await writeFile(sentinel,'unrelated bytes');await symlink(sentinel,join(s.evidence,'native-startup.json'));
  await expect(s.record('native-startup.json',{status:'FAIL'})).rejects.toThrow('evidence');
  expect(await readFile(sentinel,'utf8')).toBe('unrelated bytes');
});
test('exact native version parser accepts captured pins and rejects ambiguous banners',async()=>{
  const {parseNativeVersion}=await import('./version');
  for(const pin of ['v1-1.16.0','v1-1.18.34','v2-2.0.0','v2-2.0.21']) {
    const c=JSON.parse(await readFile(join(SOURCE,'test/fixtures/opencode-generation-native',pin,'version-command.json'),'utf8'));
    expect(parseNativeVersion(pin.slice(0,2),c.stdout)).toBe(pin.slice(3));
  }
  for(const output of ['2.0.0','opencode v2.0.0-dev','opencode v2.0.0\nopencode v2.0.21','banner opencode v2.0.0','opencode v02.0.0'])expect(()=>parseNativeVersion('v2',output)).toThrow();
  expect(()=>parseNativeVersion('v1','opencode v1.16.0')).toThrow();
});
test('accepted current root archive allows only its measured identical stub duplicate',async()=>{
  // Archive inputs are not mounted; an authored tar exercises the measured duplicate rule.
  const b=tar([{name:'package/bin/opencode.exe',content:'stub'},{name:'package/bin/opencode.exe',content:'stub'},{name:'package/postinstall.mjs',content:'authored parser fixture'}]);
  expect(()=>unpackArchive(b)).toThrow('duplicate');
  expect(unpackArchive(b,['bin/opencode.exe']).has('postinstall.mjs')).toBe(true);
  expect(()=>unpackArchive(tar([{name:'package/bin/opencode.exe',content:'first'},{name:'package/bin/opencode.exe',content:'different'}]),['bin/opencode.exe'])).toThrow('duplicate');
});
test('public reader verifies partial native artifact bytes while retaining MISSING',async()=>{
  const {ANCHORS}=await import('./artifacts');const s=await fresh('partial-native','S0');
  // No physical official archives are supplied. Exercise the partial physical reader with
  // an authored ELF header, retaining MISSING and making no official artifact claim.
  const bytes=Buffer.alloc(64);bytes.write('7f454c46',0,'hex');bytes[4]=2;bytes[5]=1;bytes.writeUInt16LE(62,18);
  const binary=join(s.root,'artifacts','native-opencode');await writeFile(binary,bytes);
  const artifact={binary,sha256:sha(bytes),generation:'v1',version:'1.16.0',packages:[{name:'opencode-ai',archiveSri:ANCHORS[0].rootSri},{name:'opencode-linux-x64'}]};
  await s.record('native-artifact-integrity.json',artifact);
  await seal(s,'S0','v1','1.16.0','MISSING','authored partial physical contract');
  bytes[63]^=1;await writeFile(binary,bytes);
  await expect(readQualification(s.evidence)).rejects.toThrow('native binary hash changed');
  await s.record('native-artifact-integrity.json',{...artifact,sha256:sha(bytes)});
  await seal(s,'S0','v1','1.16.0','MISSING','self-consistent incomplete artifact');
  await expect(readQualification(s.evidence)).rejects.toThrow();
});
test('TEST bootstrap auth is endpoint/birth scoped, scrubbed and revoked',async()=>{
  const {OwnedEndpoint}=await import('./auth');const s=await fresh('bootstrap-auth');
  const proc=Bun.spawn(['/bin/sleep','60'],{cwd:s.root,env:s.env()});const birth=await processBirth(proc.pid);
  const endpoint=new OwnedEndpoint(s,'http://127.0.0.1:32123',proc.pid,birth);
  try {
    const stream=new ReadableStream<Uint8Array>({start(c){for(const x of ['server listening on http://127.0.0.1:32123\nserver pass','word TEST-BOOTSTRAP-','ONLY\n'])c.enqueue(new TextEncoder().encode(x));c.close();}});
    const log=await endpoint.stdout(stream);expect(log).toContain('server password [REDACTED]');expect(log).not.toContain('TEST-BOOTSTRAP');
    const url=new URL('/api/info','http://127.0.0.1:32123');
    const request=new Request(url,{headers:await endpoint.headers(url)});
    expect(request.headers.get('Authorization')).toBe('Basic '+Buffer.from('opencode:TEST-BOOTSTRAP-ONLY').toString('base64'));
    await expect(endpoint.headers(new URL('http://127.0.0.1:32124/api/info'))).rejects.toThrow('endpoint');
    await expect(endpoint.headers(new URL('http://127.0.0.1:32123@evil.test/api/info'))).rejects.toThrow('endpoint');
    expect(endpoint.scrub('echo TEST-BOOTSTRAP-ONLY')).toBe('echo [REDACTED]');
    const wrong=new OwnedEndpoint(s,'http://127.0.0.1:32123',proc.pid,{...birth,value:'0'});
    await expect(wrong.headers(url)).rejects.toThrow('birth');
    const foreign=new OwnedEndpoint(s,'http://127.0.0.1:32123',proc.pid,birth);
    const banner=(text:string)=>new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode(text));c.close();}});
    await expect(foreign.stdout(banner('server listening on http://127.0.0.1:32124\nserver password TEST-FOREIGN\n'))).rejects.toThrow('endpoint mismatch');
    const premature=new OwnedEndpoint(s,'http://127.0.0.1:32123',proc.pid,birth);
    await expect(premature.stdout(banner('server password TEST-PREMATURE\n'))).rejects.toThrow('invalid TEST bootstrap');
    endpoint.revoke();await expect(endpoint.headers(url)).rejects.toThrow('revoked');
    await terminate(proc.pid,birth);await proc.exited;
    const dead=new OwnedEndpoint(s,'http://127.0.0.1:32123',proc.pid,birth);await expect(dead.headers(url)).rejects.toThrow('birth');
  }finally{endpoint.revoke();await terminate(proc.pid,birth);await proc.exited;}
});
test('successful generation-native help preserves streams and rejects failure/error streams',async()=>{
  const {successfulHelp}=await import('./version');
  for(const pin of ['v1-1.16.0','v1-1.18.34','v2-2.0.0','v2-2.0.21']) {
    const h=JSON.parse(await readFile(join(SOURCE,'test/fixtures/opencode-generation-native',pin,'serve-help.json'),'utf8'));
    const text=successfulHelp(pin.slice(0,2),h);expect(text).toContain('--hostname');expect(text).toContain('--port');
    expect(()=>successfulHelp(pin.slice(0,2),{...h,code:1})).toThrow('successful');
    expect(()=>successfulHelp(pin.slice(0,2),{...h,expired:true})).toThrow('successful');
  }
  expect(()=>successfulHelp('v2',{code:0,stdout:'',stderr:'error --hostname --port',expired:false})).toThrow('empty');
});
test('provider package scan reports measured absence without inventing SDK version or SRI',async()=>{
  const {extractProviderPackages}=await import('./artifacts');const s=await fresh('bundled-provider');
  const before=await readFile(join(s.root,'.test-project-owner.json'));
  expect(await extractProviderPackages(s)).toEqual([]);
  expect(await readFile(join(s.root,'.test-project-owner.json'))).toEqual(before);
});
test('public native requester refuses unowned and credential-bearing endpoints before fetch',async()=>{
  const {jsonRequest}=await import('./native');
  await expect(jsonRequest('http://127.0.0.1:32125','/api/info')).rejects.toThrow('unowned');
  await expect(jsonRequest('http://127.0.0.1:32125','http://user:password@127.0.0.1:32125/api/info')).rejects.toThrow('foreign');
});
test('public reader refuses absent or escaped provider package proof even on MISSING',async()=>{
  const s=await fresh('sdk-reader','S3a');
  const claim={name:'@ai-sdk/openai-compatible',version:'1.0.0',path:'cache/sdk',sri:'sha512-'+Buffer.alloc(64).toString('base64'),archiveSha256:'0'.repeat(64),metadataSha256:'0'.repeat(64)};
  await s.record('provider-protocol-authenticity.json',{status:'MISSING',packages:[claim]});
  await seal(s,'S3a','v1','1.16.0','MISSING','authored invalid SDK claim');
  await expect(readQualification(s.evidence)).rejects.toThrow('provider');
  await s.record('provider-protocol-authenticity.json',{status:'MISSING',packages:[{...claim,path:'../unowned'}]});
  await seal(s,'S3a','v1','1.16.0','MISSING','authored escaped SDK path');
  await expect(readQualification(s.evidence)).rejects.toThrow('provider');
});
test('public reader binds provider archive to installed bytes without promoting authored fixture',async()=>{
  const s=await fresh('sdk-bytes','S3a'),installed=join(s.root,'cache','sdk');await mkdir(installed);
  const manifest=JSON.stringify({name:'@ai-sdk/openai-compatible',version:'1.0.0'}),code='authored TEST integrity bytes';
  const archive=tar([{name:'package/package.json',content:manifest},{name:'package/index.js',content:code}]);
  const sri='sha512-'+createHash('sha512').update(archive).digest('base64');
  const metadata=JSON.stringify({name:'@ai-sdk/openai-compatible',version:'1.0.0',dist:{integrity:sri}});
  await writeFile(join(s.root,'artifacts','ai-sdk-1.0.0.tgz'),archive);
  await writeFile(join(s.root,'artifacts','ai-sdk-1.0.0.metadata.json'),metadata);
  await writeFile(join(installed,'package.json'),manifest);await writeFile(join(installed,'index.js'),code);
  await s.record('provider-protocol-authenticity.json',{status:'MISSING',packages:[{name:'@ai-sdk/openai-compatible',version:'1.0.0',path:'cache/sdk',sri,archiveSha256:sha(archive),metadataSha256:sha(metadata)}]});
  await seal(s,'S3a','v1','1.16.0','MISSING','authored archive integrity contract only');
  expect((await readQualification(s.evidence)).status).toBe('MISSING');
  await writeFile(join(installed,'index.js'),'modified installed bytes');
  await expect(readQualification(s.evidence)).rejects.toThrow('provider installed bytes differ');
  await rm(join(installed,'index.js'));const sentinel=join(base,'unowned-sdk-code');await writeFile(sentinel,code);await symlink(sentinel,join(installed,'index.js'));
  await expect(readQualification(s.evidence)).rejects.toThrow('symlink');
  expect(await readFile(sentinel,'utf8')).toBe(code);
});

// Retain the public-boundary H02 regression in the shipped suite, not only red evidence.
test('MISSING observation still rejects an explicitly failed owned cleanup receipt', async () => {
 const s = await fresh('failed-cleanup-missing', 'S3a');
 await s.record('cleanup.json', { ownedPidDrained: false, sentinelUnchanged: true });
 await seal(s, 'S3a', 'v1', '1.16.0', 'MISSING', 'authored cleanup failure');
 const before = await readFile(join(s.evidence, 'case-report.json'));
 await expect(readQualification(s.evidence)).rejects.toThrow('cleanup');
 expect(await readFile(join(s.evidence, 'case-report.json'))).toEqual(before);
});
