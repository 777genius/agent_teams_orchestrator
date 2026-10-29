import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
