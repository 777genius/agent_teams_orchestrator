// Offline, standalone audit. Run from repo root; no production mocks or providers.
import { expect, test } from 'bun:test'
import path from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { fixture, c0, c1, type Fixture } from './restart-fixture'
import { resolveClaudeMultimodelPaths } from '../src/services/opencode/OpenCodeManagedPaths'
import { resolveOpenCodeAppMcpLaunchConfig } from '../src/services/opencode/OpenCodeMcpManager'
import { readOpenCodeSavedAuthStore } from '../src/services/opencode/OpenCodeAuthStore'

// stdin carries diagnostic expectations without changing original -e argv indexes.
// Direct process.env lookup and a spread snapshot are deliberately both recorded.
const script = `
globalThis.fetch = async () => { throw new Error('AUDIT forbids network') };
const input = JSON.parse(await Bun.stdin.text());
const { readFile } = await import('node:fs/promises');
const path = await import('node:path');
const { resolveOpenCodeProfileScope, isOpenCodeOAuthPublicationScopeCurrent } = await import(input.modules.profile);
const { resolveClaudeMultimodelPaths } = await import(input.modules.paths);
const { resolveOpenCodeAppMcpLaunchConfig } = await import(input.modules.mcp);
const { readOpenCodeSavedAuthStore } = await import(input.modules.auth);
const attempt = async fn => { try { return { ok: true, value: await fn() } }
  catch (e) { return { ok: false, error: e.message, code: e.code } } };
const disk = async p => {
  // Read only the synthetic fixture, even if the child selected a wrong default.
  const rel = path.relative(input.root, p);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { path: p, outsideFixture: true };
  return { path: p, ...await attempt(async () => JSON.parse(await readFile(p, 'utf8'))) };
};
const files = async () => Object.fromEntries(await Promise.all(Object.entries(input.files)
  .map(async ([key, p]) => [key, await disk(p)])));
const copied = { ...process.env };
const keys = Object.keys(copied).filter(k => input.envKeys.includes(k.toUpperCase())).sort();
const direct = Object.fromEntries(input.envKeys.map(k => [k, process.env[k] ?? null]));
const enumerated = Object.fromEntries(keys.map(k => [k, copied[k]]));
const originalScopeInput = { projectPath: process.argv[1], selectedModel: 'xai/grok-4.3', purpose: process.argv[2] };
const env = input.mode === 'explicit-env' ? input.env : undefined;
const before = await files();
const sources = e => {
  const home = e.HOME?.trim() || e.USERPROFILE?.trim();
  return [...new Set([path.join(resolveClaudeMultimodelPaths(e).data, 'opencode', 'auth.json'),
    path.join(e.XDG_DATA_HOME?.trim() || path.join(home, '.local', 'share'), 'opencode', 'auth.json'),
    path.join(home, '.local', 'share', 'opencode', 'auth.json')])];
};
const probe = async e => ({
  paths: resolveClaudeMultimodelPaths(e), sourceAuthPaths: sources(e),
  mcp: await attempt(() => resolveOpenCodeAppMcpLaunchConfig({ env: e })),
  current: await attempt(() => isOpenCodeOAuthPublicationScopeCurrent(input.owner, input.c0, e)),
  // cacheSnapshot:false neither recovers nor inserts a prepared snapshot.
  scope: await attempt(() => resolveOpenCodeProfileScope({ ...originalScopeInput, env: e, cacheSnapshot: false })),
});
const preflight = { supplied: await probe(input.env), copied: await probe(copied) };
const outcome = await attempt(() => resolveOpenCodeProfileScope({ ...originalScopeInput, ...(env ? { env } : {}) }));
const after = await files();
const saved = async e => attempt(() => readOpenCodeSavedAuthStore({
  globalAuthPath: input.files.global, sourceAuthPaths: input.sourceAuthPaths, env: e }));
process.stdout.write(JSON.stringify({ platform: process.platform, bun: Bun.version,
  execPath: process.execPath, argv: process.argv, cwd: process.cwd(), direct, enumerated,
  envKeyNames: Object.keys(copied).sort(), before, preflight, outcome, after,
  childSavedExplicit: await saved(input.env), childSavedAmbient: await saved(copied) }));
`

const attempt = async (fn: () => Promise<unknown>) => {
  try { return { ok: true, value: await fn() } }
  catch (e: any) { return { ok: false, error: e.message, code: e.code } }
}

