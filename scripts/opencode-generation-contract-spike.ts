#!/usr/bin/env bun
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Sandbox, TASK, sha } from './opencode-generation-spikes/sandbox';
import { ANCHORS, acquire, MissingArtifact } from './opencode-generation-spikes/artifacts';
import { qualifyS0 } from './opencode-generation-spikes/native';
import { qualifyS3a } from './opencode-generation-spikes/model';
import { produceProtocol } from './opencode-generation-spikes/producer';
import { readQualification, seal, finalizeQualification } from './opencode-generation-spikes/evidence';
function args(argv:string[]) {
  const out:Record<string,string>={};
  for(let i=0;i<argv.length;i++) {
    const key=argv[i]!;
    if(!['--case','--binary','--generation','--expected-version','--test-root','--evidence-dir','--bundle','--platform-metadata-sha256','--matrix','--verify','--trust-manifest','--trust-sha256','--acceptance','--acceptance-sha256','--qualification-output'].includes(key)||out[key])throw new Error('unknown/duplicate flag: '+key);
    out[key]=key==='--matrix'?'true':argv[++i]??'';
    if(!out[key]||out[key].startsWith('--'))throw new Error('flag value required: '+key);
  }
  return out;
}
async function main() {
  if(Bun.version!=='1.3.11')throw new Error('pinned Bun 1.3.11 required');
  const flags=args(process.argv.slice(2));
  const trust=flags['--trust-manifest']?{path:flags['--trust-manifest'],sha256:flags['--trust-sha256']??''}:undefined;
  if(flags['--trust-sha256']&&!trust)throw new Error('trust manifest required');
  const acceptance=flags['--acceptance']?{path:flags['--acceptance'],sha256:flags['--acceptance-sha256']??''}:undefined;
  if(flags['--acceptance-sha256']&&!acceptance)throw new Error('acceptance file required');
  if(flags['--verify']) {const report=await finalizeQualification(flags['--verify'],trust,acceptance,flags['--qualification-output']);console.log(JSON.stringify(report));process.exitCode=report.qualificationStatus==='PASS'?0:1;return;}
  if(acceptance||flags['--qualification-output'])throw new Error('phase two requires --verify');
  const caseID=flags['--case'];if(caseID!=='S0'&&caseID!=='S3a')throw new Error('--case S0 or S3a required');
  const testRoot=flags['--test-root'],evidence=flags['--evidence-dir'];if(!testRoot||!evidence)throw new Error('--test-root and --evidence-dir required');
  const selected=flags['--matrix']?ANCHORS:ANCHORS.filter(a=>a.generation===flags['--generation']&&a.version===flags['--expected-version']);
  if(!selected.length)throw new Error('exact four-anchor selection required');
  if(flags['--matrix']&&(flags['--binary']||flags['--bundle']))throw new Error('matrix downloads each pin; use separate single-pin invocations for offline bundles');
  const reports=[];
  for(const a of selected) {
    const suffix=flags['--matrix']?`-${a.generation}-${a.version}`:'';
    const s=await Sandbox.create(testRoot+suffix,evidence+suffix,caseID);
    await s.record('attempt.json',{task:TASK,case:caseID,anchor:a,bun:Bun.version,bunSha256:sha(await readFile(process.execPath)),sourceBase:'6132299836a89e58d633a0557e504243035e806b',platform:process.platform,arch:process.arch,started:new Date().toISOString(),nativeExecution:false});
    const original=process.cwd();process.chdir(s.root);
    try {
      // Initial MISSING receipt survives termination/network denial before retrieval returns.
      await seal(s,caseID,a.generation,a.version,'MISSING','native artifact retrieval pending; no native evidence');
      const artifact=await acquire(s,a,flags['--bundle'],flags['--binary'],flags['--platform-metadata-sha256']);
      const help=await qualifyS0(s,a,artifact);
      if(caseID==='S3a') {
        try{await qualifyS3a(s,a,artifact,help);}catch(e){
          if(!(e instanceof MissingArtifact))throw e;
          await produceProtocol(s,a,trust);
        }
        // Cleanup is complete; freeze MISSING observation once. Acceptance arrives later.
        await seal(s,caseID,a.generation,a.version,'MISSING','awaiting-independent-acceptance');
      }
      if(caseID==='S0') {await seal(s,caseID,a.generation,a.version,'PASS','actual native Linux case completed; bounded prerequisite only');}
    } catch(e) {
      const status=e instanceof MissingArtifact?'MISSING':'FAIL';
      const failure={status,anchor:a,nativeQualification:false,observed:String(e),reproduction:process.argv.slice(2)};
      await s.record('case-failure.json',failure);
      const detail=caseID==='S3a'?'provider-protocol-authenticity.json':'native-startup.json';
      try{await readFile(join(s.evidence,detail));}catch(err:any){if(err.code!=='ENOENT')throw err;await s.record(detail,failure);}
      await seal(s,caseID,a.generation,a.version,status,String(e));
    } finally {process.chdir(original);}
    const reread=await readQualification(s.evidence,trust);reports.push(reread);
    console.log(JSON.stringify({case:caseID,generation:a.generation,version:a.version,observationStatus:reread.observationStatus,qualificationStatus:reread.qualificationStatus,report:join(s.evidence,'case-report.json')}));
  }
  process.exitCode=reports.every(r=>r.qualificationStatus==='PASS')?0:1;
}
if(import.meta.main)await main().catch(e=>{console.error(String(e));process.exitCode=1;});
