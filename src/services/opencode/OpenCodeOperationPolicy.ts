import { createHash } from 'node:crypto'

import { canonicalizeOpenCodeProviderId } from './OpenCodeProviderIdentity.js'
import type {
  OpenCodePlanScopedProfileInput,
  OpenCodeScopedProfilePlanContract,
} from './types.js'

export const OPEN_CODE_OPERATION_POLICY_SCHEMA = 'opencode-operation-policy-v2' as const

export type OpenCodeOperationPurpose =
  | 'passive-status'
  | 'provider-catalog'
  | 'provider-connect'
  | 'execution-probe'
  | 'launch'
  | 'session-resume'
  | 'legacy-diagnostic'

export type OpenCodePluginProvenance = 'user' | 'project' | 'environment' | 'app-managed'

export type OpenCodePreservedPlugin = {
  spec: string
  provenance: Exclude<OpenCodePluginProvenance, 'app-managed'>
}

export type OpenCodePolicyPlugin = {
  spec: string
  packageName: string
  provenance: OpenCodePluginProvenance
}

export type OpenCodeOperationIdentityFingerprints = {
  project: string
  model: string
  policy: string
  plugin: string
  version: string
  config: string
  auth: string
  environment: string
  binary: string
  layout: string
}

export type OpenCodeOperationPolicyInput = {
  purpose: OpenCodeOperationPurpose
  providerId?: string | null
  preservedPlugins?: readonly OpenCodePreservedPlugin[]
  /** Redacted, caller-produced fingerprints only. Never pass credentials or tokens. */
  fingerprints: OpenCodeOperationIdentityFingerprints
}

export type OpenCodeOperationPolicy = {
  schema: typeof OPEN_CODE_OPERATION_POLICY_SCHEMA
  purpose: OpenCodeOperationPurpose
  profile: {
    prepared: boolean
    hostRequired: boolean
    isolation: 'none' | 'purpose-scoped' | 'process-scoped'
    hostLifetime: 'none' | 'temporary' | 'retained'
    mutationCapabilities: readonly (
      | 'profile'
      | 'host'
      | 'auth'
      | 'session'
      | 'plugin-cache'
    )[]
  }
  providerScope:
    | { kind: 'none' }
    | { kind: 'all' }
    | { kind: 'provider'; providerId: string }
  appMcp: 'disabled' | 'enabled'
  toolApproval: 'none' | 'auto'
  auth: 'none' | 'read-only' | 'synchronize' | 'connect'
  session: 'none' | 'temporary-always-cleaned' | 'retained'
  inventory: 'none' | 'selected-provider-only' | 'full'
  inventoryFallback: 'forbidden' | 'legacy-full'
  launchAuthorization: 'forbidden' | 'fresh-retained-host-exact-proof'
  plugins: readonly OpenCodePolicyPlugin[]
  identity: {
    canonicalInput: string
    operationKey: string
    profileKey: string | null
    pluginKey: string | null
    cacheKey: string | null
  }
}

const APP_MANAGED_PLUGIN_BY_PROVIDER: Readonly<Record<string, string>> = {
  kiro: 'opencode-kiro@0.4.0',
  'cursor-acp': '@rama_nigg/open-cursor@2.5.2',
}

function packageNameFromSpec(spec: string): string {
  const normalized = spec.trim().replace(/^npm:/, '')
  if (normalized.startsWith('@')) {
    const versionSeparator = normalized.indexOf('@', normalized.indexOf('/') + 1)
    return versionSeparator < 0 ? normalized : normalized.slice(0, versionSeparator)
  }
  const versionSeparator = normalized.indexOf('@')
  return versionSeparator < 0 ? normalized : normalized.slice(0, versionSeparator)
}

