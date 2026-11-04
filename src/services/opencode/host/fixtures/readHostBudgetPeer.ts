// No native server, network, credentials or user files: this peer only speaks
// the private startup/close protocol for acquisition-budget regression tests.
const watchdog = setTimeout(() => process.exit(1), 20_000)
process.once('disconnect', () => process.exit(0))
process.on('message', (input: unknown) => {
  if (!input || typeof input !== 'object') process.exit(1)
  const row = input as Record<string, unknown>
  if (row.type === 'start') {
    process.send?.({ type: 'ready', nonce: row.nonce, pid: process.pid,
      version: row.pin, moduleSha256: row.moduleSha256,
      executableSha256: row.executableSha256, baseUrl: 'http://127.0.0.1:12345' })
  } else if (row.type === 'close') {
    clearTimeout(watchdog)
    if (!process.send) process.exit(1)
    process.send({ type: 'closed', nonce: row.nonce }, error => {
      process.disconnect?.(); process.exit(error ? 1 : 0)
    })
  } else process.exit(1)
})
