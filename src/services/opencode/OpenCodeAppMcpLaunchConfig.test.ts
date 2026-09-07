import { expect, test } from 'bun:test'
import { resolveOpenCodeAppMcpLaunchConfig, type OpenCodeAppMcpLaunchInputs } from './OpenCodeAppMcpLaunchConfig.js'
import { buildResolvedConfigFingerprint } from './OpenCodeResolvedConfigFingerprint.js'
const inputs: OpenCodeAppMcpLaunchInputs = {
  env: {}, workingDirectory: '/sandbox/project', moduleDirectory: '/p3b2/src/services/opencode',
  repositoryRoot: '/workspace/agent_teams_orchestrator-r1098', entrypoint: null,
  home: '/private/home', platform: 'linux', resolveExecutable: () => '/toolchain/node', pathExists: async () => false,
}
const prefix = 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_'
test('explicit selected launch inputs preserve remote, args, entry precedence and private overrides', async () => {
  const env = { [prefix+'URL']: 'https://user:secret@example.invalid/mcp',
    [prefix+'ARGS_JSON']: '["relative.js","--flag"]', [prefix+'ENTRY']: 'ignored.js',
    [prefix+'COMMAND']: '/pinned/node', [prefix+'ENV_JSON']: '{"TOKEN":"nested-secret","HOME":"/override"}',
    HOME: '/source/home', UNRELATED_SECRET: 'not-forwarded' }
  expect((await resolveOpenCodeAppMcpLaunchConfig({...inputs, env})).config.url).toBe(env[prefix+'URL'])
  delete env[prefix+'URL']
  const args = (await resolveOpenCodeAppMcpLaunchConfig({...inputs,env})).config
  expect(args.command).toEqual(['/pinned/node','/sandbox/project/relative.js','--flag'])
  expect(args.environment).toMatchObject({TOKEN:'nested-secret', HOME:'/override', AGENT_TEAMS_MCP_CLAUDE_DIR:'/source/home/.claude'})
  expect(args.environment).not.toHaveProperty('UNRELATED_SECRET')
  delete env[prefix+'ARGS_JSON']; delete env[prefix+'COMMAND']
  expect((await resolveOpenCodeAppMcpLaunchConfig({...inputs,env})).config.command).toEqual(['/toolchain/node','/sandbox/project/ignored.js'])
})
test('workspace discovery keeps paired dist priority and explicit platform tsx selection', async () => {
  const root = '/workspace/claude_team-r1098'
  const built = await resolveOpenCodeAppMcpLaunchConfig({...inputs,
    pathExists: async path => path === root+'/mcp-server/dist/index.js' })
  expect(built.source).toBe('workspace-dist')
  expect(built.config.command).toEqual(['/toolchain/node',root+'/mcp-server/dist/index.js'])
  const src = await resolveOpenCodeAppMcpLaunchConfig({...inputs,platform:'win32',pathExists:async path =>
    [root+'/mcp-server/src/index.ts',root+'/mcp-server/node_modules/.bin/tsx.cmd'].includes(path)})
  expect(src.config.command).toEqual([root+'/mcp-server/node_modules/.bin/tsx.cmd',root+'/mcp-server/src/index.ts'])
  await expect(resolveOpenCodeAppMcpLaunchConfig(inputs)).rejects.toThrow('Unable to resolve')
})
test('invalid private environment JSON never escapes through parser diagnostic', async () => {
  try {
    await resolveOpenCodeAppMcpLaunchConfig({...inputs,env:{[prefix+'ENTRY']:'main.js',[prefix+'ENV_JSON']:'{"secret-sentinel":'}})
    throw new Error('Expected failure')
  } catch (error) { expect(String(error)).not.toContain('secret-sentinel') }
})
test('actual resolved fingerprints preserve normalization and require complete supervisor observations', () => {
  const observed = { config:{status:200,data:{model:'model',environment:{SECRET:'one'}}},
    configProviders:{status:200,data:{providers:[{id:'b'},{id:'a'}]}},
    agents:{status:200,data:[{name:'b'},{name:'a'}]},mcp:{status:200,data:{app:{status:'connected'}}} }
  const fingerprint = buildResolvedConfigFingerprint(observed)
  expect(fingerprint).toMatch(/^[0-9a-f]{64}$/)
  const reordered = structuredClone(observed)
  reordered.agents.data.reverse(); reordered.configProviders.data.providers.reverse()
  reordered.config.data.environment.SECRET = 'two'
  expect(buildResolvedConfigFingerprint(reordered)).toBe(fingerprint)
  reordered.config.data.model = 'changed'
  expect(buildResolvedConfigFingerprint(reordered)).not.toBe(fingerprint)
  expect(buildResolvedConfigFingerprint({...observed,mcp:{status:500,data:{}}})).toBeNull()
})