function exactRegistryPackageFromSpec(spec: string): { name: string; version: string } {
  // Deliberately exclude tags/ranges, aliases, URLs, git and local/workspace
  // protocols. Scoped planning accepts only a registry name plus exact semver.
  const match = spec.match(/^(@[^/@]+\/[^/@]+|[^@/]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/)
  if (!match) throw new Error('OpenCode scoped plugin requires an exact registry package version')
  return { name: match[1]!, version: match[2]! }
}

function packageNameFromSnapshotRoot(packageRoot: string): string | null {
  const marker = '/node_modules/'
  const suffix = packageRoot.includes(marker)
    ? packageRoot.slice(packageRoot.lastIndexOf(marker) + marker.length)
    : packageRoot
  if (/^@[^/]+\/[^/]+$/.test(suffix) || /^[^/@]+$/.test(suffix)) return suffix
  return null
}

function parentSnapshotPackageRoot(packageRoot: string): string | null {
  const marker = '/node_modules/'
  const index = packageRoot.lastIndexOf(marker)
  return index < 0 ? null : packageRoot.slice(0, index)
}

function dependencyResolutionCandidates(
  packageRoot: string,
  dependencyName: string,
  packageRoots: ReadonlySet<string>,
): string[] {
  const candidates: string[] = []
  // Resolve the bytes exactly as the executed package would: its own
  // node_modules first, then each hoisted ancestor, then the snapshot root.
  // This applies equally to peers because npm may auto-install a peer locally.
  let cursor: string | null = packageRoot
  while (cursor) {
    const candidate = `${cursor}/node_modules/${dependencyName}`
    if (packageRoots.has(candidate)) candidates.push(candidate)
    cursor = parentSnapshotPackageRoot(cursor)
  }
  if (packageRoots.has(dependencyName)) candidates.push(dependencyName)
  return Array.from(new Set(candidates))
}

function packageRootsFromImmutableTreeEntry(entryPath: string): string[] {
  const segments = entryPath.split('/')
  const roots: string[] = []
  let packageStart = 0
  while (packageStart < segments.length) {
    const first = segments[packageStart]
    if (!first || first === 'node_modules' || first === '.bin') {
      throw new Error('OpenCode scoped plugin dependency tree package path is invalid')
    }
    const packageEnd = first.startsWith('@') ? packageStart + 2 : packageStart + 1
    if (
      packageEnd > segments.length
      || (first.startsWith('@') && (!segments[packageStart + 1]
        || segments[packageStart + 1]!.startsWith('@')))
    ) throw new Error('OpenCode scoped plugin dependency tree package path is invalid')
    roots.push(segments.slice(0, packageEnd).join('/'))

    const nestedModules = segments.indexOf('node_modules', packageEnd)
    if (nestedModules < 0) break
    // node_modules/.bin contains command shims, not package roots. The shim
    // bytes remain fingerprinted, while their owning package is proven by the
    // enclosing manifest and dependency edge.
    if (segments[nestedModules + 1] === '.bin') break
    packageStart = nestedModules + 1
  }
  return roots
}

type ImmutableSemVer = {
  major: number
  minor: number
  patch: number
  prerelease: Array<number | string>
}

function parseImmutableSemVer(value: string): ImmutableSemVer | null {
  const match = value.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/)
  if (!match) return null
  const core = match.slice(1, 4).map(Number)
  if (core.some(part => !Number.isSafeInteger(part))) return null
  const prerelease = match[4]?.split('.').map(identifier => {
    if (/^\d+$/.test(identifier)) {
      if (identifier.length > 1 && identifier.startsWith('0')) return null
      const numeric = Number(identifier)
      return Number.isSafeInteger(numeric) ? numeric : null
    }
    return identifier
  }) ?? []
  if (prerelease.some(identifier => identifier === null)) return null
  return {
    major: core[0]!, minor: core[1]!, patch: core[2]!,
    prerelease: prerelease as Array<number | string>,
  }
}

function compareImmutableSemVer(left: ImmutableSemVer, right: ImmutableSemVer): number {
  for (const field of ['major', 'minor', 'patch'] as const) {
    if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length
      ? 0
      : left.prerelease.length === 0 ? 1 : -1
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index]
    const rightPart = right.prerelease[index]
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1
    }
    if (leftPart === rightPart) continue
    if (typeof leftPart === 'number' && typeof rightPart !== 'number') return -1
    if (typeof leftPart !== 'number' && typeof rightPart === 'number') return 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

