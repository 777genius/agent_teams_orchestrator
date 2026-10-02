import { test, expect } from 'bun:test';
import { createServer } from 'node:http';
import { Wire, RequestFailure } from './wire';

test('TEST independent ordinary 650ms body, actual mutation reset one send, global abort one send', async () => {
  let mutation = 0, aborted = 0, slow = 0, transportCalls = 0; const requests: any[] = [];
  const sockets = new Set<any>(); const timers: ReturnType<typeof setTimeout>[] = [];
  const server = createServer((req, res) => {
    requests.push({path:req.url,method:req.method,at:performance.now()});
    if (req.url === '/ordinary') { slow++; res.writeHead(200, {'content-type':'application/json'}); res.write('{'); timers.push(setTimeout(()=>res.end('"TEST":true}'),650)); }
    else if (req.url === '/mutation') { mutation++; req.on('end',()=>{res.writeHead(200, {'content-type':'application/json'}); res.write('{'); timers.push(setTimeout(()=>res.destroy(),30));}); req.resume(); }
    else if (req.url === '/abort') { aborted++; req.on('end',()=>{res.writeHead(200, {'content-type':'application/json'}); res.write('{');}); req.resume(); }
    else res.end('{}');
  });
  server.on('connection', s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
  try {
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const base=`http://127.0.0.1:${(server.address() as any).port}`;
    const global=new AbortController();const records=new Map<string,Buffer>();
    const wire=new Wire(base,async()=>({}),async(n,b)=>{records.set(n,Buffer.from(b));},global.signal, (async (...args: Parameters<typeof fetch>) => {transportCalls++; return fetch(...args);}) as typeof fetch);
    const start=performance.now();expect((await wire.call('/ordinary')).value).toEqual({TEST:true});expect(performance.now()-start).toBeGreaterThanOrEqual(620);expect(global.signal.aborted).toBe(false);
    let error:any;try{await wire.call('/mutation','POST',{TEST:true});}catch(e){error=e;}
    console.log(JSON.stringify({TEST:'mutation-reset',requests,transportCalls,errorClass:error?.constructor.name,errorCode:error?.cause?.code,calls:wire.calls,partial:records.get('response-1.raw')?.toString()}));expect(error instanceof RequestFailure).toBe(true);expect(error.cause.code).toBe('ECONNRESET');expect(mutation).toBe(1);expect(['{', '{\r\n']).toContain(records.get('response-1.raw')?.toString());
    const timer=setTimeout(()=>global.abort(Error('TEST-global')),80);
    try{error=undefined;await wire.call('/abort','POST',{TEST:true});}catch(e){error=e;}finally{clearTimeout(timer);}
    expect(error.message).toBe('TEST-global');expect(error instanceof RequestFailure).toBe(false);
    await Bun.sleep(650);expect(aborted).toBe(1);expect(mutation).toBe(1);expect(slow).toBe(1);expect(wire.calls).toHaveLength(3);
    console.log(JSON.stringify({TEST:'independent',ordinaryElapsedMinimumMs:620,mutationTransportCalls:mutation,mutationErrorClass:'RequestFailure',globalAbortTransportCalls:aborted}));
  } finally {
    timers.forEach(clearTimeout);for(const s of sockets)s.destroy();
    if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));
    expect(server.listening).toBe(false);expect(sockets.size).toBe(0);
  }
},5000);
