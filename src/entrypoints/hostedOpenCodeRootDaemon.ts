import { HostedOpenCodeMemberSupervisorManager } from '../services/hostedControl/container/HostedOpenCodeMemberSupervisorManager.js'
import { HostedOpenCodeSupervisorRpcServer } from '../services/hostedControl/container/HostedOpenCodeSupervisorRpc.js'
import { DENIED_HOSTED_MEMBER_NETWORK_DOCKER_PORT, HostedMemberNetworkProvisioner } from
  '../services/hostedControl/containerNetworkProvisioning/HostedMemberNetworkProvisioner.js'
import { HostedRootDaemonInactiveComposition } from
  '../services/hostedControl/rootEffectDispatch/HostedRootDaemonInactiveComposition.js'

async function main(): Promise<void> {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 ||
    process.argv.length !== 4 || process.argv[2] !== '--config') {
    throw new Error('hosted-root-daemon-invocation-invalid')
  }
  process.umask(0o077)
  // All root-owned config, secrets, current Product members and immutable pins are
  // verified before the RPC socket can be bound. The proof has no effect route.
  const composition = await HostedRootDaemonInactiveComposition.load(process.argv[3])
  try {
    const config = composition.config
    const denyProductAuthority = async () => false
    const network = await HostedMemberNetworkProvisioner.create({
      stateDirectory: config.memberNetworkStateDirectory, admitMember: denyProductAuthority,
      rootDocker: DENIED_HOSTED_MEMBER_NETWORK_DOCKER_PORT,
    })
    const manager = await HostedOpenCodeMemberSupervisorManager.create({
      stateDirectory: config.memberManagerStateDirectory, network,
      admitMember: denyProductAuthority,
      assertEffectFence: denyProductAuthority,
      assertCleanupAuthority: denyProductAuthority,
      supervisorOptions: {
        image: config.image, bootstrapSha256: config.bootstrapSha256,
        workspaceParent: config.workspaceParent, profileParent: config.profileParent,
        configParent: config.configParent, seccompPath: config.seccompPath,
        seccompSha256: config.seccompSha256, apparmorProfile: config.apparmorProfile,
        handoffHelperPath: config.handoffHelperPath,
        handoffHelperSha256: config.handoffHelperSha256,
        handoffPythonSha256: config.handoffPythonSha256,
        ownerSocketDirectory: config.ownerSocketDirectory, ownerUid: config.ownerUid,
        serverPasswordKey: composition.serverPasswordKey,
      },
    })
    const server = new HostedOpenCodeSupervisorRpcServer({ socketPath: config.rpcSocketPath,
      secret: composition.rpcSecret, ownerGid: config.ownerGid, manager })
    await server.start()
    const shutdown = () => { void server.close().finally(() => { composition.close(); process.exit(0) }) }
    process.once('SIGTERM', shutdown)
    process.once('SIGINT', shutdown)
  } catch (error) {
    composition.close()
    throw error
  }
}

void main().catch(() => { process.stderr.write('hosted-root-daemon-start-failed\n'); process.exitCode = 1 })
