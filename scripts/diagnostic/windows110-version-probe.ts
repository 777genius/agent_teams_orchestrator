import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir, userInfo } from 'node:os'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { plugin } from 'bun'
import { observedPayload, payloadSha256 } from './windows110-catalog-preload.ts'

const packageName = 'opencode-windows-x64'
const version = '1.19.0'
const archiveSri = 'sha512-FsCVPchl5kjXg/UWGOtc2HuD5Fz+o6LtszUVdlVGmfVA+j/o0fSxjcYBHmIAU9/7P3KezAoQ2kL8YNn40O1DwQ=='
const executableSha256 = 'bb731f311416df16691fa16763eb87657c4a5f5f3bcff5202718c416e8f7ab1a'
const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

async function anonymousRegistryBytes(url: string, cap: number): Promise<Buffer> {
  const selected = new URL(url)
  assert.equal(selected.origin, 'https://registry.npmjs.org')
  assert(!selected.username && !selected.password)
  const response = await fetch(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(60000) })
  assert(response.ok, `Official registry HTTP ${response.status}`)
  assert(response.body, 'Official registry response has no body')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      assert(size <= cap, 'Official registry response exceeds diagnostic cap')
      chunks.push(next.value)
    }
  } finally { await reader.cancel() }
  return Buffer.concat(chunks)
}

// Validate every header before writing one canonical regular executable.
// No tar entry path is passed to a filesystem extractor; links/overrides fail closed.
function canonicalNativeBytes(archive: Buffer): Buffer {
  const tar = gunzipSync(archive, { maxOutputLength: 512 * 1024 * 1024 })
  const names = new Set<string>()
  let executable: Buffer | undefined
  let manifest: Buffer | undefined
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(value => value === 0)) {
      assert(tar.subarray(offset).every(value => value === 0), 'Unexpected tar trailing data')
      assert(executable && manifest, 'Canonical package binary/manifest missing')
      const identity = JSON.parse(manifest.toString('utf8')) as { name?: unknown; version?: unknown }
      assert.equal(identity.name, packageName)
      assert.equal(identity.version, version)
      return executable
    }
    const field = (start: number, length: number): string => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '')
    const octal = (value: string): number => {
      assert(/^[0-7]+$/.test(value.trim()), 'Unsupported tar number')
      const number = Number.parseInt(value.trim(), 8)
      assert(Number.isSafeInteger(number), 'Unsafe tar size')
      return number
    }
    let checksum = 0
    for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : header[index]!
    assert.equal(checksum, octal(field(148, 8)), 'Tar checksum mismatch')
    const prefix = field(345, 155)
    const name = (prefix ? `${prefix}/` : '') + field(0, 100)
    const type = field(156, 1)
    const size = octal(field(124, 12))
    assert(['', '0', '5'].includes(type), 'Tar links/special entries/path overrides refused')
    const clean = name.replace(/\/$/, '')
    assert(clean === 'package' ? type === '5' : clean.startsWith('package/'), 'Foreign package archive path')
    assert(!clean.includes('\\') && !clean.includes(':'), 'Package path alias refused')
    assert(clean.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part)), 'Package path alias refused')
    assert(!names.has(clean.toLowerCase()), 'Duplicate package path refused')
    names.add(clean.toLowerCase())
    assert(offset + 512 + size <= tar.length && (type !== '5' || size === 0), 'Truncated/invalid tar entry')
    const body = tar.subarray(offset + 512, offset + 512 + size)
    if (clean === 'package/bin/opencode.exe') { assert(type !== '5'); executable = body }
    if (clean === 'package/package.json') { assert(type !== '5'); manifest = body }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  throw new Error('Missing tar terminator')
}

