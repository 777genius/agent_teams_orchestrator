import { afterEach, expect, test } from 'bun:test'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { publishNativeCliFile } from './OpenCodeNativeCliPublication.js'

const exec = promisify(execFile)
const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'native-wrapper-publication-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

test.skipIf(process.platform === 'win32')('preserves matching identity, repairs mode, replaces symlinks and cleans failed publication', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli')
  const content = '#!/bin/sh\nprintf ready\n'
  await publishNativeCliFile(target, content, 0o700)
  const first = await lstat(target)
  await publishNativeCliFile(target, content, 0o700)
  expect((await lstat(target)).ino).toBe(first.ino)
  expect((await lstat(target)).mtimeMs).toBe(first.mtimeMs)
  await chmod(target, 0o777)
  await publishNativeCliFile(target, content, 0o700)
  expect((await lstat(target)).mode & 0o7777).toBe(0o700)
  const external = path.join(root, 'external')
  await writeFile(external, 'untouched')
  await rm(target)
  await symlink(external, target)
  await publishNativeCliFile(target, content, 0o700)
  expect((await lstat(target)).isSymbolicLink()).toBe(false)
  expect(await readFile(external, 'utf8')).toBe('untouched')
  const preload = path.join(root, 'preload.cjs')
  await publishNativeCliFile(preload, 'module.exports = {}', 0o600)
  expect((await lstat(preload)).mode & 0o7777).toBe(0o600)
  const directory = path.join(root, 'directory')
  await mkdir(directory)
  await expect(publishNativeCliFile(directory, content, 0o700)).rejects.toThrow()
  expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])
})

test.skipIf(process.platform !== 'linux')('Linux replaces an executing inode without ETXTBSY', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli')
  await copyFile('/bin/sleep', target)
  await chmod(target, 0o700)
  const child = spawn(target, ['20'], { stdio: 'ignore' })
  const exited = once(child, 'exit')
  try {
    await once(child, 'spawn')
    // Positive control: this is the actual Linux kernel failure, without a mock.
    await expect(writeFile(target, 'broken')).rejects.toMatchObject({ code: 'ETXTBSY' })
    await publishNativeCliFile(target, '#!/bin/sh\nprintf ready\n', 0o700)
    expect((await exec(target, [], { timeout: 5_000 })).stdout).toBe('ready')
  } finally {
    child.kill('SIGKILL')
    await exited
  }
})

test.skipIf(process.platform !== 'linux')('Linux separate publishers and executors observe complete executable generations', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli')
  await publishNativeCliFile(target, '#!/bin/sh\nprintf A\n', 0o700)
  const worker = path.join(root, 'worker.ts')
  await writeFile(worker, `
import { publishNativeCliFile } from ${JSON.stringify(import.meta.dir + '/OpenCodeNativeCliPublication.ts')}
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout } from 'node:timers/promises'
const exec = promisify(execFile)
const [target, role, start] = process.argv.slice(2)
while (Date.now() < Number(start)) await setTimeout(1)
for (let i = 0; i < 100; i++) {
  if (role === 'publish') {
    await publishNativeCliFile(target, '#!/bin/sh\\nprintf ' + (i % 2 ? 'A' : 'B') + '\\n', 0o700)
  } else {
    const { stdout } = await exec(target, [], { timeout: 2000 })
    if (stdout !== 'A' && stdout !== 'B') throw new Error('partial wrapper: ' + stdout)
  }
}
`)
  const start = String(Date.now() + 500)
  const results = await Promise.allSettled(['publish', 'publish', 'execute', 'execute'].map(role =>
    exec(process.execPath, [worker, target, role, start], { timeout: 15_000 })))
  for (const result of results) expect(result.status === 'fulfilled' ? null : result.reason).toBeNull()
  expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])
}, 20_000)
