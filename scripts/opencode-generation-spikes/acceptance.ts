import { readFile, lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical, within, sha } from './sandbox';
import { TrustInput, ProtocolV2, OWNER_BASE, equal } from './protocol';
// The controller pins this separate file AFTER cleanup/sealing. None of its bytes are
// part of the observation inventory, and the producer never writes an acceptance.
export type ObservationSubject={
 observationProtocolSha256:string;observationSealSha256:string;
 nonce:string;generation:string;version:string;case:string;root:string;evidence:string;
 sessionID:string;endpointEpoch:string;modelBaseURL:string;configPath:string;configByteSha256Before:string;configByteSha256After:string;
 configuredSelector:string;reportedSelector:string|null;logicalImplementation:string;
 sourceManifestSha256:string;ownerBase:string;planSha256:string;amendmentSha256:string;amendmentID:string;
 binarySha256:string;rootMetadataSha256:string;platformMetadataSha256:string;
 rootArchiveSha256:string;platformArchiveSha256:string;platformSri:string;
 ruleID:string;resolverSha256:string;reviewAcceptanceSha256:string;
};
export function observationSubject(p:ProtocolV2,report:any,marker:any,artifact:any,protocolBytes:Buffer,sealBytes:Buffer):ObservationSubject {
 return {observationProtocolSha256:sha(protocolBytes),observationSealSha256:sha(sealBytes),
 nonce:marker.nonce,generation:report.generation,version:report.version,case:report.case,root:report.root,evidence:report.evidence,
 sessionID:p.sessionID,endpointEpoch:p.authority.endpointEpoch,modelBaseURL:p.provenance.route.modelBaseURL,configPath:p.provenance.route.configPath,configByteSha256Before:p.provenance.route.configByteSha256Before,configByteSha256After:p.provenance.route.configByteSha256After,
 configuredSelector:p.provenance.route.configuredSelector,reportedSelector:p.provenance.route.reportedSelector,logicalImplementation:p.provenance.route.logicalImplementation,
 sourceManifestSha256:p.producerSourceManifest.sha256,ownerBase:OWNER_BASE,planSha256:p.planSha256,amendmentSha256:p.amendmentSha256,amendmentID:p.amendmentID,
 binarySha256:artifact.sha256,rootMetadataSha256:artifact.packages[0].metadataSha256,platformMetadataSha256:artifact.packages[1].metadataSha256,
 rootArchiveSha256:artifact.packages[0].archiveSha256,platformArchiveSha256:artifact.packages[1].archiveSha256,platformSri:artifact.packages[1].archiveSri,
 ruleID:p.provenance.route.ruleID,resolverSha256:p.provenance.route.resolverEvidence.sha256,reviewAcceptanceSha256:p.provenance.route.reviewAcceptance.sha256};
}
export async function acceptObservation(input:TrustInput|undefined,subject:ObservationSubject):Promise<string|undefined> {
 if(!input)return undefined;
 if(within(subject.root,input.path)||within(subject.evidence,input.path)||! /^[0-9a-f]{64}$/.test(input.sha256))throw new Error('producer cannot supply observation acceptance');
 await canonical(input.path);const stat=await lstat(input.path);
 if(!stat.isFile()||stat.size>1024*1024)throw new Error('invalid acceptance file');
 const bytes=await readFile(input.path);if(sha(bytes)!==input.sha256)throw new Error('observation acceptance digest mismatch');
 const value=JSON.parse(bytes.toString());
 if(value.schemaVersion!==1||value.kind!=='fresh-schema2-observation-acceptance'||value.decision!=='accepted')throw new Error('invalid independent observation acceptance');
 equal(value.subject,subject,'independent observation subject mismatch');return input.sha256;
}
export function qualificationDecision(facts:{complete:boolean;historical:boolean;fresh:boolean;staticTrusted:boolean;acceptanceSha256?:string;failed:boolean}) {
 const observationStatus=facts.failed?'FAIL':facts.historical||!facts.complete||facts.fresh?'MISSING':'PASS';
 const qualificationStatus=facts.failed?'FAIL':facts.complete&&!facts.historical&&facts.staticTrusted&&(!facts.fresh||!!facts.acceptanceSha256)?'PASS':'MISSING';
 return {observationStatus,qualificationStatus} as {observationStatus:'PASS'|'FAIL'|'MISSING';qualificationStatus:'PASS'|'FAIL'|'MISSING'};
}
export async function writeQualificationOutput(path:string,result:{root:string;evidence:string;[key:string]:unknown}) {
 if(within(result.root,path)||within(result.evidence,path)||path===join(result.evidence,'case-report.json'))throw new Error('qualification output inside observation');
 await canonical((await import('node:path')).dirname(path));
 // No overwrite, including existing immutable observation/result bytes. Retry reader is pure.
 const bytes=JSON.stringify(result,null,2)+'\n';
 try {await writeFile(path,bytes,{flag:'wx',mode:0o600});}catch(e:any){if(e.code!=='EEXIST')throw e;await canonical(path);if(!(await lstat(path)).isFile()||!Buffer.from(bytes).equals(await readFile(path)))throw new Error('different existing qualification output');}
}
