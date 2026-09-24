import { createHash } from 'node:crypto'
import { dlopen, FFIType } from 'bun:ffi'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { isAbsolute, posix, resolve } from 'node:path'
import {
  HOSTED_ACTUAL_OWNER_BUILD_CLOSURE_SHA256,
  HOSTED_ACTUAL_OWNER_BUILD_DESCRIPTOR,
} from './hostedActualOwnerGeneratedIdentity'

const ENTRY_MODE = process.env.HOSTED_ACTUAL_OWNER_ENTRY_MODE
const COMPILED_BUILD_CLOSURE_SHA256 = HOSTED_ACTUAL_OWNER_BUILD_CLOSURE_SHA256
const COMPILED_BUILD_DESCRIPTOR = HOSTED_ACTUAL_OWNER_BUILD_DESCRIPTOR
const LAUNCH_DESCRIPTOR_PURPOSE =
  'agent-teams.hosted-actual-owner-acceptance.launch-descriptor/v1'
const BUILD_RECIPE_PURPOSE =
  'agent-teams.hosted-actual-owner-acceptance.build-recipe/v1'
const WRAPPER_RELATIVE_PATH = 'bin/hosted-actual-owner-acceptance'
const LAUNCHER_RELATIVE_PATH =
  /^dist\/local-cli(?:-dev)?\/hostedActualOwnerLauncher-[0-9a-f]{64}$/
const LAUNCHER_RECIPE_PATH =
  /^dist\/local-cli(?:-dev)?\/hostedActualOwnerLauncher-\{sha256\}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/
const SHA256 = /^[0-9a-f]{64}$/
const FULL_REF = /^[0-9a-f]{40}$/
const SEALED_OWNER_ARGV = Object.freeze(['--hosted-actual-owner-sealed-protocol=v1'])
const NATIVE_WRAPPER_COMPILER_ARGV = Object.freeze([
  '-static', '-O2', '-std=c11', '-Wall', '-Wextra', '-Werror', '-fno-ident',
  '-Wl,--build-id=none', '-s',
])
const COMMON_DEFINE_KEYS = Object.freeze([
  'MACRO.BUILD_TIME',
  'MACRO.FEEDBACK_CHANNEL',
  'MACRO.ISSUES_EXPLAINER',
  'MACRO.NATIVE_PACKAGE_URL',
  'MACRO.PACKAGE_URL',
  'MACRO.RUNTIME_VERSION',
  'MACRO.VERSION',
  'MACRO.VERSION_CHANGELOG',
  'process.env.CCR_FORCE_BUNDLE',
  'process.env.CLAUDE_CODE_FORCE_FULL_LOGO',
  'process.env.CLAUDE_CODE_VERIFY_PLAN',
  'process.env.USER_TYPE',
])
const F_GET_SEALS = 1034
const IMMUTABLE_SEALS = 0x000f

function consumeWrapperAuthoritySha256(): string {
  const value = process.env.HOSTED_ACTUAL_OWNER_WRAPPER_AUTHORITY_SHA256
  delete process.env.HOSTED_ACTUAL_OWNER_WRAPPER_AUTHORITY_SHA256
  if (!value || !SHA256.test(value)) launchFailure('wrapper_authority_invalid')
  return value
}

type PortableArtifactIdentity = Readonly<{
  relativePath: string
  size: string
  mode: string
  sha256: string
}>

type BunArtifactIdentity = Readonly<{
  path: string
  device: string
  inode: string
  size: string
  mtimeNs: string
  ctimeNs: string
  mode: string
  linkCount: string
  uid: string
  sha256: string
}>

type SourceInputIdentity = Readonly<{
  path: string
  size: string
  mode: string
  sha256: string
}>

type BuildRecipeIdentity = Readonly<{
  canonical: string
  sha256: string
}>

