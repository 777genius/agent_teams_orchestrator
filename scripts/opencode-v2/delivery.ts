import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { openCodeBunVersion } from '../../src/constants/openCodeBunVersion.js'
import { openCodeV2ReleaseContract } from '../../src/services/opencode/compatibility/OpenCodeV2Registry.js'
import { canonicalOpenCodeV2DeliveryManifest, isOpenCodeV2DeliveryPath, OPENCODE_V2_DELIVERY_LIMITS as limits,
  OPENCODE_V2_DELIVERY_MANIFEST_FILE as manifestName, validateOpenCodeV2DeliveryDescriptor,
  type OpenCodeV2DeliveryDescriptor, type OpenCodeV2DeliveryFile, type OpenCodeV2DeliveryManifest } from '../../src/services/opencode/host/OpenCodeV2DeliveryContract.js'

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')

/** Stage is private and fully written before entry. Never follow links or preserve special modes. */
export async function inventoryOpenCodeV2Delivery(root: string): Promise<OpenCodeV2DeliveryFile[]> {
  root = await realpath(root)
  const rows: OpenCodeV2DeliveryFile[] = []
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name), relative = path.relative(root, file).split(path.sep).join('/')
      const before = await lstat(file)
      if (entry.isSymbolicLink() || before.isSymbolicLink() || (before.mode & 0o6000) !== 0) throw new Error('Unsupported OpenCode V2 payload entry')
      if (relative === manifestName) {
        if (!entry.isFile() || !before.isFile()) throw new Error('Unsupported OpenCode V2 manifest entry')
        continue
      }
      if (entry.isDirectory()) { await walk(file); continue }
      if (!entry.isFile() || !before.isFile() || before.size > limits.file || rows.length >= limits.files ||
        !isOpenCodeV2DeliveryPath(relative) || !relative.startsWith('local-cli/')) {
        throw new Error('Invalid OpenCode V2 payload file')
      }
      const digest = createHash('sha256')
      for await (const chunk of createReadStream(file)) digest.update(chunk)
      const after = await lstat(file)
      if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.mode !== after.mode || before.ctimeMs !== after.ctimeMs ||
        await realpath(file) !== file) throw new Error('OpenCode V2 payload changed')
      rows.push({ path: relative, bytes: before.size, sha256: digest.digest('hex'), executable: (before.mode & 0o111) !== 0 })
    }
  }
  await walk(root)
  return rows.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
}

