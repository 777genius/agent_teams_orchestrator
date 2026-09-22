import { runHostedControlSocketBroker } from '../HostedControlSocketBroker.js'

void runHostedControlSocketBroker(process.argv.slice(2)).catch(() => {
  process.kill(process.pid, 'SIGKILL')
})