type LaunchDescriptor = Readonly<{
  schemaVersion: 1
  purpose: typeof LAUNCH_DESCRIPTOR_PURPOSE
  inputsSha256: string
  buildRecipe: BuildRecipeIdentity
  sourceAuthority: Readonly<{
    kind: 'git-commit'
    orchestratorRef: string
    inputsSha256: string
  }>
  buildInputs: Readonly<{
    sourceInputs: readonly SourceInputIdentity[]
    bun: BunArtifactIdentity
    nativeToolchain: Readonly<{
      compiler: BunArtifactIdentity
      programs: readonly BunArtifactIdentity[]
      headers: readonly BunArtifactIdentity[]
      staticLinkInputs: readonly BunArtifactIdentity[]
    }>
    wrapper: PortableArtifactIdentity
    inputsSha256: string
  }>
  wrapper: PortableArtifactIdentity & Readonly<{ role: 'invoked-trust-anchor' }>
  launcher: Readonly<{
    directoryRelativePath: string
    basenamePrefix: 'hostedActualOwnerLauncher-'
    role: 'content-addressed-runtime'
  }>
  closure: readonly string[]
  sourceInputs: readonly SourceInputIdentity[]
}>

function launchFailure(label: string): never {
  throw new Error(`hosted_actual_owner_launch_${label}`)
}

function exactObject(value: unknown, keys: readonly string[], label: string): object {
  if (!value || typeof value !== 'object' || Array.isArray(value)) launchFailure(`${label}_invalid`)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    launchFailure(`${label}_invalid`)
  }
  return value
}

function stringField(value: object, key: string, pattern: RegExp, label: string): string {
  const field = Reflect.get(value, key)
  if (typeof field !== 'string' || !pattern.test(field)) launchFailure(`${label}_invalid`)
  return field
}

function relativeField(value: object, key: string, label: string): string {
  const path = stringField(value, key, /^.+$/, label)
  if (path.includes('\0') || path.includes('\\') || posix.normalize(path) !== path ||
    path === '.' || path === '..' || path.startsWith('../') || path.startsWith('/')) {
    launchFailure(`${label}_invalid`)
  }
  return path
}

function portableArtifact(value: unknown, label: string): PortableArtifactIdentity {
  const input = exactObject(value, ['relativePath', 'size', 'mode', 'sha256'], label)
  return Object.freeze({
    relativePath: relativeField(input, 'relativePath', label),
    size: stringField(input, 'size', POSITIVE_DECIMAL, label),
    mode: stringField(input, 'mode', /^[0-7]{3}$/, label),
    sha256: stringField(input, 'sha256', SHA256, label),
  })
}

function fixedArtifact(value: unknown, label: string): BunArtifactIdentity {
  const input = exactObject(value, [
    'path', 'device', 'inode', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'linkCount', 'uid',
    'sha256',
  ], label)
  const path = stringField(input, 'path', /^.+$/, label)
  if (!isAbsolute(path) || resolve(path) !== path || path.includes('\0')) {
    launchFailure(`${label}_invalid`)
  }
  return Object.freeze({
    path,
    device: stringField(input, 'device', DECIMAL, label),
    inode: stringField(input, 'inode', POSITIVE_DECIMAL, label),
    size: stringField(input, 'size', POSITIVE_DECIMAL, label),
    mtimeNs: stringField(input, 'mtimeNs', DECIMAL, label),
    ctimeNs: stringField(input, 'ctimeNs', DECIMAL, label),
    mode: stringField(input, 'mode', /^[0-7]{3}$/, label),
    linkCount: stringField(input, 'linkCount', /^1$/, label),
    uid: stringField(input, 'uid', DECIMAL, label),
    sha256: stringField(input, 'sha256', SHA256, label),
  })
}

function bunArtifact(value: unknown): BunArtifactIdentity {
  return fixedArtifact(value, 'bun_identity')
}

function sourceInput(value: unknown): SourceInputIdentity {
  const input = exactObject(value, ['path', 'size', 'mode', 'sha256'], 'source_input')
  return Object.freeze({
    path: relativeField(input, 'path', 'source_input'),
    size: stringField(input, 'size', POSITIVE_DECIMAL, 'source_input'),
    mode: stringField(input, 'mode', /^[0-7]{3}$/, 'source_input'),
    sha256: stringField(input, 'sha256', SHA256, 'source_input'),
  })
}

