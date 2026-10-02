import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {Sandbox,SOURCE,sha,canonical,within} from './sandbox';
import {loadTrust,TrustInput,ProtocolV2,OWNER_BASE,decodeProtocol} from './protocol';
import {Anchor,MissingArtifact} from './artifacts';
// Called only by the launch-authorized controller after cleanup. This worker runs unit tests only.
// A missing independent rule leaves the observed schema1 packet MISSING, even with a valid cache.
export async function produceProtocol(s:Sandbox,a:Anchor,input?:TrustInput) {
 const trust=await loadTrust(input,s.root,s.evidence),pin=trust?.pins[a.version];
 if(!trust||!pin?.rule)throw new MissingArtifact('selected route rule/controller trust MISSING');
 const ref=async(file:string)=>({file,sha256:sha(await readFile(join(s.evidence,file)))});
 const json=async(file:string)=>JSON.parse(await readFile(join(s.evidence,file),'utf8'));
 const rule=pin.rule;
 const copy=async(path:string|undefined,file:string,digest:string)=>{
  if(!path||within(s.root,path)||within(s.evidence,path))throw new MissingArtifact('independent route evidence MISSING');
  await canonical(path);const bytes=await readFile(path);if(sha(bytes)!==digest)throw new Error('independent route evidence digest mismatch');
  await s.recordRaw(file,bytes);return ref(file);
 };
 const resolverEvidence=await copy(rule.resolverPath,'reviewed-resolver.json',rule.resolverSha256);
 const reviewAcceptance=await copy(rule.acceptancePath,'resolver-review-acceptance.json',rule.acceptanceSha256);
 const sourceFiles=['scripts/opencode-generation-contract-spike.ts',...(await readdir(join(SOURCE,'scripts/opencode-generation-spikes'))).sort().map(n=>'scripts/opencode-generation-spikes/'+n)];
 await s.record('producer-source-manifest.json',{ownerBase:OWNER_BASE,files:await Promise.all(sourceFiles.map(async path=>({path,sha256:sha(await readFile(join(SOURCE,path)))})))});
 const producerSourceManifest=await ref('producer-source-manifest.json');
 if(producerSourceManifest.sha256!==trust.sourceManifestSha256)throw new MissingArtifact('controller has not reviewed this exact producer source');
 const observed=await json('provider-protocol-authenticity.json'),before=await json('native-provider-config.json'),after=await json('native-provider-config-after.json'),process=await json('native-process.json');
 const messages=await json('native-transcript.json'),terminal=a.generation==='v1'?messages.find((m:any)=>m.info?.id===observed.terminalMessageID):messages.find((m:any)=>m.id===observed.terminalMessageID);
 const token=(a.generation==='v1'?terminal.parts:terminal.content).find((t:any)=>t.type==='text'&&t.text?.startsWith('q0-terminal:'))?.text.slice('q0-terminal:'.length);
 const route:ProtocolV2['provenance']['route']={providerID:'test-model',catalogModelID:'q0-catalog',upstreamModelID:'q0-upstream',configuredSelector:rule.configuredSelector,reportedSelector:rule.reportedSelector,logicalImplementation:rule.logicalImplementation,
  modelBaseURL:a.generation==='v1'?before.config.provider['test-model'].options.baseURL:before.config.providers['test-model'].settings.baseURL,
  configPath:before.configPath,configByteSha256Before:before.fingerprint,configByteSha256After:after.fingerprint,
  configBefore:await ref('native-provider-config.json'),configAfter:await ref('native-provider-config-after.json'),modelCatalog:await ref('native-model-catalog.json'),
  ...(a.generation==='v2'?{providerObservation:await ref('native-custom-provider.json'),effectiveConfig:await ref('effective-native-config.json')}:{}),
  resolverEvidence,reviewAcceptance,ruleID:rule.id,executedModuleImportProved:false};
 const enclosing=await ref('native-artifact-integrity.json'),inventory=await ref('provider-inventory.json');
 const unavailable={status:'unavailable',reason:'native-bundle-no-inner-npm-manifest'} as const;
 let provenance:ProtocolV2['provenance'];
 if(rule.mode==='native-bundled')provenance={mode:rule.mode,enclosing,inventory,route,innerNpmName:unavailable,innerNpmVersion:unavailable,innerNpmSri:unavailable};
 else {
  if(!rule.sdk||!rule.selectedResolutionPath)throw new MissingArtifact('actual selected external resolution MISSING');
  // The selected resolution digest is also reviewed by the independent controller.
  const digest=pin.selectedResolutionSha256;
  provenance={mode:'externally-resolved-sdk',enclosing,inventory,route,sdk:rule.sdk,selectedResolution:await copy(rule.selectedResolutionPath,'selected-sdk-resolution.json',digest??'')};
 }
 const receipt:ProtocolV2={schemaVersion:2,case:'S3a',status:'MISSING',observationKind:'fresh-pending-acceptance',ownerBase:OWNER_BASE,amendmentID:trust.amendmentID,planSha256:trust.planSha256,amendmentSha256:trust.amendmentSha256,producerSourceManifest,provenance,
  authority:{ownerMarker:await ref('.test-project-owner.json'),nativeIdentity:await ref('native-identity.json'),process:await ref('native-process.json'),location:await ref('native-location.json'),modelHost:await ref('model-fixture-startup.json'),endpointEpoch:process.auth.epoch,canonicalDirectory:s.root},
  auth:{source:'test-dummy',childEnvironment:await ref('native-child-environment.json'),requestAuthorizationChecked:true,ambientCredentialsExcluded:true},
  sessionID:observed.sessionID,sessionCreated:await ref('native-session-created.json'),promptReceipt:await ref('native-prompt-receipt.json'),wire:await ref('model-wire.json'),transcript:await ref('native-transcript.json'),
  ...(a.generation==='v2'?{transcriptPages:await ref('native-transcript-pages.json')}:{}),terminalMessageID:observed.terminalMessageID,nativeToolIDs:observed.decisions.map((d:any)=>d.id),token,
  files:{seed:await ref('physical-seed.json'),write:await ref('physical-write.json'),shell:await ref('physical-shell.json')},cleanup:await ref('cleanup.json')};
 decodeProtocol(receipt);
 // Freeze exactly these observed bytes. Acceptance of this stored digest comes later.
 await s.record('provider-protocol-authenticity.json',receipt);
 return receipt;
}