function satisfiesImmutableDeclaration(versionValue: string, declaration: string): boolean {
  const version = parseImmutableSemVer(versionValue)
  if (!version) return false
  const wildcard = declaration.match(/^(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?\.x$/)
  if (wildcard) {
    return version.prerelease.length === 0
      && version.major === Number(wildcard[1])
      && (wildcard[2] === undefined || version.minor === Number(wildcard[2]))
  }
  const operator = declaration.startsWith('^') || declaration.startsWith('~')
    ? declaration[0]!
    : ''
  const minimum = parseImmutableSemVer(operator ? declaration.slice(1) : declaration)
  if (!minimum) return false
  if (!operator) return compareImmutableSemVer(version, minimum) === 0
  if (compareImmutableSemVer(version, minimum) < 0) return false
  // npm ranges exclude prereleases unless a comparator itself has a
  // prerelease with the exact same major/minor/patch tuple.
  if (version.prerelease.length > 0 && (
    minimum.prerelease.length === 0
    || version.major !== minimum.major
    || version.minor !== minimum.minor
    || version.patch !== minimum.patch
  )) return false
  const upper: ImmutableSemVer = operator === '~'
    ? { major: minimum.major, minor: minimum.minor + 1, patch: 0, prerelease: [] }
    : minimum.major > 0
      ? { major: minimum.major + 1, minor: 0, patch: 0, prerelease: [] }
      : minimum.minor > 0
        ? { major: 0, minor: minimum.minor + 1, patch: 0, prerelease: [] }
        : { major: 0, minor: 0, patch: minimum.patch + 1, prerelease: [] }
  return Number.isSafeInteger(upper.major)
    && Number.isSafeInteger(upper.minor)
    && Number.isSafeInteger(upper.patch)
    && compareImmutableSemVer(version, upper) < 0
}

function isSupportedImmutableDeclaration(declaration: string): boolean {
  if (/^(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?\.x$/.test(declaration)) return true
  const base = declaration.startsWith('^') || declaration.startsWith('~')
    ? declaration.slice(1)
    : declaration
  return parseImmutableSemVer(base) !== null
}

function assertCompletePluginPackageClosure(
  rootPackageName: string,
  treeBytes: ReadonlyMap<string, Buffer>,
): void {
  // Derive roots from every byte entry, not merely from manifests. Otherwise
  // an executable ghost directory can evade the closure check simply by
  // omitting package.json.
  const packageRoots = new Set<string>()
  for (const entryPath of treeBytes.keys()) {
    for (const packageRoot of packageRootsFromImmutableTreeEntry(entryPath)) {
      packageRoots.add(packageRoot)
    }
  }
  const manifests = new Map<string, Record<string, unknown>>()
  for (const [manifestPath, manifestBytes] of treeBytes) {
    if (!manifestPath.endsWith('/package.json')) continue
    const packageRoot = manifestPath.slice(0, -'/package.json'.length)
    const expectedName = packageNameFromSnapshotRoot(packageRoot)
    if (!expectedName) continue
    let manifest: Record<string, unknown>
    try {
      manifest = JSON.parse(manifestBytes.toString('utf8')) as Record<string, unknown>
    } catch {
      throw new Error('OpenCode scoped plugin dependency manifest is invalid')
    }
    if (
      manifest.name !== expectedName || typeof manifest.version !== 'string'
      || !parseImmutableSemVer(manifest.version)
      || manifests.has(packageRoot)
    ) throw new Error('OpenCode scoped plugin dependency manifest identity is incomplete')
    manifests.set(packageRoot, manifest)
  }

  for (const packageRoot of packageRoots) {
    if (!manifests.has(packageRoot)) {
      throw new Error('OpenCode scoped plugin dependency package manifest is unavailable')
    }
  }
  for (const packageRoot of manifests.keys()) {
    if (!packageRoots.has(packageRoot)) {
      throw new Error('OpenCode scoped plugin dependency manifest root is invalid')
    }
  }

  if (!manifests.has(rootPackageName)) {
    throw new Error('OpenCode scoped plugin package manifest is unavailable')
  }
  const reachable = new Set<string>()
  const pending = [rootPackageName]
  while (pending.length > 0) {
    const packageRoot = pending.pop()!
    if (reachable.has(packageRoot)) continue
    reachable.add(packageRoot)
    const manifest = manifests.get(packageRoot)!
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
      const dependencies = manifest[field]
      if (dependencies === undefined) continue
      if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
        throw new Error('OpenCode scoped plugin dependency declaration is invalid')
      }
      for (const [dependencyName, declaredSpec] of Object.entries(
        dependencies as Record<string, unknown>,
      )) {
        if (
          !packageNameFromSnapshotRoot(dependencyName) || typeof declaredSpec !== 'string'
          || !declaredSpec.trim()
          || /^(?:file:|link:|workspace:|git(?:\+|:)|https?:|github:|npm:)/i.test(declaredSpec.trim())
          || /^(?:latest|next|beta|alpha|canary)$/i.test(declaredSpec.trim())
        ) throw new Error('OpenCode scoped plugin dependency declaration is not immutable')
        const normalizedSpec = declaredSpec.trim()
        if (!isSupportedImmutableDeclaration(normalizedSpec)) {
          throw new Error('OpenCode scoped plugin dependency declaration is not immutable')
        }
        const candidates = dependencyResolutionCandidates(
          packageRoot, dependencyName, packageRoots,
        )
        if (candidates.length === 0) {
          throw new Error('OpenCode scoped plugin dependency closure is incomplete')
        }
        if (candidates.length !== 1) {
          throw new Error('OpenCode scoped plugin dependency resolution is ambiguous')
        }
        const resolvedVersion = manifests.get(candidates[0]!)!.version as string
        // Use the total npm-compatible checker for the narrow immutable
        // declaration grammar accepted above. In particular, caret
        // zero ranges and prerelease admission cannot be approximated with
        // major/minor comparisons (`^0.0.5` is exactly `<0.0.6`).
        if (!satisfiesImmutableDeclaration(resolvedVersion, normalizedSpec)) {
          throw new Error('OpenCode scoped plugin dependency resolution does not match its declaration')
        }
        pending.push(candidates[0]!)
      }
    }
  }
  if (reachable.size !== manifests.size) {
    throw new Error('OpenCode scoped plugin dependency closure contains an unbound package')
  }
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalizeJson(entry)]),
    )
  }
  return value
}

