import { readOpenCodePassiveProviderDirectory } from '../../services/opencode/OpenCodePassiveProviderDirectory.js'
import { buildOpenCodePassiveRuntimeStatus } from '../../services/runtimeBackends/openCodePassiveStatus.js'
import type { ProviderDirectoryFilter } from '../../features/runtimeProviderManagement/domain/types.js'
import type { OpenCodePassiveStatusV1 } from '../../services/opencode/OpenCodePassiveStatusContract.js'

export async function runtimeOpenCodePassiveStatus(opts: {
  projectPath?: string
  text?: boolean
  getOpenCodePassiveStatus?: (input: { projectPath: string; providerIds: readonly string[]; timeoutMs: number }) => Promise<OpenCodePassiveStatusV1>
  stdoutWrite?: (text: string) => unknown
} = {}): Promise<void> {
  const status = await buildOpenCodePassiveRuntimeStatus({
    openCodeProjectPath: opts.projectPath?.trim() || process.cwd(),
    getOpenCodePassiveStatus: opts.getOpenCodePassiveStatus,
  })
  const write = opts.stdoutWrite ?? (text => process.stdout.write(text))
  if (opts.text) {
    write(`${status.displayName}: ${status.statusMessage}\n`)
    write(`  authenticated: no\n`)
    write(`  launch: not authorized\n`)
    write(`  detail: ${status.detailMessage ?? 'none'}\n`)
    return
  }
  write(`${JSON.stringify({ schemaVersion: 2, providers: { opencode: status } }, null, 2)}\n`)
}

export async function runtimeOpenCodePassiveProviderDirectory(opts: {
  projectPath?: string
  query?: string
  filter?: string
  limit?: number
  cursor?: string
  getOpenCodePassiveStatus?: (input: { projectPath: string; providerIds: readonly string[]; timeoutMs: number }) => Promise<OpenCodePassiveStatusV1>
  stdoutWrite?: (text: string) => unknown
}): Promise<void> {
  const allowedFilters = new Set(['all', 'connected', 'configured', 'connectable', 'manual', 'has-models'])
  const filter = opts.filter && allowedFilters.has(opts.filter)
    ? opts.filter as ProviderDirectoryFilter
    : null
  const directory = await readOpenCodePassiveProviderDirectory({
    projectPath: opts.projectPath?.trim() || process.cwd(),
    query: opts.query?.trim() || null,
    filter,
    limit: opts.limit ?? null,
    cursor: opts.cursor?.trim() || null,
  }, opts.getOpenCodePassiveStatus ?? null)
  const write = opts.stdoutWrite ?? (text => process.stdout.write(text))
  write(`${JSON.stringify({ schemaVersion: 1, runtimeId: 'opencode', directory }, null, 2)}\n`)
}
