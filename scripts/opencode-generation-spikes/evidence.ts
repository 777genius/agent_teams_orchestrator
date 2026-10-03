import { readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { Sandbox, sha, canonical, within, TASK, SOURCE } from './sandbox';
import { decodeProtocol, validateProtocol, validateSentinel, loadTrust, TrustInput, TrustManifest, ProtocolV2, PacketAccess, equal } from './protocol';
import { acceptObservation, observationSubject, qualificationDecision, writeQualificationOutput } from './acceptance';
import { parseNativeVersion } from './version';
import { verifyElf, verifySri, unpackArchive, ANCHORS, verifyProviderPackages } from './artifacts';
export type Status='PASS'|'FAIL'|'MISSING';
export type CaseReport={schemaVersion:1;task:string;case:string;generation:string;version:string;status:Status;observed:string;root:string;evidence:string;created:string;observationKind?:'fresh-pending-acceptance';files:Array<{path:string;sha256:string}>};
export type QualificationResult=CaseReport & {observationStatus:Status;qualificationStatus:Status;observationProtocolSha256?:string;observationSealSha256:string;acceptanceSha256?:string;sourceManifestSha256?:string;ruleID?:string};
export async function seal(s:Sandbox,caseID:string,generation:string,version:string,status:Status,observed:string) {
  await s.validate();const files:CaseReport['files']=[];
  for(const name of (await readdir(s.evidence)).sort()) {
    if(name==='case-report.json')continue;
    const p=join(s.evidence,name);
    if(!(await lstat(p)).isFile()||(await lstat(p)).isSymbolicLink())throw new Error('nonregular evidence');
    files.push({path:name,sha256:sha(await readFile(p))});
  }
  const r:CaseReport={schemaVersion:1,task:TASK,case:caseID,generation,version,status,observed,root:s.root,evidence:s.evidence,created:new Date().toISOString(),files};
  try {const p=JSON.parse(await readFile(join(s.evidence,'provider-protocol-authenticity.json'),'utf8'));if(p.schemaVersion===2&&p.observationKind==='fresh-pending-acceptance') {if(status!=='MISSING')throw new Error('immutable observation cannot seal PASS/FAIL');r.observationKind=p.observationKind;}}catch(e:any){if(e.code!=='ENOENT')throw e;}
  await s.record('case-report.json',r);return r;
}
// Public reader verifies physical byte integrity and required native facts. It does not turn
// authored contract tests into native qualification or claim a cryptographic trusted producer.
export async function readQualification(dir:string, trustInput?:TrustInput, acceptanceInput?:TrustInput):Promise<QualificationResult> {
  await canonical(dir);await canonical(join(dir,'case-report.json'));if(!(await lstat(join(dir,'case-report.json'))).isFile())throw new Error('nonregular case report');const r=JSON.parse(await readFile(join(dir,'case-report.json'),'utf8')) as CaseReport;
  if(r.schemaVersion!==1||r.task!==TASK||r.evidence!==dir||!['PASS','FAIL','MISSING'].includes(r.status)||!Array.isArray(r.files)||r.files.length>100)throw new Error('invalid case report');
  await canonical(r.root);if(!basename(r.root).startsWith('TEST-')||within(SOURCE,r.root)&&!within(join(SOURCE,'.task-output/unit-roots'),r.root))throw new Error('foreign TEST root');
  await canonical(join(dir,'.test-project-owner.json'));
  const marker=JSON.parse(await readFile(join(dir,'.test-project-owner.json'),'utf8'));
  if(marker.task!==TASK||marker.root!==r.root||marker.evidence!==dir||marker.case!==r.case)throw new Error('foreign evidence owner');
  if(JSON.stringify(JSON.parse(await readFile(join(r.root,'.test-project-owner.json'),'utf8')))!==JSON.stringify(marker)||!marker.nonce||!marker.case)throw new Error('native root owner changed');
  const seen=new Set<string>();let totalBytes=0;
  for(const f of r.files) {
    if(!/^[A-Za-z0-9_.-]+$/.test(f.path)||seen.has(f.path))throw new Error('unsafe/duplicate evidence reference');seen.add(f.path);
    const p=join(dir,f.path);await canonical(p);
    const stat=await lstat(p);totalBytes+=stat.size;
    if(stat.size>64*1024*1024||totalBytes>192*1024*1024)throw new Error('packet byte budget');
    if(!stat.isFile()||sha(await readFile(p))!==f.sha256)throw new Error('evidence byte hash mismatch: '+f.path);
  }
  const json=async(name:string)=>{if(!seen.has(name))throw new Error('required native evidence missing: '+name);return JSON.parse(await readFile(join(dir,name),'utf8'));};
  if((await readdir(dir)).filter(n=>n!=='case-report.json').some(n=>!seen.has(n)))throw new Error('unsealed evidence file');
  let artifact:any;
  if(seen.has('native-artifact-integrity.json')) {
    await canonical(r.root);
    if(JSON.stringify(JSON.parse(await readFile(join(r.root,'.test-project-owner.json'),'utf8')))!==JSON.stringify(marker))throw new Error('native root owner changed');
    artifact=await json('native-artifact-integrity.json');
    if(artifact.version!==r.version||artifact.generation!==r.generation||!within(r.root,artifact.binary))throw new Error('artifact identity mismatch');
    await canonical(artifact.binary);const b=await readFile(artifact.binary);verifyElf(b);if(sha(b)!==artifact.sha256)throw new Error('native binary hash changed');
    const pin=ANCHORS.find(a=>a.generation===r.generation&&a.version===r.version);
    if(!pin||artifact.packages?.[0]?.archiveSri!==pin.rootSri)throw new Error('unqualified native root pin');
    if(artifact.packages?.length!==2)throw new Error('root/platform archive identities missing');
    const platformName=r.generation==='v1'?`opencode-linux-${process.arch}`:`@opencode/cli-linux-${process.arch}`;
    if(artifact.packages[1].name!==platformName)throw new Error('native platform package mismatch');
    for(const [i,p] of artifact.packages.entries()) {
      const label=i===0?'root':'platform',metadataBytes=await readFile(join(r.root,'artifacts',label+'.metadata.json'));
      if(sha(metadataBytes)!==p.metadataSha256)throw new Error('native metadata hash changed');
      const metadata=JSON.parse(metadataBytes.toString());
      if(metadata.name!==p.name||metadata.version!==r.version||metadata.dist?.integrity!==p.archiveSri)throw new Error('native metadata identity changed');
      if(i===0&&(p.name!==pin.package||metadata.optionalDependencies?.[artifact.packages[1].name]!==r.version))throw new Error('native optional platform identity mismatch');
      const archive=await readFile(join(r.root,'artifacts',i===0?'root.tgz':'platform.tgz'));
      verifySri(archive,p.archiveSri);if(sha(archive)!==p.archiveSha256)throw new Error('archive changed');
      const files=unpackArchive(archive,i===0&&r.version==='2.0.21'?['bin/opencode.exe']:[]);
      const manifest=JSON.parse(files.get('package.json')?.toString()||'null');
      if(manifest?.name!==p.name||manifest?.version!==r.version)throw new Error('archive package identity mismatch');
      if(i===0&&manifest.optionalDependencies?.[platformName]!==r.version)throw new Error('archive platform dependency mismatch');
      if(i===1) {
        const binaries=[...files].filter(([name])=>name==='bin/opencode'||name==='bin/opencode.exe');
        if(binaries.length!==1||!binaries[0][1].equals(b))throw new Error('native binary differs from verified platform archive');
      }
    }
  }
  if(seen.has('version-command.json')) {
    const v=await json('version-command.json');
    if(!artifact||v.code!==0||v.expired||parseNativeVersion(r.generation,v.stdout)!==r.version||v.args?.[0]!==artifact.binary)throw new Error('native version command proof mismatch');
  }
  if(seen.has('provider-protocol-authenticity.json')) {
    const provider=await json('provider-protocol-authenticity.json');
    if(provider.packages!==undefined)await verifyProviderPackages(r.root,provider.packages);
  }
  let protocolAccepted=false,fresh=false,historical=r.case==='S3a',protocol:any;
  let subject:ReturnType<typeof observationSubject>|undefined,acceptanceSha256:string|undefined;
  let protocolAccess:PacketAccess|undefined,controllerTrust:TrustManifest|undefined;
  if(seen.has('provider-protocol-authenticity.json')) {
    const raw=await json('provider-protocol-authenticity.json');
    if(raw.schemaVersion===2) {
      const p=decodeProtocol(raw),trust=await loadTrust(trustInput,r.root,dir);
      const bytes=async(ref:any)=>{
        if(!ref||!seen.has(ref.file)||!r.files.some(f=>f.path===ref.file&&f.sha256===ref.sha256))throw new Error('unsealed evidence reference');
        return readFile(join(dir,ref.file));
      };
      protocol=p;historical=false;fresh=p.observationKind==='fresh-pending-acceptance'&&r.observationKind===p.observationKind;
      if(p.observationKind&&(!fresh||r.status!=='MISSING'))throw new Error('fresh observation seal state mismatch');
      protocolAccess={root:r.root,dir,generation:r.generation,version:r.version,marker,artifact,bytes,ref:async(ref:any)=>JSON.parse((await bytes(ref)).toString())};controllerTrust=trust;
      if(fresh)subject=observationSubject(p,r,marker,artifact,await readFile(join(dir,'provider-protocol-authenticity.json')),await readFile(join(dir,'case-report.json')));
      else historical=true; // Schema2 without fresh protocol identity is not retroactively promoted.
    }
  }
  if(seen.has('cleanup.json')) {const c=await json('cleanup.json');if(c.ownedPidDrained!==true||c.sentinelUnchanged!==true||c.errors?.length||!c.nativeSentinel||JSON.stringify(c.nativeSentinel.before)!==JSON.stringify(c.nativeSentinel.after))throw new Error('native cleanup receipt incomplete');await validateSentinel(c.nativeSentinel,r.root,marker);}
  if(seen.has('native-process.json')&&seen.has('native-identity.json')) {const p=await json('native-process.json'),i=await json('native-identity.json');if(p.pid!==i.pid||JSON.stringify(p.birth)!==JSON.stringify(i.birth)||!Array.isArray(p.cleanup)||!p.cleanup.length||p.cleanup.some((c:any)=>!['drained','forced-drained','absent-or-changed'].includes(c.result)))throw new Error('owned native cleanup receipt incomplete');}
  const startupComplete=['native-artifact-integrity.json','version-command.json','native-identity.json','cleanup.json','native-process.json'].every(n=>seen.has(n));
  if(startupComplete||protocol||r.status==='PASS') {
    if(!artifact)throw new Error('required native evidence missing: native-artifact-integrity.json');
    const v=await json('version-command.json'),identity=await json('native-identity.json'),cleanup=await json('cleanup.json');
    const process=await json('native-process.json');
    if(process.pid!==identity.pid||JSON.stringify(process.birth)!==JSON.stringify(identity.birth)||!Array.isArray(process.cleanup)||!process.cleanup.length||process.cleanup.some((p:any)=>!['drained','forced-drained','absent-or-changed'].includes(p.result)))throw new Error('owned native cleanup receipt incomplete');
    if(!cleanup.nativeSentinel||JSON.stringify(cleanup.nativeSentinel.before)!==JSON.stringify(cleanup.nativeSentinel.after))throw new Error('native sentinel receipt incomplete');
    if(v.code!==0||parseNativeVersion(r.generation,v.stdout)!==r.version||identity.sha256!==artifact.sha256||identity.identity.version!==r.version||!cleanup.ownedPidDrained||!cleanup.sentinelUnchanged)throw new Error('native startup proof incomplete');
    if(!['S0','S3a'].includes(r.case))throw new Error('unknown qualified case');
  }
  if(protocolAccess) {const derived=await qualifyProtocolObservation(protocol,protocolAccess,r,await readFile(join(dir,'provider-protocol-authenticity.json')),await readFile(join(dir,'case-report.json')),controllerTrust,acceptanceInput);protocolAccepted=derived.staticTrusted;acceptanceSha256=derived.acceptanceSha256;}
  const statuses=qualificationDecision({complete:startupComplete&&(r.case==='S0'||!!protocol),historical,fresh,staticTrusted:r.case==='S0'||protocolAccepted,acceptanceSha256,failed:r.status==='FAIL'||protocol?.status==='FAIL'});
  return {...r,...statuses,observationSealSha256:sha(await readFile(join(dir,'case-report.json'))),...(subject?{observationProtocolSha256:subject.observationProtocolSha256,sourceManifestSha256:subject.sourceManifestSha256,ruleID:subject.ruleID}:{}),...(acceptanceSha256?{acceptanceSha256}:{})};
}
// Read-only phase two: no Sandbox.create, artifact acquisition, native/model or S0/S3a calls.
export async function finalizeQualification(dir:string,trust?:TrustInput,acceptance?:TrustInput,output?:string) {
 const result=await readQualification(dir,trust,acceptance);
 if(output)await writeQualificationOutput(output,result);
 return result;
}
// Shared semantic/acceptance boundary; public readQualification additionally verifies official
// enclosing archives and startup. Authored unit use of this boundary is not native qualification.
export async function qualifyProtocolObservation(p:ProtocolV2,access:PacketAccess,report:CaseReport,protocolBytes:Buffer,sealBytes:Buffer,trust?:TrustManifest,acceptance?:TrustInput) {
 equal(JSON.parse(protocolBytes.toString()),p,'stored observation differs');equal(JSON.parse(sealBytes.toString()),report,'stored seal differs');
 const fresh=p.observationKind==='fresh-pending-acceptance'&&report.observationKind===p.observationKind;
 if(p.observationKind&&(!fresh||p.status!=='MISSING'||report.status!=='MISSING'))throw new Error('fresh observation seal state mismatch');
 const staticTrusted=await validateProtocol(p,access,trust);
 const subject=observationSubject(p,report,access.marker,access.artifact,protocolBytes,sealBytes);
 const acceptanceSha256=fresh?await acceptObservation(acceptance,subject):undefined;
 return {...qualificationDecision({complete:true,historical:!fresh,fresh,staticTrusted,acceptanceSha256,failed:p.status==='FAIL'||report.status==='FAIL'}),staticTrusted,acceptanceSha256,subject};
}
