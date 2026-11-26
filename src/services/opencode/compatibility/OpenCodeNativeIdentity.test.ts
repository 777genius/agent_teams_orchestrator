import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { classifyOpenCodeReadGeneration } from './OpenCodeGenerationPolicy.js'
import { assertOpenCodeStandaloneNativePath, hashOpenCodeFile, hashOpenCodeNativeExecutable, readOpenCodeNativePackageMetadata, selectedOpenCodeReadPath } from './OpenCodeNativeIdentity.js'

test('strict family/dialect classification preserves V1 floor and refuses ambiguous output', () => {
  for (const version of ['1.16.0', '1.18.34']) expect(classifyOpenCodeReadGeneration(version).generation).toBe('v1')
  // Recognition is the V2 range rule; launch qualification is a separate gate.
  for (const version of ['2.0.0', '2.0.1', '2.0.21', '2.0.32', '2.0.33', '2.1.4', '2.99.0']) expect(classifyOpenCodeReadGeneration(version).generation).toBe('v2')
  for (const version of ['3.0.0', '1.15.9', '0.9.0', '2.0.32-rc.1', 'opencode 2.0.32', '1.18.34\n2.0.32', '02.0.32']) {
    expect(classifyOpenCodeReadGeneration(version).generation).toBe('unsupported')
  }
})

for (const pin of ['2.0.0', '2.0.32'] as const) {
  test(`official native --version stdout admits exact V2 ${pin} dialect`, () => {
    // Exact stdout observed from the canonical official CLI package, exit 0.
    expect(classifyOpenCodeReadGeneration(`opencode v${pin}\n`)).toEqual({
      generation: 'v2', version: pin, dialect: `v2-${pin}`,
    })
  })
}

test('decorated, multiline and out-of-range branded versions remain unsupported', () => {
  for (const output of [
    'warning: opencode v2.0.32\n', 'opencode v2.0.32 extra\n',
    'banner\nopencode v2.0.32\n', 'opencode v2.0.32\nbanner\n',
    'opencode v2.0.0\nopencode v2.0.32\n', 'opencode v2.0.32\n\n',
    '\nopencode v2.0.32\n', ' opencode v2.0.32\n', 'opencode 2.0.32\n',
    'opencode v02.0.32\n', 'opencode v2.0.32-rc.1\n',
    'opencode v3.0.0\n', 'opencode v2.1.4+build\n',
  ]) expect(classifyOpenCodeReadGeneration(output).generation).toBe('unsupported')
})

test('invalid explicit override cannot silently resolve another PATH binary', async () => {
  const before = process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH
  try {
    process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = 'relative/opencode'
    await expect(selectedOpenCodeReadPath()).rejects.toThrow('identity_mismatch')
  } finally {
    if (before === undefined) delete process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH
    else process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = before
  }
})

