import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ensureOpenCodeDirectory as ensure } from './ensureOpenCodeDirectory.js'

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-ensure-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}
const failure = (code: string) => ({ code }) // errno need not be an Error instance
const directory = { isDirectory: () => true }
const file = { isDirectory: () => false }

test('existing nonempty directory and retries preserve content/mode without mkdir', async t => {
  const root = await fixture(t)
  await fs.writeFile(path.join(root, 'keep'), 'unchanged')
  const before = await fs.stat(root)
  for (let i = 0; i < 3; i++) {
    await ensure(root, { stat: fs.stat, mkdir: async () => { assert.fail('mkdir on existing directory') } })
  }
  assert.equal(await fs.readFile(path.join(root, 'keep'), 'utf8'), 'unchanged')
  assert.equal((await fs.stat(root)).mode, before.mode)
})

test('recursive creation; file and file ancestor conflicts fail', async t => {
  const root = await fixture(t)
  const nested = path.join(root, 'a', 'b')
  await ensure(nested)
  assert.ok((await fs.stat(nested)).isDirectory())
  const conflict = path.join(root, 'file')
  await fs.writeFile(conflict, 'keep')
  await assert.rejects(ensure(conflict), { code: 'EEXIST' })
  await assert.rejects(ensure(path.join(conflict, 'child')))
  assert.equal(await fs.readFile(conflict, 'utf8'), 'keep')
})

test('directory symlink/junction succeeds without mkdir; broken link fails', async t => {
  const root = await fixture(t)
  const target = path.join(root, 'target')
  const link = path.join(root, 'link')
  await fs.mkdir(target)
  await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  await ensure(link, { stat: fs.stat, mkdir: async () => { assert.fail('mkdir on directory link') } })
  await fs.rmdir(target)
  await assert.rejects(ensure(link), { code: 'EEXIST' })
  await assert.rejects(fs.stat(target), { code: 'ENOENT' })
  assert.ok((await fs.lstat(link)).isSymbolicLink())
})

for (const result of ['directory', 'file', 'missing'] as const) {
  test(`Windows EEXIST after initial ENOENT: ${result}`, async t => {
    const root = await fixture(t)
    const exists = failure('EEXIST')
    let calls = 0
    const run = ensure(path.join(root, 'new'), {
      stat: async () => {
        if (++calls === 1 || result === 'missing') throw failure('ENOENT')
        return result === 'directory' ? directory : file
      },
      mkdir: async () => { throw exists },
    })
    if (result === 'directory') await run
    else await assert.rejects(run, e => e === exists)
    assert.equal(calls, 2)
  })
}

for (const result of ['directory', 'file', 'missing'] as const) {
  test(`successful mkdir is verified: ${result}`, async t => {
    const root = await fixture(t)
    let calls = 0
    const run = ensure(path.join(root, 'new'), {
      stat: async () => {
        if (++calls === 1 || result === 'missing') throw failure('ENOENT')
        return result === 'directory' ? directory : file
      },
      mkdir: async () => undefined,
    })
    if (result === 'directory') await run
    else await assert.rejects(run, { code: 'EEXIST' })
    assert.equal(calls, 2)
  })
}

test('real concurrent creator wins between stat and mkdir', async t => {
  const root = await fixture(t)
  const target = path.join(root, 'race')
  await ensure(target, {
    stat: fs.stat,
    mkdir: async p => {
      await fs.mkdir(p)
      await fs.writeFile(path.join(p, 'winner'), 'keep')
      throw failure('EEXIST')
    },
  })
  assert.equal(await fs.readFile(path.join(target, 'winner'), 'utf8'), 'keep')
})

for (const code of ['EACCES', 'EPERM', 'ENOSPC', 'EIO']) {
  for (const stage of ['initial stat', 'mkdir', 'confirmation stat', 'post-create stat']) {
    test(`${stage} preserves ${code}`, async t => {
      const root = await fixture(t)
      const error = failure(code)
      let stats = 0
      await assert.rejects(ensure(path.join(root, 'new'), {
        stat: async () => {
          stats++
          if (stage === 'initial stat' || stats > 1) throw error
          throw failure('ENOENT')
        },
        mkdir: async () => {
          assert.notEqual(stage, 'initial stat')
          if (stage === 'post-create stat') return
          throw stage === 'mkdir' ? error : failure('EEXIST')
        },
      }), e => e === error)
    })
  }
}

// Bun 1.3.11's node:test shim ignores the options.skip field.
const windowsTest = process.platform === 'win32' ? test : test.skip
windowsTest('Windows ReadOnly directory survives repeated ensures', async t => {
  const root = await fixture(t)
  await fs.writeFile(path.join(root, 'keep'), 'keep')
  try {
    execFileSync('attrib.exe', ['+R', root])
    await ensure(root)
    await ensure(root)
    const nested = path.join(root, 'new', 'nested')
    await ensure(nested)
    assert.ok((await fs.stat(nested)).isDirectory())
    assert.equal(await fs.readFile(path.join(root, 'keep'), 'utf8'), 'keep')
    assert.match(execFileSync('attrib.exe', [root], { encoding: 'utf8' }).split(root)[0], /R/)
  } finally {
    execFileSync('attrib.exe', ['-R', root])
  }
})

const posixTest = process.platform === 'win32' ? test.skip : test
posixTest('existing POSIX directory retains read-only permissions', async t => {
  const root = await fixture(t)
  await fs.chmod(root, 0o500)
  try {
    await ensure(root)
    assert.equal((await fs.stat(root)).mode & 0o777, 0o500)
  } finally {
    await fs.chmod(root, 0o700)
  }
})
