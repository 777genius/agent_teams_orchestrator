// Compile-time selector only. Source invocations retain the legacy acceptance
// command; the supported native build excludes its desktop dependency closure.
declare const HOSTED_ACTUAL_OWNER_NATIVE_BUILD: boolean

const args = process.argv.slice(2)
if (args[0] === '--hosted-control-socket-broker') {
  const { runHostedControlSocketBroker } = await import('../../src/services/hostedControl/HostedControlSocketBroker.js')
  await runHostedControlSocketBroker(args.slice(1))
} else if (args[0]?.startsWith('--hosted-actual-owner-sealed-protocol=')) {
  const { runActualOwnerV2 } = await import('./hosted-actual-owner/entry-v2.js')
  await runActualOwnerV2(args)
} else if (typeof HOSTED_ACTUAL_OWNER_NATIVE_BUILD === 'undefined' || !HOSTED_ACTUAL_OWNER_NATIVE_BUILD) {
  const { runActualOwnerAcceptance } = await import('./hosted-actual-owner/owner.js')
  await runActualOwnerAcceptance(args)
} else {
  throw new Error('hosted_owner_v2_invocation')
}

export {}
