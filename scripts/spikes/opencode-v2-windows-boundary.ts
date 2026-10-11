import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'

if (process.platform !== 'win32' || process.arch !== 'x64' || process.versions.bun !== '1.3.11') throw new Error('native Windows x64 Bun 1.3.11 required')
const native = await import('./opencode-v2-windows-native.ts')
const httpCheckpoint = await import('./windows-http-bridge/checkpoint.ts')
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const officialShellMode = process.env.TEST_WINDOWS_OFFICIAL_SHELL === '1'
const bundledOfficialShellMode = process.env.TEST_WINDOWS_OFFICIAL_SHELL_BUNDLED === '1'
const resolverPrimitiveMode = process.env.TEST_WINDOWS_RESOLVER_PRIMITIVE === '1'
const resolverDiagnosticsMode = officialShellMode || resolverPrimitiveMode
if (officialShellMode && resolverPrimitiveMode) throw new Error('TEST resolver primitive cannot qualify official Shell')
if (bundledOfficialShellMode && !officialShellMode) throw new Error('TEST bundled checkpoint requires official Shell mode')
const child = process.argv[2] === 'child'
async function probeOfficialGraphNativeAccess(targets: ReadonlyMap<string, boolean>) {
  const { dlopen, FFIType, ptr } = await import('bun:ffi')
  const library = dlopen('kernel32.dll', {
    GetFileAttributesW: { args: [FFIType.ptr], returns: FFIType.u32 },
    CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u64], returns: FFIType.u64 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.bool },
    ReadFile: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
    GetLastError: { args: [], returns: FFIType.u32 },
  })
  const nt = dlopen('ntdll.dll', {
    NtCreateFile: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    NtQueryDirectoryFile: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u8, FFIType.ptr, FFIType.u8], returns: FFIType.i32 },
  })
  const statusHex = (status: number) => '0x' + (status >>> 0).toString(16).padStart(8, '0')
  const results: Record<string, unknown>[] = []
  try {
    for (const [target, directory] of targets) {
      const bytes = Buffer.from(target + '\0', 'utf16le')
      const attributes = library.symbols.GetFileAttributesW(ptr(bytes))
      const result: Record<string, unknown> = { path: target, directory, attributes,
        attributeError: attributes === 0xffffffff ? library.symbols.GetLastError() : 0, opens: [] }
      const opens: Record<string, unknown>[] = []
      result.opens = opens; results.push(result)
      if (directory) {
        // Match pinned Bun1.3.11 sys.openDirAtWindowsNtPath and DirIterator,
        // including OBJECT_ATTRIBUTES.Attributes=0 and backup-intent option.
        const name = Buffer.from('\\??\\' + target + '\0', 'utf16le')
        const unicode = Buffer.alloc(16), object = Buffer.alloc(48), io = Buffer.alloc(16), handleOut = Buffer.alloc(8)
        unicode.writeUInt16LE(name.length - 2, 0); unicode.writeUInt16LE(name.length, 2)
        unicode.writeBigUInt64LE(BigInt(ptr(name)), 8)
        object.writeUInt32LE(48, 0); object.writeBigUInt64LE(BigInt(ptr(unicode)), 16)
        const status = nt.symbols.NtCreateFile(ptr(handleOut), 0x1200a9, ptr(object), ptr(io), null, 0, 7, 1, 0x4021, null, 0)
        result.bunNtDirectoryOpen = { status: statusHex(status), opened: status >= 0 }
        if (status >= 0) {
          const handle = handleOut.readBigUInt64LE()
          try {
            if (targets.has(path.join(target, 'package.json'))) {
              // PackageJSON.parse -> FSCache.readFileWithAllocator uses openatA
              // relative to the cached directory handle, not absolute CreateFileW.
              const leaf = Buffer.from('package.json\0', 'utf16le')
              const leafName = Buffer.alloc(16), leafObject = Buffer.alloc(48), leafIo = Buffer.alloc(16), leafHandle = Buffer.alloc(8)
              leafName.writeUInt16LE(leaf.length - 2, 0); leafName.writeUInt16LE(leaf.length, 2)
              leafName.writeBigUInt64LE(BigInt(ptr(leaf)), 8)
              leafObject.writeUInt32LE(48, 0); leafObject.writeBigUInt64LE(handle, 8)
              leafObject.writeBigUInt64LE(BigInt(ptr(leafName)), 16)
              // GENERIC_READ|READ_CONTROL|FILE_WRITE_ATTRIBUTES|SYNCHRONIZE;
              // FILE_OPEN, FILE_SYNCHRONOUS_IO_NONALERT, no case-insensitive flag.
              const relative = nt.symbols.NtCreateFile(ptr(leafHandle), 0x80120100, ptr(leafObject), ptr(leafIo), null, 0x80, 7, 1, 0x20, null, 0)
              result.bunNtRelativePackageOpen = { status: statusHex(relative), opened: relative >= 0 }
              if (relative >= 0) {
                const fileHandle = leafHandle.readBigUInt64LE()
                try {
                  // Pinned Bun FSCache uses synchronous kernel32.ReadFile on
                  // this exact native handle after its relative NtCreateFile.
                  const buffer = Buffer.alloc(64 * 1024), amount = Buffer.alloc(4)
                  let total = 0, eof = false, error = 0
                  while (total < buffer.length) {
                    amount.writeUInt32LE(0)
                    const ok = library.symbols.ReadFile(fileHandle, ptr(buffer.subarray(total)), buffer.length - total, ptr(amount), null)
                    if (!ok) { error = library.symbols.GetLastError(); break }
                    const count = amount.readUInt32LE()
                    if (count > buffer.length - total) throw new Error('TEST native package read exceeded buffer')
                    total += count
                    if (count === 0) { eof = true; break }
                  }
                  const contents = buffer.subarray(0, total)
                  const read: Record<string, unknown> = { succeeded: error === 0 && eof, error, bytes: total, eof,
                    limitBytes: buffer.length, sha256: createHash('sha256').update(contents).digest('hex') }
                  result.bunNtRelativePackageRead = read
                  if (error === 0 && eof) {
                    const expected = await readFile(path.join(target, 'package.json'))
                    read.matchesReadableManifest = createHash('sha256').update(expected).digest('hex') === read.sha256
                    try {
                      const actual: unknown = JSON.parse(contents.toString('utf8')), original: unknown = JSON.parse(expected.toString('utf8'))
                      const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
                      read.validJson = object(actual)
                      if (object(actual) && object(original)) {
                        read.expectedNameMatches = actual.name === original.name
                        read.expectedVersionMatches = actual.version === original.version
                        read.expectedExportsTargetsMatch = JSON.stringify(actual.exports) === JSON.stringify(original.exports)
                      }
                    } catch { read.validJson = false }
                  }
                } finally {
                  if (!library.symbols.CloseHandle(fileHandle)) throw new Error('TEST native relative package handle close failed')
                }
              }
            }
            const buffer = Buffer.alloc(64 * 1024)
            const query = nt.symbols.NtQueryDirectoryFile(handle, null, null, null, ptr(io), ptr(buffer), buffer.length, 1, 0, null, 1)
            result.bunNtDirectoryQuery = { status: statusHex(query), succeeded: query >= 0,
              bytes: Number(io.readBigUInt64LE(8)), endOfDirectory: (query >>> 0) === 0x80000006 }
          } finally {
            if (!library.symbols.CloseHandle(handle)) throw new Error('TEST native NT resolver handle close failed')
          }
        }
        try {
          const entries = await readdir(target, { withFileTypes: true })
          const expectedNames = [...targets.keys()].filter(candidate => path.dirname(candidate) === target).map(candidate => path.basename(candidate))
          result.bunDirectoryEntries = { readable: true, count: entries.length,
            expectedKinds: expectedNames.map(name => { const entry = entries.find(candidate => candidate.name === name); return { name, present: !!entry, directory: entry?.isDirectory() ?? false, file: entry?.isFile() ?? false, symbolicLink: entry?.isSymbolicLink() ?? false } }) }
        }
        catch (error) { result.bunDirectoryEntries = { readable: false, code: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN' } }
      }
      // Observe exact requested rights; never set ACLs or write any file data.
      for (const [name, mask] of [['attributesOnly', 0x80], ['bunDirectoryRead', 0x1200a9], ['bunFileRead', 0x120089], ['readWithWriteAttributes', directory ? 0x1201a9 : 0x120189]] as const) {
        const handle = BigInt(library.symbols.CreateFileW(ptr(bytes), mask, 7, null, 3, directory ? 0x02200000 : 0x00200000, 0n))
        const error = handle === 0xffffffffffffffffn ? library.symbols.GetLastError() : 0
        opens.push({ name, mask, opened: error === 0, error })
        if (error === 0 && !library.symbols.CloseHandle(handle)) throw new Error('TEST native resolver diagnostic handle close failed')
      }
    }
  } finally { nt.close(); library.close() }
  return results
}
if (child) {
  const base = process.argv[3]!, pipeName = process.argv[4]!
  const attempts: Record<string, unknown> = {}
  let baseUrl = ''
  const deny = async (name: string, action: () => Promise<unknown>) => {
    try { await action(); attempts[name] = false } catch (error) { attempts[name] = (error as NodeJS.ErrnoException).code === 'EACCES' || (error as NodeJS.ErrnoException).code === 'EPERM' }
  }
  try {
  if (!resolverPrimitiveMode) {
  await writeFile(path.join(base, 'work', 'allowed.txt'), 'owned write')
  attempts.ownedWrite = true
  await deny('outsideApprovedReadDenied', () => readFile(path.join(base, 'private-canary.txt')))
  await deny('outsideApprovedWriteDenied', () => writeFile(path.join(base, 'private-canary.txt'), 'escape'))
  await deny('siblingListingDenied', () => readdir(path.join(base, 'private-sibling')))
  await deny('hostStateWriteDenied', () => writeFile(path.join(base, 'host-state', 'secret.txt'), 'escape'))
  attempts.protectedAclEscapeError = native.attemptWindowsAclEscape(path.join(base, 'work', 'protected'))
  attempts.protectedFileAclEscapeError = native.attemptWindowsAclEscape(path.join(base, 'work', 'protected', 'owner.json'))
  await deny('protectedWriteDenied', () => writeFile(path.join(base, 'work', 'protected', 'owner.json'), 'escape'))
  await deny('protectedRenameDenied', () => rename(path.join(base, 'work', 'protected'), path.join(base, 'work', 'stolen')))
  await deny('protectedDeleteDenied', () => rm(path.join(base, 'work', 'protected'), { recursive: true }))
  attempts.readOnlyAclEscapeError = native.attemptWindowsAclEscape(path.join(base, 'readonly'))
  await deny('readOnlyWriteDenied', () => writeFile(path.join(base, 'readonly', 'immutable.txt'), 'escape'))
  await deny('runtimeInputWriteDenied', () => writeFile(path.join(base, 'readonly', 'opencode-v2-windows-boundary.ts'), 'escape'))
  await deny('runtimeHelperWriteDenied', () => writeFile(path.join(base, 'readonly', 'opencode-v2-windows-native.ts'), 'escape'))
  await deny('runtimeHttpModuleWriteDenied', () => writeFile(path.join(base, 'readonly', 'windows-http-bridge', 'checkpoint.ts'), 'escape'))
  attempts.runtimeInputAclEscapeError = native.attemptWindowsAclEscape(path.join(base, 'readonly', 'opencode-v2-windows-boundary.ts'))
  attempts.runtimeHttpModuleAclEscapeError = native.attemptWindowsAclEscape(path.join(base, 'readonly', 'windows-http-bridge', 'checkpoint.ts'))
  try {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const route = new URL(request.url).pathname
      if (route === '/echo') return new Response(await request.text())
      if (route === '/sse') {
        let cancelled = false
        return new Response(new ReadableStream({
          async pull(controller) { await pause(20); if (!cancelled) controller.enqueue(new TextEncoder().encode('data: native-sse\n\n')) },
          cancel() { cancelled = true; void writeFile(path.join(base, 'work', 'http-sse-cancelled.txt'), 'cancelled') },
        }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'text/event-stream' } })
      }
      return new Response('native-http-ok')
    } })
    baseUrl = `http://127.0.0.1:${server.port}`
  } catch (error) { attempts.serverStartupError = String(error) }
  try { attempts.selfHttp = await (await fetch(baseUrl, { signal: AbortSignal.timeout(3000) })).text() } catch (error) { attempts.selfHttp = String(error) }
  try { attempts.internet = (await fetch('https://example.com', { signal: AbortSignal.timeout(10000) })).status } catch (error) { attempts.internet = String(error) }
  try {
    const descendant = Bun.spawn([process.execPath, '-e', 'setInterval(()=>{},1000)'], { stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env } })
    attempts.descendantPID = descendant.pid
  } catch (error) { attempts.descendantStartupError = String(error) }
  try {
    const markerPath = path.join(base, 'work', 'native-descendant-marker.json')
    const descendant = native.launchWindowsNativeDescendant(process.execPath, markerPath)
    attempts.nativeDescendantPID = descendant.pid; attempts.nativeDescendantBirth = descendant.birthFiletime
    attempts.nativeDescendantInheritedJob = descendant.inheritedJob
    const deadline = Date.now() + 5000
    let marker: { pid?: number; nativeDescendant?: boolean } | undefined
    while (!marker && Date.now() < deadline) {
      marker = await readFile(markerPath, 'utf8').then(text => JSON.parse(text) as typeof marker).catch(() => undefined)
      if (!marker) await pause(20)
    }
    attempts.nativeDescendantBunStarted = marker?.pid === descendant.pid && marker.nativeDescendant === true
  } catch (error) { attempts.nativeDescendantStartupError = String(error) }
  attempts.nulAccess = JSON.stringify(native.probeWindowsNulAccess())
  try {
    const markerPath = path.join(base, 'work', 'bun-spawn-inherit.json')
    const script = `require('node:fs').writeFileSync(${JSON.stringify(markerPath)},JSON.stringify({pid:process.pid}));process.exit(0)`
    const spawned = Bun.spawn([process.execPath, '-e', script], { stdio: ['inherit', 'inherit', 'inherit'], env: { ...process.env } })
    const exitCode = await Promise.race([spawned.exited, pause(3000).then(() => 'timeout')])
    if (exitCode === 'timeout') spawned.kill()
    const marker = await readFile(markerPath, 'utf8').then(text => JSON.parse(text) as { pid?: number }).catch(() => undefined)
    attempts.spawnProbe_inherit = JSON.stringify({ pid: spawned.pid, exitCode, markerMatchesSpawnPID: marker?.pid === spawned.pid })
  } catch (error) { attempts.spawnProbe_inherit = String(error) }
  // Isolate synchronous libuv pipe creation: its ACCESS_DENIED retry loop can
  // block the event loop, so each variant runs in a held, bounded native child.
  for (const mode of ['ignore', 'files', 'pipe'] as const) {
    const markerPath = path.join(base, 'work', `bun-spawn-${mode}.json`)
    const stdio = mode === 'files'
      ? `[Bun.file(${JSON.stringify(path.join(base, 'work', 'allowed.txt'))}),Bun.file(${JSON.stringify(path.join(base, 'work', 'spawn-stdout.txt'))}),Bun.file(${JSON.stringify(path.join(base, 'work', 'spawn-stderr.txt'))})]`
      : JSON.stringify([mode, mode, mode])
    const script = `const fs=require('node:fs'),marker=${JSON.stringify(markerPath)};fs.writeFileSync(marker,JSON.stringify({probePID:process.pid,phase:'before-spawn'}));try{const child=Bun.spawn([process.execPath,'-e','process.exit(0)'],{stdio:${stdio},env:{...process.env}});const drains=${mode === 'pipe' ? '[new Response(child.stdout).text(),new Response(child.stderr).text()]' : '[]'};const [exitCode]=await Promise.all([child.exited,...drains]);fs.writeFileSync(marker,JSON.stringify({probePID:process.pid,phase:'completed',childPID:child.pid,exitCode}));}catch(error){fs.writeFileSync(marker,JSON.stringify({probePID:process.pid,phase:'failed',error:String(error)}));}`
    try {
      const probe = native.launchWindowsNativeDescendant(process.execPath, markerPath, { script, waitMs: 3000 })
      const receipt = await readFile(markerPath, 'utf8').then(text => JSON.parse(text) as { probePID?: number }).catch(() => undefined)
      attempts[`spawnProbe_${mode}`] = JSON.stringify({ ...probe, markerMatchesHeldPID: receipt?.probePID === probe.pid, receipt })
    } catch (error) { attempts[`spawnProbe_${mode}`] = String(error) }
  }
  }
  if (resolverDiagnosticsMode && !bundledOfficialShellMode) {
    const directory = path.join(import.meta.dir, 'windows-official-shell')
    const resolution: unknown = JSON.parse(await readFile(path.join(directory, 'resolution.json'), 'utf8'))
    if (!Array.isArray(resolution) || resolution.length !== (resolverPrimitiveMode ? 1 : 4)) throw new Error('TEST official resolution manifest invalid')
    const diagnostics: Record<string, unknown>[] = []
    const nativeTargets = new Map<string, boolean>([[import.meta.dir, true], [path.join(import.meta.dir, 'node_modules'), true], [directory, true]])
    attempts.officialShellResolution = diagnostics
    for (const row of resolution) {
      if (!row || typeof row !== 'object' || typeof row.specifier !== 'string' || typeof row.entry !== 'string' || typeof row.packageRoot !== 'string' || typeof row.manifest !== 'string') throw new Error('TEST official resolution entry invalid')
      const entry = path.resolve(import.meta.dir, row.entry)
      const relative = path.relative(import.meta.dir, entry)
      if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('TEST official resolution entry escaped its staged graph')
      const diagnostic: Record<string, unknown> = { specifier: row.specifier, expectedEntry: row.entry }
      diagnostics.push(diagnostic)
      for (const [relativePath, isDirectory] of [[row.packageRoot, true], [row.manifest, false], [row.entry, false]] as const) {
        const target = path.resolve(import.meta.dir, relativePath), relativeTarget = path.relative(import.meta.dir, target)
        if (relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) throw new Error('TEST native graph access target escaped')
        nativeTargets.set(target, isDirectory)
        if (isDirectory && path.basename(path.dirname(target)) === '@opencode') nativeTargets.set(path.dirname(target), true)
      }
      try { const metadata: unknown = JSON.parse(await readFile(path.resolve(import.meta.dir, row.manifest), 'utf8')); diagnostic.packageManifestReadable = true; diagnostic.packageIdentityMatches = !!metadata && typeof metadata === 'object' && 'name' in metadata && metadata.name === row.packageName && 'version' in metadata && metadata.version === row.packageVersion }
      catch (error) { diagnostic.packageManifestError = String(error).slice(0, 1024) }
      try { await readFile(entry); diagnostic.physicalEntryReadable = true }
      catch (error) { diagnostic.physicalEntryError = String(error).slice(0, 1024) }
      try { diagnostic.absoluteResolvedEntry = Bun.resolveSync(entry, directory); diagnostic.absoluteMatchesStagedEntry = diagnostic.absoluteResolvedEntry === entry }
      catch (error) { diagnostic.absoluteResolverError = String(error).slice(0, 1024) }
      // Explicit package-relative input bypasses package exports without loading code.
      const packageRoot = path.resolve(import.meta.dir, row.packageRoot)
      const packageRelativeEntry = `.${path.sep}${path.relative(packageRoot, entry)}`
      try { const resolved = Bun.resolveSync(packageRelativeEntry, packageRoot); diagnostic.packageRelativeResolution = { specifier: packageRelativeEntry, matched: resolved === entry, resolvedEntry: path.relative(import.meta.dir, resolved) } }
      catch (error) { diagnostic.packageRelativeResolution = { specifier: packageRelativeEntry, error: String(error).slice(0, 1024) } }
      if (row.specifier === 'effect') {
        try { const resolved = Bun.resolveSync('effect/package.json', directory); diagnostic.packageJsonExportResolution = { matched: resolved === path.resolve(import.meta.dir, row.manifest), resolvedEntry: path.relative(import.meta.dir, resolved) } }
        catch (error) { diagnostic.packageJsonExportResolution = { error: String(error).slice(0, 1024) } }
      }
      const contexts: Record<string, unknown>[] = []
      diagnostic.resolverContexts = contexts
      for (const [name, from] of [['exactImporter', path.join(directory, 'checkpoint.ts')], ['trailingDirectory', directory + path.sep], ['graphRoot', import.meta.dir]] as const) {
        try { const resolved = Bun.resolveSync(row.specifier, from); contexts.push({ name, matched: resolved === entry, resolvedEntry: path.relative(import.meta.dir, resolved) }) }
        catch (error) { contexts.push({ name, error: String(error).slice(0, 1024) }) }
      }
      try { diagnostic.resolvedEntry = path.relative(import.meta.dir, Bun.resolveSync(row.specifier, directory)); diagnostic.matchesStagedEntry = diagnostic.resolvedEntry === row.entry }
      catch (error) { diagnostic.resolverError = String(error).slice(0, 1024) }
    }
    // Resolver builds its directory cache top-down from the drive root.
    // Record counts/status only; do not export sibling filenames.
    for (let ancestor = path.dirname(import.meta.dir);; ancestor = path.dirname(ancestor)) {
      nativeTargets.set(ancestor, true)
      if (ancestor === path.dirname(ancestor)) break
    }
    attempts.officialShellNativeAccess = await probeOfficialGraphNativeAccess(nativeTargets)
    if (!resolverPrimitiveMode) {
      if (diagnostics.some(row => row.physicalEntryReadable !== true || row.matchesStagedEntry !== true)) throw new Error('TEST official child graph resolution refused; see officialShellResolution')
      const checkpoint = await import('./windows-official-shell/checkpoint.ts')
      attempts.officialShellCheckpoint = await checkpoint.runOfficialShellCheckpoint(base)
    } else { attempts.resolverPrimitiveCompleted = true; attempts.fullTaskQualified = false }
  }
  if (bundledOfficialShellMode) {
    const bundledPath = path.join(import.meta.dir, 'windows-official-shell', 'checkpoint-bundled.js')
    const checkpoint: { runOfficialShellCheckpointBundled(base: string): ReturnType<typeof import('./windows-official-shell/checkpoint.ts').runOfficialShellCheckpoint> } = await import(bundledPath)
    attempts.officialShellCheckpoint = await checkpoint.runOfficialShellCheckpointBundled(base)
    attempts.fullTaskQualified = false
  }
  if (!resolverPrimitiveMode) {
  const breakaway = native.attemptWindowsJobBreakaway(process.execPath)
  attempts.jobBreakawayError = breakaway.error
  attempts.jobBreakawayReceipt = JSON.stringify(breakaway)
  attempts.jobBreakawayContained = breakaway.error === 5 || ('outerJobContained' in breakaway && breakaway.outerJobContained && breakaway.candidateRetired && breakaway.neverResumed)
  }
  } catch (error) { attempts.childStartupError = String(error); console.error(JSON.stringify({ childStartupError: String(error) })) }
  // Named pipe carries the probe response without admin loopback exemptions.
  console.log(JSON.stringify({ pid: process.pid, baseUrl, attempts }))
  const pipe = createConnection(pipeName)
  if (!resolverPrimitiveMode) httpCheckpoint.attachCheckpointChild(pipe, baseUrl)
  pipe.once('connect', () => { pipe.write(JSON.stringify({ pid: process.pid, baseUrl, attempts }) + '\n') })
  pipe.once('error', error => { void writeFile(path.join(base, 'work', 'pipe-error.txt'), String(error)) })
  setInterval(() => {}, 1000)
} else {
  const root = path.join(process.env.RUNNER_TEMP ?? process.env.TEMP!, `TEST-opencode-v2-windows-${randomUUID()}`)
  const output = process.argv[2] ?? path.join(root, 'evidence.json')
  const profileName = `AgentTeams.Test.${randomUUID()}`
  let container: ReturnType<typeof native.createWindowsContainer> | undefined
  let pipe: ReturnType<typeof native.createWindowsPipe> | undefined
  let launch: ReturnType<typeof native.launchWindowsContainer> | undefined
  const ancestorJournal = path.join(root, 'ancestor-ace-journal.json')
  let officialArtifacts: import('./windows-official-shell/fixture.ts').Artifact[] = []
  const runPowerShell = async (script: string) => {
    const command = Bun.spawn([path.join(process.env.ProgramFiles!, 'PowerShell', '7', 'pwsh.exe'), '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { env: { ...process.env, PSModulePath: path.join(process.env.ProgramFiles!, 'PowerShell', '7', 'Modules'), TEST_CONTAINER_SID: container!.sid, TEST_ROOT: root, TEST_ANCESTOR_JOURNAL: ancestorJournal }, stdout: 'pipe', stderr: 'pipe' })
    // Drain both streams; neither can block a setup or cleanup operation.
    const [stderr, stdout, code] = await Promise.all([new Response(command.stderr).text(), new Response(command.stdout).text(), command.exited])
    if (code !== 0) throw new Error(`TEST ACL operation:${stderr}${stdout}`)
  }
  const evidence: Record<string, unknown> = { schema: 1, purpose: 'TEST-native-feasibility', repositorySHA: process.env.GITHUB_SHA ?? null,
    os: process.platform, arch: process.arch, bun: process.versions.bun, profileName, root }
  if (resolverPrimitiveMode) Object.assign(evidence, { purpose: 'TEST-resolver-primitive', fullTaskQualified: false, qualified: false })
  try {
    await mkdir(root, { recursive: true })
    for (const directory of ['work', 'work/protected', 'host-state', 'readonly', 'private-sibling']) await mkdir(path.join(root, directory), { recursive: true })
    await writeFile(path.join(root, 'private-canary.txt'), 'host-owned')
    await writeFile(path.join(root, 'private-sibling', 'secret.txt'), 'host-owned')
    await writeFile(ancestorJournal, '[]')
    await writeFile(path.join(root, 'host-state', 'secret.txt'), 'host-owned')
    await writeFile(path.join(root, 'work', 'protected', 'owner.json'), 'host-owned')
    await writeFile(path.join(root, 'readonly', 'immutable.txt'), 'host-owned')
    await cp(process.execPath, path.join(root, 'readonly', 'bun.exe'))
    await cp(import.meta.filename, path.join(root, 'readonly', 'opencode-v2-windows-boundary.ts'))
    await cp(path.join(import.meta.dir, 'opencode-v2-windows-native.ts'), path.join(root, 'readonly', 'opencode-v2-windows-native.ts'))
    await cp(path.join(import.meta.dir, 'windows-http-bridge'), path.join(root, 'readonly', 'windows-http-bridge'), { recursive: true })
    if (officialShellMode) officialArtifacts = bundledOfficialShellMode
      ? await (await import('./windows-official-shell/bundle.ts')).stageBundledFixture(path.join(root, 'readonly'))
      : await (await import('./windows-official-shell/fixture.ts')).stageFixture(path.join(root, 'readonly'))
    if (resolverPrimitiveMode) officialArtifacts = await (await import('./windows-resolver-primitive/fixture.ts')).stagePrimitiveFixture(path.join(root, 'readonly'))
    container = native.createWindowsContainer(profileName)
    evidence.containerSid = container.sid
    // The server is an unsandboxed broker. LOCAL would redirect the AC client
    // into a different NPFS package namespace, as Chromium's Mojo source notes.
    const pipeName = `\\\\.\\pipe\\agt-${randomUUID()}`
    pipe = native.createWindowsPipe(pipeName, container.sid)
    // Only TEST-owned paths are ACL modified. Modify omits FILE_DELETE_CHILD;
    // explicit protected denies prohibit its deletion through the writable parent.
    const aclScript = `
$ErrorActionPreference = 'Stop'
$sid = New-Object System.Security.Principal.SecurityIdentifier($env:TEST_CONTAINER_SID)
$inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$none = [System.Security.AccessControl.PropagationFlags]::None
function Rule($target, $rights, $effect) {
  $acl = Get-Acl -LiteralPath $target
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, $rights, $inherit, $none, $effect)))
  Set-Acl -LiteralPath $target -AclObject $acl
}
Rule (Join-Path $env:TEST_ROOT 'work') ([System.Security.AccessControl.FileSystemRights]::Modify) ([System.Security.AccessControl.AccessControlType]::Allow)
Rule (Join-Path $env:TEST_ROOT 'readonly') ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute) ([System.Security.AccessControl.AccessControlType]::Allow)
# Bun1.3.11 sys.zig openatWindowsTMaybeNormalize requests FILE_WRITE_ATTRIBUTES
# even for O_RDONLY. Qualify only the finite copied TEST runtime read inputs.
$runtimeInputRights = [System.Security.AccessControl.FileSystemRights]'ReadAndExecute,WriteAttributes'
# Exact finite copied graph artifact list, hashed before and after the child.
$runtimeInputs = @('opencode-v2-windows-boundary.ts', 'opencode-v2-windows-native.ts', 'windows-http-bridge/checkpoint.ts')
$manifest = Join-Path (Join-Path $env:TEST_ROOT 'readonly') 'official-artifacts.json'
if (Test-Path -LiteralPath $manifest) {
  $runtimeInputs += 'official-artifacts.json'
  $runtimeInputs += @(Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json | Where-Object { $_.metadataReadInput -eq $true } | ForEach-Object { $_.path })
}
# Apply the low integrity label in one traversal. File data and ACL write
# permissions remain denied; only the finite metadata inputs below gain rights.
$extendedPrefix = [string][char]92 + [char]92 + '?' + [char]92
$readonlyRoot = Join-Path $env:TEST_ROOT 'readonly'
& icacls.exe ($extendedPrefix + $readonlyRoot) /setintegritylevel '(OI)(CI)L' /T /Q
if ($LASTEXITCODE -ne 0) { throw 'TEST runtime graph low integrity setup failed' }
foreach ($name in $runtimeInputs) {
  $target = Join-Path (Join-Path $env:TEST_ROOT 'readonly') $name
  $acl = Get-Acl -LiteralPath $target
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, $runtimeInputRights, [System.Security.AccessControl.AccessControlType]::Allow))
  Set-Acl -LiteralPath $target -AclObject $acl
}
Rule (Join-Path $env:TEST_ROOT 'work/protected') ([System.Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership') ([System.Security.AccessControl.AccessControlType]::Deny)
Rule (Join-Path $env:TEST_ROOT 'host-state') ([System.Security.AccessControl.FileSystemRights]::FullControl) ([System.Security.AccessControl.AccessControlType]::Deny)
& icacls.exe (Join-Path $env:TEST_ROOT 'work') /setintegritylevel '(OI)(CI)L' /T /Q
if ($LASTEXITCODE -ne 0) { throw 'TEST low integrity setup failed' }
# Bun1.3.11 resolver opens every ancestor directory with mask0x1200a9.
# Each ACE applies to this directory only, never files or subdirectories.
$added = [System.Collections.Generic.List[string]]::new()
$ancestor = $env:TEST_ROOT
while ($ancestor) {
  $acl = Get-Acl -LiteralPath $ancestor
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::ReadAndExecute, [System.Security.AccessControl.InheritanceFlags]::None, $none, [System.Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
  $added.Add($ancestor)
  ConvertTo-Json -InputObject $added.ToArray() -Compress | Set-Content -LiteralPath $env:TEST_ANCESTOR_JOURNAL -Encoding utf8NoBOM
  Set-Acl -LiteralPath $ancestor -AclObject $acl
  $parentInfo = [System.IO.DirectoryInfo]::new($ancestor).Parent
  $parent = if ($parentInfo) { $parentInfo.FullName } else { $null }
  if ($parent -eq $ancestor) { break }
  $ancestor = $parent
}
# Apply explicit protection after all ancestor inheritance updates. Preserve
# other trustees, remove only this unique package's writable inherited grants.
$protectedRights = [System.Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'
$protectedAcls = @()
foreach ($relative in @('work/protected', 'work/protected/owner.json')) {
  $target = Join-Path $env:TEST_ROOT $relative
  $acl = Get-Acl -LiteralPath $target
  $before = @($acl.Access | Where-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq $sid.Value } | ForEach-Object { @{ rights = [int]$_.FileSystemRights; effect = [string]$_.AccessControlType; inherited = $_.IsInherited } })
  $acl.SetAccessRuleProtection($true, $true)
  # Persist conversion before removing inherited grants: the Win32 write turns
  # those grants into explicit ACEs. RemoveAccessRuleSpecific skipped them before.
  Set-Acl -LiteralPath $target -AclObject $acl
  $acl = Get-Acl -LiteralPath $target
  foreach ($existing in @($acl.Access)) {
    if ($existing.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq $sid.Value -and $existing.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) { $acl.RemoveAccessRuleAll($existing) }
  }
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, $protectedRights, [System.Security.AccessControl.InheritanceFlags]::None, $none, [System.Security.AccessControl.AccessControlType]::Deny))
  Set-Acl -LiteralPath $target -AclObject $acl
  $actual = Get-Acl -LiteralPath $target
  $unexpectedAllow = $actual.Access | Where-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq $sid.Value -and $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow }
  if ($unexpectedAllow) { throw 'TEST protected package allow remained after removal' }
  $after = @($actual.Access | Where-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq $sid.Value } | ForEach-Object { @{ rights = [int]$_.FileSystemRights; effect = [string]$_.AccessControlType; inherited = $_.IsInherited } })
  $protectedAcls += @{ relative = $relative; before = $before; after = $after; inheritanceProtected = $actual.AreAccessRulesProtected }
}
ConvertTo-Json -InputObject $protectedAcls -Depth 5 -Compress | Set-Content -LiteralPath (Join-Path $env:TEST_ROOT 'protected-acl-evidence.json') -Encoding utf8NoBOM
$workPackageAllows = (Get-Acl -LiteralPath (Join-Path $env:TEST_ROOT 'work')).Access | Where-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq $sid.Value -and $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow }
foreach ($entry in $workPackageAllows) { if (([int]$entry.FileSystemRights -band 0x40) -ne 0) { throw 'TEST writable parent grants package DELETE_CHILD' } }
`;
    await runPowerShell(aclScript)
    evidence.protectedAcls = JSON.parse(await readFile(path.join(root, 'protected-acl-evidence.json'), 'utf8'))
    await writeFile(path.join(root, 'work', 'protected', 'owner.json'), 'host-owned')
    evidence.trustedOwnerWrite = true
    evidence.ancestorDirectoryAccessMask = '0x1200a9'
    evidence.runtimeInputMetadataGrant = { files: 3 + (resolverDiagnosticsMode ? officialArtifacts.filter(artifact => artifact.metadataReadInput).length + 1 : 0), readAndExecute: true, writeAttributes: true, writeData: false, delete: false, changePermissions: false }
    evidence.ancestorGrantCount = (JSON.parse(await readFile(ancestorJournal, 'utf8')) as unknown[]).length
    if (resolverDiagnosticsMode && !bundledOfficialShellMode) {
      // Parent normal Bun control uses the SAME fresh staged graph, never repository dependencies.
      const graphRoot = path.join(root, 'readonly'), from = path.join(graphRoot, 'windows-official-shell')
      const resolution: unknown = JSON.parse(await readFile(path.join(from, 'resolution.json'), 'utf8'))
      if (!Array.isArray(resolution) || resolution.length !== (resolverPrimitiveMode ? 1 : 4)) throw new Error('TEST parent resolution manifest invalid')
      const diagnostics: Record<string, unknown>[] = []
      evidence.officialShellParentResolution = { phase: 'staged-before-container-launch', bunVersion: Bun.version, diagnostics }
      for (const row of resolution) {
        if (!row || typeof row !== 'object' || typeof row.specifier !== 'string' || typeof row.entry !== 'string') throw new Error('TEST parent resolution entry invalid')
        const entry = path.resolve(graphRoot, row.entry), relative = path.relative(graphRoot, entry)
        if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('TEST parent resolution entry escaped staged graph')
        const diagnostic: Record<string, unknown> = { specifier: row.specifier, expectedEntry: row.entry }
        diagnostics.push(diagnostic)
        try { const resolved = Bun.resolveSync(row.specifier, from); diagnostic.matched = resolved === entry; diagnostic.resolvedEntry = path.relative(graphRoot, resolved) }
        catch (error) { diagnostic.error = String(error).slice(0, 1024) }
      }
    }
    const executable = path.join(root, 'readonly', 'bun.exe'), childOutput = path.join(root, 'child-output.txt')
    const launchEnv = { SystemRoot: process.env.SystemRoot!, WINDIR: process.env.WINDIR!, PATH: `${path.dirname(executable)};${process.env.SystemRoot}\\System32`,
      // CreateProcess constructs the profile namespace from this system path.
      // Chromium's AppContainer launcher also retains LOCALAPPDATA explicitly.
      LOCALAPPDATA: process.env.LOCALAPPDATA!, USERPROFILE: path.join(root, 'work'), HOME: path.join(root, 'work'),
      TEMP: path.join(root, 'work'), TMP: path.join(root, 'work') }
    if (officialShellMode) Object.assign(launchEnv, { TEST_WINDOWS_OFFICIAL_SHELL: '1', XDG_DATA_HOME: path.join(root, 'work', 'data'), XDG_CACHE_HOME: path.join(root, 'work', 'cache'), XDG_CONFIG_HOME: path.join(root, 'work', 'config'), XDG_STATE_HOME: path.join(root, 'work', 'state') })
    if (bundledOfficialShellMode) Object.assign(launchEnv, { TEST_WINDOWS_OFFICIAL_SHELL_BUNDLED: '1' })
    if (resolverPrimitiveMode) Object.assign(launchEnv, { TEST_WINDOWS_RESOLVER_PRIMITIVE: '1' })
    evidence.environmentPresence = Object.fromEntries(Object.entries(launchEnv).map(([key, value]) => [key, typeof value === 'string' && value.length > 0]))
    if (Object.values(launchEnv).some(value => typeof value !== 'string' || value.length === 0)) throw new Error('required native environment path missing')
    launch = native.launchWindowsContainer({ containerSid: container.address, executable,
      arguments: [path.join(root, 'readonly', 'opencode-v2-windows-boundary.ts'), 'child', root, pipeName], cwd: path.join(root, 'work'), outputPath: childOutput,
      env: launchEnv, onEnvironmentShape: shape => { evidence.environmentShape = shape } })
    evidence.pid = launch.pid; evidence.birthFiletime = launch.birthFiletime; evidence.assignedBeforeResume = true
    let bytes = ''
    const deadline = Date.now() + (officialShellMode ? 180000 : 45000)
    while (!bytes.includes('\n') && !launch.exited() && Date.now() < deadline) { bytes += pipe.read(); await pause(20) }
    if (!bytes.includes('\n')) {
      evidence.childExitCode = launch.exitCode()
      evidence.childOutput = await readFile(childOutput, 'utf8').catch(() => null)
      evidence.pipeError = await readFile(path.join(root, 'work', 'pipe-error.txt'), 'utf8').catch(() => null)
      throw new Error('native Bun/IPC probe did not report')
    }
    const report = JSON.parse(bytes.split('\n')[0]!) as { pid: number; baseUrl: string; attempts: Record<string, unknown> }
    evidence.report = report
    if (report.pid !== launch.pid) throw new Error('native PID mismatch')
    if (!resolverPrimitiveMode) {
    try { evidence.parentHttp = await (await fetch(report.baseUrl, { signal: AbortSignal.timeout(3000) })).text() } catch (error) { evidence.parentHttp = String(error) }
    try {
      evidence.httpBridgeCheckpoint = await httpCheckpoint.runCheckpointHost(pipe, pid => launch!.validatePeer(pid))
      const deadline = Date.now() + 3000
      while (Date.now() < deadline && await readFile(path.join(root, 'work', 'http-sse-cancelled.txt'), 'utf8').catch(() => '') !== 'cancelled') await pause(20)
      evidence.httpBridgeServerCancellation = await readFile(path.join(root, 'work', 'http-sse-cancelled.txt'), 'utf8').catch(() => '') === 'cancelled'
    } catch (error) { evidence.httpBridgeCheckpointError = String(error) }
    }
    evidence.activeWithDescendant = launch.active()
    launch.terminate()
    const retiredDeadline = Date.now() + 5000
    while ((launch.active() !== 0 || !launch.exited()) && Date.now() < retiredDeadline) await pause(20)
    evidence.activeAfterTerminate = launch.active(); evidence.processExited = launch.exited()
    if (officialShellMode) { await (await import('./windows-official-shell/fixture.ts')).verifyArtifacts(path.join(root, 'readonly'), officialArtifacts); evidence.officialArtifactsRetained = true }
    if (resolverPrimitiveMode) {
      await (await import('./windows-resolver-primitive/fixture.ts')).verifyPrimitiveArtifacts(path.join(root, 'readonly'), officialArtifacts)
      evidence.purpose = 'TEST-resolver-primitive'; evidence.fullTaskQualified = false
      evidence.resolverPrimitiveCompleted = report.attempts.resolverPrimitiveCompleted === true && evidence.activeAfterTerminate === 0 && evidence.processExited === true
      evidence.primitiveArtifactsRetained = true
    }
    evidence.hostStateRetained = await readFile(path.join(root, 'host-state', 'secret.txt'), 'utf8') === 'host-owned'
    evidence.protectedRetained = await readFile(path.join(root, 'work', 'protected', 'owner.json'), 'utf8') === 'host-owned'
    evidence.readOnlyRetained = await readFile(path.join(root, 'readonly', 'immutable.txt'), 'utf8') === 'host-owned'
    const critical = ['ownedWrite', 'outsideApprovedReadDenied', 'outsideApprovedWriteDenied', 'siblingListingDenied', 'hostStateWriteDenied', 'protectedWriteDenied', 'protectedRenameDenied', 'protectedDeleteDenied', 'readOnlyWriteDenied', 'runtimeInputWriteDenied', 'runtimeHelperWriteDenied', 'runtimeHttpModuleWriteDenied']
    evidence.filesystemPassed = critical.every(key => report.attempts[key] === true) && report.attempts.protectedAclEscapeError === 5 && report.attempts.protectedFileAclEscapeError === 5 && report.attempts.readOnlyAclEscapeError === 5 && report.attempts.runtimeInputAclEscapeError === 5 && report.attempts.runtimeHttpModuleAclEscapeError === 5 && evidence.hostStateRetained && evidence.protectedRetained && evidence.readOnlyRetained && evidence.trustedOwnerWrite
    evidence.jobPassed = Number(evidence.activeWithDescendant) >= 2 && report.attempts.nativeDescendantInheritedJob === true && report.attempts.nativeDescendantBunStarted === true && evidence.activeAfterTerminate === 0 && evidence.processExited && report.attempts.jobBreakawayContained === true
    evidence.dropInLoopbackPassed = evidence.parentHttp === 'native-http-ok'
    evidence.qualified = !resolverPrimitiveMode && evidence.filesystemPassed && evidence.jobPassed && evidence.dropInLoopbackPassed
  } catch (error) { evidence.error = String(error); evidence.qualified = false }
  finally {
    const cleanupErrors: string[] = []
    if (launch) {
      try {
        launch.terminate()
        const deadline = Date.now() + 5000
        while ((launch.active() !== 0 || !launch.exited()) && Date.now() < deadline) await pause(20)
        evidence.cleanupActiveProcesses = launch.active(); evidence.cleanupProcessExited = launch.exited()
        if (evidence.cleanupActiveProcesses !== 0 || !evidence.cleanupProcessExited) throw new Error('TEST native retirement uncertain')
      } catch (error) { cleanupErrors.push(String(error)) }
    }
    let heldHandlesClosed = !launch
    try { launch?.close(); heldHandlesClosed = true; evidence.cleanupHeldHandlesClosed = true } catch (error) { cleanupErrors.push(String(error)) }
    for (const dispose of [() => pipe?.close()]) {
      try { dispose() } catch (error) { cleanupErrors.push(String(error)) }
    }
    if (container && heldHandlesClosed && (!launch || (evidence.cleanupActiveProcesses === 0 && evidence.cleanupProcessExited === true))) {
      try {
        await runPowerShell(`
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.SecurityIdentifier]::new($env:TEST_CONTAINER_SID)
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::ReadAndExecute, [System.Security.AccessControl.InheritanceFlags]::None, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
if (Test-Path -LiteralPath $env:TEST_ANCESTOR_JOURNAL) {
  $paths = @(Get-Content -LiteralPath $env:TEST_ANCESTOR_JOURNAL -Raw | ConvertFrom-Json)
  foreach ($target in $paths) {
    $acl = Get-Acl -LiteralPath $target
    $acl.RemoveAccessRuleSpecific($rule)
    Set-Acl -LiteralPath $target -AclObject $acl
    $remaining = (Get-Acl -LiteralPath $target).Access | Where-Object { !$_.IsInherited -and $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq $sid.Value -and $_.InheritanceFlags -eq [System.Security.AccessControl.InheritanceFlags]::None -and $_.PropagationFlags -eq [System.Security.AccessControl.PropagationFlags]::None -and $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and [int]$_.FileSystemRights -eq 0x1200a9 }
    if ($remaining) { throw 'TEST ancestor ACE remained after removal' }
  }
}
`)
        evidence.ancestorOwnAcesRemoved = true
      } catch (error) { cleanupErrors.push(String(error)) }
    } else if (container) cleanupErrors.push('TEST ancestor grants retained: native retirement uncertain')
    try { container?.close() } catch (error) { cleanupErrors.push(String(error)) }
    if (cleanupErrors.length) { evidence.cleanupErrors = cleanupErrors; evidence.qualified = false }
    await writeFile(output, JSON.stringify(evidence, null, 2) + '\n')
    console.log(JSON.stringify(evidence, null, 2))
  }
  if (resolverPrimitiveMode ? evidence.resolverPrimitiveCompleted !== true || evidence.cleanupErrors !== undefined || evidence.primitiveArtifactsRetained !== true : !evidence.qualified) process.exitCode = 2
}
