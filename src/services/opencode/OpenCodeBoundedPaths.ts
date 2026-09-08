import type { OpenCodePreparedProfile } from './types.js'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { lstat } from 'node:fs/promises'

/** Serializable admission, carried by the private profile to every later auth participant.
 * Outputs are the authoritative stores, including on first read. Root seeds them before
 * preparation if needed; Owner never falls back to reopening a logical target/import.
 * Path validation is not mount custody. The caller retains the admitted filesystem view.
 */
export type OpenCodeBoundedExecutionPaths = Readonly<{
  format: 'agent-teams.opencode-bounded-paths/v1'
  nativeSubscriptionHomePath: string
  nativeExecutables: Readonly<{ cursor: string; kiro: string; path: readonly string[] }>
  authCoordinationOutputDirectory: string
  globalAuthPath: string
  selectedAuthPath: string
  immutableAuthPaths: readonly string[]
  authStores: readonly Readonly<{ logicalPath: string; outputPath: string }>[]
  localMcp: Readonly<{
    cwd: string
    home: string
    tmp: string
    claudeDir: string
    command: readonly string[]
    environment: Readonly<Record<string, string>>
  }>
}>

function check(ok: unknown): asserts ok { if (!ok) throw new Error('opencode_bounded_paths_rejected') }
function record(v: unknown, fields: string): asserts v is Record<string, unknown> {
  check(v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype)
  const keys = fields.split(',')
  check(Object.keys(v).length === keys.length && Object.keys(v).every(k => keys.includes(k)))
}
export function boundedAbsolute(v: unknown): asserts v is string {
  check(typeof v === 'string' && v.length > 1 && Buffer.byteLength(v) <= 4096 && !/[\0\r\n]/.test(v) && !/\{(?:file|env):/.test(v)
    && v.startsWith('/') && path.posix.normalize(v) === v && !v.endsWith('/'))
}
const contains = (a: string, b: string) => b === a || b.startsWith(a + '/')
const overlap = (a: string, b: string) => contains(a,b) || contains(b,a)
function strings(v: unknown, max: number): asserts v is string[] {
  check(Array.isArray(v) && v.length <= max)
  for (const s of v) check(typeof s === 'string' && s.length > 0 && s.length <= 4096 && !s.includes('\0') && !/\{(?:file|env):/.test(s))
  check(new Set(v).size === v.length)
}
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') { for (const child of Object.values(v)) freeze(child); Object.freeze(v) }
  return v
}
/** Strict domains; no unknown peers, aliases, or discovery fallback. */
export function validateOpenCodeBoundedPaths(value: unknown): OpenCodeBoundedExecutionPaths {
  record(value, 'format,nativeSubscriptionHomePath,nativeExecutables,authCoordinationOutputDirectory,globalAuthPath,selectedAuthPath,immutableAuthPaths,authStores,localMcp')
  check(value.format === 'agent-teams.opencode-bounded-paths/v1')
  for (const k of ['nativeSubscriptionHomePath','authCoordinationOutputDirectory','globalAuthPath','selectedAuthPath']) boundedAbsolute(value[k])
  record(value.nativeExecutables, 'cursor,kiro,path')
  boundedAbsolute(value.nativeExecutables.cursor); boundedAbsolute(value.nativeExecutables.kiro)
  check(value.nativeExecutables.cursor !== value.nativeExecutables.kiro)
  strings(value.nativeExecutables.path, 32); check(value.nativeExecutables.path.length > 0)
  value.nativeExecutables.path.forEach(p => { boundedAbsolute(p); check(!p.includes(':')) })
  strings(value.immutableAuthPaths, 32); value.immutableAuthPaths.forEach(boundedAbsolute)
  check(Array.isArray(value.authStores) && value.authStores.length >= 2 && value.authStores.length <= 128)
  const logical: string[] = [], outputs: string[] = []
  const global = value.globalAuthPath as string
  check(global.endsWith('/opencode/auth.json') && !global.includes('/opencode/profiles/'))
  const profiles = path.posix.join(path.posix.dirname(global), 'profiles')
  for (const s of value.authStores) {
    record(s, 'logicalPath,outputPath'); boundedAbsolute(s.logicalPath); boundedAbsolute(s.outputPath)
    check(s.logicalPath === global || (s.logicalPath.startsWith(profiles + '/')
      && /^[0-9a-f]{16}\/data\/opencode\/auth.json$/.test(s.logicalPath.slice(profiles.length + 1))))
    check(path.posix.basename(s.outputPath) === 'auth.json')
    check(s.logicalPath === value.selectedAuthPath ? s.outputPath === s.logicalPath : !contains(path.posix.dirname(global), s.outputPath))
    logical.push(s.logicalPath); outputs.push(s.outputPath)
  }
  check(new Set(logical).size === logical.length && logical.includes(global) && logical.includes(value.selectedAuthPath as string))
  check(value.selectedAuthPath !== global)
  const islands = [value.nativeSubscriptionHomePath as string, value.authCoordinationOutputDirectory as string, ...outputs.map(p => path.posix.dirname(p))]
  for (let i=0;i<islands.length;i++) for (let j=0;j<i;j++) check(!overlap(islands[i],islands[j]))
  for (const p of value.immutableAuthPaths) {
    check(!logical.includes(p)); for (const island of islands) check(!overlap(island,p))
  }
  for (const executable of [value.nativeExecutables.cursor,value.nativeExecutables.kiro,...value.nativeExecutables.path]) {
    for (const island of islands) check(!overlap(island,executable))
    check(!value.immutableAuthPaths.includes(executable))
  }
  const policy = value.localMcp
  record(policy,'cwd,home,tmp,claudeDir,command,environment')
  for (const k of ['cwd','home','tmp','claudeDir']) boundedAbsolute(policy[k])
  strings(policy.command, 64); check(policy.command.length >= 2); boundedAbsolute(policy.command[0]); boundedAbsolute(policy.command[1])
  check(policy.environment && typeof policy.environment === 'object' && !Array.isArray(policy.environment) && Object.getPrototypeOf(policy.environment) === Object.prototype)
  check(Object.keys(policy.environment).length <= 128)
  for (const [k,v] of Object.entries(policy.environment)) {
    check(/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string' && v.length <= 8192 && !v.includes('\0') && !/\{(?:file|env):/.test(v))
    check(!escapeEnvironmentKey(k) && localEnvironmentKeys.has(k))
  }
  for (const role of [policy.home,policy.tmp,policy.claudeDir]) for (const island of islands) check(!overlap(island,role as string))
  const roles: Record<string,unknown> = { HOME:policy.home, USERPROFILE:policy.home, TMPDIR:policy.tmp, TMP:policy.tmp, TEMP:policy.tmp, AGENT_TEAMS_MCP_CLAUDE_DIR:policy.claudeDir }
  for (const [k,v] of Object.entries(policy.environment)) {
    if (Object.hasOwn(roles,k)) check(v === roles[k])
    if (k.startsWith('XDG_')) { boundedAbsolute(v); check(contains(policy.home as string,v)) }
    if (k === 'AGENT_TEAMS_MCP_TRANSPORT') check(v === 'stdio')
    if (k === 'PATH') for (const p of (v as string).split(':')) { boundedAbsolute(p); for (const island of islands) check(!overlap(island,p)) }
  }
  for (const arg of policy.command) check(!/^(-[er]|--(eval|require|import|loader|experimental-loader|inspect|transport|host|port|endpoint)(=|$))/.test(arg))
  return freeze(structuredClone(value)) as unknown as OpenCodeBoundedExecutionPaths
}
export function resolveBoundedAuthPath(filePath: string, contract?: OpenCodeBoundedExecutionPaths, write = false): string {
  if (!contract) return filePath
  const c = validateOpenCodeBoundedPaths(contract)
  const store = c.authStores.find(s => s.logicalPath === filePath)
  if (store) return store.outputPath
  check(!write && c.immutableAuthPaths.includes(filePath))
  return filePath
}
export function boundedCoordinationDatabase(authPath: string, contract: OpenCodeBoundedExecutionPaths): string {
  const c = validateOpenCodeBoundedPaths(contract)
  check(c.authStores.some(s => s.logicalPath === authPath))
  return path.posix.join(c.authCoordinationOutputDirectory, createHash('sha256').update(c.globalAuthPath).digest('hex') + '.sqlite')
}
/** Verify current names before effects; Root must prevent substitutions after admission. */
export async function assertBoundedAuthObjects(contract: OpenCodeBoundedExecutionPaths): Promise<void> {
  const c = validateOpenCodeBoundedPaths(contract)
  const database = boundedCoordinationDatabase(c.globalAuthPath,c)
  const files = [...c.immutableAuthPaths,c.nativeExecutables.cursor,c.nativeExecutables.kiro,
    ...c.authStores.map(s=>s.outputPath),...[database,database+'-journal',database+'-wal',database+'-shm']]
  const directories = [...c.nativeExecutables.path,c.nativeSubscriptionHomePath,c.authCoordinationOutputDirectory,...c.authStores.map(s=>path.posix.dirname(s.outputPath))]
  const seenObjects = new Map<string,string>()
  for (const target of new Set([...files,...directories])) {
    let current = '/'
    for (const part of target.slice(1).split('/')) {
      current = path.posix.join(current, part)
      try {
        const s = await lstat(current)
        check(!s.isSymbolicLink() && (current === target && files.includes(target) ? s.isFile() && s.nlink === 1 : s.isDirectory()))
        if (current === target) {
          const identity = `${s.dev}:${s.ino}`
          check(!seenObjects.has(identity) || seenObjects.get(identity) === target)
          seenObjects.set(identity,target)
        }
      } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') break; throw e }
    }
  }
}
const localEnvironmentKeys = new Set(['PATH','HOME','USERPROFILE','TMPDIR','TMP','TEMP','AGENT_TEAMS_MCP_CLAUDE_DIR','LANG','LC_ALL','TZ','NODE_ENV','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','AGENT_TEAMS_MCP_TRANSPORT'])
const preparationSelectionKeys = new Set(['OPENCODE_CONFIG','OPENCODE_CONFIG_CONTENT',
  'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY','CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND',
  'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON','CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON'])
function escapeEnvironmentKey(key: string): boolean {
  return /^(NODE_OPTIONS|NODE_PATH|BUN_OPTIONS|LD_.*|DYLD_.*|PYTHON.*|RUBY.*|PERL.*|BASH_ENV|ENV|SHELLOPTS|CDPATH|GIT_.*|npm_config_.*|NPM_CONFIG_.*|.*PROXY|.*_PROXY|.*CA_BUNDLE|SSL_CERT_.*|NODE_EXTRA_CA_CERTS|CLAUDE_TEAM_CONTROL_URL|CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_.*|OPENCODE_.*)$/i.test(key)
}
export function validateBoundedPreparationEnvironment(env: NodeJS.ProcessEnv, c: OpenCodeBoundedExecutionPaths): void {
  for (const [k,v] of Object.entries(env)) if (v !== undefined) {
    check(typeof v === 'string' && v.length <= 768 * 1024 && !v.includes('\0'))
    // These config imports are parsed as data by the real preparer, then removed.
    if (preparationSelectionKeys.has(k)) continue
    check(!escapeEnvironmentKey(k) && (localEnvironmentKeys.has(k) || ['XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','CURSOR_ACP_HOME_DIR','CURSOR_AGENT_EXECUTABLE','CLAUDE_MULTIMODEL_DATA_HOME','CLAUDE_MULTIMODEL_CACHE_HOME'].includes(k)))
  }
  if (env.AGENT_TEAMS_MCP_TRANSPORT !== undefined) check(env.AGENT_TEAMS_MCP_TRANSPORT === 'stdio')
  if (env.CURSOR_ACP_HOME_DIR !== undefined) check(env.CURSOR_ACP_HOME_DIR === c.nativeSubscriptionHomePath)
  if (env.CURSOR_AGENT_EXECUTABLE !== undefined) check(env.CURSOR_AGENT_EXECUTABLE === c.nativeExecutables.cursor)
  if (env.XDG_STATE_HOME !== undefined) {
    boundedAbsolute(env.XDG_STATE_HOME)
    check(contains(c.nativeSubscriptionHomePath, env.XDG_STATE_HOME))
  }
}
/** Resolve the actual local layer before hashing. Exact admitted environment is an
 * allowlist of values, not a lossy identity projection. Relative path overrides
 * resolve against the admitted MCP cwd; data/cache are always Owner-authoritative.
 */
export function applyBoundedLocalMcp(managed: Record<string, unknown>, c: OpenCodeBoundedExecutionPaths, data: string, cache: string): void {
  const servers = managed.mcp as Record<string, Record<string, unknown>> | undefined
  for (const config of Object.values(servers ?? {})) {
    check(Object.keys(config).every(k=>['type','command','environment','enabled','timeout','cwd'].includes(k)))
    check(config.type === 'local' && JSON.stringify(config.command) === JSON.stringify(c.localMcp.command))
    check(config.cwd === undefined || (typeof config.cwd === 'string' && config.cwd.trim().length > 0 && path.posix.resolve(c.localMcp.cwd,config.cwd.trim()) === c.localMcp.cwd))
    const roles: Record<string,string> = { HOME:c.localMcp.home, USERPROFILE:c.localMcp.home,
      TMPDIR:c.localMcp.tmp, TMP:c.localMcp.tmp, TEMP:c.localMcp.tmp, AGENT_TEAMS_MCP_CLAUDE_DIR:c.localMcp.claudeDir }
    const authoritative = { CLAUDE_MULTIMODEL_DATA_HOME:data, CLAUDE_MULTIMODEL_CACHE_HOME:cache }
    const env = config.environment ?? {}
    check(env && typeof env === 'object' && !Array.isArray(env))
    for (const [key,v] of Object.entries(env)) {
      check(typeof v === 'string' && !/\{(?:file|env):/.test(v) && !escapeEnvironmentKey(key))
      if (Object.hasOwn(authoritative,key)) continue
      if (Object.hasOwn(roles,key)) check(v.trim().length && path.posix.resolve(c.localMcp.cwd,v.trim()) === roles[key])
      else check(Object.hasOwn(c.localMcp.environment,key) && c.localMcp.environment[key] === v)
    }
    config.cwd = c.localMcp.cwd
    config.environment = { ...c.localMcp.environment, ...roles, ...authoritative }
  }
}

/** Drop selection-only data so a descendant cannot reinterpret a resolver request. */
export function removeBoundedSelectionEnvironment(env: NodeJS.ProcessEnv): void {
  for (const key of preparationSelectionKeys) if (key !== 'OPENCODE_CONFIG_CONTENT') delete env[key]
}

/** Private restoration must not reintroduce selection, loader, or transport keys. */
export function validateBoundedRuntimeEnvironment(env: Record<string, unknown>, c: OpenCodeBoundedExecutionPaths): void {
  const generated = new Set(['XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME',
    'NPM_CONFIG_CACHE','PLAYWRIGHT_BROWSERS_PATH','PUPPETEER_CACHE_DIR','PIP_CACHE_DIR','UV_CACHE_DIR','npm_config_devdir',
    'CLAUDE_MULTIMODEL_DATA_HOME','CLAUDE_MULTIMODEL_CACHE_HOME','CURSOR_AGENT_EXECUTABLE','CURSOR_ACP_HOME_DIR',
    'OPENCODE_CONFIG_CONTENT','OPENCODE_DISABLE_CLAUDE_CODE','OPENCODE_DISABLE_AUTOUPDATE'])
  for (const k of Object.keys(env)) check(generated.has(k) || localEnvironmentKeys.has(k))
  if (env.AGENT_TEAMS_MCP_TRANSPORT !== undefined) check(env.AGENT_TEAMS_MCP_TRANSPORT === 'stdio')
  check(env.OPENCODE_DISABLE_CLAUDE_CODE === '1' && env.OPENCODE_DISABLE_AUTOUPDATE === '1')
  if (env.XDG_STATE_HOME !== undefined) {
    boundedAbsolute(env.XDG_STATE_HOME)
    check(contains(c.nativeSubscriptionHomePath,env.XDG_STATE_HOME))
  }
}

export function boundedPeerAuthPaths(c: OpenCodeBoundedExecutionPaths): string[] {
  return c.authStores.filter(s=>s.logicalPath !== c.globalAuthPath).map(s=>s.logicalPath).sort()
}
/** Logical peer directories may be hidden by the admitted view, but every visible
 * entry must be declared. Missing logical names never prune the physical stores.
 */
export function assertBoundedPeerEntries(entries: readonly {name: string; isDirectory(): boolean}[], c: OpenCodeBoundedExecutionPaths): void {
  const names = new Set(boundedPeerAuthPaths(c).map(p=>p.slice(path.posix.join(path.posix.dirname(c.globalAuthPath),'profiles').length+1).split('/')[0]))
  for (const entry of entries) check(entry.isDirectory() && names.has(entry.name))
}

export function boundedPathsIdentity(c: OpenCodeBoundedExecutionPaths): string {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',') + '}'
    const encoded = JSON.stringify(value)
    check(encoded !== undefined)
    return encoded
  }
  return createHash('sha256').update(canonical(validateOpenCodeBoundedPaths(c))).digest('hex')
}

/** Root Product integration dependency, UNMOUNTED in the default bounded route.
 * This live capability is never serialized into a profile. The profile argument
 * identifies an operation; it grants no authority. Before invoking operation,
 * Root must match the full retained profile and live generation, retain the exact
 * admitted mount/object/native executable identities, and verify currentness.
 * It must hold those protections through ALL awaited effects and cleanup, revoke
 * on abort/death/close, drain descendants before releasing custody, and reject
 * replay/post-close calls. Nested refresh/probe calls for the same generation
 * must be reentrant and keep the outer lifetime held; a non-reentrant callback
 * mutex would deadlock those real call paths. Sibling calls retain independent
 * ownership until settled. Failure must drain pending effects, not merely race
 * the operation promise and release its view. Authorized auth mutations require Root's same-view
 * currentness transition; no ambient preparation or silent generation replacement.
 * A snapshot check or a copied profile is not an implementation of this port.
 */
export interface OpenCodeBoundedProfileLifetime {
  withCurrentProfile<T>(profile: OpenCodePreparedProfile, operation: () => Promise<T>): Promise<T>
}
