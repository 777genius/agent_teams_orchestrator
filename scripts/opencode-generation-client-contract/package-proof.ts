import { assertExternalDestination, assertTestProject } from './isolation';
import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
const root = process.env.S6_TEST_ROOT!;
const evidence = process.env.S6_EVIDENCE_DIR!;
const referenceOnly = process.env.S6_REFERENCE_ONLY === '1';
const sourceRoot = process.env.S6_SOURCE_ROOT!;
await assertExternalDestination(evidence, sourceRoot);
await assertTestProject(root, sourceRoot);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function packageAt(entry: string) {
  let dir = dirname(await realpath(entry));
  for (;;) {
    try {
      const path = join(dir, 'package.json');
      const bytes = await readFile(path);
      return { ...JSON.parse(bytes.toString()), path, sha256: hash(bytes) };
    } catch { const parent = dirname(dir); if (parent === dir) throw new Error('Missing package manifest'); dir = parent; }
  }
}
const packages = [];
for (const [name, version] of [['@opencode/client', '2.0.21'], ['@opencode/client-v2-floor', '2.0.0']]) {
  const entry = referenceOnly ? join(sourceRoot, `.task-inputs/reference/opencode-client-${version}/package/dist/promise/index.js`) : Bun.resolveSync(name, root);
  const client = await packageAt(entry);
  if (referenceOnly) {
    packages.push({ name, version, entry: await realpath(entry), manifests: [{ name: client.name,
      version: client.version, path: client.path, sha256: client.sha256, dependencies: client.dependencies }],
      installedGraph: 'MISSING', schemaEntry: null, protocolEntry: null, protocolClass: null });
    continue;
  }
  const schemaEntry = Bun.resolveSync('@opencode/schema', dirname(client.path));
  const protocolEntry = Bun.resolveSync('@opencode/protocol/errors', dirname(client.path));
  const schema = await packageAt(schemaEntry), protocol = await packageAt(protocolEntry);
  if (client.version !== version || schema.version !== version || protocol.version !== version)
    throw new Error('Dialect dependency contamination');
  // Resolve the real public schema and protocol modules, including their class identity.
  const schemaModule = await import(schemaEntry);
  const protocolModule = await import(protocolEntry);
  packages.push({ name, version, entry: await realpath(entry), schemaEntry: await realpath(schemaEntry),
    protocolEntry: await realpath(protocolEntry), manifests: [client, schema, protocol].map(p => ({
      name: p.name, version: p.version, path: p.path, sha256: p.sha256, dependencies: p.dependencies })),
    schemaExports: Object.keys(schemaModule).length, protocolClass: protocolModule.InvalidRequestError });
}
if (!referenceOnly && (packages[0].schemaEntry === packages[1].schemaEntry || packages[0].protocolEntry === packages[1].protocolEntry ||
    packages[0].protocolClass === packages[1].protocolClass)) throw new Error('Packages resolved to same dialect');
const fixture = join(root, 'fixture.ts');
await writeFile(fixture, `import { OpenCode as current, ClientError as CurrentError } from ${JSON.stringify(referenceOnly ? packages[0].entry : '@opencode/client')};
import { OpenCode as floor, ClientError as FloorError } from ${JSON.stringify(referenceOnly ? packages[1].entry : '@opencode/client-v2-floor')};
const a = current.make({baseUrl:'http://127.0.0.1:1'}), b = floor.make({baseUrl:'http://127.0.0.1:1'});
if (typeof a.server.info !== 'function' || typeof b.health.get !== 'function' || CurrentError === FloorError) throw Error('dialect collision');
console.log(JSON.stringify({current:typeof a.session.form.reply, floor:typeof b.form.state, distinctErrorClasses:CurrentError!==FloorError}));\n`);
const imports = new Set<string>();
const build = await Bun.build({ entrypoints: [fixture], target: 'bun', minify: true,
  outdir: join(root, 'dist'), plugins: [{ name: 'record-actual-build-loads', setup(b) {
    b.onLoad({ filter: /\.[cm]?[jt]s$/ }, args => { imports.add(args.path); return undefined; });
  } }] });
if (!build.success) throw new Error('Promise bundle failed');
if ([...imports].some(p => /node_modules\/(effect|solid-js)\//.test(p) || /dist\/(effect|solid)\//.test(p)))
  throw new Error('Promise fixture imports Effect/Solid');
async function execute(args: string[]) {
  const keys = ['PATH', 'LANG', 'TZ', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'TMPDIR', 'TMP', 'TEMP',
    'BUN_INSTALL_CACHE_DIR', 'NPM_CONFIG_CACHE', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL',
    'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];
  const env: Record<string, string> = {};
  for (const key of keys) if (process.env[key]) env[key] = process.env[key]!;
  const child = Bun.spawn(args, { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error('Fixture execution/build failed: ' + stderr);
  return { args, stdout: stdout.trim(), exitCode: code };
}
// Environment is already an explicit TEST allowlist from the parent harness, without credential roots.
const source = await execute([process.execPath, fixture]);
const bundle = await execute([process.execPath, join(root, 'dist/fixture.js')]);
const compiledPath = join(root, 'fixture-compiled');
const compile = await execute([process.execPath, 'build', '--compile', '--target=bun', fixture, '--outfile', compiledPath]);
const compiled = await execute([compiledPath]);
if (source.stdout !== bundle.stdout || source.stdout !== compiled.stdout) throw new Error('Fixture mode mismatch');
const proof = { kind: 'minimal source/minified/compiled TEST fixture composition; NOT owner release/platform qualification',
  packages: packages.map(({ protocolClass, ...item }) => item), imports: [...imports].sort(),
  importHashes: await Promise.all([...imports].sort().map(async path => ({ path, sha256: hash(await readFile(path)) }))),
  packageMode: referenceOnly ? 'official read-only reference roots; installed alias NOT qualified' : 'installed registry packages',
  optionalInstalledEffect: referenceOnly ? null : (await packageAt(Bun.resolveSync('effect', root))).version,
  source, bundle, compile, compiled, fixtureSha256: hash(await readFile(fixture)),
  bundleSha256: hash(await readFile(join(root, 'dist/fixture.js'))), compiledSha256: hash(await readFile(compiledPath)) };
await writeFile(join(evidence, 'package-proof.json'), JSON.stringify(proof, null, 2));
console.log(JSON.stringify(proof));
