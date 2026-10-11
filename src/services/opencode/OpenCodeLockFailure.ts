import nodePath from 'node:path'
import { resolveClaudeMultimodelPaths } from './OpenCodeManagedPaths.js'

export type OpenCodeLockFailure = {
  lockCode: 'ELOCKED' | 'ECOMPROMISED'
  lockCategory: 'registry' | 'profile' | 'startup' | 'unknown'
}

export function safeOpenCodeLockFailure(error: unknown): OpenCodeLockFailure | null {
  const row = error && typeof error === 'object' && !Array.isArray(error)
    ? error as Record<string, unknown> : null
  const code = row?.code
  if (code !== 'ELOCKED' && code !== 'ECOMPROMISED') return null
  const root = nodePath.join(resolveClaudeMultimodelPaths().data, 'opencode')
  const file = typeof row?.file === 'string' && nodePath.isAbsolute(row.file)
    && !row.file.includes('\0') ? nodePath.relative(root, nodePath.normalize(row.file)) : null
  const category = file === 'host-registry.json.lock' ? 'registry'
    : file && !file.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(file)
      && file !== '..' && file.split(nodePath.sep)[0] === 'profiles'
      && nodePath.basename(file) === 'node_modules.prepare-lock' ? 'profile'
    : file && file.split(nodePath.sep).length === 2
      && file.split(nodePath.sep)[0] === 'host-startup-locks'
      && /^[a-f0-9]{64}\.lock$/.test(nodePath.basename(file)) ? 'startup' : 'unknown'
  return { lockCode: code, lockCategory: category }
}

export function formatOpenCodeLockFailure(failure: OpenCodeLockFailure): string {
  return `OpenCode lock operation failed [code=${failure.lockCode}, lock=${failure.lockCategory}]`
}
