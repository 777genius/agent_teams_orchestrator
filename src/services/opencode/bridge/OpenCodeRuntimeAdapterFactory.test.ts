import { describe, expect, test } from 'bun:test'
import { selectOpenCodeRuntimeAdapter, openCodeV2BridgeCompositionIsConcrete,
  OPENCODE_V2_TEAM_BRIDGE_CAPABILITIES, type OpenCodeSessionSemanticPorts } from './OpenCodeRuntimeAdapterFactory.js'

describe('generation composition', () => {
  test('V1 invokes the unchanged indexed semantic port and never constructs V2', async () => {
    type EnsureInput = Parameters<OpenCodeSessionSemanticPorts['ensureSession']>[0]
    let captured: EnsureInput | null = null
    const v1: Pick<OpenCodeSessionSemanticPorts, 'ensureSession'> = { ensureSession: async params => {
      captured = params; throw new Error('synthetic session authority')
    } }
    const selected = selectOpenCodeRuntimeAdapter({ generation: 'v1', version: '1.18.2' }, {
      v1: () => v1,
      v2: () => { throw new Error('V2 invoked for V1') },
    })
    expect(selected.generation).toBe('v1')
    if (selected.generation === 'v1') {
      expect(selected.adapter).toBe(v1)
      const input: EnsureInput = { teamId: 'TEST', memberName: 'worker', selectedModel: 'provider/model',
        runId: 'run', fresh: false, toolApprovalMode: 'manual' }
      await expect(selected.adapter.ensureSession(input)).rejects.toThrow('synthetic session authority')
      expect(captured === input).toBe(true)
    }
  })
  test.each(['2.0.0', '2.0.32'] as const)('pin %s does not touch the V1 path', pin => {
    const selected = selectOpenCodeRuntimeAdapter({ generation: 'v2', version: pin, dialect: `v2-${pin}` }, {
      v1: () => { throw new Error('V1 invoked for V2') },
      v2: selectedPin => ({ selectedPin }),
    })
    expect(selected).toEqual({ generation: 'v2', adapter: { selectedPin: pin } })
  })
  test('unsupported admission invokes neither adapter and preserves capsfalse', () => {
    const denied = () => { throw new Error('unsupported constructed a client') }
    expect(selectOpenCodeRuntimeAdapter({ generation: 'unsupported', version: '2.1.0' }, {
      v1: denied, v2: denied,
    })).toEqual({ generation: 'unsupported', version: '2.1.0' })
    expect(OPENCODE_V2_TEAM_BRIDGE_CAPABILITIES).toEqual({ teamLaunch: false, memberSession: false, permission: false })
    expect(openCodeV2BridgeCompositionIsConcrete({ sourceLinux: true, supportedPin: true,
      ownerCallable: true, selectedProfileVerified: true, persistentBootstrapVerified: true,
      controllerMcpSchemasVerified: false })).toBe(false)
  })
})
