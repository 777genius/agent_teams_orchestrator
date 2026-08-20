import { runOpenCodeProviderCatalogAttemptAllocationWorkerOperation } from './OpenCodeProviderCatalogService.js'

type Request = Readonly<{
  id: string
  scope: string
  startedAt: number
  budgetMs: number
  cacheHome: string
  windowsPlatformAuthority: boolean
  testStallPhase?: 'open' | 'commit' | 'after-commit'
  testGate?: Readonly<{ phase: 'open' | 'commit' | 'after-commit'; path: string }>
}>

const decoder = new TextDecoder()
let pending = ''
for await (const chunk of Bun.stdin.stream()) {
  pending += decoder.decode(chunk, { stream: true })
  for (;;) {
    const newline = pending.indexOf('\n')
    if (newline < 0) break
    const line = pending.slice(0, newline)
    pending = pending.slice(newline + 1)
    if (!line) continue
    let request: Request
    try { request = JSON.parse(line) as Request }
    catch { process.exit(1) }
    try {
      const result = await runOpenCodeProviderCatalogAttemptAllocationWorkerOperation(
        request.scope,
        request.startedAt,
        {
          deadline: performance.now() + request.budgetMs,
          cacheHome: request.cacheHome,
          windowsPlatformAuthority: request.windowsPlatformAuthority,
          testStallPhase: request.testStallPhase,
          testGate: request.testGate,
        },
      )
      process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`)
    } catch {
      process.stdout.write(`${JSON.stringify({ id: request.id, failed: true })}\n`)
    }
  }
}
