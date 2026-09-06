const args = process.argv.slice(2)
if (args[0] === '--hosted-control-socket-broker') {
  const { runHostedControlSocketBroker } = await import('../../src/services/hostedControl/HostedControlSocketBroker.js')
  await runHostedControlSocketBroker(args.slice(1))
} else if (args[0]?.startsWith('--hosted-actual-owner-sealed-protocol=')) {
  const { runActualOwnerV2 } = await import('./hosted-actual-owner/entry-v2.js')
  await runActualOwnerV2(args)
} else {
  const { runActualOwnerAcceptance } = await import('./hosted-actual-owner/owner.js')
  await runActualOwnerAcceptance(args)
}

export {}
