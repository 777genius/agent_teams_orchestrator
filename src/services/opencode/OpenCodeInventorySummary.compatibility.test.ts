import {expect,test} from 'bun:test'
test('summary inventory retains the prepared V1 profile required by provider mutations; passive reads do not prepare it',async()=>{
 const target=import.meta.resolve('./OpenCodeInventoryService.ts'),identity=import.meta.resolve('./compatibility/OpenCodeNativeIdentity.ts'),profile=import.meta.resolve('./OpenCodeProfileManager.ts');
 const script=`import {mock} from 'bun:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
 const root=await mkdtemp(path.join(tmpdir(),'TEST-summary-'));let prepared=0,read=0;const managed={profileRootPath:root};
 const original=await import(${JSON.stringify(identity)});mock.module(${JSON.stringify(identity)},()=>({...original,inspectOpenCodeReadSelection:async()=>{read++;return {path:'/TEST/opencode',policy:{generation:'v1',version:'1.18.34'},fingerprint:'TEST'}}}));
 const p=await import(${JSON.stringify(profile)});p.openCodeProfileManager.prepareProfile=async()=>{prepared++;return managed};
 const {openCodeInventoryService:service}=await import(${JSON.stringify(target)});
 service.probePreparedProfile=async input=>({detected:true,profile:input.profile});
 try{const summary=await service.probe(root,{mode:'summary'});assert.equal(summary.detected,true);assert.equal(summary.profile,managed);assert.equal(prepared,1);assert.equal(read,1);
 const passive=await service.probe(root,{mode:'passive'});assert.equal(passive.profile,null);assert.equal(prepared,1);assert.equal(read,1)}finally{await rm(root,{recursive:true,force:true})}`;
 const child=Bun.spawn([process.execPath,'-e',script],{cwd:import.meta.dir,stdout:'pipe',stderr:'pipe'});const [exit,stderr]=await Promise.all([child.exited,new Response(child.stderr).text()]);expect({exit,stderr}).toEqual({exit:0,stderr:''});
},15000)

test('settings-only V1 preparation does not replace either V2 full catalog route or cache an empty full inventory',async()=>{
 const target=import.meta.resolve('./OpenCodeInventoryService.ts'),identity=import.meta.resolve('./compatibility/OpenCodeNativeIdentity.ts'),profile=import.meta.resolve('./OpenCodeProfileManager.ts'),v2=import.meta.resolve('./catalog/OpenCodeV2InventoryService.ts');
 const script=`import {mock} from 'bun:test';import assert from 'node:assert/strict';import {mkdtemp,rm,realpath} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'TEST-settings-')));let prepared=0,reads=0,v2Reads=0,captured;let selected={path:'/TEST/opencode',policy:{generation:'v1',version:'1.18.31'},fingerprint:'TEST'};
 const original=await import(${JSON.stringify(identity)});mock.module(${JSON.stringify(identity)},()=>({...original,inspectOpenCodeReadSelection:async()=>{reads++;return selected}}));
 mock.module(${JSON.stringify(v2)},()=>({probeOpenCodeV2Inventory:async(native,directory)=>{v2Reads++;assert.equal(native,selected.native);assert.equal(directory,root);return {readGeneration:'v2',models:['TEST/authoritative']}}}));
 const p=await import(${JSON.stringify(profile)});p.openCodeProfileManager.prepareProfile=async()=>{prepared++;return {profileRootPath:root}};
 const {openCodeInventoryService:service}=await import(${JSON.stringify(target)});service.probePreparedProfile=async input=>{captured=input;return {detected:true}};
 try{await service.probe(root,{v1SettingsOnly:true});assert.equal(reads,1);assert.equal(prepared,1);assert.equal(captured.mode,'profile');assert.equal(captured.verifiedVersion,'1.18.31');assert.equal(captured.cacheEnabled,false);assert.ok(captured.cacheKey.includes('\\0profile\\0'));
 await service.probe(root,{mode:'full'});assert.equal(captured.mode,'full');assert.equal(captured.cacheEnabled,true);assert.equal(captured.verifiedVersion,undefined);
 for(const version of ['2.0.0','2.0.32']){selected={...selected,policy:{generation:'v2',version},native:{version}};const result=await service.probe(root,{v1SettingsOnly:true});assert.deepEqual(result.models,['TEST/authoritative']);assert.equal(result.readGeneration,'v2')}
 assert.equal(v2Reads,2);assert.equal(prepared,2);assert.equal(reads,4)}finally{await rm(root,{recursive:true,force:true})}`;
 const child=Bun.spawn([process.execPath,'-e',script],{cwd:import.meta.dir,stdout:'pipe',stderr:'pipe'});const [exit,stderr]=await Promise.all([child.exited,new Response(child.stderr).text()]);expect({exit,stderr}).toEqual({exit:0,stderr:''});
},15000)
