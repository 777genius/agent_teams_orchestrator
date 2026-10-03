import { readFile, writeFile, readlink, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Sandbox, processBirth, terminate, sha, boundedText, inventory, OwnedProcessTree, within } from './sandbox';
import { parseNativeVersion, successfulHelp } from './version';
import { Anchor, NativeArtifact } from './artifacts';
import { OwnedEndpoint } from './auth';
import { captureSentinelLeases } from './protocol';
const endpoints=new Map<string,OwnedEndpoint>();
export async function jsonRequest(base:string, path:string, method='GET', body?:unknown, timeout=15000, signal?:AbortSignal) {
  const url=new URL(path,base);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.origin!==base||url.username||url.password)throw new Error('foreign endpoint refused');
  const owner=endpoints.get(base);if(!owner)throw new Error('unowned native endpoint refused');
  const headers:Record<string,string>=await owner.headers(url);if(body!==undefined)headers['Content-Type']='application/json';
  const r=await fetch(url,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout),redirect:'error'});
  const text=await boundedText(r.body!,8*1024*1024);
  if(!r.ok)throw new Error(`native ${method} ${url.pathname}: ${r.status} ${owner.scrub(text).slice(0,500)}`);
  return text?JSON.parse(text):null;
}
export function nativeChildEnvironment(s:Sandbox,testModelKey?:'TEST-DUMMY-KEY') {
  if(testModelKey!==undefined&&testModelKey!=='TEST-DUMMY-KEY')throw new Error('only dummy TEST key accepted');
  return {...s.env(),...(testModelKey?{TEST_Q0_MODEL_API_KEY:testModelKey}:{})};
}
export function reservePort() {
  const token=crypto.randomUUID();
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response(token)});
  return {server,port:server.port!,token,url:`http://127.0.0.1:${server.port}`};
}
export async function startNative(s:Sandbox,a:Anchor,artifact:NativeArtifact,help:string,port?:number,testModelKey?:'TEST-DUMMY-KEY') {
  await s.validate();await s.path(artifact.binary);
  if(sha(await readFile(artifact.binary))!==artifact.sha256)throw new Error('binary changed before spawn');
  if(!help.includes('--port')||!help.includes('--hostname'))throw new Error('advertised nonservice --hostname/--port unavailable');
  const reserved=reservePort(),chosen=port??reserved.port;reserved.server.stop(true);
  const args=[artifact.binary,'serve','--hostname','127.0.0.1','--port',String(chosen)];
  const childEnvironment=nativeChildEnvironment(s,testModelKey);
  if(testModelKey)await s.record('native-child-environment.json',childEnvironment);
  const proc=Bun.spawn(args,{cwd:s.root,env:childEnvironment,stdout:'pipe',stderr:'pipe'});
  const birth=await processBirth(proc.pid);const tree=new OwnedProcessTree(proc.pid,birth);tree.start();
  const base=`http://127.0.0.1:${chosen}`;
  const owner=new OwnedEndpoint(s,base,proc.pid,birth);
  if(endpoints.has(base)){await tree.stop();throw new Error('endpoint already owned');}endpoints.set(base,owner);
  const stdout=owner.stdout(proc.stdout),stderr=boundedText(proc.stderr);
  // Attach handlers immediately, so a log cap cannot become an unhandled rejection.
  let captureFailed=false;stdout.catch(()=>{captureFailed=true;});stderr.catch(()=>{captureFailed=true;});
  let stopped=false;
  const stop=async()=>{
    if(stopped)return;stopped=true;owner.retire();endpoints.delete(base);
    try {
    const result=await tree.stop();await proc.exited;
    await s.record('native-process.json',{args,pid:proc.pid,birth,port:chosen,cleanup:result,exit:proc.exitCode,
      stdout:owner.scrub(await stdout.catch(()=> 'native stdout capture failed')),stderr:owner.scrub(await stderr.catch(()=> 'native stderr capture failed')),auth:{source:a.generation==='v2'?'owned bootstrap stdout':'none',epoch:owner.epoch,endpoint:base,pid:proc.pid,birth}});
    }finally{owner.revoke();}
  };
  try {
    let identity:any,last='';
    for(let i=0;i<150;i++) {
      if(captureFailed)throw new Error('native log capture failed');
      if(proc.exitCode!==null)throw new Error('native exited before readiness');
      try { identity=await jsonRequest(base,a.generation==='v1'?'/global/health':a.version==='2.0.0'?'/api/health':'/api/info','GET',undefined,500);break; }
      catch(e){last=String(e);await Bun.sleep(100);}
    }
    if(!identity)throw new Error('readiness timeout: '+last);
    if(identity.version!==a.version || identity.healthy===false)throw new Error('native identity mismatch');
    const serverInfo=a.version==='2.0.0'?await jsonRequest(base,'/api/server'):identity;
    if(a.generation==='v2'&&identity.pid!==proc.pid)throw new Error('direct native PID differs; descendant qualification required');
    const executable=await readlink(`/proc/${proc.pid}/exe`);
    if(executable!==artifact.binary||sha(await readFile(executable))!==artifact.sha256||JSON.stringify(await processBirth(proc.pid))!==JSON.stringify(birth))throw new Error('live executable/process birth mismatch');
    const environment=(await readFile(`/proc/${proc.pid}/environ`)).toString().split('\0').filter(Boolean).map(x=>x.slice(0,x.indexOf('='))).sort();
    if(a.version==='2.0.21'&&(!identity.paths?.tmp||!within(s.root,identity.paths.tmp)))throw new Error('native temp path outside TEST root');
    await s.record('native-identity.json',{identity,serverInfo,pid:proc.pid,birth,executable,sha256:artifact.sha256,environmentKeyNames:environment,args,port:chosen});
    return {proc,birth,base,stop,identity};
  } catch(e) {await stop();throw e;}
}
// Shared actual producer shape, exercised without starting a native process.
export function nativeSentinelReceipt(project:Pick<Sandbox,'root'|'evidence'>,host:{proc:{pid:number};birth:unknown},before:unknown,after:unknown,beforeFiles:unknown[],afterFiles:unknown[]) {
 return {pid:host.proc.pid,birth:host.birth,root:project.root,evidence:project.evidence,before,after,beforeFiles,afterFiles};
}
export async function qualifyS0(s:Sandbox,a:Anchor,artifact:NativeArtifact) {
  await s.path(artifact.binary);if(sha(await readFile(artifact.binary))!==artifact.sha256)throw new Error('binary changed before version execution');
  const version=await s.command(artifact.binary,['--version']);await s.record('version-command.json',version);
  if(version.code!==0||version.expired||parseNativeVersion(a.generation,version.stdout)!==a.version)throw new Error('actual --version mismatch');
  const help=await s.command(artifact.binary,['serve','--help']);await s.record('serve-help.json',help);
  const advertisedHelp=successfulHelp(a.generation,help);
  if(!advertisedHelp.includes('--hostname')||!advertisedHelp.includes('--port'))throw new Error('native advertised foreground serve flags unavailable');
  const auth=await s.command(artifact.binary,['auth','--help']);await s.record('auth-help.json',auth);successfulHelp(a.generation,auth);
  const sentinelProject=await Sandbox.create(s.root+'-sentinel space',s.evidence+'-sentinel', 'S0-native-sentinel');
  for(const file of ['root.tgz','platform.tgz','root.metadata.json','platform.metadata.json','native-opencode'])await copyFile(join(s.root,'artifacts',file),join(sentinelProject.root,'artifacts',file));
  const sentinelArtifact={...artifact,binary:join(sentinelProject.root,'artifacts','native-opencode')};
  await sentinelProject.record('native-artifact-integrity.json',sentinelArtifact);
  const nativeSentinel=await startNative(sentinelProject,a,sentinelArtifact,advertisedHelp);
  let sentinel:ReturnType<typeof reservePort>|undefined;
  try {
  const nativeBefore=await jsonRequest(nativeSentinel.base,a.generation==='v1'?'/path':'/api/location');
  if(nativeBefore.directory!==sentinelProject.root){await nativeSentinel.stop();throw new Error('native sentinel location mismatch');}
  const sentinelBeforeFiles=await inventory(sentinelProject.root);
  const transientLeases=await captureSentinelLeases(sentinelProject.root,nativeSentinel.proc.pid,a.version,sentinelBeforeFiles);
  sentinel=reservePort();
  const before=await (await fetch(sentinel.url)).text();
  // Occupied-port control runs against the actual native CLI in the same isolated env.
  const collision=await s.command(artifact.binary,['serve','--hostname','127.0.0.1','--port',String(sentinel.port)],5000);
    await s.record('port-collision.json',{...collision,stdout:collision.stdout.replace(/server password[^\r\n]*/gi,'server password [REDACTED]'),stderr:collision.stderr.replace(/server password[^\r\n]*/gi,'server password [REDACTED]'),sentinelBefore:sha(before),sentinelAfter:sha(await (await fetch(sentinel.url)).text())});
    if(collision.code===0||collision.expired||await (await fetch(sentinel.url)).text()!==sentinel.token)throw new Error('native occupied-port refusal/sentinel proof failed');
    const beforeFiles=await inventory(s.root),host=await startNative(s,a,artifact,advertisedHelp);
    try {
      const location=a.generation==='v2'?await jsonRequest(host.base,'/api/location'):await jsonRequest(host.base,'/path');
      const directory=a.generation==='v2'?location.directory:location.directory;
      if(directory!==s.root)throw new Error('native default directory mismatch');
      await s.record('native-startup.json',{status:'PASS',scope:'Linux direct native startup/default-directory/port/process/environment',location,
        environment:s.env(),binary:artifact,version,help,beforeFiles,observedFiles:await inventory(s.root),
        nativeSentinel:{root:sentinelProject.root,evidence:sentinelProject.evidence,pid:nativeSentinel.proc.pid,birth:nativeSentinel.birth,location:nativeBefore},
        limitations:['File inventory proves observed writes; it is not a syscall read-access audit.','Windows/macOS and native wrapper descendants remain later platform gates.','Native sentinel is an isolated host, not a managed app team.']});
    }finally{await host.stop();}
    if(await (await fetch(sentinel.url)).text()!==sentinel.token)throw new Error('cleanup altered sentinel');
    const nativeAfter=await jsonRequest(nativeSentinel.base,a.generation==='v1'?'/path':'/api/location');
    if(JSON.stringify(nativeBefore)!==JSON.stringify(nativeAfter)||JSON.stringify(await processBirth(nativeSentinel.proc.pid))!==JSON.stringify(nativeSentinel.birth))throw new Error('native sentinel changed during cleanup');
    const sentinelAfterFiles=await inventory(sentinelProject.root);
    const beforeMap=new Map(sentinelBeforeFiles.filter(f=>!f.path.startsWith('data/')&&!f.path.startsWith('cache/')).map(f=>[f.path,f.sha256]));
    for(const f of sentinelAfterFiles)if(beforeMap.has(f.path)&&beforeMap.get(f.path)!==f.sha256)throw new Error('native sentinel config/artifact changed');
    await s.record('cleanup.json',{ownedPidDrained:true,sentinelUnchanged:true,nativeSentinel:{...nativeSentinelReceipt(sentinelProject,nativeSentinel,nativeBefore,nativeAfter,sentinelBeforeFiles,sentinelAfterFiles),...(transientLeases?{transientLeases}:{})},files:await inventory(s.root)});
    return advertisedHelp;
  }finally{
    sentinel?.server.stop(true);await nativeSentinel.stop();
    try {
      const cleanup=JSON.parse(await readFile(join(s.evidence,'cleanup.json'),'utf8'));
      cleanup.nativeSentinel.cleanup=JSON.parse(await readFile(join(sentinelProject.evidence,'native-process.json'),'utf8'));
      await s.record('cleanup.json',cleanup);
    }catch(e:any){if(e.code!=='ENOENT')throw e;}
  }
}
