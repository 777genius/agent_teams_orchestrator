import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { link, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { main } from './native-windows-execution-smoke.js'

test('invalid receipt arguments cannot overwrite a runtime executable or an external JSON file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'TEST-native-execution-receipt-'))
  try {
    for (const name of ['node.exe', 'external.json']) {
      const file = path.join(root, name), original = `TEST untouched ${name}`
      await writeFile(file, original)
      await expect(main('/TEST-cli', '/TEST-node', file, 'win32-x64'))
        .rejects.toThrow('Receipt must be a JSON file in the current directory')
      expect(await readFile(file, 'utf8')).toBe(original)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('an existing receipt or hardlink cannot overwrite an owned external file or change the environment', async () => {
  // The parent keeps both paths on the same volume for the portable hardlink case.
  const root = await mkdtemp(path.join(path.dirname(process.cwd()), 'TEST-native-execution-alias-'))
  const receipt = path.join(process.cwd(), `TEST-native-execution-${randomUUID()}.json`)
  const target = path.join(root, 'owned-target.txt'), original = 'TEST external bytes stay unchanged'
  const environment = { ...process.env }, directory = process.cwd()
  try {
    await writeFile(target, original)
    for (const hardlink of [false, true]) {
      if (hardlink) await link(target, receipt)
      else await writeFile(receipt, original)
      await expect(main('/TEST-cli', '/TEST-node', receipt, 'win32-x64'))
        .rejects.toThrow('Receipt destination must not already exist')
      expect(await readFile(receipt, 'utf8')).toBe(original)
      expect(await readFile(target, 'utf8')).toBe(original)
      expect(process.cwd()).toBe(directory)
      expect({ ...process.env }).toEqual(environment)
      await rm(receipt)
    }
  } finally { await rm(receipt, { force: true }); await rm(root, { recursive: true, force: true }) }
})

// Windows file symlinks require privileges; the hardlink contract runs on both native Windows targets.
test.skipIf(process.platform === 'win32')('JSON symlinks, including dangling aliases, are refused before side effects', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'TEST-native-execution-symlink-'))
  const receipt = path.join(process.cwd(), `TEST-native-execution-${randomUUID()}.json`)
  const target = path.join(root, 'owned-target.txt'), original = 'TEST symlink target stays unchanged'
  const environment = { ...process.env }, directory = process.cwd()
  try {
    await writeFile(target, original)
    for (const destination of [target, path.join(root, 'missing-target')]) {
      await symlink(destination, receipt)
      await expect(main('/TEST-cli', '/TEST-node', receipt, 'win32-x64'))
        .rejects.toThrow('Receipt destination must not already exist')
      expect(await readFile(target, 'utf8')).toBe(original)
      expect(process.cwd()).toBe(directory)
      expect({ ...process.env }).toEqual(environment)
      await rm(receipt)
    }
  } finally { await rm(receipt, { force: true }); await rm(root, { recursive: true, force: true }) }
})
