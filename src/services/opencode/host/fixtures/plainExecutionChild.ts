// TEST child for OpenCodeV2PlainExecution: answers the handshake, then starts one
// command in its own process group, as an agent shell command would.
import { spawn } from 'node:child_process'
import { preparePlainExecutionChild } from '../OpenCodeV2PlainExecution.js'

process.on('message', value => {
  void preparePlainExecutionChild(value).then(() => {
    const command = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    process.send!({ type: 'command', pid: command.pid })
  })
})
