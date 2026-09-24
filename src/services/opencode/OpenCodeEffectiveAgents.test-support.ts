import path from 'node:path'

// Test-only HTTP response fixture: raw managed policies followed by OpenCode's
// documented Truncate exception, independently of the production validator.
export function effectiveAgentsFixture(config: Record<string, unknown>, xdgDataHome: string) {
  return Object.entries(config.agent as Record<string, { permission: Record<string, string | Record<string, string>> }>).map(([name, agent]) => ({
    name,
    permission: [
      { permission: '*', pattern: '*', action: 'allow' },
      ...Object.entries(agent.permission).flatMap(([permission, action]) => typeof action === 'string'
        ? [{ permission, pattern: '*', action }]
        : Object.entries(action).map(([pattern, action]) => ({ permission, pattern, action }))),
      { permission: 'external_directory', pattern: path.join(xdgDataHome, 'opencode', 'tool-output', '*'), action: 'allow' },
    ],
  }))
}
