import path from 'node:path'
import { realpath, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { executionAssert } from '../execution/OpenCodeV2ExecutionContracts.js'

/** Resolve only the current delivery layout. A JS bundle never falls back to source. */
export function classifyOpenCodeV2ExecutionDelivery(location: string) {
  executionAssert(![location, Bun.main].some(value => value.includes('$bunfs') || /[/\\]~BUN[/\\]/.test(value)), 'v2_compiled_runtime_unsupported')
  const file = fileURLToPath(location)
  const source = /\/src\/(?:services\/opencode\/(?:host|profile|bridge)\/[^/]+|entrypoints\/opencodeV2(?:ExecutionServer|RunOwner))\.ts$/.test(file)
  const packaged = /\/(?:cli|cli-dev|opencodeV2ExecutionServer|opencodeV2RunOwner)\.js$/.test(file)
  executionAssert(source || packaged, 'v2_execution_layout_unsupported')
  return { file, source }
}

export async function resolveOpenCodeV2ExecutionDelivery(location: string, child: 'execution' | 'run-owner') {
  const { file, source } = classifyOpenCodeV2ExecutionDelivery(location)
  const root = await realpath(source ? file.slice(0, file.lastIndexOf('/src/')) : path.dirname(file))
  const name = child === 'execution' ? 'opencodeV2ExecutionServer' : 'opencodeV2RunOwner'
  const entryPath = await realpath(path.join(root, source ? `src/entrypoints/${name}.ts` : `${name}.js`))
  executionAssert(entryPath === path.join(root, source ? `src/entrypoints/${name}.ts` : `${name}.js`), 'execution_entry_changed')
  return { runtimeMode: source ? 'source' as const : 'packaged' as const, root, entryPath,
    entrySha256: createHash('sha256').update(await readFile(entryPath)).digest('hex') }
}
