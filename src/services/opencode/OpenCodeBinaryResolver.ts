import { existsSync, readdirSync, realpathSync, statSync, type Dirent } from 'node:fs'
import path from 'node:path'

import { detectOpenCodeNativeFacts } from './OpenCodeNativePlatform.js'
import { compareOpenCodeNativeVersions, getOpenCodeNativePackages, type OpenCodeNativeFacts } from './OpenCodeNativePolicy.js'

function isExecutableCandidate(value: string | null | undefined): value is string {
  if (!value?.trim()) {
    return false
  }
  const resolved = path.resolve(value.trim())
  if (!path.isAbsolute(resolved) || !existsSync(resolved)) {
    return false
  }
  try {
    return statSync(resolved).isFile()
  } catch {
    return false
  }
}

let capturedSelection: { key: string; path: string | null } | null = null
function selectionKey(): string {
  return JSON.stringify([process.platform, process.arch, process.cwd(), process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH, process.env.OPENCODE_BIN_PATH, process.env.PATH, process.env.APPDATA])
}
/** Timeout diagnostics may observe a completed selection but never start another native probe. */
export function readCapturedOpenCodeBinaryPath(): string | null {
  return capturedSelection?.key === selectionKey() && isExecutableCandidate(capturedSelection.path) ? capturedSelection.path : null
}

export async function resolveOpenCodeBinaryPath(signal?: AbortSignal): Promise<string | null> {
  signal?.throwIfAborted()
  const key = selectionKey()
  const capture = (value: string | null): string | null => {
    if (selectionKey() === key) capturedSelection = { key, path: value }
    return value
  }
  const envCandidates = [
    process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH,
    process.env.OPENCODE_BIN_PATH,
  ]
  for (const candidate of envCandidates) {
    if (isExecutableCandidate(candidate)) {
      return capture(path.resolve(candidate.trim()))
    }
  }
  const selected = Bun.which('opencode') ?? resolveAppManagedOpenCodeBinaryPath(await detectOpenCodeNativeFacts(signal))
  signal?.throwIfAborted()
  return capture(selected)
}

export function resolveAppManagedOpenCodeBinaryPath(facts: OpenCodeNativeFacts): string | null {
  const packages = getOpenCodeNativePackages(facts)
  if (!packages.length) return null
  const appData = process.env.APPDATA?.trim()
  if (!appData) {
    return null
  }
  const versionsDir = path.join(
    appData,
    'claude-agent-teams-ui',
    'data',
    'runtimes',
    'opencode',
    'versions',
  )
  if (!existsSync(versionsDir)) {
    return null
  }

  const candidates: Array<{ version: string; binaryPath: string; mtimeMs: number; packageRank: number }> = []
  for (const versionEntry of readDirectoryEntries(versionsDir)) {
    if (!versionEntry.isDirectory() || compareOpenCodeNativeVersions(versionEntry.name, versionEntry.name) === null) {
      continue
    }
    const versionPath = path.join(versionsDir, versionEntry.name)
    for (const platformEntry of readDirectoryEntries(versionPath)) {
      const packageRank = packages.indexOf(platformEntry.name)
      if (!platformEntry.isDirectory() || packageRank < 0) {
        continue
      }
      for (const binaryName of [facts.platform === 'win32' ? 'opencode.exe' : 'opencode']) {
        const binaryPath = path.join(versionPath, platformEntry.name, binaryName)
        if (!isExecutableCandidate(binaryPath)) {
          continue
        }
        candidates.push({
          version: versionEntry.name,
          binaryPath: realpathSync(binaryPath),
          packageRank,
          mtimeMs: getMtimeMs(binaryPath),
        })
      }
    }
  }

  candidates.sort((left, right) => (
    compareOpenCodeNativeVersions(right.version, left.version)! ||
    left.packageRank - right.packageRank ||
    right.mtimeMs - left.mtimeMs ||
    left.binaryPath.localeCompare(right.binaryPath)
  ))
  return candidates[0]?.binaryPath ?? null
}

function readDirectoryEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function getMtimeMs(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs
  } catch {
    return 0
  }
}
