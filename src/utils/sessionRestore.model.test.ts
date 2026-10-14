import { afterEach, describe, expect, it } from 'bun:test'
import {
  getMainLoopModelOverride,
  setMainLoopModelOverride,
  setMainThreadAgentType,
} from '../bootstrap/state.js'
import type {
  AgentDefinition,
  AgentDefinitionsResult,
} from '../tools/AgentTool/loadAgentsDir.js'
import { restoreAgentFromSession } from './sessionRestore.js'

function agent(model: string): AgentDefinition {
  return {
    agentType: 'resumed-agent',
    whenToUse: 'test',
    getSystemPrompt: () => '',
    tools: ['*'],
    source: 'projectSettings',
    permissionMode: 'default',
    model,
  } as AgentDefinition
}

function definitions(
  activeAgents: AgentDefinition[],
): AgentDefinitionsResult {
  return {
    activeAgents,
    allAgents: activeAgents,
    allowedAgentTypes: activeAgents.map(entry => entry.agentType),
  } as AgentDefinitionsResult
}

afterEach(() => {
  setMainLoopModelOverride(undefined)
  setMainThreadAgentType(undefined)
})

describe('session resume model selection', () => {
  it('keeps an explicit startup/session override instead of adopting the resumed agent model', () => {
    const resumedAgent = agent('claude-haiku-5')
    setMainLoopModelOverride('claude-opus-5-5')

    const result = restoreAgentFromSession(
      resumedAgent.agentType,
      undefined,
      definitions([resumedAgent]),
    )

    expect(result.agentDefinition).toBe(resumedAgent)
    expect(getMainLoopModelOverride()).toBe('claude-opus-5-5')
  })

  it('restores an exact agent model only when no explicit override exists', () => {
    const resumedAgent = agent('claude-opus-5-5[1m]')

    restoreAgentFromSession(
      resumedAgent.agentType,
      undefined,
      definitions([resumedAgent]),
    )

    expect(getMainLoopModelOverride()).toBe('claude-opus-5-5[1m]')
  })
})
