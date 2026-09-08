import { validateBoundedRuntimeEnvironment, validateOpenCodeBoundedPaths, applyBoundedLocalMcp, type OpenCodeBoundedExecutionPaths } from './OpenCodeBoundedPaths.js'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import path from 'node:path'
import { buildManagedConfigFingerprint } from './OpenCodeManagedConfigFingerprint.js'
import type { OpenCodePreparedProfile } from './types.js'

export const PREPARED_PROFILE = 'agent-teams.opencode-prepared-profile/v1' as const
export const PREPARED_PROFILE_BINDING = 'agent-teams.opencode-prepared-profile-binding/v1' as const
export const PREPARED_PROFILE_MAXIMUM = 768 * 1024
export const PRIVATE_PROFILE_DOCUMENT_MAXIMUM = 1024 * 1024
export const PRIVATE_PROFILE_AUTH = 'agent-teams.hosted-control.opencode-server-auth/v2' as const
export const PROFILE_PATH_ENVIRONMENT = ['HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'NPM_CONFIG_CACHE', 'PLAYWRIGHT_BROWSERS_PATH', 'PUPPETEER_CACHE_DIR', 'PIP_CACHE_DIR', 'UV_CACHE_DIR', 'npm_config_devdir', 'CLAUDE_MULTIMODEL_DATA_HOME', 'CLAUDE_MULTIMODEL_CACHE_HOME'] as const
const FIELDS = 'format,projectPath,profileRootKey,profileRootPath,projectBehaviorFingerprint,behaviorSources,managedConfigJson,managedConfigFingerprint,homePath,tmpPath,xdgConfigHome,xdgDataHome,xdgCacheHome,managedAuthPath,sourceAuthPath,sourceAuthSources,sourceAuthFingerprint,managedAuthFingerprint,authState,runtimePathEnvironment'
export type PreparedProfileProjection = Pick<OpenCodePreparedProfile, 'projectPath' | 'profileRootKey' | 'profileRootPath' | 'projectBehaviorFingerprint' | 'behaviorSources' | 'managedConfigFingerprint' | 'homePath' | 'tmpPath' | 'xdgConfigHome' | 'xdgDataHome' | 'xdgCacheHome' | 'managedAuthPath' | 'sourceAuthPath' | 'sourceAuthFingerprint' | 'managedAuthFingerprint' | 'authState'> & {
  boundedPaths?: OpenCodeBoundedExecutionPaths
  boundedAuthSources?: { path: string; fingerprint: string | null }[]
  boundedRuntimeEnvironment?: Record<string, string>
  format: typeof PREPARED_PROFILE
  managedConfigJson: string
  sourceAuthSources: { path: string; fingerprint: string | null }[]
  runtimePathEnvironment: Record<typeof PROFILE_PATH_ENVIRONMENT[number], string>
}
export type PreparedProfileBinding = Readonly<{ format: typeof PREPARED_PROFILE_BINDING; publicationId: string; byteLength: number; hmacSha256: string }>
export type PreparedProfileBindingContext = Readonly<{ expectedHostSha256: string; ownerProcessStartToken: string; bootstrapDigest: string }>
function check(value: unknown): asserts value { if (!value) throw new Error('opencode_private_profile_rejected') }
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const hex = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
function exact(value: unknown, fields: string): asserts value is Record<string, unknown> {
  check(value && typeof value === 'object' && !Array.isArray(value))
  const keys = fields.split(','); check(Object.keys(value).length === keys.length && Object.keys(value).every(k => keys.includes(k)))
}
/** Private canonical JSON allows finite configuration numbers; public bootstrap canonical rules stay unchanged. */
export function canonicalPreparedProfile(value: unknown, depth = 0): string {
  check(depth <= 64)
  if (typeof value === 'string') check(Buffer.from(value).toString('utf8') === value)
  if (typeof value === 'number') check(Number.isFinite(value) && !Object.is(value, -0))
  if (Array.isArray(value)) {
    // Array.map skips holes: accepting them would silently change the input JSON.
    for (let index = 0; index < value.length; index++) check(Object.hasOwn(value, index))
    return `[${value.map(v => canonicalPreparedProfile(v, depth + 1)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    check(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    return `{${Object.keys(value).sort((a,b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(k => `${canonicalPreparedProfile(k, depth + 1)}:${canonicalPreparedProfile((value as Record<string, unknown>)[k], depth + 1)}`).join(',')}}`
  }
  check(value === null || ['string', 'boolean', 'number'].includes(typeof value))
  return JSON.stringify(value)
}
export function decodePrivateProfileJson(bytes: Buffer, maximum: number): unknown {
  try {
    check(bytes.length >= 2 && bytes.length <= maximum)
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
    check(canonicalPreparedProfile(value) === bytes.toString('utf8')); return value
  } catch { throw new Error('opencode_private_profile_rejected') }
}
function freezeProfile<T>(value: T): T {
  if (value && typeof value === 'object') { for (const v of Object.values(value)) freezeProfile(v); Object.freeze(value) }
  return value
}
function absolute(value: unknown): asserts value is string {
  check(typeof value === 'string' && Buffer.byteLength(value) <= 4096 && !value.includes('\0') && value.startsWith('/') && path.posix.normalize(value) === value && (value === '/' || !value.endsWith('/')))
}
export function decodePreparedProfile(bytes: Buffer): PreparedProfileProjection {
  try {
    const r = decodePrivateProfileJson(bytes, PREPARED_PROFILE_MAXIMUM)
    check(r && typeof r === 'object')
    const bounded = Object.hasOwn(r, 'boundedPaths')
    exact(r, FIELDS + (bounded ? ',boundedPaths,boundedAuthSources,boundedRuntimeEnvironment' : ''))
    check(r.format === PREPARED_PROFILE)
    for (const k of ['projectPath','profileRootPath','homePath','tmpPath','xdgConfigHome','xdgDataHome','xdgCacheHome','managedAuthPath']) absolute(r[k])
    check(r.profileRootKey === digest(r.projectPath as string).slice(0,16))
    for (const k of ['projectBehaviorFingerprint','managedConfigFingerprint']) check(hex(r[k]))
    for (const k of ['sourceAuthFingerprint','managedAuthFingerprint']) check(r[k] === null || hex(r[k]))
    check(typeof r.authState === 'string' && ['missing','ok','stale'].includes(r.authState))
    check(Array.isArray(r.behaviorSources) && r.behaviorSources.length <= 4096)
    for (const p of r.behaviorSources) check(typeof p === 'string' && p.length > 0 && Buffer.byteLength(p) <= 4096 && !p.includes('\0') && !p.startsWith('/') && !p.split('/').some(s => !s || s === '.' || s === '..'))
    check(new Set(r.behaviorSources).size === r.behaviorSources.length)
    check(JSON.stringify(r.behaviorSources) === JSON.stringify([...r.behaviorSources].sort()))
    check(Array.isArray(r.sourceAuthSources) && r.sourceAuthSources.length <= 32)
    const sources = r.sourceAuthSources.map(s => { exact(s, 'path,fingerprint'); absolute(s.path); check(s.fingerprint === null || hex(s.fingerprint)); return s as {path:string;fingerprint:string|null} })
    check(new Set(sources.map(s=>s.path)).size === sources.length)
    check(r.sourceAuthPath === (sources.findLast(s=>s.fingerprint)?.path ?? null))
    check(r.sourceAuthFingerprint === (sources.some(s=>s.fingerprint) ? digest(sources.filter(s=>s.fingerprint).map(s=>`${s.path}:${s.fingerprint}`).join('\n')) : null))
    check(typeof r.managedConfigJson === 'string')
    const config = JSON.parse(r.managedConfigJson); check(config && typeof config === 'object' && !Array.isArray(config))
    canonicalPreparedProfile(config)
    check(buildManagedConfigFingerprint(config) === r.managedConfigFingerprint)
    exact(r.runtimePathEnvironment, PROFILE_PATH_ENVIRONMENT.join(','))
    for (const p of Object.values(r.runtimePathEnvironment)) absolute(p)
    const env = r.runtimePathEnvironment
    for (const [key, field] of Object.entries({ HOME:'homePath', USERPROFILE:'homePath', TMPDIR:'tmpPath', TMP:'tmpPath', TEMP:'tmpPath', XDG_CONFIG_HOME:'xdgConfigHome', XDG_DATA_HOME:'xdgDataHome', XDG_CACHE_HOME:'xdgCacheHome' })) check(env[key] === r[field])
    check(r.profileRootPath === path.posix.join(env.CLAUDE_MULTIMODEL_DATA_HOME as string, 'opencode/profiles', r.profileRootKey as string))
    check(r.xdgCacheHome === path.posix.join(env.CLAUDE_MULTIMODEL_CACHE_HOME as string, 'opencode/shared-cache'))
    for (const [field, suffix] of Object.entries({homePath:'home',tmpPath:'tmp',xdgConfigHome:'config',xdgDataHome:'data'})) check(r[field] === path.posix.join(r.profileRootPath as string,suffix))
    check(r.managedAuthPath === path.posix.join(r.xdgDataHome as string, 'opencode/auth.json'))
    for (const [key, suffix] of Object.entries({NPM_CONFIG_CACHE:'npm',PLAYWRIGHT_BROWSERS_PATH:'tools/ms-playwright',PUPPETEER_CACHE_DIR:'tools/puppeteer',PIP_CACHE_DIR:'tools/pip',UV_CACHE_DIR:'tools/uv',npm_config_devdir:'tools/node-gyp'})) check(env[key] === path.posix.join(r.xdgCacheHome as string,suffix))
    if (bounded) {
      const c = validateOpenCodeBoundedPaths(r.boundedPaths)
      check(c.selectedAuthPath === r.managedAuthPath && c.globalAuthPath === path.posix.join(env.CLAUDE_MULTIMODEL_DATA_HOME as string,'opencode/auth.json'))
      check(c.localMcp.cwd === r.projectPath)
      check(canonicalPreparedProfile(c.immutableAuthPaths) === canonicalPreparedProfile(sources.map(s=>s.path)))
      check(Array.isArray(r.boundedAuthSources) && r.boundedAuthSources.length === c.authStores.length)
      for (let i=0;i<c.authStores.length;i++) {
        const source = r.boundedAuthSources[i]; exact(source,'path,fingerprint')
        check(source.path === c.authStores[i].outputPath && (source.fingerprint === null || hex(source.fingerprint)))
        if (source.path === r.managedAuthPath) check(source.fingerprint === r.managedAuthFingerprint)
      }
      check(r.boundedRuntimeEnvironment && typeof r.boundedRuntimeEnvironment === 'object' && !Array.isArray(r.boundedRuntimeEnvironment))
      const runtime = r.boundedRuntimeEnvironment as Record<string,unknown>
      check(Object.keys(runtime).length <= 256)
      validateBoundedRuntimeEnvironment(runtime,c)
      for (const [k,v] of Object.entries(runtime)) check(/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string' && v.length <= PREPARED_PROFILE_MAXIMUM && !v.includes('\0'))
      for (const [k,v] of Object.entries(env)) check(runtime[k] === v)
      check(runtime.OPENCODE_CONFIG_CONTENT === r.managedConfigJson)
      check(runtime.CURSOR_ACP_HOME_DIR === c.nativeSubscriptionHomePath)
      check(runtime.CURSOR_AGENT_EXECUTABLE === path.posix.join(r.profileRootPath as string,'native-subscription-cli-bin/cursor-agent'))
      check(runtime.PATH === [path.posix.join(r.profileRootPath as string,'native-subscription-cli-bin'),...c.nativeExecutables.path].join(':'))
      const effective = structuredClone(config)
      applyBoundedLocalMcp(effective,c,env.CLAUDE_MULTIMODEL_DATA_HOME as string,env.CLAUDE_MULTIMODEL_CACHE_HOME as string)
      check(canonicalPreparedProfile(effective) === canonicalPreparedProfile(config))
    }
    return freezeProfile(r as unknown as PreparedProfileProjection)
  } catch { throw new Error('opencode_private_profile_rejected') }
}
/** Copies the real returned configuration string, never reconstructs it from its fingerprint. */
export function projectPreparedProfile(profile: OpenCodePreparedProfile): PreparedProfileProjection {
  try {
    const managedConfigJson = profile.env.OPENCODE_CONFIG_CONTENT
    check(typeof managedConfigJson === 'string' && canonicalPreparedProfile(JSON.parse(managedConfigJson)) === canonicalPreparedProfile(profile.managedConfig))
    const projection: Record<string, unknown> = {}
    for (const key of FIELDS.split(',')) if (key in profile) projection[key] = profile[key as keyof OpenCodePreparedProfile]
    if (profile.boundedPaths) check(profile.globalAuthPath === profile.boundedPaths.globalAuthPath)
    if (profile.boundedPaths) Object.assign(projection, { boundedPaths: profile.boundedPaths, boundedAuthSources: profile.boundedAuthSources, boundedRuntimeEnvironment: Object.fromEntries(Object.entries(profile.env).filter(([,v])=>v !== undefined)) })
    Object.assign(projection, {format: PREPARED_PROFILE, managedConfigJson, runtimePathEnvironment: Object.fromEntries(PROFILE_PATH_ENVIRONMENT.map(k=>[k,profile.env[k]]))})
    const bytes = Buffer.from(canonicalPreparedProfile(projection))
    try { return decodePreparedProfile(bytes) } finally { bytes.fill(0) }
  } catch { throw new Error('opencode_private_profile_rejected') }
}
export function restorePreparedProfile(projection: PreparedProfileProjection): OpenCodePreparedProfile {
  let bytes: Buffer | undefined
  try {
    // This exported entry must not trust a caller's TypeScript assertion or expose
    // native JSON parser diagnostics containing private configuration bytes.
    bytes = Buffer.from(canonicalPreparedProfile(projection))
    const { format, managedConfigJson, runtimePathEnvironment, boundedRuntimeEnvironment, ...fields } = decodePreparedProfile(bytes)
    return { ...fields, ...(fields.boundedPaths ? { globalAuthPath: fields.boundedPaths.globalAuthPath } : {}), custody: 'supervisor', managedConfig: JSON.parse(managedConfigJson), env: { ...runtimePathEnvironment, ...boundedRuntimeEnvironment, OPENCODE_CONFIG_CONTENT: managedConfigJson } }
  } catch { throw new Error('opencode_private_profile_rejected') }
  finally { bytes?.fill(0) }
}
export function validatePreparedProfileBinding(value: unknown): PreparedProfileBinding {
  exact(value, 'format,publicationId,byteLength,hmacSha256')
  check(value.format === PREPARED_PROFILE_BINDING && hex(value.publicationId) && hex(value.hmacSha256) && Number.isSafeInteger(value.byteLength) && Number(value.byteLength) >= 2 && Number(value.byteLength) <= PREPARED_PROFILE_MAXIMUM)
  return value as unknown as PreparedProfileBinding
}
export function bindPreparedProfile(bytes: Buffer, publicationId: string, key: Uint8Array, context: PreparedProfileBindingContext): PreparedProfileBinding {
  exact(context, 'expectedHostSha256,ownerProcessStartToken,bootstrapDigest')
  check(hex(publicationId) && key.length === 32 && Object.values(context).every(hex))
  check(bytes.length <= PREPARED_PROFILE_MAXIMUM && bytes.length >= 2)
  const message = canonicalPreparedProfile({ publicationId, profileSha256: digest(bytes), ...context })
  return Object.freeze({format: PREPARED_PROFILE_BINDING, publicationId, byteLength: bytes.length, hmacSha256: createHmac('sha256',key).update(PREPARED_PROFILE_BINDING+'\0').update(message).digest('hex')})
}
export function verifyPreparedProfileBinding(bytes: Buffer, binding: PreparedProfileBinding, key: Uint8Array, context: PreparedProfileBindingContext): void {
  validatePreparedProfileBinding(binding)
  const wanted = bindPreparedProfile(bytes,binding.publicationId,key,context)
  check(wanted.byteLength === binding.byteLength && timingSafeEqual(Buffer.from(wanted.hmacSha256,'hex'),Buffer.from(binding.hmacSha256,'hex')))
}
/** One private retained publication; close wipes the owned bytes and drops its parsed reference. */
export function retainPreparedProfile(profile: OpenCodePreparedProfile) {
  let projection: PreparedProfileProjection | undefined = projectPreparedProfile(profile)
  const bytes = Buffer.from(canonicalPreparedProfile(projection)); const publicationId = randomBytes(32).toString('hex')
  let closed = false
  return Object.freeze({
    publicationId,
    transfer(key: Uint8Array, context: PreparedProfileBindingContext) {
      check(!closed && projection)
      return { preparedProfile: decodePreparedProfile(bytes), preparedProfileSha256: digest(bytes), publicationId, binding: bindPreparedProfile(bytes,publicationId,key,context) }
    },
    close() { if (closed) return; closed = true; bytes.fill(0); projection = undefined },
  })
}
