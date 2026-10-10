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
