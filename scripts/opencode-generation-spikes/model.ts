import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { sha, Sandbox, boundedText } from './sandbox';
import { Anchor, NativeArtifact, extractProviderPackages, MissingArtifact } from './artifacts';
import { collectTranscript, waitCatalog } from './collections';
import { jsonRequest, startNative } from './native';
export const CATALOG='q0-catalog', UPSTREAM='q0-upstream', PROVIDER='test-model';
export type Decision = { tool:string;args:Record<string,unknown>;id:string };
export class ModelFixture {
  readonly requests:any[]=[];readonly frames:string[][]=[];readonly decisions:Decision[]=[];readonly failures:string[]=[];
  server?:ReturnType<typeof Bun.serve>;
  constructor(readonly root:string,readonly seed:string,readonly output:string,readonly shellOutput:string,readonly token:string) {
  }
  async start(s:Sandbox) {
    await s.validate();if(s.root!==this.root||this.server)throw new Error('fixture ownership mismatch');
    this.server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:r=>this.respond(r)});
  }
  get url(){if(!this.server)throw new Error('fixture not listening');return `http://127.0.0.1:${this.server.port}/v1`;}
  stop(){this.server?.stop(true);this.server=undefined;}
  private next(body:any):Decision|null {
    if(body.model!==UPSTREAM||body.stream!==true||!Array.isArray(body.messages))throw new Error('unexpected native model identity/protocol');
    const stage=this.decisions.length;
    if(stage>0) {
      const previous=this.decisions[stage-1]!;
      const result=body.messages.find((m:any)=>m.role==='tool'&&m.tool_call_id===previous.id);
      if(!result)throw new Error('native tool result absent from next model request');
      if(stage===1 && !JSON.stringify(result.content).includes(this.token))throw new Error('native read result lacks TEST seed');
      if(/error|denied|not found/i.test(typeof result.content==='string'?result.content:JSON.stringify(result.content)))throw new Error('native tool result reports error');
    }
    if(stage===3)return null;
    const names=stage===0?['read']:stage===1?['write']:['bash','shell'];
    const tool=body.tools?.find((t:any)=>names.includes(t.function?.name));
    if(!tool)throw new Error('native tool not advertised: '+names.join('/'));
    const schema=tool.function.parameters,props=schema?.properties;
    if(!props||!Array.isArray(schema.required))throw new Error('native tool schema unavailable');
    const args:Record<string,unknown>={};
    const pathKey=['filePath','path','file_path'].find(p=>p in props);
    if(stage<2) {
      if(!pathKey)throw new Error('unsupported native path schema');
      args[pathKey]=stage===0?this.seed:this.output;
      if(stage===1) { if(!('content' in props))throw new Error('unsupported write schema');args.content=`native-write:${this.token}\n`; }
    }else {
      if(!('command' in props))throw new Error('unsupported shell schema');
      // All substituted characters are from canonical TEST paths and UUID; single quote is escaped.
      const quote=(x:string)=>"'"+x.replace(/'/g,"'\\''")+"'";
      args.command=`printf '%s\\n' ${quote('native-shell:'+this.token)} > ${quote(this.shellOutput)}`;
      if('description' in props)args.description='Write isolated TEST shell evidence';
      if('workdir' in props)args.workdir=this.root;
    }
    for(const p of schema.required) if(!(p in args))throw new Error('unsupported required native tool argument: '+p);
    const decision={tool:tool.function.name,args,id:'call_'+sha(JSON.stringify({stage,args})).slice(0,24)};
    this.decisions.push(decision);return decision;
  }
  async respond(r:Request) {
    if(new URL(r.url).pathname!=='/v1/chat/completions'||r.method!=='POST')return new Response('unsupported model protocol',{status:404});
    try {
      if(this.requests.length>=4)throw new Error('model request budget');
      if(r.headers.get('authorization')!=='Bearer TEST-DUMMY-KEY')throw new Error('TEST-only auth missing');
      const raw=await boundedText(r.body!,4*1024*1024);
      const body=JSON.parse(raw);this.requests.push({endpoint:'/v1/chat/completions',method:r.method,authorization:'TEST dummy key (redacted)',headers:{'user-agent':r.headers.get('user-agent'),'content-type':r.headers.get('content-type')},body});
      const d=this.next(body),id='chatcmpl_'+sha(raw).slice(0,24),frames:string[]=[];
      const chunk=(delta:any,finish:any=null)=>({id,object:'chat.completion.chunk',created:1,model:UPSTREAM,choices:[{index:0,delta,finish_reason:finish}]});
      const objects:any[]=[chunk({role:'assistant'})];
      if(d) {
        objects.push(chunk({tool_calls:[{index:0,id:d.id,type:'function',function:{name:d.tool,arguments:''}}]}));
        const args=JSON.stringify(d.args),mid=Math.floor(args.length/2);
        objects.push(chunk({tool_calls:[{index:0,function:{arguments:args.slice(0,mid)}}]}));
        objects.push(chunk({tool_calls:[{index:0,function:{arguments:args.slice(mid)}}]}));
      }else objects.push(chunk({content:`q0-terminal:${this.token}`}));
      objects.push(chunk({},d?'tool_calls':'stop'));
      objects.push({id,object:'chat.completion.chunk',created:1,model:UPSTREAM,choices:[],usage:{prompt_tokens:17,completion_tokens:5,total_tokens:22,prompt_tokens_details:{cached_tokens:0},completion_tokens_details:{reasoning_tokens:0}}});
      for(const obj of objects)frames.push('data: '+JSON.stringify(obj)+'\n\n');frames.push('data: [DONE]\n\n');this.frames.push(frames);
      const encoder=new TextEncoder();
      return new Response(new ReadableStream({start(c){for(const f of frames)c.enqueue(encoder.encode(f));c.close();}}),{headers:{'Content-Type':'text/event-stream','Cache-Control':'no-cache'}});
    }catch(e){if(this.failures.length<10)this.failures.push(String(e));return Response.json({error:{message:String(e),type:'invalid_request_error'}},{status:400});}
  }
}
export function configFor(a:Anchor,baseURL:string) {
  const common={$schema:'https://opencode.ai/config.json',model:`${PROVIDER}/${CATALOG}`,share:'disabled'};
  return a.generation==='v1'?{...common,autoupdate:false,permission:{read:'allow',edit:'allow',bash:'allow'},provider:{[PROVIDER]:{
    npm:'@ai-sdk/openai-compatible',name:'TEST protocol',options:{baseURL,apiKey:'TEST-DUMMY-KEY'},models:{[CATALOG]:{
      id:UPSTREAM,name:'TEST native model',tool_call:true,limit:{context:32000,output:2048},cost:{input:1,output:1}}}}}}
    :{...common,update:'disable',permissions:[{action:'read',resource:'*',effect:'allow'},{action:'edit',resource:'*',effect:'allow'},{action:'shell',resource:'*',effect:'allow'}],providers:{[PROVIDER]:{
      package:'aisdk:@ai-sdk/openai-compatible',env:['TEST_Q0_MODEL_API_KEY'],name:'TEST protocol',settings:{baseURL,apiKey:'TEST-DUMMY-KEY'},models:{[CATALOG]:{
        modelID:UPSTREAM,name:'TEST native model',capabilities:{tools:true,input:['text'],output:['text']},limit:{context:32000,output:2048},cost:{input:1,output:1}}}}}};
}
function terminal(messages:any[],a:Anchor,token:string) {
  return messages.find(m=>a.generation==='v1'
    ?m.info?.role==='assistant'&&m.info?.time?.completed&&m.info?.finish==='stop'&&!m.info?.error&&m.parts?.some((p:any)=>p.type==='text'&&p.text===`q0-terminal:${token}`)
    :m.type==='assistant'&&m.time?.completed&&m.finish==='stop'&&!m.error&&m.content?.some((p:any)=>p.type==='text'&&p.text===`q0-terminal:${token}`));
}
export async function qualifyS3a(s:Sandbox,a:Anchor,artifact:NativeArtifact,help:string,signal?:AbortSignal) {
  await s.validate();
  const deadline=Date.now()+90000;
  const token=crypto.randomUUID(),seed=join(s.root,'q0-seed.txt'),output=join(s.root,'q0-written.txt'),shell=join(s.root,'q0-shell.txt');
  await writeFile(seed,`native-read:${token}\n`,{flag:'wx'});
  const fixture=new ModelFixture(s.root,seed,output,shell,token);
  let host:Awaited<ReturnType<typeof startNative>>|undefined;
  const cleanupErrors:string[]=[];
  try {
    await fixture.start(s);
    await s.record('model-fixture-startup.json',{url:fixture.url,owner:s.marker.nonce,root:s.root});
    const config=configFor(a,fixture.url),configPath=join(s.root,'opencode.json');
    await writeFile(configPath,JSON.stringify(config,null,2),{flag:'wx'});
    const fingerprint=sha(await readFile(configPath));
    await s.record('native-provider-config.json',{configPath,fingerprint,rawBase64:(await readFile(configPath)).toString('base64'),config,credential:'TEST-only dummy key'});
    host=await startNative(s,a,artifact,help,undefined,'TEST-DUMMY-KEY');
    const call=async(path:string,method='GET',body?:unknown,timeout=15000,cancel=signal)=>{
      cancel?.throwIfAborted();await s.validate();const remaining=deadline-Date.now();if(remaining<=0)throw new Error('native roundtrip deadline');
      return jsonRequest(host!.base,path,method,body,Math.min(timeout,remaining),cancel);
    };
    const request=(path:string,timeout:number,signal?:AbortSignal)=>call(path,'GET',undefined,timeout,signal);
    const catalog=await waitCatalog(request,a.generation,r=>s.record('catalog-readiness-timeline.json',r),signal);
    await s.record('native-model-catalog.json',catalog);
    await s.record('native-location.json',await call(a.generation==='v1'?'/path':'/api/location'));
    if(a.generation==='v2') {
      await s.record('effective-native-config.json',await call('/api/config'));
      await s.record('native-custom-provider.json',await call('/api/provider/'+PROVIDER));
    }
    const created=await call(a.generation==='v1'?'/session':'/api/session','POST',a.generation==='v1'?{title:'TEST q0 protocol'}:{title:'TEST q0 protocol',location:{directory:s.root},agent:'build',model:{providerID:PROVIDER,id:CATALOG}});
    const session=a.generation==='v1'?created:created.data;
    if(typeof session?.id!=='string')throw new Error('native session identity missing');
    await s.record('native-session-created.json',created);
    const id=encodeURIComponent(session.id),prompt={text:'Execute the TEST read/write/shell model instructions, then reply.'};
    const receipt=await call(a.generation==='v1'?`/session/${id}/prompt_async`:`/api/session/${id}/prompt`,'POST',a.generation==='v1'?{model:{providerID:PROVIDER,modelID:CATALOG},parts:[{type:'text',text:prompt.text}]}:{...prompt,delivery:'queue',resume:true});
    await s.record('native-prompt-receipt.json',receipt);
    let messages:any[]=[],proof:any;
    for(let i=0;i<600;i++) {
      if(fixture.failures.length)throw new Error(fixture.failures.join('; '));
      messages=a.generation==='v1'?await call(`/session/${id}/message`):
        await collectTranscript(request,session.id,pages=>s.record('native-transcript-pages.json',pages),signal,Math.min(20000,deadline-Date.now()),a.version);
      if(!Array.isArray(messages))throw new Error('invalid native transcript');proof=terminal(messages,a,token);if(proof)break;
      await Bun.sleep(100);
    }
    await s.record('native-transcript.json',messages);
    if(!proof||fixture.requests.length!==4||fixture.decisions.length!==3)throw new Error('native tool roundtrips/terminal missing');
    const nativeTools=messages.flatMap((m:any)=>a.generation==='v1'?(m.parts??[]):(m.content??[])).filter((p:any)=>p.type==='tool');
    for(const d of fixture.decisions) {
      const t=nativeTools.find((p:any)=>(a.generation==='v1'?p.callID:p.id)===d.id);
      if(!t||t.state?.status!=='completed'||JSON.stringify(t.state.input)!==JSON.stringify(d.args))throw new Error('native persisted completed tool/input proof missing');
    }
    const info=a.generation==='v1'?proof.info:proof,tokens=info.tokens;
    if(!tokens||tokens.input!==17||tokens.output!==5)throw new Error('native persisted usage mismatch');
    const written=await readFile(output,'utf8'),shelled=await readFile(shell,'utf8');
    if(written!==`native-write:${token}\n`||shelled!==`native-shell:${token}\n`||sha(await readFile(seed))!==sha(`native-read:${token}\n`))throw new Error('native file effects mismatch');
    await s.record('native-provider-config-after.json',{fingerprint:sha(await readFile(configPath)),rawBase64:(await readFile(configPath)).toString('base64'),config:JSON.parse(await readFile(configPath,'utf8'))});const packages=await extractProviderPackages(s);
    await s.record('provider-inventory.json',packages);
    const providerImplementation={mode:'unresolved-selected-route',nativeSha256:artifact.sha256,configuredPackage:a.generation==='v1'?config.provider[PROVIDER].npm:config.providers[PROVIDER].package,exactSdkIdentityProved:false};
    if(sha(await readFile(configPath))!==fingerprint)throw new Error('native rewrote TEST config');
    await s.record('provider-protocol-authenticity.json',{status:'MISSING',nativeBehavior:'PASS',providerImplementation,scope:'S3a Linux native model protocol prerequisite only',generation:a.generation,version:a.version,artifact,
      configFingerprint:fingerprint,providerID:PROVIDER,catalogModelID:CATALOG,upstreamModelID:UPSTREAM,packages,sessionID:session.id,
      terminalMessageID:info.id,tokens,fileDelta:[{path:output,sha256:sha(written)},{path:shell,sha256:sha(shelled)}],decisions:fixture.decisions,nativeTools});
    for(const [name,path] of [['seed',seed],['write',output],['shell',shell]])await s.record('physical-'+name+'.json',{path,sha256:sha(await readFile(path))});
    throw new MissingArtifact('native behavior observed; trusted selected resolver binding and new exact-source acceptance remain MISSING');
  }catch(e){await s.record('model-setup-or-run-error.json',{error:String(e)});throw e;}finally {
    try{fixture.stop();}catch(e){cleanupErrors.push('fixture: '+String(e));}
    try{if(host)await host.stop();}catch(e){cleanupErrors.push('host: '+String(e));}
    let prior:any={};try{prior=JSON.parse(await readFile(join(s.evidence,'cleanup.json'),'utf8'));}catch(e:any){if(e.code!=='ENOENT')cleanupErrors.push('cleanup read: '+String(e));}
    await s.record('cleanup.json',{...prior,modelFixtureStopped:!fixture.server,nativeHostStopped:!!host&&!cleanupErrors.length,errors:cleanupErrors});
    await s.record('model-wire.json',{requests:fixture.requests,streamedFrames:fixture.frames,decisions:fixture.decisions,failures:fixture.failures});
  }
}
