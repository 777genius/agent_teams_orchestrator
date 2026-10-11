import assert from 'node:assert/strict'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { plugin } from 'bun'

export const payloadSha256 = '3825021267c5f51c506d473c037a020b0e06708fe38f260747274c07386b215a'
const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
const hook = 'globalThis.__WIN110'
const normalizedPath = (file: string): string => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)

// Exact release110 physical names, joined to immutable d64 source. No runtime
// discovery or general rewriting: every anchor must occur exactly once.
const edits = [
  ['catalog-catch', 'async loadModels(q){let K=!1;try{K=q.runtimeId==="opencode"&&await Sz7()}catch{return i4("runtime-unhealthy","Selected OpenCode identity is unavailable")}', `async loadModels(q){let K=!1;try{${hook}.stage("selected-path");K=q.runtimeId==="opencode"&&await Sz7()}catch(__error){${hook}.error("catalog-admission-catch",__error);return i4("runtime-unhealthy","Selected OpenCode identity is unavailable")}`],
  ['selected-path', 'async function YH6(q,K){q?.throwIfAborted();let _=rJA();', `async function YH6(q,K){${hook}.stage("selected-path");q?.throwIfAborted();let _=rJA();${hook}.selected(_);`],
  ['missing-selection-return', 'if(!_)return{path:null,policy:{generation:"unsupported",version:null},native:null,fingerprint:null};', `if(!_)return(${hook}.event("classification",{generation:"unsupported",versionMatches:!1,selectionMissing:!0}),{path:null,policy:{generation:"unsupported",version:null},native:null,fingerprint:null});`],
  ['realpath', 'K?.(),q?.throwIfAborted();let Y=await iJA(_);q?.throwIfAborted();let $=await MA(Y);', `K?.(),q?.throwIfAborted();${hook}.stage("realpath");let Y=await iJA(_);${hook}.selected(Y);q?.throwIfAborted();${hook}.stage("fingerprint");let $=await MA(Y);${hook}.selected(Y,$);`],
  ['private-roots-version', 'q?.throwIfAborted();let H=await Npq(),O=await ef3(Y,H,q);q?.throwIfAborted();let z=af3(O);', `q?.throwIfAborted();${hook}.stage("private-roots");let H=await Npq();${hook}.roots(H);${hook}.stage("owned-version");let O=await ef3(Y,H,q);${hook}.event("version-returned",{versionMatches:O==="1.19.0\\n"||O==="1.19.0\\r\\n"});q?.throwIfAborted();${hook}.stage("classification");let z=af3(O);${hook}.event("classification",{generation:z.generation,versionMatches:z.version==="1.19.0"});`],
  ['version-spawn', 'O.child=Y;let X=null,A=xp8({},(z6)=>{X=z6})', `O.child=Y;${hook}.event("version-spawn",{pid:Y.pid??null});let X=null,A=xp8({},(z6)=>{X=z6;${hook}.helper(z6)})`],
  ['acquisition-timeout', 'x=W+5000,C=setTimeout(R,5000);', `x=W+5000,C=setTimeout(()=>{${hook}.event("acquisition-timeout",{});R()},5000);`],
  ['version-error', 'Y.once("error",()=>{if(R(),!Y?.pid)M=!0}),', `Y.once("error",(__error)=>{if(R(),!Y?.pid)M=!0;${hook}.error("version-error",__error)}),`],
  ['existing-alive-check', 'if(A.alive(z6)==="gone")return!1;', `let __alive=A.alive(z6);${hook}.event("existing-alive-check",{pid:z6,state:__alive});if(__alive==="gone")return!1;`],
  ['version-exit', 'Y.once("exit",(z6)=>{M=!0,f=z6,j=!0});', `Y.once("exit",(z6)=>{${hook}.event("version-exit",{code:z6});M=!0,f=z6,j=!0});`],
  ['version-close', 'Y.once("close",()=>{if(Date.now()>=x)R();clearTimeout(C),P=!0,z6()})', `Y.once("close",()=>{let __late=Date.now()>=x;if(__late)R();clearTimeout(C),P=!0,${hook}.event("version-close",{late:__late}),z6()})`],
  ['initial-birth', 'if(w){let z6=await r(w);if(z6!==null)n.set(w,z6)}', `if(w){${hook}.event("birth-start",{pid:w});let z6=await r(w);${hook}.event("birth-result",{pid:w,birth:z6});if(z6!==null)n.set(w,z6)}`],
  ['owned-table', 'let z6=await K6(),_6=q6(z6),Y6=z6.filter((f6)=>!f6.retired),J6;for(let f6 of _6)', `let z6=await K6(),_6=q6(z6),Y6=z6.filter((f6)=>!f6.retired),J6;${hook}.members(_6,n,P);for(let f6 of _6)`],
  ['version-failure', '}catch(z6){if(!$)throw new Vpq(z6,X);throw z6}finally{clearTimeout(C)', `}catch(z6){${hook}.error("version-failure",z6,X,$);if(!$)throw new Vpq(z6,X);throw z6}finally{clearTimeout(C)`],
  ['helper-operation', 'let z=Date.now();try{return await huq($,H,O)}catch(J)', `let z=Date.now();${hook}.operation(Y,O);try{return await huq($,H,O)}catch(J)`],
  ['helper-spawn', 'function huq(q,K,_,Y=dYA){return new Promise(($,H)=>{let O=Y(q,K,{windowsHide:!0,stdio:["ignore","pipe","ignore"]}),z="",J,', `function huq(q,K,_,Y=dYA){return new Promise(($,H)=>{let O=Y(q,K,{windowsHide:!0,stdio:["ignore","pipe","ignore"]}),z="",J;${hook}.event("helper-spawn",{pid:O.pid??null,timeoutMs:_});O.once("exit",(__code)=>${hook}.event("helper-exit",{pid:O.pid??null,code:__code}));let `],
  ['helper-timeout', 'A=setTimeout(()=>X(Error("Native helper timed out")),_);', `A=setTimeout(()=>{${hook}.event("helper-timeout",{});X(Error("Native helper timed out"))},_);`],
  ['helper-close', 'O.once("close",(w)=>{if(clearTimeout(A),J||w!==0)H(J??Error(`Native helper exited ${w}`));else $(z)})', `O.once("close",(w)=>{${hook}.event("helper-close",{code:w});if(clearTimeout(A),J||w!==0)H(J??Error(\`Native helper exited \${w}\`));else $(z)})`],
] as const

