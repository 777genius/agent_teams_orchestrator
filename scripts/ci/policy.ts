import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Keep routine source work on Linux. Native boundaries need Windows as well.
const policyPath = /^(?:\.github\/workflows\/|scripts\/ci\/)/
const platformPath = /^(?:package\.json$|bun\.lock$|tsconfig[^/]*\.json$|cli(?:-source)?$|install\.sh$|scripts\/(?:package-runtime\.ts$|runtime-bun-pins\.json$|opencode-v2\/|(?:build|compile)[^/]*)|features\/|src\/(?:native-ts\/|entrypoints\/|cli\/packagedOpenCodeDelivery[^/]*)|src\/utils\/(?:platform|nativeInstaller|subprocessEnv))/
const lifecyclePath = /^(?:src\/services\/(?:runtimeBackends|teamBootstrap|codexNative)\/|src\/features\/runtimeProviderManagement\/(?:application|adapters|domain|ports)\/|src\/utils\/(?:process(?:\.ts$|Kill\.)|genericProcessUtils|swarm\/|windowsNativeProcess)|src\/services\/opencode\/host\/OpenCodeV2PlainExecution|src\/tools\/shared\/spawnMultiAgent|src\/cli\/(?:handlers\/(?:runtime|model(?:\.test)?\.ts$|anthropicCompatibleRuntime\.integration\.test\.ts$)|(?:runtimeStatusCommand|effectiveDefaultModel)\.entry\.test\.ts$)|scripts\/(?:opencode-.*conformance|smoke\/windows-runtime-opencode)|test\/fixtures\/opencode-generation-native\/)/
// The real V2 execution lane runs on Linux, so it follows the V2 execution, catalog
// and provider code, not only native boundaries (host/ is not one).
const v2LinuxPath = /^(?:src\/services\/opencode\/(?:host|execution|bridge|catalog|compatibility|transport|profile)\/|src\/entrypoints\/opencodeV2|src\/features\/runtimeProviderManagement\/adapters\/opencode\/|scripts\/opencode-v2\/|scripts\/opencode-v2-(?:anonymous|team)-native-e2e\.ts$|scripts\/ci\/opencode-v2-linux-execution\.sh$|patches\/)/
const authorityPath = /^src\/services\/opencode\/(?:types\.ts$|recovery-contract\/|compatibility\/OpenCodeVersionProbe(?:\.ts$|\.helperBudget\.test\.ts$)|OpenCode[^/]*(?:Authority|Recovery|Identity|Attribution|Host|BinaryResolver|ProvisioningProbe|ExecutionProof|Launch|Startup|Stop|Cursor|Profile|Session|Native|OAuth|ExecutionProbe|ManagedPaths|AuthCoordination|AuthStore|RuntimeDeadline|EffectiveAgentPolicyContract|BridgePreconditions|BridgeCommandHandler|McpManager))/
const custodyPath = /^(?:native\/opencode-custody\/|src\/services\/opencode\/(?:native\/|OpenCodeClientFactory(?:\.test)?\.ts$)|scripts\/stage-opencode-custody\.mts$|scripts\/lib\/opencode-custody-artifact(?:\.test)?\.ts$)/

export function classify(paths: string[], full = false) {
  const native = full || paths.some(path => policyPath.test(path) || platformPath.test(path) || lifecyclePath.test(path) || authorityPath.test(path) || custodyPath.test(path))
  return {
    native: String(native),
    authority_os: JSON.stringify(native ? ['ubuntu-latest', 'windows-latest'] : ['ubuntu-latest']),
    reason: full ? 'Explicit full validation request' : native ? 'CI policy, platform or process/provider lifecycle boundary changed' : 'Routine change: Linux authority, client/headless, ledger and Cursor checks; native jobs skipped',
    v2_linux: String(native || paths.some(path => v2LinuxPath.test(path))),
  }
}

export function diffArgs(event: string, base: string, head: string): string[] {
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error('Invalid event head SHA')
  if (event === 'push' && /^0{40}$/.test(base)) return ['ls-tree', '-r', '--name-only', '-z', head]
  if (!/^[a-f0-9]{40}$/.test(base) || /^0{40}$/.test(base)) throw new Error('Invalid event base SHA')
  if (event !== 'pull_request' && event !== 'push') throw new Error('Unsupported diff event')
  // No rename detection: deleting/renaming away a risk path still selects it.
  return ['diff', '--name-only', '-z', '--no-renames', event === 'pull_request' ? `${base}...${head}` : base, ...(event === 'push' ? [head] : []), '--']
}

export function parsePaths(output: string): string[] {
  if (output && !output.endsWith('\0')) throw new Error('Truncated changed-path output')
  return output.split('\0').filter(Boolean)
}

type Need = { result: string; outputs?: Record<string, string> }
export function aggregate(needs: Record<string, Need>): string {
  const scope = needs.scope
  if (scope?.result !== 'success') throw new Error('Classifier failed, cancelled or skipped')
  const native = scope.outputs?.native
  const reason = scope.outputs?.reason
  const v2Linux = scope.outputs?.v2_linux
  if (!['true', 'false'].includes(native ?? '') || !reason?.trim()) throw new Error('Missing classifier decision/reason')
  if (!['true', 'false'].includes(v2Linux ?? '') || (native === 'true' && v2Linux !== 'true')) throw new Error('Missing V2 Linux decision')
  const required = ['cursor-managed-plugin', 'task-change-ledger', 'opencode-authority']
  const optional = ['windows-packaged-backfill', 'opencode-conformance', 'packaged-delivery', 'opencode-native-custody']
  for (const job of [...required, ...optional]) {
    const result = needs[job]?.result
    const allowedSkip = native === 'false' && optional.includes(job)
    if (result !== 'success' && !(allowedSkip && result === 'skipped')) throw new Error(`${job}: ${result ?? 'missing'}`)
  }
  for (const job of ['opencode-v2-linux', 'opencode-v2-desktop-lifecycle']) {
    const result = needs[job]?.result
    if (result !== 'success' && !(v2Linux === 'false' && result === 'skipped')) throw new Error(`${job}: ${result ?? 'missing'}`)
  }
  return reason
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'aggregate') {
    console.log(aggregate(JSON.parse(process.env.CI_NEEDS ?? '{}')))
  } else if (process.argv[2] === 'classify') {
    const event = process.env.CI_EVENT ?? ''
    const full = event === 'workflow_dispatch' && process.env.CI_FULL === 'true'
    if (event === 'workflow_dispatch' && !full) throw new Error('Dispatch requires full validation')
    const paths = full ? [] : parsePaths(execFileSync('git', diffArgs(event, process.env.CI_BASE ?? '', process.env.CI_HEAD ?? ''), { encoding: 'utf8' }))
    const decision = classify(paths, full)
    if (!process.env.GITHUB_OUTPUT) throw new Error('Missing GITHUB_OUTPUT')
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(decision).map(([key, value]) => `${key}=${value}\n`).join(''))
    console.log(decision.reason)
  } else {
    throw new Error('Expected classify or aggregate')
  }
}
