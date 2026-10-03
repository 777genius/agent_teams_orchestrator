import { lstat, mkdir, mkdtemp, open, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

export const task = 'hosted-v1-opencode-dual-q0-client-20261001';
const sourceCheckout = resolve(import.meta.dir, '../..');
const contains = (parent: string, child: string) => parent === child || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

// Resolve every existing ancestor before creating anything. A dangling link is
// rejected rather than treated as a missing directory that mkdir may traverse.
export async function canonicalDestination(path: string): Promise<string> {
  if (!path || !path.trim()) throw new Error('Missing destination');
  // Reject traversal before lexical normalization can hide a symlink/../ escape.
  if (path.split(/[\\/]/).includes('..')) throw new Error('Destination parent traversal is forbidden');
  let ancestor = resolve(path);
  const suffix: string[] = [];
  for (;;) {
    try { return join(await realpath(ancestor), ...suffix); }
    catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      try {
        if ((await lstat(ancestor)).isSymbolicLink()) throw new Error('Dangling destination alias');
      } catch (entry: any) { if (entry.code !== 'ENOENT') throw entry; }
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(ancestor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      ancestor = parent;
    }
  }
}

export async function assertExternalDestination(path: string, source = sourceCheckout) {
  const destination = await canonicalDestination(path);
  // Explicit source/product/reference exclusions, including the separately mounted
  // owner checkout referenced by linked .git metadata. Exclude lexical aliases too.
  const roots = [source, join(source, '.task-inputs/product'), join(source, '.task-inputs/reference'),
    join(source, '.task-inputs/owner')];
  try {
    const git = await readFile(join(source, '.git'), 'utf8');
    const match = /^gitdir: (.+)$/m.exec(git);
    if (match) {
      const admin = resolve(source, match[1]);
      const index = admin.indexOf(sep + '.git' + sep);
      if (index >= 0) roots.push(admin.slice(0, index));
    }
  } catch (error: any) { if (!['ENOENT', 'EISDIR'].includes(error.code)) throw error; }
  for (const root of roots) for (const excluded of [resolve(root), await canonicalDestination(root)]) {
    if (contains(excluded, destination) || contains(destination, excluded))
      throw new Error('Destination must be external and disjoint from protected source/reference roots');
  }
  return destination;
}

export async function gitLockPreflight(source = sourceCheckout) {
  let lockPath: string | null = null;
  try {
    const dotgit = join(source, '.git');
    const entry = await lstat(dotgit);
    const admin = entry.isDirectory() ? dotgit : resolve(source,
      (await readFile(dotgit, 'utf8')).replace(/^gitdir: /, '').trim());
    lockPath = join(admin, 'index.lock');
    await realpath(admin); // Do not create missing linked administration.
    const handle = await open(lockPath, 'wx');
    const created = await handle.stat();
    try { await handle.close(); } finally {
      const current = await lstat(lockPath);
      if (current.dev !== created.dev || current.ino !== created.ino) throw new Error('New lock ownership changed; refusing removal');
      await unlink(lockPath);
    }
    return { status: 'PASS', lockPath, observation: 'Exclusive new lock created/released; no existing lock removed' };
  } catch (error: any) {
    return { status: error.code === 'EEXIST' ? 'EXISTING_LOCK' : 'UNAVAILABLE', lockPath,
      code: error.code, observation: 'No existing lock removed; controller verifies exact base/diff outside sandbox' };
  }
}

export async function createTestProject(parent: string, caseName: string, source = sourceCheckout) {
  if (!/^[a-zA-Z0-9_-]+$/.test(caseName)) throw new Error('Invalid TEST case name');
  parent = await assertExternalDestination(parent, source);
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(await realpath(parent), `TEST-${task}-${caseName}-`));
  const env: Record<string, string> = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC' };
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME',
    'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'TMPDIR', 'TMP', 'TEMP',
    'BUN_INSTALL_CACHE_DIR', 'NPM_CONFIG_CACHE']) {
    env[key] = join(root, 'state', key.toLowerCase());
    await mkdir(env[key], { recursive: true });
  }
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'iliya', GIT_AUTHOR_EMAIL: 'iliyazelenkog@gmail.com',
    GIT_COMMITTER_NAME: 'iliya', GIT_COMMITTER_EMAIL: 'iliyazelenkog@gmail.com' });
  await writeFile(join(root, '.test-project-owner.json'), JSON.stringify({ task, caseName,
    root, nonce: crypto.randomUUID(), nativeEvidence: false, environmentKeys: Object.keys(env) }, null, 2));
  for (const args of [['git', 'init', '--quiet'], ['git', 'config', 'user.name', 'iliya'],
    ['git', 'config', 'user.email', 'iliyazelenkog@gmail.com']]) {
    const child = Bun.spawn(args, { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
    if (await child.exited !== 0) throw new Error('TEST git initialization failed');
  }
  return { root, env };
}

export async function assertTestProject(root: string, source: string) {
  const canonical = await assertExternalDestination(root, source);
  const marker = JSON.parse(await readFile(join(canonical, '.test-project-owner.json'), 'utf8'));
  if (marker.task !== task || marker.root !== canonical || !marker.nonce)
    throw new Error('Missing TEST ownership');
  const git = Bun.spawn(['git', 'rev-parse', '--show-toplevel'], { cwd: canonical,
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    stdout: 'pipe', stderr: 'pipe' });
  const actual = (await new Response(git.stdout).text()).trim();
  if (await git.exited !== 0 || resolve(actual) !== canonical) throw new Error('Wrong TEST Git root');
  return marker;
}