/** Deterministic JSON: object keys are sorted recursively; array order is significant. */
export function canonicalSerializeOpenCodePolicyIdentity(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value))
}

const CANONICAL_SHA256_RE = /^[a-f0-9]{64}$/

function planningFingerprint(value: unknown): string {
  return createHash('sha256')
    .update(canonicalSerializeOpenCodePolicyIdentity(value))
    .digest('hex')
}

/** Canonical redacted identity shared by scoped planning and durable hosts. */
export function deriveOpenCodeScopedHostKeyFromPlanDigest(planDigest: string): string {
  requireCanonicalPlanningDigest('plan digest', planDigest)
  return `opencode-host-v2:${planningFingerprint({
    schema: 'opencode-scoped-host-key-v1',
    planDigest,
  })}`
}

function requireCanonicalPlanningDigest(name: string, value: string): string {
  if (!CANONICAL_SHA256_RE.test(value)) {
    throw new Error(`OpenCode scoped planning requires canonical ${name} evidence`)
  }
  return value
}

function deepFreezeScopedPlan<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      deepFreezeScopedPlan(entry)
    }
    Object.freeze(value)
  }
  return value
}

/** Pure: no filesystem, environment, process, lock, network, or clock access. */
export function planScopedProfile(
  input: OpenCodePlanScopedProfileInput,
): OpenCodeScopedProfilePlanContract {
  if (!input || typeof input !== 'object' || !input.evidence) {
    throw new Error('OpenCode scoped planning evidence is required')
  }
  if (![
    'passive-status', 'provider-catalog', 'provider-connect', 'execution-probe',
    'launch', 'session-resume', 'legacy-diagnostic',
  ].includes(input.purpose)) {
    throw new Error(`Unsupported OpenCode operation purpose: ${String(input.purpose)}`)
  }
  if (input.purpose === 'passive-status' || input.purpose === 'legacy-diagnostic') {
    throw new Error(`OpenCode ${input.purpose} cannot plan a scoped profile`)
  }
  if (!input.runtimeInstanceId?.trim()) {
    throw new Error('OpenCode scoped profile requires runtimeInstanceId')
  }
  const providerId = input.providerId?.trim()
    ? canonicalizeOpenCodeProviderId(input.providerId)
    : null
  if (!providerId) throw new Error(`OpenCode operation ${input.purpose} requires a providerId`)
  const modelId = input.modelId?.trim() || null
  if (['execution-probe', 'launch', 'session-resume'].includes(input.purpose) && !modelId) {
    throw new Error(`OpenCode operation ${input.purpose} requires a modelId`)
  }
  const evidence = input.evidence
  if (!['official-provider-cli', 'managed-auth'].includes(evidence.nativeAccountIdentitySource)) {
    throw new Error('OpenCode scoped planning account evidence source is invalid')
  }
  if (providerId === 'kiro' && evidence.nativeAccountIdentitySource !== 'official-provider-cli') {
    throw new Error('OpenCode Kiro requires an official stable account identity')
  }
  const digests = {
    canonicalProjectPathFingerprint: requireCanonicalPlanningDigest(
      'canonical project path', evidence.canonicalProjectPathFingerprint,
    ),
    projectBehaviorFingerprint: requireCanonicalPlanningDigest(
      'project behavior', evidence.projectBehaviorFingerprint,
    ),
    providerEnvironmentFingerprint: requireCanonicalPlanningDigest(
      'provider environment', evidence.providerEnvironmentFingerprint,
    ),
    selectedAuthFingerprint: requireCanonicalPlanningDigest(
      'selected auth', evidence.selectedAuthFingerprint,
    ),
    binaryFingerprint: requireCanonicalPlanningDigest('binary', evidence.binaryFingerprint),
    configFingerprint: requireCanonicalPlanningDigest('config', evidence.configFingerprint),
    nativeAccountIdentityFingerprint: requireCanonicalPlanningDigest(
      'native account identity', evidence.nativeAccountIdentityFingerprint,
    ),
    nativeAccountIdentitySource: evidence.nativeAccountIdentitySource,
    nativeTargetExecutableFingerprint: requireCanonicalPlanningDigest(
      'native target executable', evidence.nativeTargetExecutableFingerprint,
    ),
    profileLayoutFingerprint: requireCanonicalPlanningDigest(
      'profile layout', evidence.profileLayoutFingerprint,
    ),
    automaticUserPluginFingerprint: requireCanonicalPlanningDigest(
      'automatic user plugin',
      evidence.automaticUserPluginFingerprint ?? planningFingerprint([]),
    ),
  }
  const plugins = evidence.plugins.map(plugin => {
    const spec = plugin.spec.trim()
    if (!spec || !/^sha256:[a-f0-9]{64}$/.test(plugin.resolvedIdentity.trim())) {
      throw new Error('OpenCode scoped plugin immutable identity is required')
    }
    if (!['user', 'project', 'environment', 'app-managed'].includes(plugin.provenance)) {
      throw new Error('OpenCode scoped plugin provenance is invalid')
    }
    const exactPackage = exactRegistryPackageFromSpec(spec)
    const seenTreePaths = new Set<string>()
    const treeBytes = new Map<string, Buffer>()
    const treeIdentity = plugin.immutableTreeEntries.map(entry => {
      const relativePath = entry.path.replaceAll('\\', '/')
      if (
        !relativePath || relativePath.startsWith('/') || relativePath.includes('../')
        || relativePath.includes('/./') || relativePath.endsWith('/..')
        || relativePath.split('/').some(part => part === '.git' || part === '.DS_Store')
        || seenTreePaths.has(relativePath)
        || ![0o400, 0o500].includes(entry.mode)
      ) throw new Error('OpenCode scoped plugin dependency tree path is invalid')
      seenTreePaths.add(relativePath)
      const bytes = Buffer.from(entry.bytesBase64, 'base64')
      if (bytes.toString('base64') !== entry.bytesBase64) {
        throw new Error('OpenCode scoped plugin dependency bytes are not canonical base64')
      }
      treeBytes.set(relativePath, bytes)
      return {
        path: relativePath,
        mode: entry.mode,
        fingerprint: createHash('sha256').update(bytes).digest('hex'),
      }
    }).sort((left, right) => left.path.localeCompare(right.path))
    if (treeIdentity.length === 0) {
      throw new Error('OpenCode scoped plugin dependency tree is unavailable')
    }
    requireCanonicalPlanningDigest('plugin dependency tree', plugin.dependencyTreeFingerprint)
    if (planningFingerprint(treeIdentity) !== plugin.dependencyTreeFingerprint) {
      throw new Error('OpenCode scoped plugin dependency tree fingerprint mismatch')
    }
    const packageName = exactPackage.name
    if (!treeIdentity.some(entry =>
      entry.path === `${packageName}/package.json` || entry.path.startsWith(`${packageName}/`)
    )) throw new Error('OpenCode scoped plugin package root is absent from its dependency tree')
    const rootManifestBytes = treeBytes.get(`${packageName}/package.json`)
    if (!rootManifestBytes) {
      throw new Error('OpenCode scoped plugin package manifest is unavailable')
    }
    let rootManifest: Record<string, unknown>
    try {
      rootManifest = JSON.parse(rootManifestBytes.toString('utf8')) as Record<string, unknown>
    } catch {
      throw new Error('OpenCode scoped plugin package manifest is invalid')
    }
    if (rootManifest.name !== packageName || rootManifest.version !== exactPackage.version) {
      throw new Error('OpenCode scoped plugin package manifest does not match its exact spec')
    }
    assertCompletePluginPackageClosure(packageName, treeBytes)
    const manifestFingerprint = createHash('sha256').update(rootManifestBytes).digest('hex')
    const packageIntegrity = `sha512-${createHash('sha512')
      .update(plugin.dependencyTreeFingerprint)
      .digest('base64')}`
    const lockBindingFingerprint = planningFingerprint({
      packageName,
      version: exactPackage.version,
      packageIntegrity,
      manifestFingerprint,
      dependencyTreeFingerprint: plugin.dependencyTreeFingerprint,
    })
    const independentlyResolvedIdentity = `sha256:${lockBindingFingerprint}`
    if (plugin.resolvedIdentity.trim() !== independentlyResolvedIdentity) {
      throw new Error('OpenCode scoped plugin resolution evidence mismatch')
    }
    return {
      spec,
      provenance: plugin.provenance,
      dependencyTreeFingerprint: plugin.dependencyTreeFingerprint,
      packageIntegrity,
      manifestFingerprint,
      lockBindingFingerprint,
      resolvedIdentity: plugin.resolvedIdentity.trim(),
      executionSpecifier: `file:./node_modules/${packageName}`,
    }
  })
  const selectedManagedPackage = providerId === 'kiro'
    ? 'opencode-kiro'
    : providerId === 'cursor-acp' ? '@rama_nigg/open-cursor' : null
  const unrelatedManagedPackages = new Set([
    'opencode-kiro', '@rama_nigg/open-cursor',
  ].filter(packageName => packageName !== selectedManagedPackage))
  const expectedManagedSpec = APP_MANAGED_PLUGIN_BY_PROVIDER[providerId]
  if (plugins.some(plugin =>
    plugin.provenance === 'app-managed' && plugin.spec !== expectedManagedSpec)) {
    throw new Error('OpenCode scoped app-managed plugin pin is invalid')
  }
  if (plugins.some(plugin =>
    plugin.provenance === 'app-managed'
    && unrelatedManagedPackages.has(packageNameFromSpec(plugin.spec)))) {
    throw new Error('OpenCode scoped plan contains an unrelated app-managed plugin')
  }
  if (
    selectedManagedPackage
    && !plugins.some(plugin => packageNameFromSpec(plugin.spec) === selectedManagedPackage)
  ) {
    throw new Error('OpenCode selected provider plugin immutable evidence is unavailable')
  }
  const pluginFingerprint = planningFingerprint(plugins)
  const accountFingerprint = planningFingerprint({
    providerId,
    identity: digests.nativeAccountIdentityFingerprint,
    auth: digests.selectedAuthFingerprint,
    environment: digests.providerEnvironmentFingerprint,
  })
  const common = {
    schema: 'opencode-scoped-profile-plan-v1' as const,
    purpose: input.purpose,
    providerId,
    modelId,
    ...digests,
    plugins,
    pluginFingerprint,
    accountFingerprint,
  }
  const cacheFingerprint = planningFingerprint(common)
  const profileFingerprint = planningFingerprint({ ...common, cacheFingerprint })
  const operationFingerprint = planningFingerprint({
    profileFingerprint, purpose: input.purpose, modelId,
  })
  const digest = planningFingerprint({
    ...common, cacheFingerprint, profileFingerprint, operationFingerprint,
  })
  return deepFreezeScopedPlan({
    ...common,
    cacheFingerprint,
    profileFingerprint,
    operationFingerprint,
    digest,
    expectedHostKey: deriveOpenCodeScopedHostKeyFromPlanDigest(digest),
  })
}

