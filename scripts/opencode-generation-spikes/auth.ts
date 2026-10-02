import { Sandbox, processBirth } from './sandbox';
// Credentials come only from the stdout pipe of this newly spawned TEST native process.
// No service registry, ambient headers, config or auth-root lookup is permitted here.
export class OwnedEndpoint {
  readonly epoch=crypto.randomUUID();
  private password?:string;
  private listening=false;
  private active=true;
  constructor(readonly sandbox:Sandbox,readonly base:string,readonly pid:number,readonly birth:Awaited<ReturnType<typeof processBirth>>) {
    const u=new URL(base);
    if(u.origin!==base||u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||u.username||u.password)throw new Error('invalid TEST endpoint');
  }
  async headers(url:URL) {
    if(!this.active)throw new Error('TEST endpoint revoked');
    if(url.origin!==this.base||url.username||url.password)throw new Error('foreign TEST endpoint');
    await this.sandbox.validate();
    if(JSON.stringify(await processBirth(this.pid).catch(()=>null))!==JSON.stringify(this.birth))throw new Error('TEST endpoint birth changed');
    if(!this.active)throw new Error('TEST endpoint revoked');
    return this.password?{Authorization:'Basic '+Buffer.from('opencode:'+this.password).toString('base64')}:{};
  }
  retire(){this.active=false;}
  revoke(){this.active=false;this.password=undefined;}
  scrub(text:string) {
    const clean=text.replace(/server password[^\r\n]*/gi,'server password [REDACTED]');
    return this.password?clean.split(this.password).join('[REDACTED]'):clean;
  }
  private line(line:string) {
    const text=line.replace(/\r$/,'');
    const listening=/^server listening on (http:\/\/127\.0\.0\.1:[0-9]+\/?$)/.exec(text);
    if(listening) {
      if(new URL(listening[1]).origin!==this.base)throw new Error('bootstrap endpoint mismatch');
      this.listening=true;
    }
    if(/^server password /i.test(text)) {
      const match=/^server password ([!-~]{1,512})$/.exec(text);
      if(!this.active||!this.listening||!match||this.password)throw new Error('invalid TEST bootstrap password banner');
      this.password=match[1];
    }
    return this.scrub(line);
  }
  async stdout(stream:ReadableStream<Uint8Array>) {
    const reader=stream.getReader(),decoder=new TextDecoder();let pending='',result='',bytes=0;
    try {
      for(;;) {
        const {value,done}=await reader.read();if(done)break;bytes+=value.length;
        if(bytes>2*1024*1024)throw new Error('native stdout limit');
        pending+=decoder.decode(value,{stream:true});
        let cut:number;while((cut=pending.indexOf('\n'))>=0){result+=this.line(pending.slice(0,cut))+'\n';pending=pending.slice(cut+1);}
      }
      pending+=decoder.decode();if(pending)result+=this.line(pending);return this.scrub(result);
    }catch(e){await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
  }
}
