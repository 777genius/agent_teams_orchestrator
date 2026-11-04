// TEST child for OpenCodeV2PlainExecution: answers the handshake, then starts one
// command, as an agent shell command would. TEST_PLAIN_CHILD_MODE selects a broken
// handshake: `foreign-nonce`, `wrong-pid` or `silent`.
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { preparePlainExecutionChild, readPlainExecutionBirth } from '../OpenCodeV2PlainExecution.js'

const mode = process.env.TEST_PLAIN_CHILD_MODE ?? 'normal'
process.on('message', (value: { nonce?: string; leaseOwnerId?: string }) => {
  void (async () => {
    if (mode === 'silent') return
    if (mode === 'foreign-nonce') { await preparePlainExecutionChild({ ...value, nonce: randomUUID() }); return }
    if (mode === 'wrong-pid') {
      process.send!({ type: 'prepared', nonce: value.nonce, leaseOwnerId: value.leaseOwnerId, pid: process.pid + 1,
        birth: await readPlainExecutionBirth(process.pid), namespace: 'process',
        executableSha256: createHash('sha256').update(await readFile(process.execPath)).digest('hex') })
      return
    }
    await preparePlainExecutionChild(value)
    const command = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
    process.send!({ type: 'command', pid: command.pid })
  })()
})
