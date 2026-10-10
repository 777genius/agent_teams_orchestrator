import {expect,test} from 'bun:test'
import {mkdtemp,readFile,realpath,rm,writeFile,symlink} from 'node:fs/promises'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {openCodeV2SupportedSourcePredicate} from './OpenCodeV2TeamBridge.js'

const workspace=path.resolve(import.meta.dir,'../../../..')
const status={kind:'status',qualification:{capabilitySnapshotId:'TEST',expectedBehaviorFingerprint:'a'.repeat(64),binaryPath:'/TEST/native',binaryFingerprint:'b'.repeat(64),version:'2.0.0'},state:'active',deadline:Date.now()+60_000,members:[{
  pin:'2.0.0',state:'accepted',originalSessionId:'ses_TEST',opencodeSessionId:'ses_TEST',runtimeSessionId:'ses_TEST',
  bootstrap:{verified:true,strategy:'instruction-entry',missingNativeMessageID:true},
  controllerTools:{server:'agent-teams',nativeNames:['message_send'],schemasHash:'a'.repeat(64)},
}]} as unknown as Parameters<typeof openCodeV2SupportedSourcePredicate>[0]

test('actual bundled bridge qualifies exact JS layout and retains native proof fences',async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'TEST-v2-bridge-delivery-')))
 try{
  await symlink(path.join(workspace,'node_modules'),path.join(root,'node_modules'),'dir')
  await writeFile(path.join(root,'tsconfig.json'),JSON.stringify({extends:path.join(workspace,'tsconfig.json')}))
  const entry=path.join(root,'harness.ts'),bundle=path.join(root,'cli.js')
  await writeFile(entry,`import {openCodeV2SupportedSourcePredicate as predicate} from ${JSON.stringify(path.join(import.meta.dir,'OpenCodeV2TeamBridge.ts'))};const status=${JSON.stringify(status)};console.log(JSON.stringify([await predicate(status),await predicate({...status,members:status.members.map(member=>({...member,bootstrap:{...member.bootstrap,verified:false}}))}),await predicate({...status,deadline:Date.now()-1})]));`)
  const result=await Bun.build({entrypoints:[entry],target:'bun',format:'esm',packages:'bundle',external:['@opencode/*'],minify:true,define:{'process.env.NODE_ENV':JSON.stringify('production'),'process.env.USER_TYPE':JSON.stringify('external')}})
  expect(result.success).toBe(true)
  await writeFile(bundle,await result.outputs[0]!.text());await rm(entry)
  await writeFile(path.join(root,'opencodeV2RunOwner.js'),'export {}')
  const run=async(file=bundle)=>{
   const child=Bun.spawn([process.execPath,file],{stdout:'pipe',stderr:'pipe'})
   const [out,error,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
   expect({error,code}).toEqual({error:'',code:0})
   return JSON.parse(out) as boolean[]
  }
  expect(await run()).toEqual([true,false,false])
  expect(await openCodeV2SupportedSourcePredicate(status)).toBe(true)
  const unsupported=path.join(root,'unknown.js');await writeFile(unsupported,await readFile(bundle))
  expect(await run(unsupported)).toEqual([false,false,false])
 }finally{await rm(root,{recursive:true,force:true})}
},20_000)