async function diagnose(f: Fixture, label: string, mode = 'ambient', controlPort?: string) {
  const env = { ...f.env, ...(controlPort ? { CLAUDE_TEAM_CONTROL_URL: controlPort } : {}) }
  const files = { global: f.global, managed: f.profile.managedAuthPath,
    receipt: f.receiptPath, archive: f.archivePath,
    successor: `${f.global}.agent-teams-xai-oauth-successor.json` }
  const modules = Object.fromEntries(Object.entries({ profile: 'OpenCodeProfileManager',
    paths: 'OpenCodeManagedPaths', mcp: 'OpenCodeMcpManager', auth: 'OpenCodeAuthStore' })
    .map(([key, name]) => [key, path.resolve(import.meta.dir, '../src/services/opencode', `${name}.ts`)]))
  const envKeys = [...new Set([...Object.keys(env).map(k => k.toUpperCase()),
    'PATH', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
    'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL'])]
  const child = Bun.spawn([process.execPath, '-e', script, f.project, f.purpose],
    { env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  child.stdin.write(JSON.stringify({ root: f.root, env, files, modules, envKeys,
    sourceAuthPaths: f.receipt.sourceAuthPaths, owner: f.receipt.owner, c0, mode }))
  child.stdin.end()
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  const parsed = await attempt(async () => JSON.parse(stdout))
  const result: any = parsed.ok ? parsed.value : null
  const parentFiles = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([k, p]) =>
    [k, { path: p, ...await attempt(async () => JSON.parse(await readFile(p, 'utf8'))) }])))
  const parentSaved = await attempt(() => readOpenCodeSavedAuthStore({ globalAuthPath: f.global,
    sourceAuthPaths: f.receipt.sourceAuthPaths, env }))
  const evidence = { label, mode, suppliedEnv: env, files,
    parentPaths: resolveClaudeMultimodelPaths(env), parentMcp: await resolveOpenCodeAppMcpLaunchConfig({ env }),
    parentPreparedScope: f.profile.profileScope, receiptOwner: f.receipt.owner,
    child: { code, stderr, parsed, ...(!parsed.ok ? { stdout } : {}) }, parentFiles, parentSaved }
  // Write before assertions so failures still leave complete evidence for CI upload.
  await writeFile(path.join(import.meta.dir, `diagnostic-${label}.json`), JSON.stringify(evidence, null, 2))
  console.log('AUDIT', JSON.stringify({ label, code, stderr,
    argv: result?.argv, paths: result?.preflight, outcome: result?.outcome,
    after: result?.after, childSavedExplicit: result?.childSavedExplicit, parentSaved }))
  expect(stderr).toBe('')
  expect(code).toBe(0)
  expect(parsed.ok).toBe(true)
  expect(result.argv.slice(1)).toEqual([f.project, f.purpose])
  expect(parentFiles).toEqual(result.after)
  return { result, parentSaved }
}

for (const scenario of [
  { label: 'baseline', options: {} },
  { label: 'new-port-session', options: { session: true }, port: 'http://127.0.0.1:43102' },
  { label: 'explicit-env', options: {}, mode: 'explicit-env' },
  { label: 'pinned-windows-roots', options: { pinWindowsRoots: true } },
  { label: 'remote-mcp-control', options: { remote: true } },
  { label: 'execution-probe-control', options: { purpose: 'execution_probe' as const } },
]) {
  test(`Windows restart diagnostic: ${scenario.label}`, async () => {
    const f = await fixture(scenario.options)
    const { result, parentSaved } = await diagnose(f, scenario.label, scenario.mode, scenario.port)
    expect(result.outcome.ok).toBe(true)
    expect(parentSaved).toEqual({ ok: true, value: { xai: c1 } })
    expect(result.childSavedExplicit).toEqual(parentSaved)
    expect(result.after.global.value).toEqual({ xai: c0 })
    expect(result.after.managed.value).toEqual({ xai: c1 })
    expect(result.after.receipt.code).toBe('ENOENT')
    expect(result.after.archive.code).toBe('ENOENT')
    expect(result.after.successor.value.successor).toEqual(c1)
    expect(result.after.successor.value.owner).toEqual(f.receipt.owner)
    expect(result.after.successor.value.predecessor).toEqual(c0)
    expect(result.after.successor.value.before).toEqual(f.receipt.before)
  })
}

test('Windows restart diagnostic: incomplete native history remains fenced', async () => {
  const f = await fixture({ terminal: 'incomplete' })
  const { result, parentSaved } = await diagnose(f, 'incomplete')
  expect(result.outcome.ok).toBe(false)
  expect(result.outcome.error).toContain('pending')
  expect(result.after.receipt.value).toEqual(f.receipt)
  expect(result.after.archive.code).toBe('ENOENT')
  expect(result.after.successor.code).toBe('ENOENT')
  expect(parentSaved).toEqual({ ok: true, value: { xai: c0 } })
})
