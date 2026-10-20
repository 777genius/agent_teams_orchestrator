import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { isPackagedOpenCodeCommand, validatePackagedOpenCodeIdentity } from './packagedOpenCodeDelivery.js'

let root: string, binary: string, bun: string, entry: string, content: string
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const abruptCallerTermination = (code: number | null, signal: string | null) =>
  (Number.isInteger(code) && code !== 0 && signal === null) || (code === null && signal === 'SIGTERM')
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'TEST-packaged-opencode-'))
  binary = path.join(root, process.platform === 'win32' ? 'frontdoor.exe' : 'frontdoor')
  bun = path.join(root, 'bun', process.platform === 'win32' ? 'bun.exe' : 'bun')
  entry = path.join(root, 'local-cli/cli.js')
  await mkdir(path.dirname(bun), { recursive: true }); await mkdir(path.dirname(entry), { recursive: true })
  await copyFile(process.execPath, bun)
  content = `
const input=await Bun.stdin.text(), waiting=process.argv.includes('--wait');
if(waiting){
  if(process.argv.includes('--ignore-term'))process.on('SIGTERM',()=>{});
  else process.once('SIGTERM',()=>{console.log('CANCELLED');process.exit(143)});
  setInterval(()=>{},1000);
  await new Promise(resolve=>setImmediate(resolve));
}
console.log(JSON.stringify({args:process.argv.slice(2),input,cwd:process.cwd(),marker:process.env.TEST_DELIVERY_MARKER,bun:process.execPath,...(waiting?{pid:process.pid,ready:true}:{})}));
if(!waiting)process.exit(Number(process.env.TEST_DELIVERY_EXIT??0));`
  await writeFile(entry, content)
  const identity = { schema: 1, platform: process.platform, arch: process.arch, bunVersion: '1.3.11',
    bunSha256: sha(await readFile(bun)), entrySha256: sha(await readFile(entry)) }
  const source = path.join(root, 'frontdoor.ts')
  await writeFile(source, `import {runPackagedOpenCodeDelivery} from ${JSON.stringify(path.join(import.meta.dir,'packagedOpenCodeDelivery.ts'))};declare const IDENTITY:any;process.exit(await runPackagedOpenCodeDelivery(process.argv.slice(2),IDENTITY));`)
  const compiled = Bun.spawn([process.execPath, 'build', source, '--compile', '--outfile', binary,
    '--define', 'IDENTITY=' + JSON.stringify(identity)], { stdout: 'ignore', stderr: 'pipe' })
  expect(await compiled.exited).toBe(0)
}, 30_000)
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })

test('routes the complete runtime and model list prefixes', () => {
  for (const command of ['status','providers','verify','verify-model','reconcile','transcript','preview','opencode-command','opencode-ledger-backfill']) expect(isPackagedOpenCodeCommand(['runtime',command])).toBe(true)
  expect(isPackagedOpenCodeCommand(['model','list','--provider=all'])).toBe(true)
  for (const args of [['--version'],['model'],['auth','login'],['--print','runtime']]) expect(isPackagedOpenCodeCommand(args)).toBe(false)
  expect(() => validatePackagedOpenCodeIdentity({schema:1,bunVersion:'1.4.2'})).toThrow()
})
test('abrupt caller evidence rejects successful, unknown and unrelated termination', () => {
  expect(abruptCallerTermination(1,null)).toBe(true)
  expect(abruptCallerTermination(null,'SIGTERM')).toBe(true)
  for (const [code,signal] of [[0,null],[null,null],[null,'SIGKILL'],[1,'SIGTERM']] as const) expect(abruptCallerTermination(code,signal)).toBe(false)
})

