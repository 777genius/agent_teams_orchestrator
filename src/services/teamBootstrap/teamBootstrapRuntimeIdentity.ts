import { getTeammateCommand } from 'src/utils/swarm/spawnUtils.js'

export type TeamBootstrapRuntimeIdentity = {
  execPath: string
  scriptPath: string | null
  runtimeVersion: string
  teammateCommand: string
}

export function getCurrentTeamBootstrapRuntimeIdentity(): TeamBootstrapRuntimeIdentity {
  return {
    execPath: process.execPath,
    scriptPath: process.argv[1] ?? null,
    runtimeVersion: process.versions.bun ?? process.version,
    teammateCommand: getTeammateCommand(),
  }
}

export function assertStableTeamBootstrapRuntimeIdentity(params: {
  teamName: string
  expected: TeamBootstrapRuntimeIdentity
  current?: TeamBootstrapRuntimeIdentity
}): void {
  const current = params.current ?? getCurrentTeamBootstrapRuntimeIdentity()
  if (
    current.execPath !== params.expected.execPath ||
    current.scriptPath !== params.expected.scriptPath ||
    current.runtimeVersion !== params.expected.runtimeVersion ||
    current.teammateCommand !== params.expected.teammateCommand
  ) {
    throw new Error(
      `Deterministic bootstrap cannot continue team "${params.teamName}" because the runtime executable identity changed during launch.`,
    )
  }
}
