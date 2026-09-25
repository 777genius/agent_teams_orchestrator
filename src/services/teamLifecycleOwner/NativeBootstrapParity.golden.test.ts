import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTeamBootstrapSpec } from '../teamBootstrap/teamBootstrapSpec.js'
import {
  buildNativeBootstrapSpec,
  NATIVE_LANE_DISALLOWED_TOOLS,
  nativeBootstrapTimeoutMs,
  type NativeHostLocalLaunchShape,
} from './NativeHostLocalLanePlan.js'

// The same bytes live in agent-teams-ai docs/; both repositories pin this digest.
const GOLDEN_SHA256 = 'f48d98ffbdbc85248a01fd1ebbb00cf37d2f3c1f49d7b641cb25bc0825018f54'

type Json = Record<string, unknown>
type Golden = {
  format: string
  disallowedTools: string
  bootstrapTimeoutMs: Array<{ teammates: number; timeoutMs: number }>
  desktopCreateSpec: Json & { team: { name: string; cwd: string }; members: Json[] }
}

const raw = readFileSync(new URL('../../../docs/hosted-native-bootstrap-parity-golden.json', import.meta.url))
const golden = JSON.parse(raw.toString('utf8')) as Golden
const desktop = golden.desktopCreateSpec

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

/** The hosted lane for the same roster: the desktop member workflow is the hosted member prompt. */
function hostedSpec(workspaceRoot: string): Json {
  const shape = {
    lane: { laneId: 'native-lane', kind: 'native', provider: 'anthropic', members: [] },
    provider: 'anthropic',
    lead: { name: 'team-lead', prompt: 'Lead the team.' },
    teammates: desktop.members.map(member => ({
      name: String(member.name),
      prompt: String(member.workflow),
      ...(member.model ? { model: String(member.model) } : {}),
      ...(member.effort ? { effort: String(member.effort) } : {}),
    })),
  } as unknown as NativeHostLocalLaunchShape
  return buildNativeBootstrapSpec({
    runId: String(desktop.runId), teamName: desktop.team.name, workspaceRoot, mode: 'create', shape,
  })
}

describe('hosted native bootstrap parity cross-repository golden', () => {
  test('uses the shared Product-generated vector', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(GOLDEN_SHA256)
    expect(golden.format).toBe('agent-teams.hosted-native-bootstrap-parity-golden/v1')
  })

  test('disallows the same app-owned tools and budgets bootstrap like the desktop launch', () => {
    expect(NATIVE_LANE_DISALLOWED_TOOLS).toBe(golden.disallowedTools)
    for (const { teammates, timeoutMs } of golden.bootstrapTimeoutMs) {
      expect({ teammates, timeoutMs: nativeBootstrapTimeoutMs(teammates) }).toEqual({ teammates, timeoutMs })
    }
  })

  test('builds the desktop spec for the same roster, less the desktop-only lead language', () => {
    const hosted = hostedSpec(desktop.team.cwd)
    const { lead: _desktopLead, ...desktopShared } = desktop
    const { lead: hostedLead, ...hostedShared } = hosted
    expect(hostedLead).toEqual({})
    expect(hostedShared).toEqual(desktopShared)
  })

  test('both specs pass the runtime bootstrap spec reader', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'native-bootstrap-parity-')))
    roots.push(root)
    const relocate = (spec: Json): Json => JSON.parse(JSON.stringify(spec).replaceAll(desktop.team.cwd, root))
    const read = async (name: string, spec: Json) => {
      const path = join(root, `${name}.json`)
      await writeFile(path, JSON.stringify(spec), { mode: 0o600 })
      const request = await readTeamBootstrapSpec(path)
      return {
        cwd: request.cwd,
        bootstrapTimeoutMs: request.bootstrapTimeoutMs,
        continueOnPartialFailure: request.continueOnPartialFailure,
        emitStructuredEvents: request.emitStructuredEvents,
        members: request.members.map(({ originalName, provider, workflow, prompt }) =>
          ({ originalName, provider, workflow, prompt })),
      }
    }
    const fromDesktop = await read('desktop', relocate(desktop))
    expect(fromDesktop.members.map(member => member.originalName))
      .toEqual(desktop.members.map(member => String(member.name)))
    // Hosted drafts carry no agent language yet, so teammates miss the desktop language line.
    const withoutLanguage = await read('desktop-without-language', relocate({ ...desktop, lead: {} }))
    expect(withoutLanguage).not.toEqual(fromDesktop)
    expect(await read('hosted', hostedSpec(root))).toEqual(withoutLanguage)
  })
})
