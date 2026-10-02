import { realpath, lstat, mkdir, readFile, writeFile, readdir, rename, unlink } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join, basename, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
export const TASK = 'hosted-v1-opencode-dual-q0-native-20261001';
export const SOURCE = resolve(import.meta.dir, '../..');
const UNIT_ROOT = join(SOURCE,'.task-output','unit-roots');
const sourceRuntime = (p:string) => within(SOURCE,p)&&!within(UNIT_ROOT,p);
export const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
export function within(root: string, path: string) {
  const r = relative(root, path);
  return r === '' || (!r.startsWith('..' + '/') && r !== '..' && !isAbsolute(r));
}
export async function canonical(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path)
    throw new Error('noncanonical or symlink path: ' + path);
  return path;
}
export function isolatedEnvironment(root:string):Record<string,string> {
    const p = (s: string) => join(root, s);
    return {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'C.UTF-8', TZ: 'UTC',
      HOME: p('home'), USERPROFILE: p('home'), XDG_CONFIG_HOME: p('config'), XDG_DATA_HOME: p('data'),
      XDG_CACHE_HOME: p('cache'), XDG_STATE_HOME: p('state'), TMPDIR: p('tmp'), TMP: p('tmp'), TEMP: p('tmp'),
      APPDATA: p('appdata'), LOCALAPPDATA: p('localappdata'), NPM_CONFIG_CACHE: p('cache/npm'),
      BUN_INSTALL_CACHE_DIR: p('cache/bun'), CLAUDE_MULTIMODEL_DATA_HOME: p('data/teams'),
      CLAUDE_MULTIMODEL_CACHE_HOME: p('cache/teams'), GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: p('home/.gitconfig'), GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'iliya', GIT_AUTHOR_EMAIL: 'iliyazelenkog@gmail.com',
      GIT_COMMITTER_NAME: 'iliya', GIT_COMMITTER_EMAIL: 'iliyazelenkog@gmail.com',
    };
  }
