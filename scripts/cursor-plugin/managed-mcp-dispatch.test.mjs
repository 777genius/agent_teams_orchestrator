// Offline source test: node --test scripts/cursor-plugin/managed-mcp-dispatch.test.mjs
// Uses the pinned plugin dependency, or CURSOR_PLUGIN_SOURCE_ARCHIVE for offline review.
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, chmod, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

test('pinned patch dispatch survives intercepted shell environment and quoting', async () => {
  const archive = process.env.CURSOR_PLUGIN_SOURCE_ARCHIVE;
  const temp = await mkdtemp(path.join(tmpdir(), 'cursor-mcp-dispatch-'));
  try {
    const root = path.join(temp, 'upstream-plugin');
    if (archive) {
      execFileSync('tar', ['xzf', archive, '-C', temp]);
    } else {
      const installed = path.join(import.meta.dirname, 'node_modules/@rama_nigg/open-cursor');
      await mkdir(root);
      await cp(path.join(installed, 'src'), path.join(root, 'src'), { recursive: true });
      await cp(path.join(installed, 'package.json'), path.join(root, 'package.json'));
    }
    assert.equal(createHash('sha256').update(await readFile(path.join(root, 'src/plugin.ts'))).digest('hex'),
      '9afffb392a99ced5d7a30a08cef1b7abf41df17251592f7d9db0117084c92be3');
    const patch = path.join(import.meta.dirname, 'cancellation.patch');
    execFileSync('git', ['apply', '--check', patch], { cwd: root });
    execFileSync('git', ['apply', patch], { cwd: root });
    const metadata = JSON.parse(await readFile(path.join(root, 'package.json')));
    assert.equal(metadata.version, '2.5.2');
    for (const name of ['plugin-toggle', 'proxy/managed-mcp-dispatch']) {
      const source = await readFile(path.join(root, 'src', name + '.ts'), 'utf8');
      await writeFile(path.join(root, 'src', name + '.js'), stripTypeScriptTypes(source));
    }
    const { managedMcpDispatchInstructions: instructions } = await import(pathToFileURL(path.join(root, 'src/proxy/managed-mcp-dispatch.js')));
    assert.equal(instructions({}), '');
    assert.throws(() => instructions({ AGENT_TEAMS_CURSOR_PROXY_PORT: '1234' }), /scoped CLI bridge/);
    const bin = path.join(temp, "profile with ' quote", 'native-subscription-cli-bin');
    await mkdir(bin, { recursive: true });
    const shim = path.join(bin, 'mcptool');
    await writeFile(shim, '#!/bin/sh\nprintf "%s\\n" "$OPENCODE_CONFIG" "$@"\n');
    await chmod(shim, 0o700);
    const env = { AGENT_TEAMS_CURSOR_PROXY_PORT: '1234', CURSOR_AGENT_EXECUTABLE: path.join(bin, 'cursor-agent'), XDG_CONFIG_HOME: path.join(temp, "config ' scoped") };
    const prompt = instructions(env);
    const command = prompt.split('\n').find(line => line.startsWith('Discover available')).split('with: ')[1];
    // OpenCode bash has neither the native wrapper PATH nor its OPENCODE_CONFIG.
    const output = execFileSync('/bin/sh', ['-c', command], { env: { PATH: '/nonexistent' }, encoding: 'utf8' });
    assert.deepEqual(output.trim().split('\n'), [path.join(env.XDG_CONFIG_HOME, 'opencode/opencode.json'), 'tools', 'agent-teams']);
    const quote = value => "'" + value.replace(/'/g, "'\"'\"'") + "'";
    const payload = JSON.stringify({ teamName: 'fixture', to: 'lead', text: "it's $(false) `false`" });
    const call = command.replace(' tools agent-teams', ' call agent-teams message_send ') + quote(payload);
    const callOutput = execFileSync('/bin/sh', ['-c', call], { env: { PATH: '/nonexistent' }, encoding: 'utf8' });
    assert.deepEqual(callOutput.trim().split('\n').slice(1), ['call', 'agent-teams', 'message_send', payload]);
    assert.match(prompt, /approved managed mcptool transport/);
    assert.match(prompt, /do not switch to raw HTTP or blindly retry a side effect/);
    assert.match(prompt, /required message envelope/);
    const explicit = instructions({ ...env, OPENCODE_CONFIG: path.join(temp, 'explicit.json') });
    assert.ok(explicit.includes(path.join(temp, 'explicit.json')));
    const builder = await readFile(path.join(root, 'src/proxy/prompt-builder.ts'), 'utf8');
    assert.match(builder, /const lines: string\[\] = dispatch \? \[dispatch\] : \[\]/);
    assert.match(builder, /Boolean\(process.env.AGENT_TEAMS_CURSOR_PROXY_PORT\)/);
    const plugin = await readFile(path.join(root, 'src/plugin.ts'), 'utf8');
    assert.match(plugin, /prompt: \[managedMcpDispatchInstructions\(\), incremental\]/);
    // Compose the actual summary and prompt builder: registration names alone
    // must not reintroduce the nonexistent native-MCP route after dispatch.
    const dataUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
    const loggerUrl = dataUrl('export const createLogger = () => ({debug(){},info(){},warn(){},isDebugEnabled(){return false;}});');
    const modules = new Map();
    async function moduleUrl(name) {
      if (modules.has(name)) return modules.get(name);
      let source = stripTypeScriptTypes(await readFile(path.join(root, 'src', name + '.ts'), 'utf8'));
      for (const match of [...source.matchAll(/from "([^"\n]+)"/g)]) {
        if (!match[1].startsWith('.')) continue;
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), match[1])).replace(/\.js$/, '');
        const resolved = target === 'utils/logger' ? loggerUrl : await moduleUrl(target);
        source = source.replace(match[0], `from "${resolved}"`);
      }
      const result = dataUrl(source); modules.set(name, result); return result;
    }
    const promptBuilder = await import(await moduleUrl('proxy/prompt-builder'));
    const namespaceSource = (await readFile(path.join(root, 'src/mcp/tool-bridge.ts'), 'utf8'))
      .split('export function namespaceMcpTool(')[1].split('\nfunction mcpSchemaToZod(')[0];
    const namespace = new Function(stripTypeScriptTypes('const MCP_TOOL_PREFIX="mcp__"; function namespaceMcpTool(' + namespaceSource) + '; return namespaceMcpTool;')();
    const summarySource = plugin.slice(plugin.indexOf('function getMcpToolDefinitionName('), plugin.indexOf('export async function ensurePluginDirectory('));
    const summary = new Function('namespaceMcpTool', stripTypeScriptTypes(summarySource).replace('export function', 'function') + '; return buildAvailableToolsSystemMessage;')(namespace);
    const keys = [...Object.keys(env), 'OPENCODE_CONFIG'];
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    try {
      Object.assign(process.env, env); delete process.env.OPENCODE_CONFIG;
      const tool = { type: 'function', function: { name: namespace('agent-teams', 'message_send'), parameters: { type: 'object', properties: { text: { type: 'string' } } } } };
      assert.equal(tool.function.name, 'mcp__agent_teams__message_send');
      const summaries = [{ serverName: 'agent-teams', toolName: 'message_send' }];
      const compose = () => promptBuilder.buildPromptFromMessages([{ role: 'system', content: summary([], [], [tool], summaries) }, { role: 'user', content: 'Send the assigned reply.' }], [tool]);
      const managed = compose();
      assert.match(managed, /approved managed mcptool transport/);
      assert.match(managed, /mcp__agent_teams__message_send/);
      assert.doesNotMatch(managed, /Always use the complete tool name below|Call these tools by their FULL exact name|respond with a tool_call in the standard OpenAI format/);
      delete process.env.AGENT_TEAMS_CURSOR_PROXY_PORT;
      const unmanaged = compose();
      assert.match(unmanaged, /Always use the complete tool name below/);
      assert.match(unmanaged, /respond with a tool_call in the standard OpenAI format/);
      process.env.AGENT_TEAMS_CURSOR_PROXY_PORT = env.AGENT_TEAMS_CURSOR_PROXY_PORT;
      assert.doesNotMatch(compose(), /Always use the complete tool name below/);
    } finally {
      for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    }
    // Syntax-check changed source without bundling or loading provider dependencies.
    stripTypeScriptTypes(builder);
    stripTypeScriptTypes(plugin);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