function identityKey(kind: 'operation' | 'profile' | 'plugin' | 'cache', value: unknown): string {
  const digest = createHash('sha256')
    .update(canonicalSerializeOpenCodePolicyIdentity(value))
    .digest('hex')
  return `${OPEN_CODE_OPERATION_POLICY_SCHEMA}:${kind}:${digest}`
}

function resolveProviderScope(
  purpose: OpenCodeOperationPurpose,
  providerId: string | null,
): OpenCodeOperationPolicy['providerScope'] {
  if (purpose === 'passive-status') return { kind: 'none' }
  if (purpose === 'legacy-diagnostic') return { kind: 'all' }
  if (!providerId) {
    throw new Error(`OpenCode operation ${purpose} requires a providerId`)
  }
  return { kind: 'provider', providerId }
}

function resolvePlugins(
  providerId: string | null,
  preservedPlugins: readonly OpenCodePreservedPlugin[],
): OpenCodePolicyPlugin[] {
  const plugins: OpenCodePolicyPlugin[] = preservedPlugins.map(plugin => ({
    spec: plugin.spec,
    packageName: packageNameFromSpec(plugin.spec),
    provenance: plugin.provenance,
  }))
  const managedSpec = providerId ? APP_MANAGED_PLUGIN_BY_PROVIDER[providerId] : undefined
  if (!managedSpec) return plugins

  const managedPackage = packageNameFromSpec(managedSpec)
  if (!plugins.some(plugin => plugin.packageName === managedPackage)) {
    plugins.push({
      spec: managedSpec,
      packageName: managedPackage,
      provenance: 'app-managed',
    })
  }
  return plugins
}

