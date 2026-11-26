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


const nativeSizePhasePrefix = 'TEST_NATIVE_SIZE_PHASE '
const nativeSizePhases = new Set([
  'setup', 'imports', 'sparse', 'inspect', 'oracle', 'validate', 'ordinary-cap',
  'tail-write', 'tampered-validate', 'changed-inspect', 'oversize-refusal', 'cleanup',
])
const nativeSizeValues = new Set([0, 278504840, 350 * 1024 * 1024, 350 * 1024 * 1024 + 1])
const nativeSizePhaseLineLimit = 256
const nativeSizePhaseCountLimit = 64
const nativeSizePhaseBytesLimit = 16 * 1024

function nativeSizePhaseLine(line: string): string | null {
  if (line.length > nativeSizePhaseLineLimit || !line.startsWith(nativeSizePhasePrefix)) return null
  try {
    const parsed: unknown = JSON.parse(line.slice(nativeSizePhasePrefix.length))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const value = parsed as Record<string, unknown>
    if (Object.keys(value).length !== 5 || value.protocol !== 1 ||
        typeof value.phase !== 'string' || !nativeSizePhases.has(value.phase) ||
        (value.edge !== 'start' && value.edge !== 'end') ||
        typeof value.size !== 'number' || !nativeSizeValues.has(value.size) ||
        typeof value.elapsedMs !== 'number' || !Number.isInteger(value.elapsedMs) ||
        value.elapsedMs < 0 || value.elapsedMs > 60000) return null
    const closed = nativeSizePhasePrefix + JSON.stringify({
      protocol: 1, phase: value.phase, edge: value.edge, size: value.size, elapsedMs: value.elapsedMs,
    })
    return line === closed ? closed : null
  } catch { return null }
}

/** One pipe consumer retains all output; only complete, closed records are forwarded live. */
async function observeNativeSizeStdout(
  stream: ReadableStream<Uint8Array>, report: (line: string) => void,
): Promise<{ stdout: string; withoutPhases: string }> {
  const reader = stream.getReader(), decoder = new TextDecoder()
  let stdout = '', withoutPhases = '', pending = '', longLine = false, records = 0, recordBytes = 0
  const consume = (text: string): void => {
    stdout += text
    let offset = 0
    while (offset < text.length) {
      const newline = text.indexOf('\n', offset)
      const fragment = text.slice(offset, newline < 0 ? undefined : newline)
      const complete = newline >= 0
      if (longLine || pending.length + fragment.length > nativeSizePhaseLineLimit) {
        withoutPhases += pending + fragment + (complete ? '\n' : '')
        pending = ''; longLine = !complete
      } else {
        pending += fragment
        if (complete) {
          const closed = nativeSizePhaseLine(pending), bytes = Buffer.byteLength(pending) + 1
          if (closed !== null && records < nativeSizePhaseCountLimit &&
              recordBytes + bytes <= nativeSizePhaseBytesLimit) {
            records++; recordBytes += bytes
            try { report(closed) } catch { /* Reporting cannot change the original work. */ }
          } else withoutPhases += pending + '\n'
          pending = ''
        }
      }
      offset = complete ? newline + 1 : text.length
    }
  }
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      consume(decoder.decode(next.value, { stream: true }))
    }
    consume(decoder.decode())
    // A final unterminated fragment is original output, never an admitted phase.
    return { stdout, withoutPhases: withoutPhases + pending }
  } finally { reader.releaseLock() }
}

test('native size phase observations are live before EOF and retain exact original output', async () => {
  const line = nativeSizePhasePrefix + JSON.stringify({ protocol: 1, phase: 'inspect', edge: 'start', size: 278504840, elapsedMs: 12 }) + '\n'
  const success = 'TEST original success\n'
  const encoder = new TextEncoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>, seen!: (line: string) => void
  const phaseSeen = new Promise<string>(resolve => { seen = resolve })
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
  const observed = observeNativeSizeStdout(stream, seen)
  controller.enqueue(encoder.encode(line.slice(0, 17)))
  controller.enqueue(encoder.encode(line.slice(17)))
  expect(await phaseSeen).toBe(line.trimEnd())
  expect(stream.locked).toBe(true)
  controller.enqueue(encoder.encode(success)); controller.close()
  expect(await observed).toEqual({ stdout: line + success, withoutPhases: success })
  expect(stream.locked).toBe(false)
})