function buildRecipe(value: unknown): BuildRecipeIdentity {
  const input = exactObject(value, ['canonical', 'sha256'], 'build_recipe')
  const canonical = stringField(input, 'canonical', /^.+$/, 'build_recipe')
  const sha256 = stringField(input, 'sha256', SHA256, 'build_recipe')
  if (createHash('sha256').update(canonical).digest('hex') !== sha256) {
    launchFailure('build_recipe_invalid')
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(canonical)
  } catch {
    launchFailure('build_recipe_invalid')
  }
  const recipe = exactObject(decoded, [
    'schemaVersion', 'purpose', 'invocation', 'mode', 'features', 'defines', 'platform',
    'bundler', 'environment',
  ], 'build_recipe')
  if (Reflect.get(recipe, 'schemaVersion') !== 1 ||
    Reflect.get(recipe, 'purpose') !== BUILD_RECIPE_PURPOSE) {
    launchFailure('build_recipe_invalid')
  }
  const invocation = Reflect.get(recipe, 'invocation')
  const mode = exactObject(Reflect.get(recipe, 'mode'), ['compile', 'development'], 'build_recipe')
  const features = Reflect.get(recipe, 'features')
  const platform = exactObject(
    Reflect.get(recipe, 'platform'),
    ['os', 'architecture', 'bunVersion', 'target', 'format'],
    'build_recipe',
  )
  const environment = Reflect.get(recipe, 'environment')
  const defines = exactObject(
    Reflect.get(recipe, 'defines'), ['common', 'owner'], 'build_recipe',
  )
  const bundler = exactObject(Reflect.get(recipe, 'bundler'), [
    'minify', 'packages', 'conditions', 'ownerEntrypoint', 'ownerExternal',
    'ownerGeneratedIdentity',
    'ownerCompile', 'ownerAutoloadDotenv', 'ownerAutoloadBunfig', 'ownerExecArgv',
    'sealedOwnerArgv', 'ownerRelativePath', 'nativeWrapperCompiler',
    'nativeWrapperCompilerArgs', 'nativeWrapperStatic', 'nativeWrapperBuildInputsSha256',
    'nativeWrapperClosureCapture', 'tsconfig',
  ], 'build_recipe')
  const development = Reflect.get(mode, 'development')
  const commonDefines = defineEntries(Reflect.get(defines, 'common'))
  const expectedCommonDefineKeys = [
    ...COMMON_DEFINE_KEYS,
    ...(development
      ? ['process.env.CLAUDE_CODE_EXPERIMENTAL_BUILD', 'process.env.NODE_ENV']
      : []),
  ].sort()
  const ownerDefines = defineEntries(Reflect.get(defines, 'owner'))
  const ownerGeneratedIdentity = exactObject(
    Reflect.get(bundler, 'ownerGeneratedIdentity'),
    ['path', 'format', 'embeddedFields', 'runtimeSidecar'],
    'build_recipe',
  )
  if (!Array.isArray(invocation) || invocation.length < 3 ||
    invocation.some(part => typeof part !== 'string') ||
    invocation[0] !== 'bun' || invocation[1] !== 'run' || invocation[2] !== 'scripts/build.ts' ||
    Reflect.get(mode, 'compile') !== false || typeof development !== 'boolean' ||
    !Array.isArray(features) || features.some(feature => typeof feature !== 'string') ||
    features.some((feature, index) => index > 0 && features[index - 1] >= feature) ||
    JSON.stringify(invocation) !== JSON.stringify([
      'bun', 'run', 'scripts/build.ts', ...(development ? ['--dev'] : []),
      ...features.map(feature => `--feature=${feature}`),
    ]) ||
    Reflect.get(platform, 'os') !== 'linux' || Reflect.get(platform, 'architecture') !== process.arch ||
    Reflect.get(platform, 'bunVersion') !== Bun.version || Reflect.get(platform, 'target') !== 'bun' ||
    Reflect.get(platform, 'format') !== 'esm' ||
    Reflect.get(bundler, 'minify') !== true || Reflect.get(bundler, 'packages') !== 'bundle' ||
    JSON.stringify(Reflect.get(bundler, 'conditions')) !== JSON.stringify(['bun']) ||
    Reflect.get(bundler, 'ownerEntrypoint') !==
      'src/entrypoints/hostedActualOwnerAcceptance.ts' ||
    Reflect.get(ownerGeneratedIdentity, 'path') !==
      'src/entrypoints/hostedActualOwnerGeneratedIdentity.ts' ||
    Reflect.get(ownerGeneratedIdentity, 'format') !==
      'deterministic-typescript-module' ||
    JSON.stringify(Reflect.get(ownerGeneratedIdentity, 'embeddedFields')) !==
      JSON.stringify(['buildClosureSha256', 'descriptorJson']) ||
    Reflect.get(ownerGeneratedIdentity, 'runtimeSidecar') !== false ||
    JSON.stringify(Reflect.get(bundler, 'ownerExternal')) !== JSON.stringify([]) ||
    Reflect.get(bundler, 'ownerCompile') !== true ||
    Reflect.get(bundler, 'ownerAutoloadDotenv') !== false ||
    Reflect.get(bundler, 'ownerAutoloadBunfig') !== false ||
    !Array.isArray(Reflect.get(bundler, 'ownerExecArgv')) ||
    Reflect.get(bundler, 'ownerExecArgv').length !== 0 ||
    JSON.stringify(Reflect.get(bundler, 'sealedOwnerArgv')) !==
      JSON.stringify(SEALED_OWNER_ARGV) ||
    typeof Reflect.get(bundler, 'ownerRelativePath') !== 'string' ||
    !LAUNCHER_RECIPE_PATH.test(Reflect.get(bundler, 'ownerRelativePath')) ||
    typeof Reflect.get(bundler, 'nativeWrapperCompiler') !== 'string' ||
    !isAbsolute(Reflect.get(bundler, 'nativeWrapperCompiler')) ||
    Reflect.get(bundler, 'tsconfig') !== 'tsconfig.json' ||
    typeof Reflect.get(bundler, 'nativeWrapperBuildInputsSha256') !== 'string' ||
    !SHA256.test(Reflect.get(bundler, 'nativeWrapperBuildInputsSha256')) ||
    JSON.stringify(Reflect.get(bundler, 'nativeWrapperCompilerArgs')) !==
      JSON.stringify(NATIVE_WRAPPER_COMPILER_ARGV) ||
    JSON.stringify(Reflect.get(bundler, 'nativeWrapperClosureCapture')) !== JSON.stringify({
      headers: ['-MD', '-MF'], staticLinkInputs: '-Wl,-Map=',
    }) ||
    Reflect.get(bundler, 'nativeWrapperStatic') !== true ||
    JSON.stringify(commonDefines.map(([key]) => key)) !==
      JSON.stringify(expectedCommonDefineKeys) ||
    JSON.stringify(ownerDefines) !== JSON.stringify([
      ['process.env.HOSTED_ACTUAL_OWNER_ENTRY_MODE', JSON.stringify('owner')],
    ]) ||
    JSON.stringify(environment) !== JSON.stringify([
      ['LANG', 'C'], ['LC_ALL', 'C'], ['PATH', '/usr/bin:/bin'], ['TZ', 'UTC'],
    ])) {
    launchFailure('build_recipe_invalid')
  }
  return Object.freeze({ canonical, sha256 })
}

