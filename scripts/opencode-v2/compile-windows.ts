import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stageWindowsHelper } from './stage-windows.js'

// Build-time producer only. Runtime startup never invokes a compiler.
export async function compileWindowsHelper(root: string): Promise<void> {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 MSVC host required')
  const quote = (value: string) => {
    if (/["%\r\n!]/.test(value)) throw new Error('Unsupported native build path')
    return `"${value}"`
  }
  const vswhere = path.join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft Visual Studio/Installer/vswhere.exe')
  const discovery = spawnSync(vswhere, ['-latest', '-products', '*', '-requires',
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8', timeout: 30_000 })
  if (discovery.error || discovery.status !== 0 || !discovery.stdout.trim()) throw new Error('MSVC installation missing')
  const vcvars = path.join(discovery.stdout.trim(), 'VC/Auxiliary/Build/vcvars64.bat')
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'TEST-native-producer-'))
  const destination = path.join(root, 'native/win32-x64')
  await mkdir(destination, { recursive: true })
  const sources = path.join(root, 'src/services/opencode/host/windows')
  const assets = [
    { source: 'WindowsKernelScope.cpp', name: 'opencode-v2-windows-helper.exe', manifest: 'windows-helper.json', flags: '', libs: ' /link windowsapp.lib userenv.lib advapi32.lib bcrypt.lib' },
    { source: 'WindowsNativeRealpath.cpp', name: 'opencode-v2-windows-realpath.dll', manifest: 'windows-realpath.json', flags: ' /LD', libs: '' },
  ]
  try {
    const commands = assets.map(asset => `cl.exe /nologo /std:c++20 /EHsc /MT /W4 /O2 /DUNICODE /D_UNICODE${asset.flags} ${quote(path.join(sources, asset.source))} /Fe:${quote(path.join(destination, asset.name))}${asset.libs}\r\nif errorlevel 1 exit /b 1`)
    const script = path.join(temporary, 'compile.cmd')
    await writeFile(script, ['@echo off', 'setlocal DisableDelayedExpansion', `call ${quote(vcvars)}`,
      'if errorlevel 1 exit /b 1', ...commands, 'exit /b 0', ''].join('\r\n'))
    const build = spawnSync('cmd.exe', ['/d', '/c', script], { cwd: temporary, stdio: 'inherit', timeout: 180_000 })
    if (build.error || build.status !== 0) throw build.error ?? new Error('Windows native compilation failed')
    for (const asset of assets) {
      const sha256 = createHash('sha256').update(await readFile(path.join(destination, asset.name))).digest('hex')
      await writeFile(path.join(destination, asset.manifest), JSON.stringify({ format: 1, platform: 'win32', arch: 'x64', name: asset.name, sha256 }) + '\n')
    }
    // Validate architecture, binary kind and sealed hashes through the delivery reader.
    await stageWindowsHelper(path.join(root, 'native'), temporary, 'x64')
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  await compileWindowsHelper(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'))
}
