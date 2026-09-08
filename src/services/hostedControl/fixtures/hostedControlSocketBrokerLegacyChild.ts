import { runHostedControlSocketBrokerLegacy } from '../HostedControlSocketBrokerLegacy.js'

void runHostedControlSocketBrokerLegacy(process.argv.slice(2)).catch(() => {
  process.kill(process.pid, 'SIGKILL')
})