function defineEntries(value: unknown): readonly (readonly [string, string])[] {
  if (!Array.isArray(value)) launchFailure('build_recipe_invalid')
  const entries: (readonly [string, string])[] = []
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 ||
      typeof entry[0] !== 'string' || typeof entry[1] !== 'string') {
      launchFailure('build_recipe_invalid')
    }
    entries.push(frozenDefineEntry(entry[0], entry[1]))
  }
  if (entries.some((entry, index) => index > 0 && entries[index - 1]![0] >= entry[0])) {
    launchFailure('build_recipe_invalid')
  }
  return Object.freeze(entries)
}

function frozenDefineEntry(key: string, value: string): readonly [string, string] {
  return Object.freeze([key, value])
}

function buildRecipeLauncherPath(identity: BuildRecipeIdentity, sha256: string): string {
  const recipe = JSON.parse(identity.canonical) as { bundler?: unknown }
  const bundler = recipe.bundler
  if (!bundler || typeof bundler !== 'object' || Array.isArray(bundler)) {
    launchFailure('build_recipe_invalid')
  }
  const path = Reflect.get(bundler, 'ownerRelativePath')
  if (typeof path !== 'string' || !LAUNCHER_RECIPE_PATH.test(path)) {
    launchFailure('build_recipe_invalid')
  }
  return path.replace('{sha256}', sha256)
}

