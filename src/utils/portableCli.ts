import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
} from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export type DirectWindowsLauncher = {
  command: string
  argsPrefix: string[]
}

function isPathLikeCommand(command: string): boolean {
  return (
    command.includes('/')
    || command.includes('\\')
    || /^[A-Za-z]:/.test(command)
  )
}

function isWindowsBatchLauncher(binaryPath: string): boolean {
  const extension = path.extname(binaryPath).toLowerCase()
  return extension === '.cmd' || extension === '.bat'
}

function resolveCmdPathTemplate(template: string, launcherDir: string): string {
  const dirWithSep = launcherDir.endsWith(path.sep)
    ? launcherDir
    : `${launcherDir}${path.sep}`
  const resolvedTemplate = template
    .replace(/%SCRIPT_DIR%/gi, dirWithSep)
    .replace(/%~dp0/gi, dirWithSep)
    .replace(/%dp0%/gi, dirWithSep)
  return path.resolve(resolvedTemplate.replace(/\\/g, path.sep))
}

function resolveGeneratedBunLauncher(
  content: string,
  launcherDir: string,
): DirectWindowsLauncher | null {
  if (!/\bbun\s+"%TARGET%"\s+%\*/i.test(content)) {
    return null
  }
  const targetTemplate = /set\s+"TARGET=([^"]+)"/i.exec(content)?.[1]
  if (!targetTemplate) {
    return null
  }

  const target = resolveCmdPathTemplate(targetTemplate, launcherDir)
  if (!existsSync(target)) {
    return null
  }
  return { command: 'bun', argsPrefix: [target] }
}

function resolveNpmNodeShim(
  content: string,
  launcherDir: string,
): DirectWindowsLauncher | null {
  const scriptTemplate =
    /"%_prog%"\s+"([^"]+(?:\.(?:cjs|mjs|js))?)"\s+%\*/i.exec(content)?.[1]
  if (!scriptTemplate) {
    return null
  }

  const scriptPath = resolveCmdPathTemplate(scriptTemplate, launcherDir)
  if (!existsSync(scriptPath)) {
    return null
  }

  const localNode = path.join(launcherDir, 'node.exe')
  return {
    command: existsSync(localNode) ? localNode : 'node',
    argsPrefix: [scriptPath],
  }
}

function resolveNpmNativeShim(
  content: string,
  launcherDir: string,
): DirectWindowsLauncher | null {
  const nativeTarget =
    /(?:^|[&|])\s*"([^"]+\.(?:exe|com))"\s+%\*/im.exec(content)?.[1]
  if (!nativeTarget) {
    return null
  }

  const target = resolveCmdPathTemplate(nativeTarget, launcherDir)
  if (!existsSync(target)) {
    return null
  }

  return { command: target, argsPrefix: [] }
}

function resolveCompanionWindowsExecutable(binaryPath: string): string {
  if (process.platform !== 'win32' || path.extname(binaryPath)) {
    return binaryPath
  }

  if (!isPathLikeCommand(binaryPath)) {
    return Bun.which(binaryPath) ?? binaryPath
  }

  for (const extension of ['.exe', '.cmd', '.bat', '.com']) {
    const candidate = `${binaryPath}${extension}`
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return binaryPath
}

export function resolveDirectWindowsLauncher(
  binaryPath: string,
): DirectWindowsLauncher | null {
  if (process.platform !== 'win32') {
    return null
  }

  const resolvedBinaryPath = resolveCompanionWindowsExecutable(binaryPath)
  if (!isWindowsBatchLauncher(resolvedBinaryPath)) {
    return null
  }

  try {
    const content = readFileSync(resolvedBinaryPath, 'utf8')
    const launcherDir = path.dirname(resolvedBinaryPath)
    return (
      resolveGeneratedBunLauncher(content, launcherDir)
      ?? resolveNpmNodeShim(content, launcherDir)
      ?? resolveNpmNativeShim(content, launcherDir)
    )
  } catch {
    return null
  }
}

function quoteCmdChunk(chunk: string): string {
  const escaped = chunk
    .replace(/(\\*)"/g, (_match, backslashes: string) => `${backslashes}${backslashes}\\"`)
    .replace(/(\\+)$/g, '$1$1')
  return `"${escaped}"`
}

export function quoteWindowsCmdArg(arg: string): string {
  if (/[^A-Za-z0-9_\-/.]/.test(arg)) {
    return arg.split('%').map(quoteCmdChunk).join('^%')
  }
  return arg
}

function needsWindowsShellFallback(binaryPath: string): boolean {
  if (process.platform !== 'win32') {
    return false
  }
  const resolvedBinaryPath = resolveCompanionWindowsExecutable(binaryPath)
  return isWindowsBatchLauncher(resolvedBinaryPath)
}

function buildWindowsShellCommand(binaryPath: string, args: string[]): string {
  const resolvedBinaryPath = resolveCompanionWindowsExecutable(binaryPath)
  return [resolvedBinaryPath, ...args].map(quoteWindowsCmdArg).join(' ')
}

function withoutShell<TOptions extends SpawnOptions | SpawnSyncOptions>(
  options: TOptions,
): TOptions {
  const next = { ...options }
  delete (next as { shell?: unknown }).shell
  return next
}

export function spawnPortableCli(
  binaryPath: string,
  args: string[],
  options: SpawnOptions = {},
): ChildProcess {
  const directLauncher = resolveDirectWindowsLauncher(binaryPath)
  if (directLauncher) {
    return spawn(
      directLauncher.command,
      [...directLauncher.argsPrefix, ...args],
      withoutShell(options),
    )
  }

  if (needsWindowsShellFallback(binaryPath)) {
    return spawn(buildWindowsShellCommand(binaryPath, args), {
      ...options,
      shell: true,
    })
  }

  try {
    return spawn(binaryPath, args, options)
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? (error as NodeJS.ErrnoException).code
        : undefined
    if (process.platform === 'win32' && code === 'EINVAL') {
      return spawn(buildWindowsShellCommand(binaryPath, args), {
        ...options,
        shell: true,
      })
    }
    throw error
  }
}

export function spawnSyncPortableCli(
  binaryPath: string,
  args: string[],
  options: SpawnSyncOptions = {},
): SpawnSyncReturns<Buffer | string> {
  const directLauncher = resolveDirectWindowsLauncher(binaryPath)
  if (directLauncher) {
    return spawnSync(
      directLauncher.command,
      [...directLauncher.argsPrefix, ...args],
      withoutShell(options),
    )
  }

  if (needsWindowsShellFallback(binaryPath)) {
    return spawnSync(buildWindowsShellCommand(binaryPath, args), {
      ...options,
      shell: true,
    })
  }

  const result = spawnSync(binaryPath, args, options)
  const code = result.error && 'code' in result.error
    ? (result.error as NodeJS.ErrnoException).code
    : undefined
  if (process.platform === 'win32' && code === 'EINVAL') {
    return spawnSync(buildWindowsShellCommand(binaryPath, args), {
      ...options,
      shell: true,
    })
  }
  return result
}
