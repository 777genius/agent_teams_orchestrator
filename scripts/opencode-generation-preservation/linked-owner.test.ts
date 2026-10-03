import { expect, test } from 'bun:test'
import { cp, mkdir, mkdtemp, readFile, stat, writeFile, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import { ownerSource, persistentRoot } from './baseline'

// Red on99e8cc: runBaseline creates evidence/TEST-project directories in a
// linked owner checkout before its later build failure. Fixtures are TEST only.
for (const target of ['evidence', 'projects'] as const) test(`linked owner ${target} rejects before any write`, async () => {
  const root = await mkdtemp(path.join(persistentRoot, 'TEST-S5a-linked-owner-'))
  const owner = path.join(root, 'owner'), work = path.join(root, 'work')
  const admin = path.join(owner, '.git/worktrees/work')
  await mkdir(admin, { recursive: true })
  await mkdir(path.join(work, 'scripts'), { recursive: true })
  await cp(path.join(ownerSource, 'scripts/opencode-generation-preservation'), path.join(work, 'scripts/opencode-generation-preservation'), { recursive: true })
  await writeFile(path.join(work, '.git'), `gitdir: ${admin}\n`)
  await writeFile(path.join(admin, 'commondir'), '../..\n')
  for (const name of ['product', 'reference']) await mkdir(path.join(work, '.task-inputs', name), { recursive: true })
  const sentinel = path.join(owner, 'sentinel.txt'); await writeFile(sentinel, 'UNCHANGED')
  const forbidden = path.join(owner, `TEST-${target}`)
  const evidenceDir = target === 'evidence' ? forbidden : path.join(root, 'TEST-external-evidence')
  const testParent = target === 'projects' ? forbidden : path.join(root, 'TEST-external-projects')
  const { runBaseline } = await import(path.join(work, 'scripts/opencode-generation-preservation/baseline.ts'))
  await expect(runBaseline({ evidenceDir, testParent, selectedReaders: [], selectedVariants: [] })).rejects.toThrow('Output overlaps source INPUT')
  expect(await stat(forbidden).then(() => true, () => false)).toBe(false)
  expect(await stat(evidenceDir).then(() => true, () => false)).toBe(false)
  expect(await readFile(sentinel, 'utf8')).toBe('UNCHANGED')
})

// A malformed metadata path must never reduce source protection to a guess.
for (const variant of ['missing-gitfile', 'symlink-gitfile', 'directory-commondir', 'missing-admin', 'missing-commondir', 'nonexistent-common', 'symlink-commondir', 'redirected-common'] as const) {
  test(`invalid linked metadata ${variant} rejects before evidence creation`, async () => {
    const root = await mkdtemp(path.join(persistentRoot, 'TEST-S5a-invalid-owner-'))
    const owner = path.join(root, 'owner'), work = path.join(root, 'work'), admin = path.join(owner, '.git/worktrees/work')
    await mkdir(admin, { recursive: true }); await mkdir(path.join(work, 'scripts'), { recursive: true })
    await cp(path.join(ownerSource, 'scripts/opencode-generation-preservation'), path.join(work, 'scripts/opencode-generation-preservation'), { recursive: true })
    await writeFile(path.join(work, '.git'), `gitdir: ${admin}\n`); await writeFile(path.join(admin, 'commondir'), '../..\n')
    const other = path.join(root, 'other/.git'); await mkdir(other, { recursive: true })
    if (variant === 'missing-gitfile') await rm(path.join(work, '.git'))
    if (variant === 'symlink-gitfile') { await rm(path.join(work, '.git')); await symlink(path.join(owner, '.git'), path.join(work, '.git')) }
    if (variant === 'directory-commondir') { await rm(path.join(admin, 'commondir')); await mkdir(path.join(admin, 'commondir')) }
    if (variant === 'missing-admin') await rm(admin, { recursive: true })
    if (variant === 'missing-commondir') await rm(path.join(admin, 'commondir'))
    if (variant === 'nonexistent-common') await writeFile(path.join(admin, 'commondir'), path.join(root, 'missing/.git'))
    if (variant === 'redirected-common') await writeFile(path.join(admin, 'commondir'), other)
    if (variant === 'symlink-commondir') { await writeFile(path.join(root, 'redirect'), other); await rm(path.join(admin, 'commondir')); await symlink(path.join(root, 'redirect'), path.join(admin, 'commondir')) }
    const sentinel = path.join(owner, 'sentinel.txt'); await writeFile(sentinel, 'UNCHANGED')
    const evidenceDir = path.join(owner, 'TEST-evidence'), testParent = path.join(root, 'TEST-external-projects')
    const { runBaseline } = await import(path.join(work, 'scripts/opencode-generation-preservation/baseline.ts'))
    await expect(runBaseline({ evidenceDir, testParent, selectedReaders: [], selectedVariants: [] })).rejects.toThrow()
    expect(await stat(evidenceDir).then(() => true, () => false)).toBe(false)
    expect(await stat(testParent).then(() => true, () => false)).toBe(false)
    expect(await readFile(sentinel, 'utf8')).toBe('UNCHANGED')
  })
}