export type Marker = { task: string; case: string; nonce: string; root: string; evidence: string; created: string };
export class Sandbox {
  private initialized=false;
  private constructor(readonly root: string, readonly evidence: string, readonly marker: Marker) {}
  // Both supplied paths must be absent. This owns the evidence directory before any native call.
  static async create(root: string, evidence: string, caseID: string) {
    for (const p of [root, evidence]) {
      if (!isAbsolute(p) || resolve(p) !== p || sourceRuntime(p)) throw new Error('source/noncanonical root refused');
      await canonical(dirname(p));
      try { await lstat(p); throw new Error('existing root refused: ' + p); }
      catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    }
    if (within(root, evidence) || within(evidence, root) || !basename(root).startsWith('TEST-'))
      throw new Error('distinct TEST/evidence roots required');
    await mkdir(root, { mode: 0o700 });
    await mkdir(evidence, { mode: 0o700 });
    const marker: Marker = { task: TASK, case: caseID, nonce: randomUUID(), root, evidence, created: new Date().toISOString() };
    for (const p of [root, evidence]) await writeFile(join(p, '.test-project-owner.json'), JSON.stringify(marker), { flag: 'wx', mode: 0o600 });
    const s = new Sandbox(root, evidence, marker);
    for (const p of ['home', 'config', 'data', 'cache', 'state', 'tmp', 'appdata', 'localappdata', 'artifacts'])
      await mkdir(join(root, p), { mode: 0o700 });
    for(const argv of [['init','--quiet'],['config','user.name','iliya'],['config','user.email','iliyazelenkog@gmail.com']]) {
      if((await s.command('/usr/bin/git',argv)).code!==0)throw new Error('TEST Git initialization failed');
    }
    s.initialized=true;
    await s.validate();
    return s;
  }
  env():Record<string,string> {return isolatedEnvironment(this.root);}
  async validate() {
    for (const p of [this.root, this.evidence]) {
      await canonical(p);
      if (sourceRuntime(p)) throw new Error('source runtime refused');
      const m = JSON.parse(await readFile(join(p, '.test-project-owner.json'), 'utf8'));
      if (JSON.stringify(m) !== JSON.stringify(this.marker)) throw new Error('ownership changed');
    }
    const proc = Bun.spawn(['/usr/bin/git', 'rev-parse', '--show-toplevel'], { cwd: this.root, env: this.env(), stdout: 'pipe', stderr: 'pipe' });
    const out = (await new Response(proc.stdout).text()).trim();
    if (await proc.exited !== 0 || out !== this.root || (await lstat(join(this.root, '.git'))).isSymbolicLink()) throw new Error('TEST Git root mismatch');
    for (const p of ['home','config','data','cache','state','tmp','appdata','localappdata','artifacts']) await canonical(join(this.root,p));
  }
  async path(path: string) {
    await this.validate();
    await canonical(path);
    if (!within(this.root, path)) throw new Error('escaped TEST path');
    return path;
  }
  async record(name: string, data: unknown) {
    return this.recordRaw(name,Buffer.from(JSON.stringify(data,null,2)+'\n'));
  }
  async recordRaw(name:string, data:Uint8Array) {
    await this.validate();
    try {const report=JSON.parse(await readFile(join(this.evidence,'case-report.json'),'utf8'));if(report.observationKind==='fresh-pending-acceptance')throw new Error('immutable fresh observation already sealed');}catch(e:any){if(e.code!=='ENOENT')throw e;}
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error('invalid evidence name');
    const target=join(this.evidence,name);
    try {const current=await lstat(target);if(!current.isFile()||current.isSymbolicLink())throw new Error('nonregular evidence destination');}
    catch(e:any){if(e.code!=='ENOENT')throw e;}
    const stage=join(this.evidence,'.evidence-'+randomUUID()+'.tmp');
    try {
      await writeFile(stage,data,{flag:'wx',mode:0o600});
      await this.validate();await rename(stage,target);
    }finally{await unlink(stage).catch((e:any)=>{if(e.code!=='ENOENT')throw e;});}
  }
  async command(binary: string, args: string[], timeout = 15000) {
    if(this.initialized)await this.validate();
    else {
      if(binary!=='/usr/bin/git')throw new Error('only Git initialization allowed before TEST validation');
      for(const p of [this.root,this.evidence]) {await canonical(p);if(JSON.stringify(JSON.parse(await readFile(join(p,'.test-project-owner.json'),'utf8')))!==JSON.stringify(this.marker))throw new Error('ownership changed');}
    }
    const proc = Bun.spawn([binary, ...args], { cwd: this.root, env: this.env(), stdout: 'pipe', stderr: 'pipe' });
    const birth = await processBirth(proc.pid).catch(() => null);
    const owned = birth ? new OwnedProcessTree(proc.pid,birth) : undefined;
    owned?.start();
    let expired = false;
    const timer = setTimeout(async () => { expired = true; if (owned) await owned.stop(); }, timeout);
    try {
      const [stdout, stderr, code] = await Promise.all([boundedText(proc.stdout), boundedText(proc.stderr), proc.exited]);
      return { args: [binary, ...args], pid: proc.pid, birth, stdout, stderr, code, expired };
    } finally { clearTimeout(timer); if(owned)await owned.stop(); }
  }
}
export async function boundedText(stream: ReadableStream<Uint8Array>, cap = 2 * 1024 * 1024) {
  const reader = stream.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length;
    if (size > cap) { await reader.cancel(); throw new Error('output limit'); } chunks.push(value); }
  return Buffer.concat(chunks).toString('utf8');
}
export async function processBirth(pid: number) {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  return { format: 'linux-start-ticks', value: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], bootId: (await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim() };
}
export async function terminate(pid: number, birth: Awaited<ReturnType<typeof processBirth>>) {
  const same = async () => {
    try{return JSON.stringify(await processBirth(pid))===JSON.stringify(birth);}
    catch(e:any){if(e.code==='ENOENT')return false;throw new Error('process identity unknown: '+String(e));}
  };
  if (!await same()) return 'absent-or-changed';
  process.kill(pid, 'SIGTERM');
  for (let i=0;i<50;i++) { if (!await same()) return 'drained'; await Bun.sleep(100); }
  if (await same()) process.kill(pid, 'SIGKILL');
  for (let i=0;i<30;i++) { if (!await same()) return 'forced-drained'; await Bun.sleep(100); }
  throw new Error('owned process did not drain');
}
export async function inventory(root: string): Promise<Array<{path:string;sha256:string;bytes:number}>> {
  const out: Array<{path:string;sha256:string;bytes:number}> = [];
  async function visit(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p=join(dir,entry.name);
      if (entry.isSymbolicLink()) { if (!within(root, await realpath(p))) throw new Error('native escaped symlink'); continue; }
      if (entry.isDirectory()) await visit(p);
      else if (entry.isFile()) { const b=await readFile(p); out.push({path:relative(root,p),sha256:sha(b),bytes:b.length}); }
    }
  }
  await visit(root); return out.sort((a,b)=>a.path.localeCompare(b.path));
}
export class OwnedProcessTree {
  readonly processes=new Map<number,Awaited<ReturnType<typeof processBirth>>>();
  private timer?:ReturnType<typeof setInterval>;
  private scan:Promise<void>=Promise.resolve();
  constructor(readonly pid:number,birth:Awaited<ReturnType<typeof processBirth>>) {this.processes.set(pid,birth);}
  async capture() {
    for(const [pid,birth] of this.processes) {
      if(JSON.stringify(await processBirth(pid).catch((e:any)=>{if(e.code==='ENOENT')return null;throw e;}))!==JSON.stringify(birth))continue;
      const children=await readFile(`/proc/${pid}/task/${pid}/children`,'utf8').catch((e:any)=>{if(e.code==='ENOENT')return '';throw e;});
      for(const child of children.trim().split(/\s+/).filter(Boolean).map(Number)) {
        const token=await processBirth(child).catch((e:any)=>{if(e.code==='ENOENT')return null;throw e;});if(token&&!this.processes.has(child))this.processes.set(child,token);
      }
    }
  }
  start() {this.timer=setInterval(()=>{this.scan=this.scan.then(()=>this.capture());},100);}
  async stop() {
    clearInterval(this.timer);await this.scan;await this.capture();
    const results=[];
    // Drain foreground owner first, then any previously observed descendants by exact birth.
    for(const [pid,birth] of this.processes)results.push({pid,birth,result:await terminate(pid,birth)});
    return results;
  }
}
