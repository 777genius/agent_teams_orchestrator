// Test double for the owner CLI started by NativeHostLocalTeamLifecycleLane.
// Lead mode: reads the bootstrap spec, optionally starts one detached process
// teammate recorded in config.json, publishes bootstrap-state.json, then idles.
// Teammate mode: idles with process-backend argv so identity checks can match it.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

if (args[0] !== 'teammate') {
  const spec = JSON.parse(readFileSync(flag('--team-bootstrap-spec')!, 'utf8')) as {
    runId: string
    team: { name: string }
    members: Array<{ name: string }>
  }
  const teamRoot = join(process.env.CLAUDE_CONFIG_DIR!, 'teams', spec.team.name)
  writeFileSync(join(teamRoot, 'fake-lead-env.json'), JSON.stringify(process.env), { mode: 0o600 })
  // Like spawnMultiAgent, the durable owner-token claim is published before the process exists.
  const members: Array<Record<string, unknown>> = spec.members.map(member => ({
    agentId: `${member.name}@${spec.team.name}`, name: member.name, backendType: 'process',
    tmuxPaneId: 'process:pending', processOwnerToken: randomUUID(), processRunId: 'fake-session',
  }))
  const publish = () => {
    writeFileSync(join(teamRoot, 'config.json.tmp'), JSON.stringify({ name: spec.team.name, members }))
    renameSync(join(teamRoot, 'config.json.tmp'), join(teamRoot, 'config.json'))
  }
  publish()
  for (const member of members) {
    const child = spawn(process.execPath, [
      process.argv[1]!, 'teammate', '--agent-id', String(member.agentId), '--team-name', spec.team.name,
      '--process-owner-token', String(member.processOwnerToken), '--parent-session-id', 'fake-session',
    ], { detached: true, stdio: 'ignore' })
    child.unref()
    Object.assign(member, { tmuxPaneId: `process:${child.pid}`, runtimePid: child.pid })
  }
  publish()
  setTimeout(() => {
    writeFileSync(join(teamRoot, 'bootstrap-state.json'),
      JSON.stringify({ version: 1, runId: spec.runId, phase: 'completed' }))
  }, 50)
}

setInterval(() => undefined, 60_000)