export function observedPayload(source: string): { contents: string; anchors: { id: string; anchorSha256: string }[]; transformedSha256: string } {
  assert.equal(sha256(source), payloadSha256, 'Published payload SHA mismatch')
  let contents = source
  const anchors = edits.map(([id, before, after]) => {
    assert.equal(source.split(before).length - 1, 1, `Physical source anchor mismatch: ${id}`)
    assert.equal(contents.split(before).length - 1, 1, `Overlapping source anchor: ${id}`)
    contents = contents.replace(before, after)
    return { id, anchorSha256: sha256(before) }
  })
  // Parsing only. Never evaluate the observed release during preparation.
  new Bun.Transpiler({ loader: 'js' }).scan(contents)
  return { contents, anchors, transformedSha256: sha256(contents) }
}

type Fields = { [key: string]: string | number | boolean | null | unknown[] | Fields }
const categories = new Set(['identity_mismatch', 'selection_unavailable', 'cleanup_unknown', 'timeout', 'invalid_response'])
const codes = new Set(['ENOENT', 'EACCES', 'EPERM', 'ESRCH', 'EINVAL', 'EIO', 'EBUSY', 'ETIMEDOUT'])
function errorCategory(error: unknown): string {
  if (!(error instanceof Error)) return 'other'
  if (categories.has(error.message)) return error.message
  if (/^Native helper exited -?\d+$/.test(error.message)) return 'helper_nonzero'
  if (error.message === 'Native helper timed out') return 'helper_timeout'
  if (error.message === 'Native helper output exceeded limit') return 'helper_output_limit'
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return error.name
  const code = 'code' in error ? error.code : null
  return typeof code === 'string' && codes.has(code) ? code : 'other'
}
function finiteHelper(value: unknown): Fields | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (!['birth', 'tree'].includes(String(v.operation)) ||
      !['helper_timeout', 'helper_nonzero', 'helper_spawn_error', 'helper_output_limit', 'helper_error'].includes(String(v.reason)) ||
      !(v.exitCode === null || Number.isSafeInteger(v.exitCode)) || typeof v.elapsedMs !== 'number' || !Number.isFinite(v.elapsedMs)) return null
  return { operation: String(v.operation), reason: String(v.reason), exitCode: v.exitCode as number | null, elapsedMs: v.elapsedMs }
}

