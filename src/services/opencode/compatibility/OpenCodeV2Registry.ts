import qualificationData from './opencode-v2-qualifications.json' with { type: 'json' }

/**
 * The single OpenCode V2 version policy. Recognition, the API dialect, the
 * staged package graph and launch admission all derive from this module.
 *
 * - Recognition is a range rule: any exact stable release >=2.0.0 <3.0.0.
 * - A graph is the official `@opencode/server` and `@opencode/client` release
 *   of that exact version, installed under version-derived aliases.
 * - Launch additionally requires a team-launch qualification record with
 *   evidence for the running platform (`opencode-v2-qualifications.json`).
 *   Recognition alone never admits a run.
 */
export const OPENCODE_V2_SUPPORTED_RANGE = Object.freeze({ minimum: '2.0.0', below: '3.0.0' } as const)

/** An exact recognized V2 release. Runtime values must pass `isOpenCodeV2Pin`. */
export type OpenCodeV2Pin = `2.${number}.${number}`
export type OpenCodeV2Dialect = `v2-${OpenCodeV2Pin}`
/** Wire family: only the first V2 release keeps the original HTTP surface. */
export type OpenCodeV2Wire = 'floor' | 'current'
/** The one release with the original 2.0.0 HTTP surface (health/server identity,
 * `continue`/`reply` fields, non-experimental instruction and MCP routes). Every
 * later release uses the current surface. Independent of the supported range. */
export const OPENCODE_V2_FLOOR_WIRE_VERSION = '2.0.0'
/** Platforms a qualification record can name, keyed like the release assets (`<platform>-<arch>`). */
export const OPENCODE_V2_RELEASE_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'] as const
export type OpenCodeV2ReleasePlatform = typeof OPENCODE_V2_RELEASE_PLATFORMS[number]
/** The only scope that admits a team launch. */
export const OPENCODE_V2_TEAM_LAUNCH_SCOPE = 'team-launch'
export type OpenCodeV2VersionStatus = 'recognized' | 'too_old' | 'too_new' | 'unsupported'
export type OpenCodeV2VersionClass =
  | Readonly<{ status: 'recognized'; version: OpenCodeV2Pin; dialect: OpenCodeV2Dialect }>
  | Readonly<{ status: Exclude<OpenCodeV2VersionStatus, 'recognized'>; version: string | null }>

type Release = readonly [number, number, number]
const RELEASE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/

function release(value: string): Release | null {
  const match = RELEASE.exec(value)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}
function compare(left: Release, right: Release): number {
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index]! - right[index]!
  return 0
}
const MINIMUM = release(OPENCODE_V2_SUPPORTED_RANGE.minimum)!
const BELOW = release(OPENCODE_V2_SUPPORTED_RANGE.below)!

/** Exact stable releases only: build metadata and prereleases are unsupported. */
export function classifyOpenCodeV2Version(value: unknown): OpenCodeV2VersionClass {
  if (typeof value !== 'string') return { status: 'unsupported', version: null }
  const parsed = release(value)
  if (!parsed) return { status: 'unsupported', version: null }
  if (compare(parsed, MINIMUM) < 0) return { status: 'too_old', version: value }
  if (compare(parsed, BELOW) >= 0) return { status: 'too_new', version: value }
  const version = value as OpenCodeV2Pin
  return { status: 'recognized', version, dialect: openCodeV2Dialect(version) }
}

export function isOpenCodeV2Pin(value: unknown): value is OpenCodeV2Pin {
  return classifyOpenCodeV2Version(value).status === 'recognized'
}
export function openCodeV2Dialect(version: OpenCodeV2Pin): OpenCodeV2Dialect {
  return `v2-${version}`
}
/** One identity check for every host/authority record that carries both values. */
export function isOpenCodeV2Identity(version: unknown, dialect: unknown): version is OpenCodeV2Pin {
  return isOpenCodeV2Pin(version) && dialect === openCodeV2Dialect(version)
}
export function openCodeV2Wire(version: OpenCodeV2Pin): OpenCodeV2Wire {
  return version === OPENCODE_V2_FLOOR_WIRE_VERSION ? 'floor' : 'current'
}

const GRAPH_ALIAS = /^@opencode\/(server|client)-v(.+)$/
/** Package aliases are derived from the version; there is no per-version table. */
export function openCodeV2GraphPackages(version: OpenCodeV2Pin): Readonly<{ server: string; client: string }> {
  return { server: `@opencode/server-v${version}`, client: `@opencode/client-v${version}` }
}
/** Inverse of `openCodeV2GraphPackages`; returns null for every other package name. */
export function parseOpenCodeV2GraphAlias(name: string): Readonly<{ kind: 'server' | 'client'; version: OpenCodeV2Pin }> | null {
  const match = GRAPH_ALIAS.exec(name)
  if (!match || !isOpenCodeV2Pin(match[2])) return null
  return { kind: match[1] as 'server' | 'client', version: match[2] }
}

/**
 * Versions staged by an install manifest: every server alias needs its client
 * alias and both must name the official package at that exact version. Build
 * staging and install-time isolation read the set from the manifest only.
 */
export function openCodeV2StagedVersions(dependencies: Readonly<Record<string, unknown>>): readonly OpenCodeV2Pin[] {
  const kinds = new Map<OpenCodeV2Pin, Set<string>>()
  for (const [name, specification] of Object.entries(dependencies)) {
    if (!name.startsWith('@opencode/server-v') && !name.startsWith('@opencode/client-v')) continue
    const alias = parseOpenCodeV2GraphAlias(name)
    if (!alias || specification !== `npm:@opencode/${alias.kind}@${alias.version}`) throw new Error(`opencode_v2_graph_alias_invalid: ${name}`)
    kinds.set(alias.version, (kinds.get(alias.version) ?? new Set()).add(alias.kind))
  }
  for (const [version, present] of kinds) if (present.size !== 2) throw new Error(`opencode_v2_graph_alias_incomplete: ${version}`)
  return [...kinds.keys()].sort((left, right) => compare(release(left)!, release(right)!))
}