async function run(args: string[], input = '', extra: Record<string,string> = {}) {
  // Product is a Node/Electron caller. Use its native Node spawn implementation
  // as an independent oracle rather than Bun's test-runner child launch.
  const program = `const{spawn}=require('node:child_process');let data='';process.stdin.on('data',x=>data+=x);process.stdin.on('end',()=>{const r=JSON.parse(data),c=spawn(r.binary,r.args,{cwd:r.root,env:r.env,stdio:'pipe'});let stdout='',stderr='';c.stdout.on('data',x=>stdout+=x);c.stderr.on('data',x=>stderr+=x);c.stdin.end(r.input);c.once('error',e=>{console.error(e.message);process.exit(1)});c.once('close',exit=>console.log(JSON.stringify({stdout,stderr,exit})))})`
  const oracle=Bun.spawn([Bun.which('node')!,'-e',program],{stdin:'pipe',stdout:'pipe',stderr:'pipe'})
  oracle.stdin.write(JSON.stringify({binary,args,root,input,env:{HOME:root,PATH:path.join(root,'missing'),
    BUN_INSTALL:path.join(root,'wrong-bun'),TEST_DELIVERY_MARKER:'literal $() " marker',...extra}}));oracle.stdin.end()
  const [output,error,exit]=await Promise.all([new Response(oracle.stdout).text(),new Response(oracle.stderr).text(),oracle.exited])
  expect(exit).toBe(0);expect(error).toBe('')
  return JSON.parse(output) as {stdout:string;stderr:string;exit:number}
}
async function nativeExecutableIdentity(file: string) {
  // Resolve DOS 8.3 aliases with the independent Node caller, then check the
  // actual file ID and bytes rather than accepting path spelling differences.
  const program = `const fs=require('node:fs'),crypto=require('node:crypto');const file=fs.realpathSync.native(process.argv[1]),s=fs.statSync(file,{bigint:true});console.log(JSON.stringify({file,device:String(s.dev),inode:String(s.ino),size:String(s.size),sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}))`
  const oracle=Bun.spawn([Bun.which('node')!,'-e',program,file],{stdout:'pipe',stderr:'pipe'})
  const [output,error,exit]=await Promise.all([new Response(oracle.stdout).text(),new Response(oracle.stderr).text(),oracle.exited])
  expect(error).toBe('');expect(exit).toBe(0)
  return JSON.parse(output) as {file:string;device:string;inode:string;size:string;sha256:string}
}
test('compiled delegation preserves argv stdin cwd env and nonzero exit without PATH', async () => {
  const args = ['runtime','providers','connect','--provider','literal $() " value']
  const result = await run(args,'line one\nline two\n',{TEST_DELIVERY_EXIT:'7'})
  expect(result.exit).toBe(7); expect(result.stderr).toBe('')
  const output = JSON.parse(result.stdout)
  const {bun:actualBun,...transport}=output
  expect(transport).toEqual({args,input:'line one\nline two\n',cwd:root,marker:'literal $() " marker'})
  const [actual,expected]=await Promise.all([nativeExecutableIdentity(actualBun),nativeExecutableIdentity(bun)])
  expect(actual).toEqual(expected)
  expect(actual.sha256).toBe(sha(await readFile(bun)))
})
test('changed JS refuses before executing the sidecar', async () => {
  const marker=path.join(root,'unexpected-effect')
  await writeFile(entry,`await Bun.write(${JSON.stringify(marker)},'bad');`)
  try {const result=await run(['runtime','status']);expect(result.exit).not.toBe(0);expect(result.stderr).toContain('packaged_opencode_delivery_changed');expect(await lstat(marker).then(()=>true,()=>false)).toBe(false)}
  finally {await writeFile(entry,content)}
})
test('missing Bun refuses without using inherited Bun/PATH', async () => {
  await rename(bun,bun+'.owned-quarantine')
  try {expect((await run(['model','list'])).exit).not.toBe(0)}
  finally {await rename(bun+'.owned-quarantine',bun)}
})
test('changed Bun refuses before executing the sidecar', async () => {
  const original=await readFile(bun)
  await writeFile(bun,'invalid-bun-bytes')
  try {const result=await run(['runtime','status']);expect(result.exit).not.toBe(0);expect(result.stderr).toContain('packaged_opencode_delivery_changed');expect(result.stdout).toBe('')}
  finally {await writeFile(bun,original)}
})
if (process.platform !== 'win32') {
async function readDeliveryReady(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  let output=''
  while(!output.includes('\n')) {const next=await reader.read();expect(next.done).toBe(false);output+=new TextDecoder().decode(next.value)}
  const acknowledgement=JSON.parse(output.split('\n')[0])
  expect(acknowledgement.ready).toBe(true)
  expect(Number.isSafeInteger(acknowledgement.pid)&&acknowledgement.pid>0).toBe(true)
  return output
}
test('POSIX caller cancellation reaches exact live child and propagates exit', async () => {
  const child=Bun.spawn([binary,'runtime','status','--wait'],{cwd:root,env:{HOME:root,PATH:path.join(root,'missing')},stdin:'pipe',stdout:'pipe',stderr:'pipe'})
  child.stdin.end();const reader=child.stdout.getReader();let output=''
  try {output=await readDeliveryReady(reader);child.kill('SIGTERM');for(;;){const next=await reader.read();if(next.done)break;output+=new TextDecoder().decode(next.value)}expect(await child.exited).toBe(143);expect(output).toContain('CANCELLED')}
  finally {if(child.exitCode===null)child.kill('SIGKILL');reader.releaseLock()}
},10_000)
test('POSIX stalled cancellation kills only the child without manufacturing cleanup evidence', async () => {
  const child=Bun.spawn([binary,'runtime','status','--wait','--ignore-term'],{cwd:root,env:{HOME:root,PATH:path.join(root,'missing')},stdin:'pipe',stdout:'pipe',stderr:'pipe'})
  child.stdin.end();const reader=child.stdout.getReader();let output=''
  try {output=await readDeliveryReady(reader);child.kill('SIGTERM');for(;;){const next=await reader.read();if(next.done)break;output+=new TextDecoder().decode(next.value)}expect(await child.exited).toBe(143);expect(output).not.toContain('CANCELLED');expect(output).not.toContain('cleanup')}
  finally {if(child.exitCode===null)child.kill('SIGKILL');reader.releaseLock()}
},10_000)
} else {
test('Windows abrupt caller termination closes the exact immediate sidecar process', async () => {
  // Cold PowerShell/WMI startup on hosted Windows runners can exceed 8s.
  // Give identity acquisition its own budget; WaitForExit still enforces 5s.
  // Windows Node kill(SIGTERM) is TerminateProcess, not a POSIX handler call.
  // Retain the sidecar's kernel handle BEFORE killing the caller: PID absence
  // alone cannot distinguish termination from PID reuse. This proves only the
  // immediate JS child; existing command-owned hosts/leases have separate rules.
  const script = `
$ErrorActionPreference='Stop'
$p=$null
$owned=$false
try {
  $p=[System.Diagnostics.Process]::GetProcessById([int]$args[0])
  $handle=$p.Handle
  $birth=$p.StartTime.ToUniversalTime().Ticks.ToString()
  # Query WMI directly without CimCmdlets autoimport, retaining the held handle.
  [void][System.Reflection.Assembly]::Load('System.Management, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a')
  $searcher=[System.Management.ManagementObjectSearcher]::new('SELECT ProcessId, ParentProcessId FROM Win32_Process WHERE ProcessId='+[int]$args[0])
  $results=$null
  $row=$null
  try {
    $results=$searcher.Get()
    foreach ($entry in $results) {
      try {
        $row=@{ProcessId=$entry.GetPropertyValue('ProcessId');ParentProcessId=$entry.GetPropertyValue('ParentProcessId')}
      } finally { $entry.Dispose() }
    }
  } finally {
    if ($null -ne $results) { $results.Dispose() }
    $searcher.Dispose()
  }
  $observedPath=$p.MainModule.FileName
  if ($null -eq $row -or $row.ProcessId -ne $p.Id -or $row.ParentProcessId -ne [int]$args[1] -or $observedPath -ne $args[2]) { throw ('owned_sidecar_identity_mismatch '+(@{pid=$p.Id;parentPid=$row.ParentProcessId;expectedParentPid=$args[1];path=$observedPath;expectedPath=$args[2]}|ConvertTo-Json -Compress)) }
  $owned=$true
  [Console]::WriteLine(('READY '+(@{pid=$p.Id;birth=$birth;parentPid=$row.ParentProcessId}|ConvertTo-Json -Compress)))
  [Console]::Out.Flush()
  if ([Console]::ReadLine() -ne 'WAIT') { throw 'owned_sidecar_wait_missing' }
  $gone=$p.WaitForExit(5000)
  [Console]::WriteLine(('RESULT '+(@{gone=$gone;cleanupRequired=(-not $gone)}|ConvertTo-Json -Compress)))
  if (-not $gone) { throw 'owned_sidecar_termination_unknown' }
} finally {
  if ($null -ne $p) { try { if ($owned -and -not $p.HasExited) { $p.Kill();[void]$p.WaitForExit(2000) } } finally { $p.Dispose() } }
}`
  const watcher = path.join(root,'owned-sidecar-watch.ps1')
  await writeFile(watcher,script)
  const program = `
const{spawn}=require('node:child_process');const{once}=require('node:events');const{realpathSync}=require('node:fs');
let data='';process.stdin.on('data',x=>data+=x);process.stdin.on('end',async()=>{
 const r=JSON.parse(data);let c,w,stdout='',stderr='',watchout='',watcherr='',timer;
 try {
  c=spawn(r.binary,['runtime','status','--wait'],{cwd:r.root,env:r.env,stdio:'pipe'});
  c.stdin.end();c.stdout.on('data',x=>stdout+=x);c.stderr.on('data',x=>stderr+=x);
  const line=await Promise.race([new Promise((resolve,reject)=>{const read=()=>{if(stdout.includes('\\n')){c.stdout.off('data',read);resolve(stdout.split('\\n')[0])}};c.stdout.on('data',read);c.once('error',reject);c.once('exit',()=>reject(Error('sidecar_startup_missing')))}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('sidecar_startup_timeout')),5000)})]);clearTimeout(timer);
  const pid=JSON.parse(line).pid;if(!Number.isSafeInteger(pid)||pid<=0)throw Error('sidecar_pid_invalid');
  w=spawn(r.powershell,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',r.watcher,String(pid),String(c.pid),realpathSync.native(r.bun)],{stdio:'pipe'});
  w.stdout.on('data',x=>watchout+=x);w.stderr.on('data',x=>watcherr+=x);
  const ready=await Promise.race([new Promise((resolve,reject)=>{const read=()=>{if(watchout.includes('\\n')){w.stdout.off('data',read);resolve(watchout.split('\\n')[0])}};w.stdout.on('data',read);w.once('error',reject);w.once('close',()=>reject(Error('identity_observer_failed')))}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('identity_observer_timeout')),20000)})]);clearTimeout(timer);
  const identity=JSON.parse(ready.slice(6));if(!ready.startsWith('READY ')||identity.pid!==pid||identity.parentPid!==c.pid||!/^\\d+$/.test(identity.birth))throw Error('sidecar_identity_invalid');
  const closed=once(c,'close'),observed=once(w,'close');if(!c.kill('SIGTERM'))throw Error('caller_termination_failed');w.stdin.end('WAIT\\n');
  const [[exit,signal],[watchExit]]=await Promise.race([Promise.all([closed,observed]),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('termination_observation_timeout')),8000)})]);clearTimeout(timer);
  const result=JSON.parse(watchout.split('\\n').find(x=>x.startsWith('RESULT ')).slice(7));
  console.log(JSON.stringify({exit,signal,watchExit,identity,result,stdout,stderr,watcherr}));
 } catch(e){console.error(JSON.stringify({phase:e.message,watchout:watchout.slice(0,8192),watcherr:watcherr.slice(0,8192),frontendStderr:stderr.slice(0,8192)}));process.exitCode=1}
 finally {clearTimeout(timer);if(c&&c.exitCode===null&&c.signalCode===null)c.kill('SIGKILL');if(w&&w.exitCode===null&&w.signalCode===null){if(!w.stdin.writableEnded)w.stdin.end('WAIT\\n');const cleanup=setTimeout(()=>w.kill('SIGKILL'),3000);await once(w,'close').catch(()=>{});clearTimeout(cleanup)}if(c){c.stdout.destroy();c.stderr.destroy()}}
})`
  const oracle=Bun.spawn([Bun.which('node')!,'-e',program],{stdin:'pipe',stdout:'pipe',stderr:'pipe'})
  oracle.stdin.write(JSON.stringify({binary,root,bun,watcher,powershell:path.join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/powershell.exe'),env:{HOME:root,PATH:path.join(root,'missing')}}));oracle.stdin.end()
  const [output,error,exit]=await Promise.all([new Response(oracle.stdout).text(),new Response(oracle.stderr).text(),oracle.exited])
  expect(error).toBe('');expect(exit).toBe(0)
  const result=JSON.parse(output)
  // Node's close event reports either an exit code or a terminating signal.
  // Windows SIGTERM still terminates abruptly; null without that exact signal
  // remains unknown, and the independent retained-child proof is required.
  const diagnostic=output.slice(0,8192)
  expect(abruptCallerTermination(result.exit,result.signal),diagnostic).toBe(true)
  expect(result.watchExit,diagnostic).toBe(0)
  expect(result.result,diagnostic).toEqual({gone:true,cleanupRequired:false})
  expect(result.stderr,diagnostic).toBe('');expect(result.watcherr,diagnostic).toBe('')
},45_000)
}
