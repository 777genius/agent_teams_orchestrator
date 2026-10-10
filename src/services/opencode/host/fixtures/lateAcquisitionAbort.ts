import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { acquireOpenCodeV2ReadHost } from '../OpenCodeHostNativeAdapter.js'
import type { OpenCodeV2NativeIdentity } from '../../compatibility/OpenCodeNativeIdentity.js'

// A real isolated adapter caller. Control files belong to this TEST invocation;
// there are no substituted filesystem, process, server, or adapter functions.
const [root, project, executablePath, executableSha256, pin] = process.argv.slice(2)
if (!root || !project || !executablePath || !executableSha256 || (pin !== '2.0.0' && pin !== '2.0.21')) {
  throw new Error('Invalid lifecycle fixture arguments')
}
const native: OpenCodeV2NativeIdentity = {
  generation: 'v2', version: pin, dialect: pin === '2.0.0' ? 'v2-2.0.0' : 'v2-2.0.21',
  executablePath, executableSha256, packageName: '@opencode/cli-test-fixture',
}
const controller = new AbortController()
const reason = new Error('late-executable-abort')
let begin: (() => void) | undefined
const begun = new Promise<void>(resolve => { begin = resolve })
const poll = setInterval(() => {
  if (existsSync(path.join(root, 'begin'))) { begin?.(); begin = undefined }
  if (!controller.signal.aborted && existsSync(path.join(root, 'abort'))) {
    controller.abort(reason)
    writeFileSync(path.join(root, 'aborted'), 'late-executable-abort')
  }
}, 2)
writeFileSync(path.join(root, 'ready'), JSON.stringify({ pid: process.pid }))
try {
  await begun
  const host = await acquireOpenCodeV2ReadHost(native, project, { signal: controller.signal })
  await host.close()
  writeFileSync(path.join(root, 'result'), JSON.stringify({ outcome: 'acquired' }))
} catch (error) {
  writeFileSync(path.join(root, 'result'), JSON.stringify({
    outcome: 'rejected', sameAbortReason: error === reason,
    aborted: controller.signal.aborted,
    error: error instanceof Error ? error.message : 'non-error',
  }))
} finally {
  clearInterval(poll)
}