export type OpenCodeV2QualificationEvidence = Readonly<{ kind: string; ref: string }>
export type OpenCodeV2Qualification = Readonly<{
  version: OpenCodeV2Pin; qualifiedAt: string; scope: string
  platforms: readonly OpenCodeV2ReleasePlatform[]; evidence: readonly OpenCodeV2QualificationEvidence[]
}>

function loadQualifications(value: unknown): ReadonlyMap<OpenCodeV2Pin, OpenCodeV2Qualification> {
  const invalid = () => { throw new Error('opencode_v2_qualification_data_invalid') }
  const row = (input: unknown): Record<string, unknown> =>
    input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : invalid()
  const text = (input: unknown): string => typeof input === 'string' && input.length > 0 && input.length <= 512 ? input : invalid()
  const document = row(value)
  if (document.schema !== 1 || !Array.isArray(document.versions)) invalid()
  const records = new Map<OpenCodeV2Pin, OpenCodeV2Qualification>()
  for (const entry of document.versions as unknown[]) {
    const record = row(entry)
    const version = record.version
    if (!isOpenCodeV2Pin(version) || records.has(version)) invalid()
    const qualifiedAt = text(record.qualifiedAt)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(qualifiedAt)) invalid()
    if (!Array.isArray(record.evidence) || record.evidence.length === 0) invalid()
    const evidence = (record.evidence as unknown[]).map(item => {
      const proof = row(item)
      return Object.freeze({ kind: text(proof.kind), ref: text(proof.ref) })
    })
    // A record names every platform its evidence covers; nothing is implied for the others.
    const platforms = record.platforms
    if (!Array.isArray(platforms) || platforms.length === 0 || new Set(platforms).size !== platforms.length ||
      !platforms.every(platform => (OPENCODE_V2_RELEASE_PLATFORMS as readonly unknown[]).includes(platform))) invalid()
    records.set(version as OpenCodeV2Pin, Object.freeze({ version: version as OpenCodeV2Pin, qualifiedAt,
      scope: text(record.scope), platforms: Object.freeze([...platforms as OpenCodeV2ReleasePlatform[]]),
      evidence: Object.freeze(evidence) }))
  }
  return records
}
const qualifications = loadQualifications(qualificationData)
const byVersion = (left: OpenCodeV2Pin, right: OpenCodeV2Pin) => compare(release(left)!, release(right)!)

export function openCodeV2Qualification(version: OpenCodeV2Pin): OpenCodeV2Qualification | null {
  return qualifications.get(version) ?? null
}
export function openCodeV2QualifiedVersions(): readonly OpenCodeV2Pin[] {
  return [...qualifications.keys()].sort(byVersion)
}
export function openCodeV2CurrentPlatform(): string {
  return `${process.platform}-${process.arch}`
}
/** Published with each runtime release; the desktop pins this exact contract in its runtime lock.
 * `qualified` lists, per release platform, the versions admitted for team launch there. */
export function openCodeV2ReleaseContract(): Readonly<{
  range: typeof OPENCODE_V2_SUPPORTED_RANGE; qualified: Readonly<Record<OpenCodeV2ReleasePlatform, readonly OpenCodeV2Pin[]>>
}> {
  const qualified = Object.fromEntries(OPENCODE_V2_RELEASE_PLATFORMS.map(platform => [platform,
    [...qualifications.values()].filter(record => record.scope === OPENCODE_V2_TEAM_LAUNCH_SCOPE &&
      record.platforms.includes(platform)).map(record => record.version).sort(byVersion)]))
  return { range: { ...OPENCODE_V2_SUPPORTED_RANGE }, qualified: qualified as Record<OpenCodeV2ReleasePlatform, OpenCodeV2Pin[]> }
}

// Defined by the build; source runs and tests deliver V2.
declare const OPENCODE_V2_DELIVERED: boolean | undefined
/** False only in a runtime released without OpenCode V2: its release contract qualifies nothing either. */
export function openCodeV2Delivered(): boolean {
  return typeof OPENCODE_V2_DELIVERED === 'undefined' || OPENCODE_V2_DELIVERED
}

export type OpenCodeV2LaunchRefusal = 'opencode_v2_version_out_of_range' | 'opencode_v2_version_unqualified'
/** Launch admission: in range and qualified for team launch on this platform. Returns the coded refusal, or null. */
export function openCodeV2LaunchRefusal(version: unknown, platform = openCodeV2CurrentPlatform()): OpenCodeV2LaunchRefusal | null {
  if (!isOpenCodeV2Pin(version)) return 'opencode_v2_version_out_of_range'
  if (!openCodeV2Delivered()) return 'opencode_v2_version_unqualified'
  const record = qualifications.get(version)
  return record && record.scope === OPENCODE_V2_TEAM_LAUNCH_SCOPE &&
    (record.platforms as readonly string[]).includes(platform) ? null : 'opencode_v2_version_unqualified'
}
export function assertOpenCodeV2Launchable(version: unknown): asserts version is OpenCodeV2Pin {
  const refusal = openCodeV2LaunchRefusal(version)
  if (refusal) throw new Error(refusal)
}