test('native size phase observations refuse unknown, private, malformed and incomplete records', async () => {
  const valid = { protocol: 1, phase: 'oracle', edge: 'end', size: 350 * 1024 * 1024, elapsedMs: 45 }
  const lines = [
    { ...valid, phase: '/TEST/private/path' }, { ...valid, edge: 'success' },
    { ...valid, size: 1 }, { ...valid, elapsedMs: -1 }, { ...valid, elapsedMs: 60001 },
    { ...valid, elapsedMs: 0.5 }, { ...valid, protocol: 2 }, { ...valid, error: 'private payload' },
    null, [], {},
  ].map(value => nativeSizePhasePrefix + JSON.stringify(value) + '\n')
  lines.push(nativeSizePhasePrefix + '{malformed}\n', nativeSizePhasePrefix + JSON.stringify(valid) + ' \n')
  const incomplete = nativeSizePhasePrefix + JSON.stringify(valid)
  const raw = 'ordinary unicode: π\n' + lines.join('') + incomplete
  const bytes = new TextEncoder().encode(raw), reports: string[] = []
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7))
    controller.close()
  } })
  expect(await observeNativeSizeStdout(stream, line => reports.push(line))).toEqual({ stdout: raw, withoutPhases: raw })
  expect(reports).toEqual([])
})

test('native size phase observations bound forwarding without discarding excess original output', async () => {
  const line = nativeSizePhasePrefix + JSON.stringify({ protocol: 1, phase: 'sparse', edge: 'start', size: 350 * 1024 * 1024 + 1, elapsedMs: 60000 }) + '\n'
  const longPrefix = 'x'.repeat(nativeSizePhaseLineLimit + 1)
  const raw = longPrefix + line + line.repeat(nativeSizePhaseCountLimit + 1) + 'TEST original success\n'
  const reports: string[] = [], encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(encoder.encode(longPrefix))
    controller.enqueue(encoder.encode(line))
    controller.enqueue(encoder.encode(line.repeat(nativeSizePhaseCountLimit + 1) + 'TEST original success\n'))
    controller.close()
  } })
  expect(await observeNativeSizeStdout(stream, line => reports.push(line))).toEqual({
    stdout: raw, withoutPhases: longPrefix + line + line + 'TEST original success\n',
  })
  expect(reports).toHaveLength(nativeSizePhaseCountLimit)
  expect(reports.reduce((bytes, report) => bytes + Buffer.byteLength(report) + 1, 0)).toBeLessThanOrEqual(nativeSizePhaseBytesLimit)
})

test('native size phase reporter errors do not change the single drain or original output', async () => {
  const line = nativeSizePhasePrefix + JSON.stringify({ protocol: 1, phase: 'cleanup', edge: 'end', size: 0, elapsedMs: 8 }) + '\n'
  const raw = line + 'TEST original success\n'
  let reports = 0
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode(raw)); controller.close()
  } })
  expect(await observeNativeSizeStdout(stream, () => { reports++; throw new Error('TEST reporter failure') })).toEqual({
    stdout: raw, withoutPhases: 'TEST original success\n',
  })
  expect(reports).toBe(1)
  expect(stream.locked).toBe(false)
})

test('native size phase observation preserves its original pipe read failure', async () => {
  const reason = new Error('TEST original pipe failure')
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(reason) } })
  await expect(observeNativeSizeStdout(stream, () => {})).rejects.toBe(reason)
  expect(stream.locked).toBe(false)
})

