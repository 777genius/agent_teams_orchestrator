import { expect, test } from 'bun:test'
import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ownerSource, persistentRoot } from './baseline'
import { command, testProject } from './isolation'
const bun = path.join(ownerSource, '.task-inputs/toolchain/bun')

// Red if the harness accepts source as a test project or writes its marker before
// rejecting source. Existing runtime tests do not cover this new script's guard.
test('source-parent rejection happens before TEST project content is created', async () => {
  const forbidden = path.join(ownerSource, `TEST-forbidden-S5a-${Date.now()}`)
  await expect(testProject(forbidden, 'reject-source', bun, [ownerSource])).rejects.toThrow('TEST parent inside source INPUT')
  expect(await stat(forbidden).then(() => true, () => false)).toBe(false)
})
// Red if a child inherits credentials, NODE_OPTIONS, production overrides or a
// user HOME. This observes the actual child environment in a marked TEST repo.
test('reader descendants see only allowlisted TEST environment and exact Git identity', async () => {
  const parent = await mkdtemp(path.join(persistentRoot, 'S5a-isolation-TEST-parent-'))
  const project = await testProject(parent, 'env', bun, [ownerSource])
  await writeFile(path.join(project.project, 'observe-env.js'), 'console.log(JSON.stringify({ env: process.env, cwd: process.cwd() }))')
  const child = await command(bun, ['observe-env.js'], project.project, project.env)
  expect(child.code).toBe(0)
  const observed = JSON.parse(child.stdout)
  expect(observed.cwd).toBe(project.project)
  expect(observed.env).toEqual(project.env)
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']) expect(observed.env[key].startsWith(project.project + path.sep)).toBe(true)
  for (const key of ['NODE_OPTIONS', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENCODE_CONFIG', 'CODEX_HOME']) expect(observed.env[key]).toBeUndefined()
  const config = await command('/usr/bin/git', ['config', '--local', '--get-regexp', '^user\.'], project.project, project.env)
  expect(config.stdout).toContain('user.name iliya')
  expect(config.stdout).toContain('user.email iliyazelenkog@gmail.com')
})