function parseLaunchDescriptor(text: string | undefined): LaunchDescriptor {
  if (!text) launchFailure('descriptor_missing')
  let decoded: unknown
  try {
    decoded = JSON.parse(text)
  } catch {
    launchFailure('descriptor_invalid')
  }
  const input = exactObject(decoded, [
    'schemaVersion', 'purpose', 'inputsSha256', 'buildRecipe', 'sourceAuthority',
    'buildInputs', 'wrapper', 'launcher', 'closure', 'sourceInputs',
  ], 'descriptor')
  if (Reflect.get(input, 'schemaVersion') !== 1 ||
    Reflect.get(input, 'purpose') !== LAUNCH_DESCRIPTOR_PURPOSE) {
    launchFailure('descriptor_invalid')
  }
  const authorityInput = exactObject(
    Reflect.get(input, 'sourceAuthority'),
    ['kind', 'orchestratorRef', 'inputsSha256'],
    'source_authority',
  )
  const kind = Reflect.get(authorityInput, 'kind')
  if (kind !== 'git-commit') {
    launchFailure('source_authority_invalid')
  }
  const sourceAuthority = Object.freeze({
    kind,
    orchestratorRef: stringField(authorityInput, 'orchestratorRef', FULL_REF, 'source_authority'),
    inputsSha256: stringField(authorityInput, 'inputsSha256', SHA256, 'source_authority'),
  })
  const validatedBuildRecipe = buildRecipe(Reflect.get(input, 'buildRecipe'))
  const wrapperInput = exactObject(Reflect.get(input, 'wrapper'), [
    'relativePath', 'size', 'mode', 'sha256', 'role',
  ], 'wrapper_identity')
  const wrapperArtifact = portableArtifact({
    relativePath: Reflect.get(wrapperInput, 'relativePath'),
    size: Reflect.get(wrapperInput, 'size'),
    mode: Reflect.get(wrapperInput, 'mode'),
    sha256: Reflect.get(wrapperInput, 'sha256'),
  }, 'wrapper_identity')
  const wrapper = Object.freeze({
    ...wrapperArtifact,
    role: Reflect.get(wrapperInput, 'role'),
  })
  if (wrapper.relativePath !== WRAPPER_RELATIVE_PATH ||
    wrapper.role !== 'invoked-trust-anchor') {
    launchFailure('wrapper_invalid')
  }
  if (wrapper.mode !== '555') launchFailure('wrapper_invalid')
  const launcherInput = exactObject(Reflect.get(input, 'launcher'), [
    'directoryRelativePath', 'basenamePrefix', 'role',
  ], 'launcher_identity')
  const launcher = Object.freeze({
    directoryRelativePath: relativeField(
      launcherInput, 'directoryRelativePath', 'launcher_identity',
    ),
    basenamePrefix: Reflect.get(launcherInput, 'basenamePrefix'),
    role: Reflect.get(launcherInput, 'role'),
  })
  if (!/^dist\/local-cli(?:-dev)?$/.test(launcher.directoryRelativePath) ||
    launcher.basenamePrefix !== 'hostedActualOwnerLauncher-' ||
    launcher.role !== 'content-addressed-runtime') {
    launchFailure('launcher_invalid')
  }
  const sourceInputsValue = Reflect.get(input, 'sourceInputs')
  if (!Array.isArray(sourceInputsValue) || sourceInputsValue.length < 4) {
    launchFailure('source_inputs_invalid')
  }
  const sourceInputs = Object.freeze(sourceInputsValue.map(sourceInput))
  if (sourceInputs.some((entry, index) => index > 0 &&
    sourceInputs[index - 1]!.path >= entry.path)) {
    launchFailure('source_inputs_invalid')
  }
  const canonicalInputs = JSON.stringify(sourceInputs)
  if (createHash('sha256').update(canonicalInputs).digest('hex') !==
    sourceAuthority.inputsSha256) {
    launchFailure('source_authority_invalid')
  }
  const buildInputsInput = exactObject(
    Reflect.get(input, 'buildInputs'),
    ['sourceInputs', 'bun', 'nativeToolchain', 'wrapper', 'inputsSha256'], 'build_inputs',
  )
  const toolchainInput = exactObject(
    Reflect.get(buildInputsInput, 'nativeToolchain'),
    ['compiler', 'programs', 'headers', 'staticLinkInputs'], 'native_toolchain',
  )
  const fixedList = (key: string) => {
    const value = Reflect.get(toolchainInput, key)
    if (!Array.isArray(value) || value.length === 0) launchFailure('native_toolchain_invalid')
    const entries = Object.freeze(value.map(item => fixedArtifact(item, 'toolchain_identity')))
    if (entries.some((entry, index) => index > 0 && entries[index - 1]!.path >= entry.path)) {
      launchFailure('native_toolchain_invalid')
    }
    return entries
  }
  const buildInputSourcesValue = Reflect.get(buildInputsInput, 'sourceInputs')
  if (!Array.isArray(buildInputSourcesValue)) launchFailure('build_inputs_invalid')
  const buildInputSources = Object.freeze(buildInputSourcesValue.map(sourceInput))
  const buildInputBun = bunArtifact(Reflect.get(buildInputsInput, 'bun'))
  const buildInputWrapper = portableArtifact(
    Reflect.get(buildInputsInput, 'wrapper'), 'wrapper_identity',
  )
  const nativeToolchain = Object.freeze({
    compiler: fixedArtifact(Reflect.get(toolchainInput, 'compiler'), 'compiler_identity'),
    programs: fixedList('programs'),
    headers: fixedList('headers'),
    staticLinkInputs: fixedList('staticLinkInputs'),
  })
  const buildInputsSha256 = stringField(
    buildInputsInput, 'inputsSha256', SHA256, 'build_inputs',
  )
  const buildInputs = Object.freeze({
    sourceInputs: buildInputSources, bun: buildInputBun, nativeToolchain,
    wrapper: buildInputWrapper,
    inputsSha256: buildInputsSha256,
  })
  const buildClosureSha256 = createHash('sha256').update(JSON.stringify({
    buildInputs,
    buildRecipe: validatedBuildRecipe,
    sourceAuthority,
  })).digest('hex')
  if (COMPILED_BUILD_CLOSURE_SHA256 !== buildClosureSha256) {
    launchFailure('compiled_build_closure_mismatch')
  }
  if (JSON.stringify(buildInputSources) !== JSON.stringify(sourceInputs) ||
    JSON.stringify(buildInputWrapper) !== JSON.stringify(wrapperArtifact) ||
    createHash('sha256').update(JSON.stringify({
      sourceInputs: buildInputSources, bun: buildInputBun, nativeToolchain,
      wrapper: buildInputWrapper,
    })).digest('hex') !== buildInputsSha256 ||
    Reflect.get(input, 'inputsSha256') !== buildClosureSha256) {
    launchFailure('build_inputs_invalid')
  }
  const recipeObject = JSON.parse(validatedBuildRecipe.canonical) as { bundler?: object }
  if (Reflect.get(recipeObject.bundler!, 'nativeWrapperBuildInputsSha256') !== buildInputsSha256) {
    launchFailure('build_inputs_invalid')
  }
  const closure = Reflect.get(input, 'closure')
  const expectedClosure = [launcher.directoryRelativePath, wrapper.relativePath].sort()
  if (!Array.isArray(closure) || closure.length !== expectedClosure.length ||
    closure.some((path, index) => path !== expectedClosure[index])) {
    launchFailure('closure_invalid')
  }
  return Object.freeze({
    schemaVersion: 1,
    purpose: LAUNCH_DESCRIPTOR_PURPOSE,
    inputsSha256: buildClosureSha256,
    buildRecipe: validatedBuildRecipe,
    sourceAuthority,
    buildInputs,
    wrapper,
    launcher,
    closure: Object.freeze([...expectedClosure]),
    sourceInputs,
  })
}