test('native identity admits complete installer-sized executables while keeping ordinary files bounded', async () => {
  const script = `
    import {mock} from 'bun:test'
    import assert from 'node:assert/strict'
    import {createHash} from 'node:crypto'
    import {createReadStream,writeSync} from 'node:fs'
    import {mkdir,mkdtemp,open,realpath,rm,writeFile} from 'node:fs/promises'
    import {tmpdir} from 'node:os'
    import path from 'node:path'
    let phaseStartedAt
    try {phaseStartedAt=performance.now()} catch {}
    let phaseSize=0
    const phase=(name,edge)=>{try{
      const elapsed=performance.now()-phaseStartedAt
      if(!Number.isFinite(elapsed)) return
      writeSync(1,'TEST_NATIVE_SIZE_PHASE '+JSON.stringify({protocol:1,phase:name,edge,size:phaseSize,
        elapsedMs:Math.min(60000,Math.max(0,Math.floor(elapsed)))})+'\\n')
    }catch{/* Diagnostic output cannot change the original work. */}}
    phase('setup','start')
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
    phase('setup','end')
    phase('imports','start')
    const {hashOpenCodeFile,inspectOpenCodeReadSelection}=await import(${JSON.stringify(import.meta.resolve('./OpenCodeNativeIdentity.ts'))})
    const {validateExecutionNative}=await import(${JSON.stringify(import.meta.resolve('../host/OpenCodeV2ExecutionBinding.ts'))})
    phase('imports','end')
    const digest=async()=>{
      phase('oracle','start')
      const hash=createHash('sha256')
      for await(const bytes of createReadStream(executable,{highWaterMark:1024*1024})) hash.update(bytes)
      const result=hash.digest('hex')
      phase('oracle','end')
      return result
    }
    let previousSize=0
    const sparse=async(size)=>{
      phase('sparse','start')
      // Cases only grow. Clear the old tail to preserve each fresh fixture's bytes
      // without zero-truncating and re-extending the whole file on Windows.
      const file=await open(executable,previousSize?'r+':'w')
      try {
        if(previousSize) await file.write(Buffer.alloc(16),0,16,previousSize-16)
        await file.truncate(size);await file.write(header,0,header.length,0);await file.write(Buffer.from('TEST-native-tail'),0,16,size-16)
        previousSize=size
      }
      finally {await file.close()}
      phase('sparse','end')
    }
    try {
      // Actual @opencode/cli-windows-x64 2.4.2 size, then the inclusive installer ceiling.
      for(const size of [278504840,350*1024*1024]) {
        phaseSize=size
        await sparse(size)
        phase('inspect','start')
        const selected=await inspectOpenCodeReadSelection()
        phase('inspect','end')
        const expected=await digest()
        assert.equal(selected.native.executableSha256,expected)
        assert.equal(selected.fingerprint,expected)
        phase('validate','start')
        await validateExecutionNative(selected.native)
        phase('validate','end')
        phase('ordinary-cap','start')
        await assert.rejects(hashOpenCodeFile(executable),/identity_mismatch/)
        phase('ordinary-cap','end')
        phase('tail-write','start')
        const file=await open(executable,'r+')
        try {await file.write(Buffer.from([0x7f]),0,1,size-1)} finally {await file.close()}
        phase('tail-write','end')
        phase('tampered-validate','start')
        await assert.rejects(validateExecutionNative(selected.native),/execution_identity_mismatch/)
        phase('tampered-validate','end')
        phase('changed-inspect','start')
        const changed=await inspectOpenCodeReadSelection()
        phase('changed-inspect','end')
        assert.equal(changed.native.executableSha256,await digest())
        assert.notEqual(changed.fingerprint,selected.fingerprint)
      }
      const callsBeforeOversize=versionCalls
      phaseSize=350*1024*1024+1
      await sparse(350*1024*1024+1)
      phase('oversize-refusal','start')
      await assert.rejects(inspectOpenCodeReadSelection(),/identity_mismatch/)
      phase('oversize-refusal','end')
      assert.equal(versionCalls,callsBeforeOversize)
      console.log('TEST native 350 MiB admission, complete hashes and ordinary 256 MiB refusal')
    } finally {phaseSize=0;phase('cleanup','start');await rm(root,{recursive:true,force:true});phase('cleanup','end')}
  `
  const child=Bun.spawn([process.execPath,'-e',script],{cwd:import.meta.dir,stdout:'pipe',stderr:'pipe'})
  const [code,observed,stderr]=await Promise.all([child.exited,observeNativeSizeStdout(child.stdout,line=>console.error(line)),new Response(child.stderr).text()])
  const stdout=observed.withoutPhases
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
