import path from 'node:path'
import {
  OPEN_CODE_TEAMMATE_AGENT_NAME,
  OPEN_CODE_TEAMMATE_BOOTSTRAP_AGENT_NAME,
  OPEN_CODE_MODEL_PROBE_AGENT_NAME,
} from './OpenCodeAgentNames.js'

type Action = 'allow' | 'ask' | 'deny'
type Rule = Readonly<{ permission: string; pattern: string; action: Action }>
export type ExpectedOpenCodeAgentPolicies = readonly Readonly<{ name: string; rules: readonly Rule[] }>[]
const names = [OPEN_CODE_TEAMMATE_AGENT_NAME, OPEN_CODE_TEAMMATE_BOOTSTRAP_AGENT_NAME, OPEN_CODE_MODEL_PROBE_AGENT_NAME]
const invalid = (): never => { throw new TypeError('Invalid OpenCode effective agent policy contract') }

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid()
  return value as Record<string, unknown>
}

function read(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor?.enumerable || !('value' in descriptor)) return invalid()
  return descriptor.value
}

function keys(value: object): string[] {
  const result = Object.keys(value)
  if (Reflect.ownKeys(value).length !== result.length) return invalid()
  return result
}

function action(value: unknown): Action {
  if (value !== 'allow' && value !== 'ask' && value !== 'deny') return invalid()
  return value
}

function rule(permission: string, pattern: string, value: unknown): Rule {
  if (!permission || !pattern) return invalid()
  return Object.freeze({ permission, pattern, action: action(value) })
}

/** Capture ordered raw permissions before any await; no upstream defaults or policy evaluator. */
export function buildExpectedOpenCodeAgentPolicies(config: unknown, xdgDataHome: string): ExpectedOpenCodeAgentPolicies {
  try {
    if (typeof xdgDataHome !== 'string' || !path.isAbsolute(xdgDataHome) || xdgDataHome.includes('\0')) return invalid()
    const root = record(config)
    if (Object.hasOwn(root, 'permission')) return invalid()
    const agents = record(read(root, 'agent'))
    return Object.freeze(names.map(name => {
      const policy = record(read(record(read(agents, name)), 'permission'))
      const permissions = keys(policy)
      if (permissions[0] !== '*' || !['deny', 'ask'].includes(read(policy, '*') as string)) return invalid()
      const rules: Rule[] = []
      for (const permission of permissions) {
        const value = read(policy, permission)
        if (typeof value === 'string') rules.push(rule(permission, '*', value))
        else {
          const patterns = record(value)
          const orderedPatterns = keys(patterns)
          if (!orderedPatterns.length) return invalid()
          for (const pattern of orderedPatterns) rules.push(rule(permission, pattern, read(patterns, pattern)))
        }
      }
      rules.push(rule('external_directory', path.join(xdgDataHome, 'opencode', 'tool-output', '*'), 'allow'))
      return Object.freeze({ name, rules: Object.freeze(rules) })
    }))
  } catch { return invalid() }
}

function liveRules(value: unknown): Rule[] {
  if (!Array.isArray(value) || Object.keys(value).length !== value.length || Object.getOwnPropertySymbols(value).length) return invalid()
  return Array.from({ length: value.length }, (_, index) => {
    const source = record(read(value, String(index)))
    const fields = keys(source)
    if (fields.length !== 3 || !fields.every(key => ['permission', 'pattern', 'action'].includes(key))) return invalid()
    const permission = read(source, 'permission')
    const pattern = read(source, 'pattern')
    if (typeof permission !== 'string' || typeof pattern !== 'string') return invalid()
    return rule(permission, pattern, read(source, 'action'))
  })
}

export function assertOpenCodeEffectiveAgentPolicies(expected: ExpectedOpenCodeAgentPolicies, liveAgents: unknown): void {
  try {
    if (!Array.isArray(liveAgents)) return invalid()
    for (const policy of expected) {
      const matches = liveAgents.filter(agent => read(record(agent), 'name') === policy.name)
      if (matches.length !== 1) return invalid()
      const rules = liveRules(read(record(matches[0]), 'permission'))
      // Last-match semantics prove that this universal reset shadows every prefix rule.
      const reset = rules.findLastIndex(value => value.permission === '*' && value.pattern === '*')
      if (reset < 0 || rules.length - reset !== policy.rules.length) return invalid()
      for (let index = 0; index < policy.rules.length; index++) {
        const actual = rules[reset + index]
        const wanted = policy.rules[index]
        if (actual.permission !== wanted.permission || actual.pattern !== wanted.pattern || actual.action !== wanted.action) return invalid()
      }
    }
  } catch { return invalid() }
}