const productCommit = '209bdab0c2d09c0b14dd186d55a70701fc470712'
const sdkCommit = 'd64fda3f249153e1d6a828817343a508053099b9'
const archiveSha256 = '9dd23b817928413b869fd283bc9bd64652ea74c51dbb9e3d31e88c2ede25d462'
const frontDoorSha256 = '50bbacecfe96ff1ff2abce159d8311f0ec6a2e9f6778495ea4d009add5668e63'
const bundledBunSha256 = 'b3e7109556f472490fd8cb2b69cf28aa264cbd2a6bd08d78f3e3d6c20b72d8a9'
async function fileHash(file: string): Promise<string> {
  assert((await lstat(file)).isFile(), 'Regular pinned file required')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
function input(name: string): string {
  const value = process.env[name]
  assert(value && path.isAbsolute(value), `Missing absolute diagnostic input: ${name}`)
  return value
}
assert.equal(process.platform, 'win32')
assert.equal(process.arch, 'x64')
assert.equal(process.env.TEST_SOURCE_COMMIT, sdkCommit)
assert.equal(process.env.TEST_PRODUCT_SOURCE_COMMIT, productCommit)
assert(/^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA ?? ''))
const productRoot = input('TEST_PRODUCT_ROOT')
const resources = input('TEST_RUNTIME_RESOURCES')
const releaseArchive = input('TEST_RUNTIME_ARCHIVE')
const traceFile = input('TEST_VERSION_DIAGNOSTIC_TRACE')
const resultFile = input('TEST_VERSION_DIAGNOSTIC_RESULT')
const preload = path.join(import.meta.dir, 'windows110-catalog-preload.ts')
const frontDoor = path.join(resources, 'runtime/claude-multimodel.exe')
const bundledBun = path.join(resources, 'runtime/bun/bun.exe')
const physicalPayload = path.join(resources, 'runtime/local-cli/cli.js')
assert.equal((await lstat(releaseArchive)).size, 265993905)
assert.equal(await fileHash(releaseArchive), archiveSha256)
assert.equal(await fileHash(frontDoor), frontDoorSha256)
assert.equal(await fileHash(bundledBun), bundledBunSha256)
assert.equal(await fileHash(physicalPayload), payloadSha256)
const transformation = observedPayload(await readFile(physicalPayload, 'utf8'))

