import { readFile, writeFile, mkdir, chmod, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { Sandbox, sha, within, canonical } from './sandbox';
export const ANCHORS = [
  { generation: 'v1', version: '1.16.0', package: 'opencode-ai', rootSri: 'sha512-dtwbLWn/lzPUcHQ0OYlZENZhAwf0KWTynrI6ZcbTALUHzau5zW0oFPTjOE3xhjTfQyEichd++oafMyKmBkjNDQ==' },
  { generation: 'v1', version: '1.18.34', package: 'opencode-ai', rootSri: 'sha512-9WUS2T0t4HHDVzXvuwTHF0nvhXvZ9mQ0r+ozCvKdJu0LVoQpOzqAW4qWTC3ygNc5Oedcc7j+Oct24JYlQYnySA==' },
  { generation: 'v2', version: '2.0.0', package: '@opencode/cli', rootSri: 'sha512-YrukVlHyLA8b32nexmnvntZEKzFTdEu+a1QkPs1AoF4QzDDTHwDiyzOCP+2r8xRP9/BVLwBrT1InmCdI2beOag==' },
  { generation: 'v2', version: '2.0.21', package: '@opencode/cli', rootSri: 'sha512-hXFVQlNX+usWsYR5xYxDl1pYyG525V7p0kAGI0Q/mhrLg/2FpyJwuw0bMVJ+fc4PxHKHPC0tsIwAG/8i3lusKg==' },
] as const;
export type Anchor = typeof ANCHORS[number];
export class MissingArtifact extends Error {}
export async function responseBytes(response: Response, max: number) {
  if (!response.ok) throw new MissingArtifact(`HTTP ${response.status} ${response.url ? new URL(response.url).pathname : '(no URL)'}`);
  if (!response.body) throw new Error('empty body');
  const reader = response.body.getReader(); let bytes=0; const chunks: Uint8Array[]=[];
  try { for (;;) { const {value,done}=await reader.read(); if(done) break;
    bytes+=value.length; if(bytes>max) throw new Error('download exceeds cap'); chunks.push(value); }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}
export async function registryFetch(url: string, cap: number) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.hostname !== 'registry.npmjs.org' || u.username || u.password || u.port)
    throw new Error('nonofficial registry URL refused');
  try { return await responseBytes(await fetch(url, { redirect:'error', signal:AbortSignal.timeout(60000) }),cap); }
  catch (e) { if(e instanceof MissingArtifact) throw e; throw new MissingArtifact(`registry retrieval unavailable: ${String(e)}`); }
}
export function verifySri(bytes: Uint8Array, sri: string) {
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(sri)) throw new Error('exact sha512 SRI required');
  const expected=Buffer.from(sri.slice(7),'base64'),actual=createHash('sha512').update(bytes).digest();
  if (expected.length !== actual.length || !timingSafeEqual(expected,actual)) throw new Error('registry SRI mismatch');
}
// Parse and validate BEFORE writing: reject links, device entries, GNU/PAX path overrides and duplicates.
// Official npm tarballs use package/... regular files/directories. Unsupported archives fail closed.
export function unpackArchive(bytes: Uint8Array, identicalDuplicatePaths:readonly string[] = []): Map<string,Buffer> {
  const tar=gunzipSync(bytes,{maxOutputLength:1024*1024*1024}),files=new Map<string,Buffer>();
  let offset=0;const names=new Set<string>();
  while(offset+512<=tar.length) {
    const h=tar.subarray(offset,offset+512); if(h.every(b=>b===0)) {
      if(tar.subarray(offset).some(b=>b!==0)) throw new Error('nonzero trailing archive'); return files;
    }
    const field=(start:number,len:number)=>h.subarray(start,start+len).toString('utf8').replace(/\0.*$/s,'');
    const oct=(s:string)=>{if(!/^[0-7]+$/.test(s.trim()))throw new Error('invalid tar number');return parseInt(s.trim(),8);};
    const sum=oct(field(148,8));let actual=0;for(let i=0;i<512;i++)actual+=i>=148&&i<156?32:h[i]!;
    if(sum!==actual)throw new Error('tar checksum mismatch');
    const prefix=field(345,155),name=(prefix?prefix+'/':'')+field(0,100),type=field(156,1),size=oct(field(124,12));
    if (!['','0','5'].includes(type)) throw new Error('unsupported tar entry (links/overrides refused)');
    const clean=name.replace(/\/$/,'');
    if(clean==='package'&&type==='5'&&size===0){offset+=512;continue;}
    if(!clean.startsWith('package/') || clean.includes('\\') || clean.split('/').some(p=>p==='..'||p==='.'||!p))
      throw new Error('unsafe/duplicate archive path');
    const duplicate=names.has(clean);names.add(clean);
    if(offset+512+size>tar.length || !Number.isSafeInteger(size) || type==='5'&&size!==0) throw new Error('truncated archive');
    const body=Buffer.from(tar.subarray(offset+512,offset+512+size));
    if(duplicate&&(!identicalDuplicatePaths.includes(clean.slice(8))||type==='5'||!files.get(clean.slice(8))?.equals(body)))throw new Error('unsafe/duplicate archive path');
    if(type!=='5')files.set(clean.slice(8),body);
    offset+=512+Math.ceil(size/512)*512;
  }
  throw new Error('missing tar terminator');
}
export function verifyElf(bytes: Buffer) {
  if(process.platform!=='linux' || !['x64','arm64'].includes(process.arch)) throw new Error('Linux native execution required');
  if(bytes.length<64 || bytes.subarray(0,4).toString('hex')!=='7f454c46' || bytes[4]!==2 || bytes[5]!==1 || bytes.readUInt16LE(18)!==(process.arch==='x64'?62:183))
    throw new Error('real native ELF required; launcher/alias/stub rejected');
}
type Metadata = { name:string;version:string;optionalDependencies?:Record<string,string>;dist:{tarball:string;integrity:string} };
export type NativeArtifact = { binary:string;sha256:string;packages:Array<Record<string,unknown>>; generation:string;version:string };
export async function acquire(s:Sandbox, anchor:Anchor, bundle?:string, explicit?:string, platformMetadataSha256?:string):Promise<NativeArtifact> {
  await s.validate();
  if(bundle&&!/^[0-9a-f]{64}$/.test(platformMetadataSha256??''))throw new Error('offline bundle requires controller-pinned official platform metadata SHA256');
  const artifacts=join(s.root,'artifacts');
  const packages:Array<Record<string,unknown>>=[];
  async function pkg(name:string, version:string, label:string) {
    const raw=bundle ? await readFile(join(bundle,label+'.metadata.json')) : await registryFetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`,4*1024*1024);
    if(bundle&&label==='platform'&&sha(raw)!==platformMetadataSha256)throw new Error('offline platform metadata differs from pinned input');
    const m=JSON.parse(raw.toString()) as Metadata;
    if(label==='root'&&m.dist?.integrity!==anchor.rootSri)throw new Error('root registry SRI differs from immutable accepted pin');
    if(m.name!==name||m.version!==version)throw new Error('package metadata identity mismatch');
    const bytes=bundle ? await readFile(join(bundle,label+'.tgz')) : await registryFetch(m.dist.tarball,256*1024*1024);
    verifySri(bytes,m.dist.integrity);
    const files=unpackArchive(bytes,label==='root'&&anchor.version==='2.0.21'?['bin/opencode.exe']:[]),manifest=JSON.parse(files.get('package.json')?.toString()||'null');
    if(manifest?.name!==name||manifest?.version!==version)throw new Error('archive package identity mismatch');
    await writeFile(join(artifacts,label+'.metadata.json'),raw,{flag:'wx'});
    await writeFile(join(artifacts,label+'.tgz'),bytes,{flag:'wx'});
    packages.push({name,version,metadataSha256:sha(raw),archiveSri:m.dist.integrity,archiveSha256:sha(bytes),tarball:m.dist.tarball,
      files:[...files].map(([path,b])=>({path,sha256:sha(b),bytes:b.length}))});
    return {m,files};
  }
  const root=await pkg(anchor.package,anchor.version,'root');
  const platform=anchor.generation==='v1'?`opencode-linux-${process.arch}`:`@opencode/cli-linux-${process.arch}`;
  if(root.m.optionalDependencies?.[platform]!==anchor.version)throw new Error('exact platform dependency absent');
  const native=await pkg(platform,anchor.version,'platform');
  const candidates=[...native.files].filter(([name,b])=>name==='bin/opencode'||name==='bin/opencode.exe');
  if(candidates.length!==1)throw new Error('ambiguous native executable');
  const [name,bytes]=candidates[0]!; verifyElf(bytes);
  if(explicit) { const b=await readFile(await realpath(explicit)); if(sha(b)!==sha(bytes))throw new Error('explicit binary differs from official native archive'); }
  const binary=join(artifacts,'native-opencode');await writeFile(binary,bytes,{flag:'wx',mode:0o700});await chmod(binary,0o700);
  const artifact={binary,sha256:sha(bytes),packages,generation:anchor.generation,version:anchor.version,provenance:bundle?'offline controller-attested platform metadata':'fresh official registry',platformMetadataSha256:platformMetadataSha256??null};
  await s.record('native-artifact-integrity.json',artifact);
  return artifact;
}
const SDK_VERSION=/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export async function extractProviderPackages(s:Sandbox) {
  // Only actual native-installed package files qualify resolution. This never installs a guessed version.
  const found:Array<Record<string,unknown>>=[];
  async function visit(dir:string) {
    const {readdir}=await import('node:fs/promises');
    for(const e of await readdir(dir,{withFileTypes:true})) {
      const p=join(dir,e.name); if(e.isSymbolicLink()) { if(!within(s.root,await realpath(p)))throw new Error('package cache escaped');continue; }
      if(e.isDirectory())await visit(p);
      else if(e.name==='package.json') {
        let m:any;try{m=JSON.parse(await readFile(p,'utf8'));}catch{continue;}
        if(m.name==='@ai-sdk/openai-compatible') {
          if(typeof m.version!=='string'||!SDK_VERSION.test(m.version))throw new Error('invalid provider package version');
          await canonical(dir);
          const raw=await registryFetch(`https://registry.npmjs.org/${encodeURIComponent(m.name)}/${m.version}`,4*1024*1024);
          const metadata=JSON.parse(raw.toString());
          if(metadata.name!==m.name||metadata.version!==m.version)throw new Error('provider registry identity mismatch');
          const archive=await registryFetch(metadata.dist.tarball,16*1024*1024);verifySri(archive,metadata.dist.integrity);
          const files=unpackArchive(archive);
          for(const [name,b] of files) {await canonical(join(dir,name));if(sha(await readFile(join(dir,name)))!==sha(b))throw new Error('installed AI SDK differs from official archive');}
          await writeFile(join(s.root,'artifacts',`ai-sdk-${m.version}.tgz`),archive);
          await writeFile(join(s.root,'artifacts',`ai-sdk-${m.version}.metadata.json`),raw);
          found.push({name:m.name,version:m.version,path:relative(s.root,dir),sri:metadata.dist.integrity,archiveSha256:sha(archive),metadataSha256:sha(raw)});
        }
      }
    }
  }
  for(const p of ['cache','data','config'])await visit(join(s.root,p));
  await verifyProviderPackages(s.root,found);
  return found; // Empty is measured absence, never an invented package version/SRI.
}
// Shared by native collection and the public reader. Empty packages remain unresolved;
// a claimed external SDK must retain physical installed bytes AND its verified archive.
export async function verifyProviderPackages(root:string, packages:Array<Record<string,any>>) {
  if(!Array.isArray(packages))throw new Error('invalid provider package claims');
  for(const p of packages) {
    if(p.name!=='@ai-sdk/openai-compatible'||typeof p.version!=='string'||!SDK_VERSION.test(p.version)||typeof p.path!=='string')throw new Error('invalid provider package identity');
    const installed=join(root,p.path);
    if(!['cache','data','config'].some(dir=>within(join(root,dir),installed))||relative(root,installed)!==p.path)throw new Error('escaped provider package path');
    try {
      await canonical(installed);
      const metadataPath=join(root,'artifacts',`ai-sdk-${p.version}.metadata.json`),archivePath=join(root,'artifacts',`ai-sdk-${p.version}.tgz`);
      await canonical(metadataPath);await canonical(archivePath);
      const raw=await readFile(metadataPath),archive=await readFile(archivePath);
      if(sha(raw)!==p.metadataSha256||sha(archive)!==p.archiveSha256)throw new Error('provider artifact hash mismatch');
      const metadata=JSON.parse(raw.toString());
      if(metadata.name!==p.name||metadata.version!==p.version||metadata.dist?.integrity!==p.sri)throw new Error('provider metadata identity mismatch');
      verifySri(archive,p.sri);const files=unpackArchive(archive);
      const manifest=JSON.parse(files.get('package.json')?.toString()||'null');
      if(manifest?.name!==p.name||manifest?.version!==p.version)throw new Error('provider archive identity mismatch');
      for(const [name,bytes] of files) {
        const path=join(installed,name);await canonical(path);
        if(!within(installed,path)||sha(await readFile(path))!==sha(bytes))throw new Error('provider installed bytes differ from archive');
      }
    }catch(e){throw new Error('provider package proof invalid: '+String(e));}
  }
}