const physicalPath = process.env.TEST_VERSION_DIAGNOSTIC_PAYLOAD
if (physicalPath) {
  const trace = process.env.TEST_VERSION_DIAGNOSTIC_TRACE
  const fixtureRoot = process.env.TEST_VERSION_DIAGNOSTIC_ROOT
  const selectedWrapper = process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH
  assert(trace && fixtureRoot && selectedWrapper && [trace, fixtureRoot, physicalPath, selectedWrapper].every(path.isAbsolute))
  let count = 0
  const buffered: Fields[] = []
  process.once('exit', () => {
    if (count > 200) buffered.push({ at: Date.now(), pid: process.pid, event: 'trace-overflow', stage, operation })
    try { appendFileSync(trace, buffered.map(row => JSON.stringify(row)).join('\n') + '\n') }
    catch { /* missing trace fails the harness; never override runtime behavior */ }
  })
  let stage = 'preload'
  let operation = 'none'
  const event = (name: string, fields: Fields = {}): void => {
    // Receipt absence/overflow is a diagnostic failure, never a runtime override.
    if (name.startsWith('helper-') && stage !== 'owned-version') return
    if (++count > 200) return
    buffered.push({ at: Date.now(), pid: process.pid, event: name, stage, operation, ...fields })
  }
  const inside = (value: string): boolean => {
    const relative = path.relative(fixtureRoot, value)
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  }
  const observer = {
    event,
    stage(value: string): void { stage = value; event('stage', { value }) },
    selected(value: unknown, hash?: unknown): void {
      event('selection', { category: typeof value === 'string' && normalizedPath(value) === normalizedPath(selectedWrapper) ? 'matching-wrapper' : value === null ? 'missing' : 'other', sha256: typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash) ? hash : null })
    },
    roots(value: { root: string; env: NodeJS.ProcessEnv }): void {
      event('private-roots', { contained: inside(value.root), targetAbsent: value.env.OPENCODE_CONSOLE_WRAPPER_TARGET === undefined, preloadAbsent: value.env.BUN_OPTIONS === undefined,
        allRootsContained: ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'].every(key => typeof value.env[key] === 'string' && inside(value.env[key]!)) })
    },
    operation(value: string, timeoutMs: number): void { operation = value; event('helper-operation', { timeoutMs }) },
    helper(value: unknown): void { const finite = finiteHelper(value); if (finite) event('helper-failure', finite) },
    members(rows: { pid: number; ppid: number }[], births: Map<number, number>, closed: boolean): void {
      event('owned-table', { closed, group: rows.slice(0, 50).map(row => ({ pid: row.pid, ppid: row.ppid })), births: [...births].slice(0, 50), truncated: rows.length > 50 || births.size > 50 })
    },
    error(name: string, value: unknown, helper?: unknown, retired?: boolean): void {
      const error = value instanceof Error ? value : null
      const supplied = helper ?? (error && 'helperFailure' in error ? error.helperFailure : null)
      event(name, { category: errorCategory(value), cause: errorCategory(error?.cause), helperFailure: finiteHelper(supplied), retired: retired ?? null })
    },
  }
  Object.assign(globalThis, { __WIN110: observer })
  event('preload-loaded', { bunVersion: Bun.version, physicalProcess: normalizedPath(process.argv[1] ?? '') === normalizedPath(physicalPath) })
  plugin({ name: 'TEST-release110-catalog-admission-observation', setup(builder) {
    builder.onLoad({ filter: /[\\/]local-cli[\\/]cli\.js$/ }, ({ path: file }) => {
      assert.equal(normalizedPath(file), normalizedPath(physicalPath), 'Foreign physical payload refused')
      const observed = observedPayload(readFileSync(file, 'utf8'))
      event('payload-observed', { sourceSha256: payloadSha256, transformedSha256: observed.transformedSha256, anchorCount: observed.anchors.length })
      return { loader: 'js', contents: observed.contents }
    })
  } })
}