function safeMode(mode: bigint): boolean {
  return (mode & 0o022n) === 0n
}

function sameOpenFile(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode && left.nlink === right.nlink && left.uid === right.uid
}

function openMemfdLibrary() {
  if (process.arch !== 'x64') launchFailure('platform_unsupported')
  const libcPath = '/usr/lib/x86_64-linux-gnu/libc.so.6'
  if (realpathSync(libcPath) !== libcPath) launchFailure('snapshot_unsupported')
  const stat = lstatSync(libcPath, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0n || !safeMode(stat.mode)) {
    launchFailure('snapshot_unsupported')
  }
  return dlopen(libcPath, {
    fcntl: {
      args: [FFIType.i32, FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
  })
}

let memfdLibrary: ReturnType<typeof openMemfdLibrary> | undefined

function verifyLauncherExecutionSnapshot(expected: PortableArtifactIdentity): void {
  const fd = openSync('/proc/self/exe', constants.O_RDONLY)
  try {
    const before = fstatSync(fd, { bigint: true })
    const bytes = readFileSync(fd)
    const after = fstatSync(fd, { bigint: true })
    memfdLibrary ??= openMemfdLibrary()
    const seals = memfdLibrary.symbols.fcntl(fd, F_GET_SEALS, 0)
    if (!before.isFile() || before.nlink !== 0n || !safeMode(before.mode) ||
      (process.getuid?.() !== undefined && before.uid !== BigInt(process.getuid())) ||
      !sameOpenFile(before, after) || after.size.toString() !== expected.size ||
      (after.mode & 0o777n).toString(8).padStart(3, '0') !== expected.mode ||
      seals !== IMMUTABLE_SEALS ||
      createHash('sha256').update(bytes).digest('hex') !== expected.sha256) {
      launchFailure('launcher_replaced')
    }
  } finally {
    closeSync(fd)
  }
}

function installedArtifact(path: string, relativePath: string, label: string): PortableArtifactIdentity {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd, { bigint: true })
    const bytes = readFileSync(fd)
    const after = fstatSync(fd, { bigint: true })
    if (!before.isFile() || before.nlink !== 1n || !sameOpenFile(before, after) ||
      (process.getuid?.() !== undefined && before.uid !== BigInt(process.getuid())) ||
      (before.mode & 0o777n) !== 0o555n || BigInt(bytes.byteLength) !== before.size) {
      launchFailure(`${label}_replaced`)
    }
    return Object.freeze({
      relativePath,
      size: before.size.toString(),
      mode: '555',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  } finally {
    closeSync(fd)
  }
}

function verifyRunningLauncher(descriptor: LaunchDescriptor): Readonly<{
  closureRoot: string
  launcher: PortableArtifactIdentity
}> {
  const closureRoot = process.env.HOSTED_ACTUAL_OWNER_CLOSURE_ROOT
  delete process.env.HOSTED_ACTUAL_OWNER_CLOSURE_ROOT
  if (!closureRoot || !isAbsolute(closureRoot) || resolve(closureRoot) !== closureRoot ||
    realpathSync(closureRoot) !== closureRoot) {
    launchFailure('launcher_relocated')
  }
  const launcherDirectory = resolve(closureRoot, descriptor.launcher.directoryRelativePath)
  if (!launcherDirectory.startsWith(`${closureRoot}/`)) launchFailure('launcher_relocated')
  const launchers = readdirSync(launcherDirectory).filter(name =>
    /^hostedActualOwnerLauncher-[0-9a-f]{64}$/.test(name),
  )
  if (launchers.length !== 1) launchFailure('launcher_relocated')
  const launcherRelativePath = posix.join(
    descriptor.launcher.directoryRelativePath, launchers[0]!,
  )
  const launcher = installedArtifact(
    resolve(closureRoot, launcherRelativePath), launcherRelativePath, 'launcher',
  )
  if (!launcher.relativePath.endsWith(`-${launcher.sha256}`) ||
    buildRecipeLauncherPath(descriptor.buildRecipe, launcher.sha256) !== launcher.relativePath) {
    launchFailure('launcher_replaced')
  }
  verifyLauncherExecutionSnapshot(launcher)
  const parentPid = process.ppid
  if (!Number.isSafeInteger(parentPid) || parentPid <= 1) launchFailure('wrapper_parent_invalid')
  const wrapperPath = resolve(closureRoot, descriptor.wrapper.relativePath)
  const wrapperFd = openSync(wrapperPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  const parentFd = openSync(`/proc/${parentPid}/exe`, constants.O_RDONLY)
  try {
    const wrapperStat = fstatSync(wrapperFd, { bigint: true })
    const wrapperBytes = readFileSync(wrapperFd)
    const wrapperAfter = fstatSync(wrapperFd, { bigint: true })
    if (process.ppid !== parentPid || !wrapperStat.isFile() || wrapperStat.nlink !== 1n ||
      !sameOpenFile(wrapperStat, wrapperAfter) ||
      (wrapperStat.mode & 0o777n).toString(8).padStart(3, '0') !== descriptor.wrapper.mode ||
      wrapperStat.size.toString() !== descriptor.wrapper.size ||
      createHash('sha256').update(wrapperBytes).digest('hex') !== descriptor.wrapper.sha256 ||
      (process.getuid?.() !== undefined && wrapperStat.uid !== BigInt(process.getuid())) ||
      !sameOpenFile(
        wrapperStat,
        fstatSync(parentFd, { bigint: true }),
      )) {
      launchFailure('wrapper_parent_invalid')
    }
  } finally {
    closeSync(parentFd)
    closeSync(wrapperFd)
  }
  return Object.freeze({ closureRoot, launcher })
}

function validArguments(args: readonly string[]): boolean {
  return args.length === 2 && args[0] === '--runtime-manifest' &&
    isAbsolute(args[1]!) && resolve(args[1]!) === args[1] && !args[1]!.includes('\0')
}

function authenticatedClosureDescriptor(): string {
  if (!COMPILED_BUILD_DESCRIPTOR || COMPILED_BUILD_DESCRIPTOR === '{}') {
    launchFailure('descriptor_missing')
  }
  return COMPILED_BUILD_DESCRIPTOR
}

async function runSealedOwnerEntry(): Promise<void> {
  if (!Bun.main.startsWith('/$bunfs/root/') || process.argv[1] !== Bun.main) {
    launchFailure('standalone_owner_identity_invalid')
  }
  const args = process.argv.slice(2)
  if (args.length !== 1 || args[0] !== '--hosted-actual-owner-sealed-protocol=v1') {
    launchFailure('protocol_invalid')
  }
  if (process.platform !== 'linux') launchFailure('platform_unsupported')
  const wrapperAuthoritySha256 = consumeWrapperAuthoritySha256()
  const descriptor = parseLaunchDescriptor(authenticatedClosureDescriptor())
  if (createHash('sha256').update(JSON.stringify(descriptor.sourceAuthority)).digest('hex') !==
    wrapperAuthoritySha256) {
    launchFailure('wrapper_authority_mismatch')
  }
  const { closureRoot, launcher } = verifyRunningLauncher(descriptor)
  const runtimeManifest = process.env.HOSTED_ACTUAL_OWNER_RUNTIME_MANIFEST_ARG
  delete process.env.HOSTED_ACTUAL_OWNER_RUNTIME_MANIFEST_ARG
  const ownerArgs = ['--runtime-manifest', runtimeManifest ?? '']
  if (!validArguments(ownerArgs)) {
    launchFailure('protocol_invalid')
  }
  const orchestratorRef = descriptor.sourceAuthority.orchestratorRef
  const { runActualOwnerAcceptance } = await import(
    '../../scripts/e2e/hosted-actual-owner/owner.js'
  )
  await runActualOwnerAcceptance(ownerArgs, {
    kind: 'built',
    orchestratorRef,
    ownerArtifact: {
      kind: 'sealed-build',
      executable: resolve(closureRoot, launcher.relativePath),
      sha256: `sha256:${launcher.sha256}`,
      buildClosureSha256: `sha256:${descriptor.inputsSha256}`,
    },
  })
}

if (ENTRY_MODE === 'owner') {
  try {
    await runSealedOwnerEntry()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'hosted_actual_owner_launch_failed'}\n`)
    process.exit(1)
  }
} else {
  process.stderr.write('hosted_actual_owner_entry_mode_invalid\n')
  process.exitCode = 1
}