// Hash-qualified originals, not the shared Product working tree. Their pure
// environment helpers are imported unchanged; only the two PATH context imports
// are replaced in memory with this fresh fixture's home and empty shell cache.
const productSources: Record<string, string> = {
  "scripts/e2e/opencode-diagnostics/packaged.mjs": "f5fbc7f94aad4e3b26998b2616f0495a70412e19fcaffaa9f6f79e7ceaa5033c",
  "scripts/e2e/opencode-diagnostics/platform.mjs": "93b217dbf97050c3c28455f13565850f5bc798787e47426e68e5487c80639717",
  "src/main/utils/cliPathMerge.ts": "0f23ee3d469dcd775d15420394e5430d6853c1cc20930de176733d9b7afd8464",
  "src/main/utils/cliProcessDefaults.ts": "824296d3bec61a3dbf84f9e704f61207e1dfba78f1d55efecd78a7decabba15b",
  "src/main/services/runtime/openCodeRuntimeBinaryEnv.ts": "d762b74c7bb4ab0cfb2f3afc2c923cd81bd462e297c3364f386c77ee95a402ed",
  "src/main/services/runtime/openCodeAutoUpdatePolicy.ts": "9ab78b99f52289e5fffde3c3e835638b9ff2d1c3981e279338dbe8483d47a2f7",
  "src/main/services/runtime/providerAwareCliEnv.ts": "9aab217bcd67938c68f4da74c8138ab211e5c9c53bcd8a50e22ba81e21697850",
  "src/main/services/runtime/buildRuntimeBaseEnv.ts": "bf3ce454b646573bc7c7605d00e6a5f1e14b9c6912f3fd701291d232b689069e",
  "src/main/services/runtime/providerRuntimeEnv.ts": "e82555f90247ad416879cbdde9685874d0ceb11793f56293c99ad4d8f86b5692",
  "src/main/services/runtime/agentTeamsMcpLaunchEnv.ts": "802d08e005844f1668c850c625e4e888ac827ff2fe8e2cac5276f4c478072ad5",
  "src/main/services/runtime/ProviderConnectionService.ts": "e8a4534f56952823232efb58ceb6416ebbcab601962af1ff23ccebc970752535",
  "src/main/services/identity/AgentTeamsIdentityStore.ts": "2241b653282a7efc9655b77ff2583982991c82fc96768c86b7fa9cc2c559d27d",
  "src/main/services/infrastructure/ConfigManager.ts": "407e6510451a5221a57a16dcb09f6152d4ae0842a9460ab2ef9be52ae9f796f6",
  "src/main/utils/pathDecoder.ts": "5c64c89aecda79baeef45e51890a5db8c49097b8d0561c2cf2d0bd6be539563b",
  "src/main/utils/cliEnv.ts": "0359b02a2056039c78506a5329637335b101d87712294d232dba15f53c15f613",
  "scripts/stage-opencode-console-wrapper.mjs": "9b1edfd453aaa76e3aa34db6e3eaabc34200cafdcc3d0cc621c8e2cb9c5cf4f1",
  "tools/opencode-console-wrapper/OpenCodeConsoleWrapper.cs": "d8c6cc55da5f26b5255fc1686d513d26a21bcdd41fce4c4b1932f7c9e871eead"
}
const sourceJoins: { path: string; sha256: string }[] = []
for (const [file, expected] of Object.entries(productSources)) {
  const actual = sha256((await readFile(path.join(productRoot, file), 'utf8')).replace(/\r\n/g, '\n'))
  assert.equal(actual, expected, `Product source mismatch: ${file}`)
  sourceJoins.push({ path: file, sha256: actual })
}
const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'TEST-win110-compiled-catalog-'))
type DisposableProfile = { root: string; home: string; userData: string; temp: string; project: string }
const data: DisposableProfile = { root: fixtureRoot, home: path.join(fixtureRoot, 'home'), userData: path.join(fixtureRoot, 'user-data'), temp: path.join(fixtureRoot, 'tmp'), project: path.join(fixtureRoot, 'existing-project') }
const packaged = await import(path.join(productRoot, 'scripts/e2e/opencode-diagnostics/packaged.mjs')) as {
  preparePackagedProfile(data: DisposableProfile, inherited: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv>
}
const parentEnv = await packaged.preparePackagedProfile(data, process.env)
const mergeFile = path.join(productRoot, 'src/main/utils/cliPathMerge.ts')
plugin({ name: 'TEST-Product209-disposable-PATH-context', setup(builder) {
  builder.onLoad({ filter: /[\\/]cliPathMerge\.ts$/ }, async ({ path: file }) => {
    assert.equal(path.resolve(file).toLowerCase(), mergeFile.toLowerCase())
    let source = (await readFile(file, 'utf8')).replace(/\r\n/g, '\n')
    assert.equal(sha256(source), productSources['src/main/utils/cliPathMerge.ts'])
    const contexts = [
      ["import { getClaudeBasePath } from '@main/utils/pathDecoder';", `const getClaudeBasePath=()=>${JSON.stringify(path.join(data.home, '.claude'))};`],
      ["import { getCachedShellEnv, getShellPreferredHome } from '@main/utils/shellEnv';", `const getCachedShellEnv=()=>({});const getShellPreferredHome=()=>${JSON.stringify(data.home)};`],
    ] as const
    for (const [before, after] of contexts) { assert.equal(source.split(before).length - 1, 1); source = source.replace(before, after) }
    return { loader: 'ts', contents: source }
  })
} })
const merge = await import(mergeFile) as { buildMergedCliPath(binaryPath: string): string }
// The real helper reads only these process-context keys. Temporarily project the
// qualified disposable parent, never the runner PATH or login-shell environment.
const saved = { PATH: process.env.PATH, LOCALAPPDATA: process.env.LOCALAPPDATA, ProgramFiles: process.env.ProgramFiles }
Object.assign(process.env, { PATH: parentEnv.PATH, LOCALAPPDATA: parentEnv.LOCALAPPDATA })
if (parentEnv.ProgramFiles) process.env.ProgramFiles = parentEnv.ProgramFiles
else delete process.env.ProgramFiles
try { parentEnv.PATH = merge.buildMergedCliPath(frontDoor) }
finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } }
const spawnDefaults = await import(path.join(productRoot, 'src/main/utils/cliProcessDefaults.ts')) as {
  withCliProcessDefaults(options: { env: NodeJS.ProcessEnv }): { env: NodeJS.ProcessEnv; windowsHide: boolean; detached: boolean }
}
const binaryProjection = await import(path.join(productRoot, 'src/main/services/runtime/openCodeRuntimeBinaryEnv.ts')) as {
  applyOpenCodeRuntimeBinaryEnv(env: NodeJS.ProcessEnv, binary: string, options: { resourcesPath: string; platform: NodeJS.Platform; env: NodeJS.ProcessEnv }): void
}
const updatePolicy = await import(path.join(productRoot, 'src/main/services/runtime/openCodeAutoUpdatePolicy.ts')) as { applyOpenCodeAutoUpdatePolicy(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv }
// Fresh default ConfigManager + providerRuntimeEnv + cliEnv + identity projection.
// OpenCode augmentConfiguredConnectionEnv returns the same env without credentials.
parentEnv.USER = userInfo().username
parentEnv.LOGNAME = parentEnv.USER
parentEnv.AGENT_TEAMS_IDENTITY_STORE_PATH = path.join(data.userData, 'data/identity/agent-teams-client.json')
parentEnv.CLAUDE_CODE_GEMINI_BACKEND = 'auto'
parentEnv.CLAUDE_CODE_CODEX_BACKEND = 'codex-native'
parentEnv.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
parentEnv.CLAUDE_CODE_ENTRY_PROVIDER = 'opencode'
parentEnv.AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE = 'auto'
parentEnv.AGENT_TEAMS_MCP_CLAUDE_DIR = path.join(data.home, '.claude')
parentEnv.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON = JSON.stringify({ AGENT_TEAMS_MCP_CLAUDE_DIR: parentEnv.AGENT_TEAMS_MCP_CLAUDE_DIR })
Object.assign(parentEnv, updatePolicy.applyOpenCodeAutoUpdatePolicy(parentEnv))
delete parentEnv.ELECTRON_RUN_AS_NODE

const metadataUrl = `https://registry.npmjs.org/${packageName}/${version}`
const metadataBytes = await anonymousRegistryBytes(metadataUrl, 4 * 1024 * 1024)
const metadata = JSON.parse(metadataBytes.toString('utf8')) as { name?: unknown; version?: unknown; dist?: { tarball?: unknown; integrity?: unknown } }
assert.equal(metadata.name, packageName)
assert.equal(metadata.version, version)
assert.equal(metadata.dist?.integrity, archiveSri)
const tarballUrl = `https://registry.npmjs.org/${packageName}/-/${packageName}-${version}.tgz`
assert.equal(metadata.dist?.tarball, tarballUrl)
const archive = await anonymousRegistryBytes(tarballUrl, 256 * 1024 * 1024)
assert.equal(`sha512-${createHash('sha512').update(archive).digest('base64')}`, archiveSri)
const nativeBytes = canonicalNativeBytes(archive)
assert.equal(sha256(nativeBytes), executableSha256)
const executable = path.join(data.userData, 'data/runtimes/opencode/versions/1.19.0', packageName, 'opencode.exe')
await mkdir(path.dirname(executable), { recursive: true })
await writeFile(executable, nativeBytes, { flag: 'wx' })
const wrapperInput = input('TEST_WRAPPER_EXECUTABLE')
const wrapperBytes = await readFile(wrapperInput)
const wrapper = path.join(resources, 'runtime/opencode-console/opencode.exe')
await mkdir(path.dirname(wrapper), { recursive: true })
await writeFile(wrapper, wrapperBytes, { flag: 'wx' })
binaryProjection.applyOpenCodeRuntimeBinaryEnv(parentEnv, executable, { resourcesPath: resources, platform: 'win32', env: parentEnv })
assert.equal(parentEnv.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH, wrapper)
assert.equal(parentEnv.OPENCODE_BIN_PATH, wrapper)
assert.equal(parentEnv.OPENCODE_CONSOLE_WRAPPER_TARGET, executable)
assert.equal(await readFile(path.join(path.dirname(wrapper), 'opencode.real.path'), 'utf8'), executable)
const wrapperSha256 = sha256(wrapperBytes)
const normal = spawnDefaults.withCliProcessDefaults({ env: parentEnv })
assert.equal(normal.env.PSModuleAnalysisCachePath, path.join(data.temp, 'PSModuleAnalysisCache'))
assert.equal(normal.env.CLAUDE_HOOK_JUDGE_MODE, 'true')
assert.equal(normal.detached, false)
assert.equal(normal.windowsHide, true)
const rootKeys = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'AGENT_TEAMS_ELECTRON_USER_DATA_DIR', 'AGENT_TEAMS_ELECTRON_CLAUDE_ROOT', 'AGENT_TEAMS_IDENTITY_STORE_PATH', 'PSModuleAnalysisCachePath']
const parentRoots = Object.fromEntries(rootKeys.map(key => {
  const value = normal.env[key]
  assert(value && path.isAbsolute(value))
  const relative = path.relative(fixtureRoot, value)
  assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  return [key, relative]
}))
assert(!Object.keys(normal.env).some(key => /(?:API_KEY|AUTH_TOKEN|GITHUB_TOKEN|TOKEN|PASSWORD|SECRET)/i.test(key)), 'Unexpected credential-bearing environment')
await writeFile(traceFile, '', { flag: 'wx' })
// Both the intact front door and its physical Bun child retain Product's HOME
// cwd. A relative preload avoids Windows quoting or path escaping differences.
await writeFile(path.join(data.home, 'windows110-catalog-preload.ts'), await readFile(preload), { flag: 'wx' })
const env = { ...normal.env, BUN_OPTIONS: '--preload ./windows110-catalog-preload.ts', TEST_VERSION_DIAGNOSTIC_PAYLOAD: physicalPayload, TEST_VERSION_DIAGNOSTIC_TRACE: traceFile, TEST_VERSION_DIAGNOSTIC_ROOT: fixtureRoot }
const args = ['runtime', 'providers', 'models', '--runtime', 'opencode', '--provider', 'opencode', '--json']
const started = Date.now()
// Sole actual release command. Preserve Product outer budget/output bounds and
// SDK's unmodified inner ownership/deadline/cleanup behavior. No pre-version call.
const command = await new Promise<{ code: number | null; timedOut: boolean; stdout: string; stderr: string }>(resolve => {
  execFile(frontDoor, args, { env, cwd: data.home, timeout: 90000, maxBuffer: 8 * 1024 * 1024, windowsHide: normal.windowsHide }, (error, stdout, stderr) => {
    resolve({ code: error ? typeof error.code === 'number' ? error.code : null : 0, timedOut: Boolean(error?.killed), stdout, stderr })
  })
})
const elapsedMs = Date.now() - started
const events = (await readFile(traceFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
const caught = events.filter(e => e.event === 'catalog-admission-catch')
const classified = events.filter(e => e.event === 'classification')
const observationChecks = {
  tracePresent: events.length > 0,
  traceBounded: events.length < 400 && !events.some(e => e.event === 'trace-overflow'),
  physicalPayloadObservedOnce: events.filter(e => e.event === 'payload-observed').length === 1,
  catalogStageObserved: events.some(e => e.event === 'stage' && e.value === 'selected-path'),
  admissionObserved: caught.length === 1 || classified.length > 0,
}
const admissionResult = caught.length ? 'THREW' : classified.length ? 'RETURNED' : 'UNOBSERVED'
let responseCode = 'other'
let modelCount: number | null = null
try {
  const json = JSON.parse(command.stdout) as { error?: { code?: unknown }; models?: { models?: unknown[] } }
  const allowed = ['runtime-unhealthy', 'provider-missing', 'auth-required', 'model-missing', 'runtime-misconfigured']
  responseCode = typeof json.error?.code === 'string' && allowed.includes(json.error.code) ? json.error.code : json.error ? 'other' : 'none'
  modelCount = Array.isArray(json.models?.models) ? json.models.models.length : null
} catch { responseCode = 'non-json' }
for (const [file, expected] of [[frontDoor, frontDoorSha256], [bundledBun, bundledBunSha256], [physicalPayload, payloadSha256], [wrapper, wrapperSha256], [executable, executableSha256]]) assert.equal(await fileHash(file!), expected)
assert.equal(await readFile(path.join(path.dirname(wrapper), 'opencode.real.path'), 'utf8'), executable)
await writeFile(resultFile, JSON.stringify({ schema: 4, diagnosticOnly: true, harnessCommit: process.env.GITHUB_SHA, sourceCommit: sdkCommit, productCommit, release: { archiveSha256, archiveBytes: 265993905, frontDoorSha256, bundledBunSha256, payloadSha256 }, preloadSha256: await fileHash(preload), transformedSha256: transformation.transformedSha256, anchors: transformation.anchors, sourceJoins, acquisition: { packageName, version, archiveSri, metadataSha256: sha256(metadataBytes), archiveSha256: sha256(archive), executableSha256 }, wrapperSha256, sidecar: 'matching-pinned-native', parentRoots, parentContract: { windowsShellCache: 'empty', modelCatalog: 'provider-aware-augment', cwd: 'HOME', outerTimeoutMs: 90000, maxBuffer: 8388608, credentialKeys: 'absent', electronHostContext: 'unavailable-no-Electron', mcpLocalLaunchMetadata: 'unavailable-no-packaged-asar', diagnosticEnvAdditions: ['BUN_OPTIONS', 'TEST_VERSION_DIAGNOSTIC_PAYLOAD', 'TEST_VERSION_DIAGNOSTIC_TRACE', 'TEST_VERSION_DIAGNOSTIC_ROOT'] }, command: { code: command.code, timedOut: command.timedOut, elapsedMs, stdoutBytes: Buffer.byteLength(command.stdout), stderrBytes: Buffer.byteLength(command.stderr), responseCode, modelCount }, observationChecks, admission: { result: admissionResult, error: caught[0] ?? null, classificationCount: classified.length }, eventCount: events.length, noInference: true, noWarmup: true, productionChanged: false, cleanup: 'Existing runtime ownership semantics; no added queries or signals' }, null, 2))
console.log(JSON.stringify({ diagnosticOnly: true, admission: admissionResult, code: command.code, elapsedMs }))

assert(Object.values(observationChecks).every(Boolean), 'Finite compiled admission observation contract failed')
