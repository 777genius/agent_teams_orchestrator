// These collectors use only a caller's owned requester. No ambient endpoint or credentials.
export type Requester = (path:string, timeout:number, signal?:AbortSignal)=>Promise<unknown>;
export function object(value:unknown):Record<string,any> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid object');
  return value as Record<string,any>;
}
export function rows(value:unknown):any[] {
  const data=object(value).data;
  if(!Array.isArray(data)||data.length>200)throw new Error('invalid native page');
  return data;
}
export type PageReceipt={path:string;response:unknown;elapsedMs:number;budgetMs:number};
export function transcriptPath(sessionID:string,cursor?:string) {
  return `/api/session/${encodeURIComponent(sessionID)}/message?limit=200&`+
    (cursor===undefined?'order=asc':`cursor=${encodeURIComponent(cursor)}`);
}
// Measured V2 discriminated rows. Keep raw objects; only assistants own parts.
export function nativeRow(value:unknown,version?:string) {
 const m=object(value);
 if(typeof m.id!=='string'||!m.id)throw new Error('invalid native message id');
 if(m.type==='user') {if(typeof m.text!=='string'||'content' in m)throw new Error('invalid native user');}
 else if(m.type==='assistant') {
  if(!Array.isArray(m.content)||m.content.some((p:any)=>!p||typeof p!=='object'||(!['text','tool'].includes(p.type)||p.type==='text'&&typeof p.text!=='string'||p.type==='tool'&&(typeof p.id!=='string'||typeof p.name!=='string'||!p.state||typeof p.state!=='object'))))throw new Error('invalid native assistant parts');
 }else if(m.type==='idle') {if(version==='2.0.0'||'content' in m||m.outcome!=='succeeded'||!Number.isFinite(m.time?.created))throw new Error('invalid native idle');}
 else throw new Error('unknown native row');
 return m;
}
export function validatePages(pages:unknown,sessionID:string,version?:string):any[] {
  if(!Array.isArray(pages)||!pages.length||pages.length>100)throw new Error('incomplete native pages');
  const messages:any[]=[],ids=new Set<string>(),cursors=new Set<string>();let cursor:string|undefined;
  let bytes=0;
  for(let i=0;i<pages.length;i++) {
    const p=object(pages[i]);if(!Number.isFinite(p.elapsedMs)||p.elapsedMs<0||!Number.isFinite(p.budgetMs)||p.budgetMs<=0||p.budgetMs>20000||p.elapsedMs>p.budgetMs||(i&&p.elapsedMs<pages[i-1].elapsedMs))throw new Error('native page deadline evidence');if(p.path!==transcriptPath(sessionID,cursor))throw new Error('native page query mismatch');
    bytes+=Buffer.byteLength(JSON.stringify(p.response));if(bytes>32*1024*1024)throw new Error('native page byte budget');
    const data=rows(p.response);
    if(!data.length) {if(i!==pages.length-1)throw new Error('pages after empty page');return messages;}
    for(const row of data) {
      const m=nativeRow(row,version);if(ids.has(m.id))throw new Error('invalid/duplicate native message');
      ids.add(m.id);messages.push(m);
    }
    cursor=object(p.response).cursor?.next;
    if(typeof cursor!=='string'||!cursor||cursor.length>8192||cursors.has(cursor))throw new Error('incomplete native cursor or cycle');
    cursors.add(cursor);
  }
  throw new Error('incomplete native pages: no empty terminal page');
}
export async function collectTranscript(request:Requester,sessionID:string,record:(pages:PageReceipt[])=>Promise<void>,signal?:AbortSignal,budgetMs=20000,version?:string) {
  const start=Date.now(),deadline=start+budgetMs,pages:PageReceipt[]=[];let cursor:string|undefined;
  const ids=new Set<string>(),cursors=new Set<string>();let bytes=0;
  try {
    for(let n=0;n<100;n++) {
      signal?.throwIfAborted();const remaining=deadline-Date.now();if(remaining<=0)throw new Error('native page deadline');
      const path=transcriptPath(sessionID,cursor),response=await request(path,remaining,signal);pages.push({path,response,elapsedMs:Date.now()-start,budgetMs});
      if(!rows(response).length)return validatePages(pages,sessionID,version);
      const next=object(response).cursor?.next;
      if(typeof next!=='string'||!next||next.length>8192||cursors.has(next))throw new Error('incomplete native cursor or cycle');
      cursors.add(next);bytes+=Buffer.byteLength(JSON.stringify(response));if(bytes>32*1024*1024)throw new Error('native page byte budget');
      for(const row of rows(response)) {
        const m=nativeRow(row,version);if(ids.has(m.id))throw new Error('invalid/duplicate native message');
        ids.add(m.id);
      }
      cursor=next;
    }
    throw new Error('native page count budget');
  }finally{await record(pages);}
}
export function selectedModel(catalog:unknown,generation:string) {
  const c=object(catalog);
  const models=generation==='v1'?c.all?.filter((p:any)=>p.id==='test-model').flatMap((p:any)=>Object.values(p.models??{})):c.data;
  if(!Array.isArray(models))return undefined;
  return models.find((m:any)=>m.id==='q0-catalog'&&(generation==='v1'||m.providerID==='test-model')&&
    (generation==='v1'?m.api?.id==='q0-upstream'&&m.api?.npm==='@ai-sdk/openai-compatible':m.modelID==='q0-upstream'));
}
export async function waitCatalog(request:Requester,generation:string,record:(receipt:unknown)=>Promise<void>,signal?:AbortSignal,budgetMs=20000) {
  const start=Date.now(),deadline=start+budgetMs,timeline:any[]=[];let lastError='';
  try {
    for(let attempt=0;attempt<200;attempt++) {
      signal?.throwIfAborted();const remaining=deadline-Date.now();if(remaining<=0)throw new Error('catalog readiness deadline: '+lastError);
      try {
        const response=await request(generation==='v1'?'/provider':'/api/model',Math.min(remaining,1000),signal);
        timeline.push({elapsedMs:Date.now()-start,response});if(selectedModel(response,generation))return response;
        lastError='selected provider/model/upstream absent';
      }catch(e){signal?.throwIfAborted();lastError=String(e);timeline.push({elapsedMs:Date.now()-start,error:lastError});}
      await new Promise<void>((resolve,reject)=>{
        const done=()=>{signal?.removeEventListener('abort',abort);resolve();};
        const timer=setTimeout(done,Math.max(0,Math.min(100,deadline-Date.now())));
        const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal?.reason);};
        signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
      });
    }
    throw new Error('catalog readiness attempt budget: '+lastError);
  }finally{await record({budgetMs,elapsedMs:Date.now()-start,lastError,timeline});}
}
