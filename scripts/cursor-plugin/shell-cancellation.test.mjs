// Offline focused regression: CURSOR_PLUGIN_SOURCE_ARCHIVE=/path/to/pin.tar.gz
// node --test scripts/cursor-plugin/shell-cancellation.test.mjs
// Executes patched registry, interception and hook bodies with real POSIX shells.
// The tool/schema constructor is a metadata shim; this is not native Cursor E2E.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs, { existsSync, readFileSync, realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
const stripTypeScriptTypes = globalThis.Bun
  ? source => new Bun.Transpiler({ loader: 'ts' }).transformSync(source)
  : (await import('node:module')).stripTypeScriptTypes;

const temp = await mkdtemp(path.join(tmpdir(), 'cursor-shell-cancellation-'));
const sourceRoot = path.join(temp, 'upstream-plugin');
if (process.env.CURSOR_PLUGIN_SOURCE_ARCHIVE) {
  execFileSync('tar', ['xzf', process.env.CURSOR_PLUGIN_SOURCE_ARCHIVE, '-C', temp]);
} else {
  await cp(path.join(import.meta.dirname, 'node_modules/@rama_nigg/open-cursor'), sourceRoot, { recursive: true });
}
assert.equal(JSON.parse(await readFile(path.join(sourceRoot, 'package.json'))).version, '2.5.2');
assert.equal(createHash('sha256').update(await readFile(path.join(sourceRoot, 'src/plugin.ts'))).digest('hex'),
  '9afffb392a99ced5d7a30a08cef1b7abf41df17251592f7d9db0117084c92be3');
const patch = process.env.CURSOR_SHELL_TEST_PATCH || path.join(import.meta.dirname, 'cancellation.patch');
execFileSync('git', ['apply', '--check', patch], { cwd: sourceRoot });
execFileSync('git', ['apply', patch], { cwd: sourceRoot });
const transpiled = new Set();
async function importSource(name) {
  async function emit(moduleName) {
    if (transpiled.has(moduleName)) return;
    transpiled.add(moduleName);
    const filename = path.join(sourceRoot, 'src', moduleName);
    let js = stripTypeScriptTypes(await readFile(filename + '.ts', 'utf8'));
    const dependencies = [];
    js = js.replace(/from "(\.[^"\n]+)"/g, (_all, spec) => {
      const normalized = spec.replace(/\.js$/, '');
      dependencies.push(path.posix.normalize(path.posix.join(path.posix.dirname(moduleName), normalized)));
      return `from "${normalized}.js"`;
    });
    for (const dependency of dependencies) await emit(dependency);
    await writeFile(filename + '.js', js);
  }
  await emit(name);
  return import(pathToFileURL(path.join(sourceRoot, 'src', name + '.js')));
}
const { ToolRegistry } = await importSource('tools/core/registry');
const { registerDefaultTools } = await importSource('tools/defaults');
const { extractOpenAiToolCall } = await importSource('proxy/tool-loop');
const { applyToolSchemaCompat } = await importSource('provider/tool-schema-compat');
const registry = new ToolRegistry();
registerDefaultTools(registry);
// Extract the actual hook and workspace defaulting functions, avoiding plugin
// startup, provider authentication and the unavailable external SDK packages.
const plugin = await readFile(path.join(sourceRoot, 'src/plugin.ts'), 'utf8');
const workspaceHelpers = plugin.slice(plugin.indexOf('function getOpenCodeConfigPrefix('), plugin.indexOf('// Filesystem roots'));
const hookHelpers = plugin.slice(plugin.indexOf('function jsonSchemaToZod('), plugin.indexOf('/**\n * OpenCode plugin for Cursor Agent'));
assert.ok(workspaceHelpers && hookHelpers.includes('function buildToolHookEntries('));
const schema = () => ({ describe() { return this; }, optional() { return this; } });
const tool = Object.assign(entry => entry, { schema: Object.fromEntries(
  ['string', 'number', 'boolean', 'record', 'any', 'array'].map(key => [key, schema]),
) });
const deps = { tool, resolve: path.resolve, join: path.join, relative: path.relative,
  isAbsolute: path.isAbsolute, homedir, realpathSync, SESSION_WORKSPACE_CACHE_LIMIT: 200,
  TOOL_LOOP_MODE: 'opencode', log: { debug() {} } };