export function resolveOpenCodeOperationPolicy(
  input: OpenCodeOperationPolicyInput,
): OpenCodeOperationPolicy {
  const passive = input.purpose === 'passive-status'
  const providerId = input.providerId?.trim()
    ? canonicalizeOpenCodeProviderId(input.providerId)
    : null
  const providerScope = resolveProviderScope(input.purpose, providerId)
  const executionProbe = input.purpose === 'execution-probe'
  const launch = input.purpose === 'launch'
  const plugins = resolvePlugins(passive ? null : providerId, input.preservedPlugins ?? [])
  const sessionPurpose = input.purpose === 'launch' || input.purpose === 'session-resume'
  const mutationCapabilities: OpenCodeOperationPolicy['profile']['mutationCapabilities'] = passive
    ? []
    : input.purpose === 'provider-connect'
      ? ['profile', 'host', 'auth', 'plugin-cache']
      : sessionPurpose || executionProbe
        ? executionProbe
          ? ['profile', 'host', 'session', 'plugin-cache']
          : ['profile', 'host', 'auth', 'session', 'plugin-cache']
        : ['profile', 'host', 'plugin-cache']
  const identityInput = {
    schema: OPEN_CODE_OPERATION_POLICY_SCHEMA,
    purpose: input.purpose,
    provider: providerScope,
    plugins,
    fingerprints: input.fingerprints,
  }
  const canonicalInput = canonicalSerializeOpenCodePolicyIdentity(identityInput)

  return {
    schema: OPEN_CODE_OPERATION_POLICY_SCHEMA,
    purpose: input.purpose,
    profile: {
      prepared: !passive,
      hostRequired: !passive,
      isolation: passive ? 'none' : executionProbe ? 'process-scoped' : 'purpose-scoped',
      hostLifetime: passive ? 'none' : executionProbe ? 'temporary' : sessionPurpose ? 'retained' : 'temporary',
      mutationCapabilities,
    },
    providerScope,
    appMcp: sessionPurpose ? 'enabled' : 'disabled',
    toolApproval: sessionPurpose ? 'auto' : 'none',
    auth: passive
      ? 'none'
      : input.purpose === 'provider-connect'
        ? 'connect'
        : sessionPurpose
          ? 'synchronize'
          : 'read-only',
    session: executionProbe ? 'temporary-always-cleaned' : sessionPurpose ? 'retained' : 'none',
    inventory: input.purpose === 'provider-catalog'
      ? 'selected-provider-only'
      : input.purpose === 'legacy-diagnostic'
        ? 'full'
        : 'none',
    inventoryFallback: input.purpose === 'legacy-diagnostic' ? 'legacy-full' : 'forbidden',
    launchAuthorization: launch ? 'fresh-retained-host-exact-proof' : 'forbidden',
    plugins,
    identity: {
      canonicalInput,
      operationKey: identityKey('operation', identityInput),
      profileKey: passive ? null : identityKey('profile', identityInput),
      pluginKey: passive ? null : identityKey('plugin', identityInput),
      cacheKey: passive ? null : identityKey('cache', identityInput),
    },
  }
}