// Fixed code; paths travel only through environment values, never PowerShell source interpolation.
const windowsZip = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
$root = $env:AGENT_TEAMS_V2_ZIP_ROOT
$manifest = Get-Content -LiteralPath (Join-Path $root $env:AGENT_TEAMS_V2_ZIP_MANIFEST) -Raw -Encoding UTF8 | ConvertFrom-Json
$stream = [System.IO.File]::Open($env:AGENT_TEAMS_V2_ZIP_OUTPUT, [System.IO.FileMode]::CreateNew)
try {
  $zip = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create, $true, [System.Text.UTF8Encoding]::new($false))
  try {
    $names = @($manifest.files | ForEach-Object { $_.path }) + @($env:AGENT_TEAMS_V2_ZIP_MANIFEST)
    foreach ($name in $names) {
      $entry = $zip.CreateEntry($name, [System.IO.Compression.CompressionLevel]::Optimal)
      $entry.LastWriteTime = [DateTimeOffset]::new(2000, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
      $source = [System.IO.File]::OpenRead((Join-Path $root $name))
      try { $target = $entry.Open(); try { $source.CopyTo($target) } finally { $target.Dispose() } }
      finally { $source.Dispose() }
    }
  } finally { $zip.Dispose() }
} finally { $stream.Dispose() }
`

/** Existing host ZIP tools produce regular-file-only ZIPs; no new archive implementation. */
async function zipPayload(root: string, output: string, files: readonly OpenCodeV2DeliveryFile[]): Promise<void> {
  await rm(output, { force: true })
  const cmd = process.platform === 'win32'
    ? [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      '-NoProfile', '-NonInteractive', '-Command', windowsZip]
    : ['zip', '-q', '-X', '-D', output, '-@']
  const child = Bun.spawn(cmd, { cwd: root, env: { ...process.env, AGENT_TEAMS_V2_ZIP_ROOT: root, AGENT_TEAMS_V2_ZIP_OUTPUT: output,
    AGENT_TEAMS_V2_ZIP_MANIFEST: manifestName },
    stdin: process.platform === 'win32' ? 'ignore' : 'pipe', stdout: 'inherit', stderr: 'inherit' })
  if (process.platform !== 'win32' && child.stdin) {
    child.stdin.write([...files.map(file => file.path), manifestName].join('\n') + '\n')
    await child.stdin.end()
  }
  if (await child.exited !== 0) throw new Error('OpenCode V2 support ZIP creation failed')
}

/** Hooks and graph are final before this finite build step; the base embeds its result afterwards. */
export async function packageOpenCodeV2Delivery(options: {
  root: string; outputDirectory: string; runtimeVersion: string; sourceCommit: string; platformKey: string
}): Promise<OpenCodeV2DeliveryDescriptor> {
  const root = await realpath(options.root), outputDirectory = path.resolve(options.outputDirectory)
  const [platform, arch] = options.platformKey.split('-')
  const engineVersions = openCodeV2ReleaseContract().qualified[options.platformKey as keyof ReturnType<typeof openCodeV2ReleaseContract>['qualified']]
  if (!engineVersions?.length || !/^[a-f0-9]{40}$/.test(options.sourceCommit)) throw new Error('OpenCode V2 delivery is not qualified')
  const graph = JSON.parse(await readFile(path.join(root, 'local-cli/opencode-v2-graphs.json'), 'utf8')) as {
    platform?: string; arch?: string; graphs?: { version: string }[]
  }
  if (graph.platform !== platform || graph.arch !== arch ||
    JSON.stringify(graph.graphs?.map(row => row.version)) !== JSON.stringify(engineVersions)) throw new Error('OpenCode V2 delivery graph roster mismatch')
  const files = await inventoryOpenCodeV2Delivery(root)
  for (const entry of ['opencodeV2Server', 'opencodeV2ExecutionServer', 'opencodeV2RunOwner']) {
    if (!files.some(row => row.path === `local-cli/${entry}.js`)) throw new Error('OpenCode V2 delivery hook missing')
  }
  if (files.some(row => row.path === 'local-cli/cli.js' || /(?:^|\/)bun(?:\.exe)?$/.test(row.path))) throw new Error('OpenCode V2 delivery contains a duplicate base')
  const identity = { schemaVersion: 1 as const, runtimeVersion: options.runtimeVersion, sourceCommit: options.sourceCommit,
    bridgeProtocol: 1 as const, platform, arch, requiredBunVersion: openCodeBunVersion(platform), engineVersions: [...engineVersions] }
  const manifest: OpenCodeV2DeliveryManifest = { ...identity, files }
  const content = canonicalOpenCodeV2DeliveryManifest(manifest), manifestBytes = Buffer.byteLength(content)
  const expandedBytes = files.reduce((total, file) => total + file.bytes, manifestBytes)
  if (manifestBytes > limits.manifest || expandedBytes > limits.expanded) throw new Error('OpenCode V2 delivery budget exceeded')
  await writeFile(path.join(root, manifestName), content)
  await mkdir(outputDirectory, { recursive: true })
  const filename = `agent-teams-opencode-v2-support-${options.platformKey}-v${options.runtimeVersion}.zip`
  const archive = path.join(outputDirectory, filename)
  await zipPayload(root, archive, files)
  const archiveInfo = await stat(archive)
  if (archiveInfo.size <= 0 || archiveInfo.size > limits.archive ||
    JSON.stringify(await inventoryOpenCodeV2Delivery(root)) !== JSON.stringify(files)) throw new Error('OpenCode V2 delivery changed during packaging')
  const archiveHash = createHash('sha256')
  for await (const chunk of createReadStream(archive)) archiveHash.update(chunk)
  const descriptor = validateOpenCodeV2DeliveryDescriptor({ ...identity,
    archive: { file: filename, kind: 'zip', sha256: archiveHash.digest('hex'), bytes: archiveInfo.size, entries: files.length + 1, expandedBytes },
    manifest: { file: manifestName, sha256: hash(content), bytes: manifestBytes, files: files.length } })
  await writeFile(path.join(outputDirectory, 'opencode-v2-delivery.json'), JSON.stringify(descriptor, null, 2) + '\n')
  return descriptor
}

/** CI sidecars keep platform identity while public ZIPs are flattened for release upload. */
export async function stageOpenCodeV2ReleaseFiles(platformKey: string, root: string = process.cwd()): Promise<void> {
  const metadata = path.join(root, 'release/metadata', platformKey)
  const version = (await readFile(path.join(root, 'release/runtime/VERSION'), 'utf8')).trim()
  const commit = (await readFile(path.join(root, 'release/runtime/COMMIT_SHA'), 'utf8')).trim()
  const expected = openCodeV2ReleaseContract().qualified[platformKey as keyof ReturnType<typeof openCodeV2ReleaseContract>['qualified']]
  if (!expected || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid runtime release source identity')
  await mkdir(metadata, { recursive: true })
  await writeFile(path.join(metadata, 'COMMIT_SHA'), commit + '\n')
  await writeFile(path.join(metadata, 'VERSION'), version + '\n')
  const file = path.join(root, 'dist/opencode-v2-delivery.json')
  if (expected.length === 0) {
    if (await stat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })) {
      throw new Error('Unqualified release contains OpenCode V2 support')
    }
    return
  }
  const descriptor = validateOpenCodeV2DeliveryDescriptor(JSON.parse(await readFile(file, 'utf8')))
  if (await readFile(file, 'utf8') !== await readFile(path.join(root, 'release/runtime/opencode-v2-delivery.json'), 'utf8')) {
    throw new Error('Base runtime delivery metadata differs from its build descriptor')
  }
  if (`${descriptor.platform}-${descriptor.arch}` !== platformKey || descriptor.runtimeVersion !== version || descriptor.sourceCommit !== commit ||
    JSON.stringify(descriptor.engineVersions) !== JSON.stringify(expected)) throw new Error('Runtime and V2 support source identity differ')
  await copyFile(file, path.join(metadata, 'opencode-v2-delivery.json'))
  await copyFile(path.join(root, 'dist', descriptor.archive.file), path.join(root, 'release', descriptor.archive.file))
}

if (import.meta.main) {
  if (process.argv[2] !== 'stage-release' || !process.argv[3]) throw new Error('Usage: delivery.ts stage-release <platform-key>')
  await stageOpenCodeV2ReleaseFiles(process.argv[3])
}
