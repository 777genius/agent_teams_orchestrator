import { existsSync, statSync } from 'node:fs'
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
  return Bun.which('opencode')
}
