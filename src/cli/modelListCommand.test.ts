import { describe, expect, test } from 'bun:test'
import { createModelListCommand } from './modelListCommand.js'

describe('model list CLI contract', () => {
  test('preserves an explicit project with spaces as a single value', async () => {
    let args: unknown
    await createModelListCommand(async opts => { args = opts }).parseAsync([
      '--json', '--provider', 'opencode',
      '--project-path', '/Users/TEST/Library/CloudStorage/GoogleDrive/My Portfolio',
    ], { from: 'user' })
    expect(args).toMatchObject({
      json: true, provider: 'opencode',
      projectPath: '/Users/TEST/Library/CloudStorage/GoogleDrive/My Portfolio',
    })
  })
  test('preserves old calls without the project option', async () => {
    let args: unknown
    await createModelListCommand(async opts => { args = opts }).parseAsync([
      '--provider', 'opencode', '--json',
    ], { from: 'user' })
    expect(args).toMatchObject({ provider: 'opencode', json: true })
    expect(args).not.toHaveProperty('projectPath', '/Users/TEST')
  })
})