test('same-path executable replacement changes authority digest', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'TEST-opencode-identity-'))
  try {
    const executable = path.join(root, 'opencode')
    await writeFile(executable, 'old executable bytes')
    const old = await hashOpenCodeFile(executable)
    await writeFile(executable, 'new executable bytes')
    expect(await hashOpenCodeFile(executable)).not.toBe(old)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('file hashing matches independent SHA for empty, tiny and multiple read chunks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'TEST-opencode-hash-buffer-'))
  try {
    for (const size of [0, 1, 37, 64 * 1024, 64 * 1024 + 1, 3 * 64 * 1024 + 17]) {
      const content = Buffer.from(Uint8Array.from({ length: size }, (_, index) => index % 251))
      const file = path.join(root, `bytes-${size}`)
      await writeFile(file, content)
      expect(await hashOpenCodeFile(file)).toBe(createHash('sha256').update(content).digest('hex'))
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('native executable hashing matches independent SHA across large read chunk boundaries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'TEST-opencode-native-hash-buffer-'))
  try {
    for (const size of [0, 1, 37, 1024 * 1024, 1024 * 1024 + 1, 3 * 1024 * 1024 + 17]) {
      const content = Buffer.from(Uint8Array.from({ length: size }, (_, index) => index % 251))
      const file = path.join(root, `bytes-${size}`)
      await writeFile(file, content)
      expect(await hashOpenCodeNativeExecutable(file)).toBe(createHash('sha256').update(content).digest('hex'))
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})


test('cancelled file hashing rejects the caller reason before opening a missing path', async () => {
  const controller = new AbortController()
  const reason = new Error('TEST-hash-cancelled')
  controller.abort(reason)
  await expect(hashOpenCodeFile(path.join(tmpdir(), 'TEST-missing-cancelled-hash'), controller.signal)).rejects.toBe(reason)
  await expect(hashOpenCodeNativeExecutable(path.join(tmpdir(), 'TEST-missing-cancelled-native-hash'), controller.signal)).rejects.toBe(reason)
})

test('native executable hashing preserves mid-read abort and closes its original descriptor', async () => {
  const script = `
    import {mock} from 'bun:test'
    import assert from 'node:assert/strict'
    import {fstatSync} from 'node:fs'
    import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises'
    import {tmpdir} from 'node:os'
    import path from 'node:path'
    const root=await realpath(await mkdtemp(path.join(tmpdir(),'TEST-native-hash-abort-')))
    const file=path.join(root,'opencode')
    await writeFile(file,Buffer.alloc(1024*1024+17,0x5a))
    const fs=await import('node:fs/promises'),originalOpen=fs.open
    const controller=new AbortController(),reason=new Error('TEST-native-mid-read-abort')
    let reads=0,closes=0,descriptor=null
    mock.module('node:fs/promises',()=>({...fs,open:async(target,...args)=>{
      const handle=await originalOpen(target,...args)
      if(target===file){
        descriptor=handle.fd
        const read=handle.read.bind(handle),close=handle.close.bind(handle)
        handle.read=async(...readArgs)=>{const result=await read(...readArgs);assert(result.bytesRead>0);reads++;controller.abort(reason);return result}
        handle.close=async()=>{try{return await close()}finally{closes++}}
      }
      return handle
    }}))
    const {hashOpenCodeNativeExecutable}=await import(${JSON.stringify(import.meta.resolve('./OpenCodeNativeIdentity.ts'))})
    try{
      await assert.rejects(hashOpenCodeNativeExecutable(file,controller.signal),error=>error===reason)
      assert.equal(reads,1);assert.equal(closes,1);assert.notEqual(descriptor,null)
      assert.throws(()=>fstatSync(descriptor),{code:'EBADF'})
      console.log('TEST native abort preserves reason and closes original descriptor')
    }finally{await rm(root,{recursive:true,force:true})}
  `
  const child=Bun.spawn([process.execPath,'-e',script],{cwd:import.meta.dir,stdout:'pipe',stderr:'pipe'})
  const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()])
  expect({code,stderr}).toEqual({code:0,stderr:''})
  expect(stdout.trim()).toBe('TEST native abort preserves reason and closes original descriptor')
},15000)


test('private V2 version admission preserves an unlisted CLI identity separately from its engine', async () => {
  const script = `
    import {mock} from 'bun:test'
    import assert from 'node:assert/strict'
    import {mkdir,mkdtemp,realpath,rm,writeFile,symlink} from 'node:fs/promises'
    import {tmpdir} from 'node:os'
    import path from 'node:path'
    const root=await realpath(await mkdtemp(path.join(tmpdir(),'TEST-v2-cli-range-')))
    const packageRoot=path.join(root,'package'), bin=path.join(packageRoot,'bin')
    await mkdir(bin,{recursive:true})
    const executable=path.join(bin,process.platform==='win32'?'opencode.exe':'opencode')
    const header=process.platform==='linux'?'7f454c46':process.platform==='win32'?'4d5a0000':'cffaedfe'
    await writeFile(executable,Buffer.from(header,'hex'))
    process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH=executable
    const metadataFile=path.join(packageRoot,'package.json')
    const fs=await import('node:fs/promises'),originalOpen=fs.open
    let metadataReadError=null
    mock.module('node:fs/promises',()=>({...fs,open:async(file,...args)=>{
      if(file===metadataFile&&metadataReadError) throw Object.assign(new Error('TEST metadata read failed'),{code:metadataReadError})
      return originalOpen(file,...args)
    }}))
    let version='2.1.99',tamper=false,calls=0
    mock.module(${JSON.stringify(import.meta.resolve('./OpenCodeVersionProbe.ts'))},()=>({readOpenCodeOwnedVersion:async(file,roots)=>{
      assert.equal(file,executable);assert.notEqual(roots.root,root);calls++
      await roots.remove()
      if(tamper) await writeFile(executable,Buffer.from(header+'01','hex'))
      return 'opencode v'+version+'\\n'
    }}))
    const {inspectOpenCodeReadSelection}=await import(${JSON.stringify(import.meta.resolve('./OpenCodeNativeIdentity.ts'))})
    const {validateExecutionNative}=await import(${JSON.stringify(import.meta.resolve('../host/OpenCodeV2ExecutionBinding.ts'))})
    const {resolveOpenCodeV2EngineVersion,openCodeV2Dialect}=await import(${JSON.stringify(import.meta.resolve('./OpenCodeV2Registry.ts'))})
    try {
      for(version of ['2.1.99','2.99.0']) {
        await writeFile(path.join(packageRoot,'package.json'),JSON.stringify({name:'@opencode/cli-'+(process.platform==='win32'?'windows':process.platform)+'-'+process.arch,version}))
        const selected=await inspectOpenCodeReadSelection()
        assert.equal(selected.native.version,version)
        assert.equal(selected.native.origin,'npm')
        await validateExecutionNative(selected.native)
        assert.equal(selected.native.engineVersion,resolveOpenCodeV2EngineVersion(version))
        assert.equal(selected.native.dialect,openCodeV2Dialect(selected.native.engineVersion))
        assert.equal(selected.native.executablePath,executable)
        assert.equal(selected.fingerprint,selected.native.executableSha256)
      }
      await rm(metadataFile)
      const standalone=await inspectOpenCodeReadSelection()
      assert.equal(standalone.native.origin,'standalone');assert.equal(standalone.native.packageName,null)
      assert.equal(standalone.native.version,'2.99.0')
      await validateExecutionNative(standalone.native)
      await assert.rejects(validateExecutionNative({...standalone.native,origin:undefined}))
      await assert.rejects(validateExecutionNative({...standalone.native,packageName:'@opencode/cli-linux-x64'}))
      await assert.rejects(validateExecutionNative({...standalone.native,dialect:'v2-2.99.0'}))
      await assert.rejects(validateExecutionNative({...standalone.native,executableSha256:'0'.repeat(64)}))
      for(const value of ['{','null','{}',JSON.stringify({name:'unrelated',version}),JSON.stringify({name:'@opencode/cli-linux-x64',version:'2.0.0'})]) {
        await writeFile(metadataFile,value)
        await assert.rejects(inspectOpenCodeReadSelection())
      }
      await writeFile(metadataFile,JSON.stringify({name:'@opencode/cli-'+(process.platform==='win32'?'windows':process.platform)+'-'+process.arch,version}))
      for(metadataReadError of ['EACCES','ENOENT']) await assert.rejects(inspectOpenCodeReadSelection())
      metadataReadError=null
      if(process.platform!=='win32') {
        await rm(metadataFile);await symlink(path.join(root,'missing-package.json'),metadataFile)
        await assert.rejects(inspectOpenCodeReadSelection())
      }
      await rm(metadataFile)
      tamper=true
      await assert.rejects(inspectOpenCodeReadSelection(),/identity_mismatch/)
      assert(calls>=11)
      console.log('TEST private CLI identity and engine remain distinct')
    } finally {await rm(root,{recursive:true,force:true})}
  `
  const child=Bun.spawn([process.execPath,'-e',script],{cwd:import.meta.dir,stdout:'pipe',stderr:'pipe'})
  const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()])
  expect({code,stderr}).toEqual({code:0,stderr:''})
  expect(stdout.trim()).toBe('TEST private CLI identity and engine remain distinct')
},15000)


test('native identity admits complete installer-sized executables while keeping ordinary files bounded', async () => {
  const script = `
    import {mock} from 'bun:test'
    import assert from 'node:assert/strict'
    import {createHash} from 'node:crypto'
    import {createReadStream} from 'node:fs'
    import {mkdir,mkdtemp,open,realpath,rm,writeFile} from 'node:fs/promises'
    import {tmpdir} from 'node:os'
    import path from 'node:path'
    const root=await realpath(await mkdtemp(path.join(tmpdir(),'TEST-v2-native-size-')))
    const packageRoot=path.join(root,'package'),bin=path.join(packageRoot,'bin')
    await mkdir(bin,{recursive:true})
    const executable=path.join(bin,process.platform==='win32'?'opencode.exe':'opencode')
    const header=Buffer.from(process.platform==='linux'?'7f454c46':process.platform==='win32'?'4d5a0000':'cffaedfe','hex')
    process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH=executable
    await writeFile(path.join(packageRoot,'package.json'),JSON.stringify({
      name:'@opencode/cli-'+(process.platform==='win32'?'windows':process.platform)+'-'+process.arch,version:'2.4.2'
    }))
    let versionCalls=0
    mock.module(${JSON.stringify(import.meta.resolve('./OpenCodeVersionProbe.ts'))},()=>({readOpenCodeOwnedVersion:async(file,roots)=>{
      assert.equal(file,executable);versionCalls++;await roots.remove();return 'opencode v2.4.2\\n'
    }}))
    const {hashOpenCodeFile,inspectOpenCodeReadSelection}=await import(${JSON.stringify(import.meta.resolve('./OpenCodeNativeIdentity.ts'))})
    const {validateExecutionNative}=await import(${JSON.stringify(import.meta.resolve('../host/OpenCodeV2ExecutionBinding.ts'))})
    const digest=async()=>{
      const hash=createHash('sha256')
      for await(const bytes of createReadStream(executable,{highWaterMark:1024*1024})) hash.update(bytes)
      return hash.digest('hex')
    }
    const sparse=async(size)=>{
      const file=await open(executable,'w')
      try {await file.truncate(size);await file.write(header,0,header.length,0);await file.write(Buffer.from('TEST-native-tail'),0,16,size-16)}
      finally {await file.close()}
    }
    try {
      // Actual @opencode/cli-windows-x64 2.4.2 size, then the inclusive installer ceiling.
      for(const size of [278504840,350*1024*1024]) {
        await sparse(size)
        const selected=await inspectOpenCodeReadSelection(),expected=await digest()
        assert.equal(selected.native.executableSha256,expected)
        assert.equal(selected.fingerprint,expected)
        await validateExecutionNative(selected.native)
        await assert.rejects(hashOpenCodeFile(executable),/identity_mismatch/)
        const file=await open(executable,'r+')
        try {await file.write(Buffer.from([0x7f]),0,1,size-1)} finally {await file.close()}
        await assert.rejects(validateExecutionNative(selected.native),/execution_identity_mismatch/)
        const changed=await inspectOpenCodeReadSelection()
        assert.equal(changed.native.executableSha256,await digest())
        assert.notEqual(changed.fingerprint,selected.fingerprint)
      }
      const callsBeforeOversize=versionCalls
      await sparse(350*1024*1024+1)
      await assert.rejects(inspectOpenCodeReadSelection(),/identity_mismatch/)
      assert.equal(versionCalls,callsBeforeOversize)
      console.log('TEST native 350 MiB admission, complete hashes and ordinary 256 MiB refusal')
    } finally {await rm(root,{recursive:true,force:true})}
  `
  const child=Bun.spawn([process.execPath,'-e',script],{cwd:import.meta.dir,stdout:'pipe',stderr:'pipe'})
  const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()])
  expect({code,stderr}).toEqual({code:0,stderr:''})
  expect(stdout.trim()).toBe('TEST native 350 MiB admission, complete hashes and ordinary 256 MiB refusal')
},15000)

