import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

// Run module mocks in separate processes so native/packaged suites retain their real ports.
for (const scenario of ['slow', 'near-limit', 'caller-limit', 'expired', 'abort', 'tampered']) {
  test(`read-host loading budget: ${scenario}`, async () => {
    const fixture = fileURLToPath(new URL('./fixtures/readHostLoadingBudget.ts', import.meta.url))
    const child = Bun.spawn([process.execPath, fixture, scenario], { stdout: 'pipe', stderr: 'pipe' })
    const watchdog = setTimeout(() => child.kill(), 10_000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited,
        new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect(stderr).toBe('')
      expect(code).toBe(0)
      expect(JSON.parse(stdout)).toMatchObject({ scenario, ok: true })
    } finally { clearTimeout(watchdog); if (child.exitCode === null) { child.kill(); await child.exited } }
  }, 15_000)
}