const buildHooks = new Function(...Object.keys(deps), stripTypeScriptTypes(workspaceHelpers + hookHelpers)
  .replaceAll('export function ', 'function ') + '\nreturn buildToolHookEntries;')(...Object.values(deps));
const hooks = buildHooks(registry, temp);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for shell fixture');
    await delay(20);
  }
}
function running(pid) {
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  // Linux container PID 1 may leave killed orphan zombies unreaped. Only the
  // explicitly recorded PID is inspected; no process-list/global PID scan.
  if (process.platform === 'linux') {
    try { return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return false; throw error; }
  }
  return true;
}

test('owned Linux observer admits procfs disappearance and preserves other read errors', {
  skip: process.platform !== 'linux',
}, t => {
  const pid = 1234;
  let failure;
  const probe = t.mock.method(process, 'kill', (observedPid, signal) => {
    assert.equal(observedPid, pid); assert.equal(signal, 0); return true;
  });
  const stat = t.mock.method(fs, 'readFileSync', (filename, encoding) => {
    assert.equal(filename, `/proc/${pid}/stat`); assert.equal(encoding, 'utf8'); throw failure;
  });
  syncBuiltinESMExports();
  try {
    for (const code of ['ENOENT', 'ESRCH']) {
      failure = Object.assign(new Error('Owned process disappeared'), { code });
      assert.equal(running(pid), false);
    }
    for (const code of ['EPERM', 'EIO']) {
      failure = Object.assign(new Error('Observation failed'), { code });
      assert.throws(() => running(pid), error => error === failure);
    }
    assert.equal(probe.mock.callCount(), 4); assert.equal(stat.mock.callCount(), 4);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
const instances = new Set();
async function start(id, { seconds = 3, timeout = 600000, alias = 'bash', resistant = false } = {}) {
  const directory = path.join(temp, id);
  await mkdir(directory);
  const script = resistant
    ? 'set -eu\necho $$ > shell.pid\nsh -c \'trap "" TERM; echo $$ > child.pid; echo ready > ready; sleep 3; echo bad > done\' </dev/null >/dev/null 2>&1 &\nwait $!\n'
    : `set -eu\necho $$ > shell.pid\nsleep ${seconds} &\nchild=$!\necho "$child" > child.pid\necho ready > ready\nwait "$child"\necho done > done\n`;
  await writeFile(path.join(directory, 'proof.sh'), script);
  const controller = new AbortController();
  // Follow native shellToolCall -> bash extraction and schema normalization.
  const input = { command: 'sh ./proof.sh', timeout, description: id };
  const extracted = extractOpenAiToolCall({ type: 'tool_call', subtype: 'started', call_id: id,
    tool_call: { shellToolCall: { args: input } } }, new Set(['bash']));
  assert.equal(extracted.action, 'intercept');
  const normalized = applyToolSchemaCompat(extracted.toolCall, new Map([['bash', registry.getTool('bash').parameters]]));
  assert.equal(normalized.normalizedArgs.timeout, timeout);
  const promise = hooks[alias].execute(normalized.normalizedArgs, {
    sessionID: id, directory, worktree: directory, abort: controller.signal,
  }).then(output => ({ output }), error => ({ error }));
  const instance = { directory, controller, promise, pids: () => ['shell.pid', 'child.pid']
    .filter(name => existsSync(path.join(directory, name)))
    .map(name => Number(readFileSync(path.join(directory, name), 'utf8'))) };
  instances.add(instance);
  await waitFor(() => existsSync(path.join(directory, 'ready')));
  return instance;
}
async function cleanup(instance) {
  instance.controller.abort();
  // Also cleans the intentionally failing baseline control, which ignores abort.
  for (const pid of instance.pids().reverse()) {
    try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  await Promise.race([instance.promise, delay(2500)]);
  instances.delete(instance);
}
after(async () => {
  for (const instance of instances) await cleanup(instance);
  await rm(temp, { recursive: true, force: true });
});
async function resultWithin(instance, ms = 2700) {
  let timer;
  try { return await Promise.race([instance.promise, new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Tool did not settle after cancellation')), ms);
  })]); } finally { clearTimeout(timer); }
}

for (const alias of ['bash', 'shell', 'oc_bash']) {
  test(`${alias}: abort kills owned shell and ordinary child while same-host neighbor finishes`, async () => {
    const owned = await start(`owned-${alias}`, { alias });
    const neighbor = await start(`neighbor-${alias}`, { seconds: 1 });
    try {
      assert.ok(owned.pids().every(running));
      assert.ok(neighbor.pids().every(running));
      owned.controller.abort();
      const result = await resultWithin(owned);
      assert.equal(result.error?.name, 'AbortError');
      await waitFor(() => owned.pids().every(pid => !running(pid)));
      assert.ok(neighbor.pids().every(running), 'neighbor must still be active after owned Stop');
      assert.ok((await resultWithin(neighbor)).output);
      assert.ok(existsSync(path.join(neighbor.directory, 'done')));
      await delay(2600);
      assert.equal(existsSync(path.join(owned.directory, 'done')), false);
      assert.equal(await hooks.bash.execute({ command: 'printf host-still-works' }, { abort: new AbortController().signal }), 'host-still-works');
    } finally { await cleanup(owned); await cleanup(neighbor); }
  });
}
test('already-aborted request cannot spawn, including spoofed signal in model arguments', async () => {
  const controller = new AbortController(); controller.abort();
  const marker = path.join(temp, 'preaborted');
  await assert.rejects(hooks.bash.execute({ command: `touch '${marker}'`, abort: new AbortController().signal },
    { sessionID: 'preabort', abort: controller.signal }), { name: 'AbortError' });
  assert.equal(existsSync(marker), false);
});
test('TERM-resistant child with closed pipes is killed after parent exits', async () => {
  const owned = await start('resistant', { resistant: true });
  try {
    owned.controller.abort();
    assert.equal((await resultWithin(owned)).error?.name, 'AbortError');
    await waitFor(() => owned.pids().every(pid => !running(pid)));
    await delay(2800);
    assert.equal(existsSync(path.join(owned.directory, 'done')), false);
  } finally { await cleanup(owned); }
});
test('configured 120ms timeout rejects as failure and kills child subtree', async () => {
  const owned = await start('timeout', { timeout: 120 });
  try {
    const result = await resultWithin(owned);
    assert.equal(result.error?.name, 'TimeoutError');
    assert.match(result.error.message, /120ms/);
    assert.doesNotMatch(result.error.message, /Command executed successfully/);
    await waitFor(() => owned.pids().every(pid => !running(pid)));
    await delay(2700);
    assert.equal(existsSync(path.join(owned.directory, 'done')), false);
  } finally { await cleanup(owned); }
});
test('configured 600000ms timeout survives the former 30-second boundary', { timeout: 38000 }, async () => {
  const owned = await start('long-timeout', { seconds: 31, timeout: 600000 });
  try {
    const result = await resultWithin(owned, 35000);
    assert.equal(result.error, undefined);
    assert.ok(existsSync(path.join(owned.directory, 'done')));
    assert.doesNotMatch(result.output, /timed out/);
  } finally { await cleanup(owned); }
});
test('invalid and overflowing timeouts fail before spawn', async () => {
  for (const timeout of [-1, NaN, Infinity, 2147483648, '600000', 0.5]) {
    await assert.rejects(hooks.bash.execute({ command: 'printf should-not-run', timeout }, {}), /timeout must/);
  }
});
test('spawn error settles and removes the invocation abort listener', async () => {
  const controller = new AbortController();
  await assert.rejects(hooks.bash.execute({ command: 'printf never', cwd: path.join(temp, 'absent') },
    { abort: controller.signal }), /ENOENT/);
  controller.abort();
});
test('normal completion removes listener; later abort does not signal a stale group', async () => {
  const controller = new AbortController();
  assert.equal(await hooks.bash.execute({ command: 'printf completed', timeout: 2000 }, { abort: controller.signal }), 'completed');
  const original = process.kill;
  let signals = 0;
  process.kill = (...args) => { signals++; return original(...args); };
  try { controller.abort(); await delay(650); assert.equal(signals, 0); }
  finally { process.kill = original; }
});
