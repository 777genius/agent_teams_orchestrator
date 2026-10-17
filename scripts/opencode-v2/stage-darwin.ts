import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/** Stage the native helper only on its target OS/architecture. Qualification is
 * a separate native execution gate; compilation never fabricates that receipt. */
export async function stageOpenCodeV2DarwinHelper(root: string, outdir: string,
  target: Readonly<{ platform?: string; arch?: string }> = {}) {
  const platform = target.platform ?? process.platform, arch = target.arch ?? process.arch
  if (platform !== 'darwin') return
  if (process.platform !== 'darwin' || arch !== process.arch || !['arm64', 'x64'].includes(arch)) {
    throw new Error('execution_containment_native_build_required')
  }
  const nativeRoot = path.join(outdir, 'native', `darwin-${arch}`)
  const app = path.join(nativeRoot, 'OpenCodeV2Scope.app')
  const macos = path.join(app, 'Contents', 'MacOS')
  const binary = path.join(macos, 'opencode-v2-darwin-scope')
  await mkdir(macos, { recursive: true })
  const run = (command: string, args: string[]) => {
    const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', timeout: 60_000 })
    if (result.error || result.status !== 0) throw result.error ?? new Error(`native_helper_build_failed:${command}`)
  }
  run('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-O2', '-Wall', '-Wextra', '-framework', 'Foundation',
    '-framework', 'Security', '-framework', 'AppKit', path.join(root, 'src/services/opencode/host/darwin/DarwinKernelScope.m'), '-o', binary])
  await writeFile(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>ai.agentteams.opencode.scope</string>
<key>CFBundleExecutable</key><string>opencode-v2-darwin-scope</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>\n`)
  run('/usr/bin/codesign', ['--force', '--sign', '-', app])
  const sha256 = createHash('sha256').update(await readFile(binary)).digest('hex')
  const probe = path.join(nativeRoot, 'opencode-v2-darwin-qualification-probe')
  run('/usr/bin/xcrun', ['clang', '-O2', '-Wall', '-Wextra', '-framework', 'AppKit', '-framework', 'CoreServices',
    path.join(root, 'scripts/opencode-v2/darwin-qualification-probe.m'), '-o', probe])
  run('/usr/bin/codesign', ['--force', '--sign', '-', probe])
  const probeSha256 = createHash('sha256').update(await readFile(probe)).digest('hex')
  await writeFile(path.join(nativeRoot, 'darwin-helper.json'), JSON.stringify({ format: 1, sha256, probeSha256, arch }) + '\n')
  return { app, binary, sha256, probe, probeSha256 }
}

// Source-mode helpers live beside the source graph, never in a stale dist tree.
// Explicit staging avoids invoking a compiler during ordinary CLI startup.
if (import.meta.main) {
  if (process.argv.length !== 3 || process.argv[2] !== '--source') {
    throw new Error('Usage: bun scripts/opencode-v2/stage-darwin.ts --source')
  }
  if (process.platform !== 'darwin') throw new Error('execution_containment_native_build_required')
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const result = await stageOpenCodeV2DarwinHelper(root, root)
  console.log(JSON.stringify(result))
}