test('standalone identity refuses our Windows console shim across case and slash spellings', async () => {
  for (const file of [
    'C:\\app\\resources\\runtime\\opencode-console\\opencode.exe',
    'C:/App/Resources/Runtime/OpenCode-Console/OpenCode.EXE',
    'C:\\app/resources\\RUNTIME/opencode-console\\opencode.exe',
  ]) expect(() => assertOpenCodeStandaloneNativePath(file)).toThrow('identity_mismatch')
  for (const file of ['C:/Users/TEST/.opencode/bin/opencode.exe', '/TEST/.opencode/bin/opencode',
    'C:/TEST/other-runtime/opencode-console/opencode.exe', 'C:/TEST/runtime/other/opencode.exe'])
    expect(() => assertOpenCodeStandaloneNativePath(file)).not.toThrow()
  const root = await mkdtemp(path.join(tmpdir(), 'TEST-reserved-console-'))
  const executable = path.join(root, 'Runtime', 'OpenCode-Console', 'opencode.exe')
  try {
    await mkdir(path.dirname(executable), { recursive: true })
    await expect(readOpenCodeNativePackageMetadata(executable)).rejects.toThrow('identity_mismatch')
    // Existing metadata validation stays on its own npm path; only absence admits standalone.
    const metadata = { name: '@opencode/cli-windows-x64', version: '2.99.0' }
    await writeFile(path.join(root, 'Runtime', 'package.json'), JSON.stringify(metadata))
    expect(await readOpenCodeNativePackageMetadata(executable)).toEqual(metadata)
  } finally { await rm(root, { recursive: true, force: true }) }
})
