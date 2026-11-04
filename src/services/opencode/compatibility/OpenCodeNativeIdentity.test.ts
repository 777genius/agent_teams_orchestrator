import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { classifyOpenCodeReadGeneration } from './OpenCodeGenerationPolicy.js'
import { assertOpenCodeStandaloneNativePath, hashOpenCodeFile, readOpenCodeNativePackageMetadata, selectedOpenCodeReadPath } from './OpenCodeNativeIdentity.js'

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


test('cancelled file hashing rejects the caller reason before opening a missing path', async () => {
  const controller = new AbortController()
  const reason = new Error('TEST-hash-cancelled')
  controller.abort(reason)
  await expect(hashOpenCodeFile(path.join(tmpdir(), 'TEST-missing-cancelled-hash'), controller.signal)).rejects.toBe(reason)
})


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
