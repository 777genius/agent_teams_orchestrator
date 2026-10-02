import { randomUUID, createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile, readdir, lstat } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

export const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')
export async function snapshot(root: string): Promise<Record<string, { sha256: string; bytes: number }>> {
  const result: Record<string, { sha256: string; bytes: number }> = {}
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const file = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Unexpected TEST symlink: ${file}`)
      if (entry.isDirectory()) await walk(file)
      else if (entry.isFile()) { const data = await readFile(file); result[path.relative(root, file)] = { sha256: sha256(data), bytes: data.length } }
    }
  }
  await walk(root)
  return result
}
export function childEnvironment(project: string, bun: string): Record<string, string> {
  const state = path.join(project, 'TEST-state')
  return { PATH: `${path.dirname(bun)}:/usr/bin:/bin`, HOME: path.join(state, 'home'), USERPROFILE: path.join(state, 'home'),
    XDG_CONFIG_HOME: path.join(state, 'config'), XDG_STATE_HOME: path.join(state, 'state'),
    XDG_CACHE_HOME: path.join(state, 'cache'), XDG_DATA_HOME: path.join(state, 'data'),
    TMPDIR: path.join(state, 'tmp'), TMP: path.join(state, 'tmp'), TEMP: path.join(state, 'tmp'),
    APPDATA: path.join(state, 'appdata'), LOCALAPPDATA: path.join(state, 'localappdata'),
    CLAUDE_MULTIMODEL_DATA_HOME: path.join(state, 'data'), CLAUDE_MULTIMODEL_CACHE_HOME: path.join(state, 'cache'),
    BUN_INSTALL_CACHE_DIR: path.join(state, 'bun-cache'), NPM_CONFIG_CACHE: path.join(state, 'npm-cache'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'iliya', GIT_COMMITTER_NAME: 'iliya',
    GIT_AUTHOR_EMAIL: 'iliyazelenkog@gmail.com', GIT_COMMITTER_EMAIL: 'iliyazelenkog@gmail.com',
    NODE_ENV: 'development', LANG: 'C.UTF-8', TZ: 'UTC' }
}
export async function command(executable: string, args: string[], cwd: string, env: Record<string, string>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; pid: number | undefined }>((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr, pid: child.pid }))
  })
}
export async function testProject(parent: string, caseId: string, bun: string, forbidden: string[]) {
  parent = path.resolve(parent)
  // Reject source parents before creating any TEST content, including symlink parents.
  let nearest = path.resolve(parent)
  while (true) {
    try { nearest = await realpath(nearest); break } catch (error: any) {
      if (error.code !== 'ENOENT' || path.dirname(nearest) === nearest) throw error
      nearest = path.dirname(nearest)
    }
  }
  for (const source of forbidden) {
    for (const candidate of [path.resolve(parent), nearest]) {
      const relative = path.relative(await realpath(source), candidate)
      if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('TEST parent inside source INPUT')
    }
  }
  await mkdir(parent, { recursive: true })
  const project = await mkdtemp(path.join(parent, `TEST-S5a-${caseId}-`))
  const canonical = await realpath(project)
  for (const source of forbidden) {
    const relative = path.relative(await realpath(source), canonical)
    if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('TEST project inside source INPUT')
  }
  const nonce = randomUUID()
  const marker = { task: 'hosted-v1-opencode-dual-q0-preservation-20261001', caseId, nonce, project: canonical, allowedPaths: [canonical] }
  await writeFile(path.join(project, '.test-project-owner.json'), JSON.stringify(marker, null, 2))
  // Root-owned fixture unreadability must be independent of inaccessible /srv
  // ancestors. Readers use relative store paths from this already-entered cwd.
  await chmod(project, 0o777)
  const env = childEnvironment(canonical, bun)
  for (const value of Object.values(env).filter(value => value.startsWith(project))) await mkdir(value, { recursive: true, mode: 0o777 })
  const init = await command('/usr/bin/git', ['init', '--quiet', '.'], project, env)
  if (init.code !== 0) throw new Error(`TEST Git init failed: ${init.stderr}`)
  for (const [key, value] of [['user.name', 'iliya'], ['user.email', 'iliyazelenkog@gmail.com']]) {
    const result = await command('/usr/bin/git', ['config', '--local', key!, value!], project, env)
    if (result.code !== 0) throw new Error(result.stderr)
  }
  if (!(await lstat(path.join(project, '.git'))).isDirectory()) throw new Error('TEST Git root missing')
  return { project: canonical, nonce, marker, env }
}

const contains = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
}
export async function canonicalDestination(destination: string): Promise<string> {
  const absolute = path.resolve(destination)
  const suffix: string[] = []
  let ancestor = absolute
  while (true) {
    try { return path.join(await realpath(ancestor), ...suffix) }
    catch (error: any) {
      if (error.code !== 'ENOENT' || path.dirname(ancestor) === ancestor) throw error
      // A dangling symlink is a destination too, never a missing ancestor.
      if (await lstat(ancestor).then(() => true, () => false)) throw new Error('Symlink destination')
      suffix.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor)
    }
  }
}
export async function validateOutputRoots(evidence: string, projects: string, forbidden: string[]) {
  const roots = await Promise.all([evidence, projects].map(canonicalDestination))
  for (const source of forbidden) {
    const canonical = await realpath(source)
    for (const root of roots) if (contains(canonical, root) || contains(root, canonical)) throw new Error('Output overlaps source INPUT')
  }
  if (contains(roots[0]!, roots[1]!) || contains(roots[1]!, roots[0]!)) throw new Error('Evidence INPUT and TEST projects must be distinct')
  // Evidence must be fresh and empty, not an unrelated directory or alias.
  await assertNoSymlinks(evidence)
  const existing = await lstat(evidence).catch((error: any) => { if (error.code !== 'ENOENT') throw error; return null })
  if (existing && (!existing.isDirectory() || (await readdir(evidence)).length)) throw new Error('Evidence destination must be fresh and empty')
}
export async function assertNoSymlinks(destination: string) {
  let current = path.resolve(destination)
  while (true) {
    const info = await lstat(current).catch((error: any) => { if (error.code !== 'ENOENT') throw error; return null })
    if (info?.isSymbolicLink()) throw new Error('Symlink destination')
    if (path.dirname(current) === current) return
    current = path.dirname(current)
  }
}
// All evidence writes reject link components and open the final file NOFOLLOW.
export async function safeWrite(destination: string, data: string | Uint8Array) {
  destination = path.resolve(destination)
  await assertNoSymlinks(destination)
  const { open } = await import('node:fs/promises')
  const { constants } = await import('node:fs')
  const handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(data) } finally { await handle.close() }
}
