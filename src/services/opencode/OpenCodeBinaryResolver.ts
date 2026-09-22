import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs'
import path from 'node:path'

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

export function resolveOpenCodeBinaryPath(): string | null {
  const envCandidates = [
    process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH,
    process.env.OPENCODE_BIN_PATH,
  ]
  for (const candidate of envCandidates) {
    if (isExecutableCandidate(candidate)) {
      return path.resolve(candidate.trim())
    }
  }
  return Bun.which('opencode') ?? resolveAppManagedOpenCodeBinaryPath()
}

function resolveAppManagedOpenCodeBinaryPath(): string | null {
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

  const candidates: Array<{ version: string; binaryPath: string; mtimeMs: number }> = []
  for (const versionEntry of readDirectoryEntries(versionsDir)) {
    if (!versionEntry.isDirectory()) {
      continue
    }
    const versionPath = path.join(versionsDir, versionEntry.name)
    for (const platformEntry of readDirectoryEntries(versionPath)) {
      if (!platformEntry.isDirectory()) {
        continue
      }
      for (const binaryName of ['opencode.exe', 'opencode']) {
        const binaryPath = path.join(versionPath, platformEntry.name, binaryName)
        if (!isExecutableCandidate(binaryPath)) {
          continue
        }
        candidates.push({
          version: versionEntry.name,
          binaryPath,
          mtimeMs: getMtimeMs(binaryPath),
        })
      }
    }
  }

  candidates.sort((left, right) => (
    compareVersionLabels(right.version, left.version) ||
    right.mtimeMs - left.mtimeMs ||
    right.binaryPath.localeCompare(left.binaryPath)
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

function compareVersionLabels(left: string, right: string): number {
  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: 'base',
  })
}
