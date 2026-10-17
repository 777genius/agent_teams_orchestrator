import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { qualifyDarwin } from './qualify-darwin.js'

test.skipIf(process.platform !== 'darwin')('helper identity mismatch cannot publish qualification', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'TEST-darwin-qualification-rejection-'))
  const output = path.join(root, 'receipt.json')
  try {
    const binary = path.join(root, 'OpenCodeV2Scope.app/Contents/MacOS/opencode-v2-darwin-scope')
    await mkdir(path.dirname(binary), { recursive: true })
    await writeFile(binary, 'TEST-changed-helper')
    await writeFile(path.join(root, 'darwin-helper.json'), JSON.stringify({ format: 1, sha256: '0'.repeat(64) }))
    // mkdtemp can return /var, whose canonical spelling on macOS is /private/var.
    const { realpath } = await import('node:fs/promises')
    await expect(qualifyDarwin(await realpath(root), output)).rejects.toThrow('execution_containment_qualification_pending')
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
