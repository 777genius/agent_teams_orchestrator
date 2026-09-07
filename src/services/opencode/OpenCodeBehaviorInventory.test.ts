import { expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { collectProjectBehaviorMetadata } from './OpenCodeProfilePreparation.js'
import { retainOpenCodeBehaviorInventory } from './OpenCodeBehaviorInventory.js'

// Mutation hooks bracket real descriptor-relative directory enumeration; no fake
// file stats or fictional project roots stand in for the reviewed race.
for (const phase of ['preparation', 'consumption'] as const) {
  for (const mutation of ['add-link', 'excluded-link', 'replace-empty-root'] as const) {
    test(`behavior ${phase} rejects ${mutation} during enumeration`, async () => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'behavior-r1127-')))
      const tools = path.join(root, '.opencode/tools')
      fs.mkdirSync(tools, { recursive: true })
      if (mutation === 'excluded-link') fs.writeFileSync(path.join(tools, '.DS_Store'), 'excluded')
      const inode = fs.statSync(tools, { bigint: true }).ino
      let inventory: ReturnType<typeof retainOpenCodeBehaviorInventory> | undefined
      let changed = false
      const readdir = fs.readdirSync
      let mock: ReturnType<typeof spyOn> | undefined
      try {
        if (phase === 'consumption') inventory = retainOpenCodeBehaviorInventory(root)
        mock = spyOn(fs, 'readdirSync').mockImplementation(((target: fs.PathLike, options: any) => {
          const result = readdir(target, options)
          if (!changed && fs.statSync(target, { bigint: true }).ino === inode) {
            changed = true
            if (mutation === 'replace-empty-root') {
              fs.renameSync(tools, path.join(root, 'old-tools'))
              fs.symlinkSync(path.join(root, 'old-tools'), tools)
            } else {
              const leaf = path.join(tools, mutation === 'excluded-link' ? '.DS_Store' : 'new.ts')
              if (mutation === 'excluded-link') fs.unlinkSync(leaf)
              fs.symlinkSync(path.join(root, 'missing-target'), leaf)
            }
          }
          return result
        }) as typeof fs.readdirSync)
        if (phase === 'preparation') await expect(collectProjectBehaviorMetadata(root)).rejects.toThrow()
        else expect(() => inventory!.assertCurrent()).toThrow()
        expect(changed).toBe(true)
      } finally {
        mock?.mockRestore(); inventory?.close()
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  }
}

test('behavior custody retains excluded identities while allowing unrelated workspace and cache changes', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'behavior-scope-r1127-')))
  fs.mkdirSync(path.join(root, '.opencode/tools'), { recursive: true })
  fs.writeFileSync(path.join(root, '.opencode/tools/.DS_Store'), 'excluded')
  const inventory = retainOpenCodeBehaviorInventory(root)
  try {
    fs.mkdirSync(path.join(root, 'ordinary-work'))
    fs.writeFileSync(path.join(root, 'ordinary-work/source.ts'), 'workspace remains mutable')
    fs.mkdirSync(path.join(root, 'cache'))
    fs.writeFileSync(path.join(root, 'cache/generated.json'), '{}')
    expect(() => inventory.assertCurrent()).not.toThrow()
    fs.unlinkSync(path.join(root, '.opencode/tools/.DS_Store'))
    fs.symlinkSync(path.join(root, 'ordinary-work/source.ts'), path.join(root, '.opencode/tools/.DS_Store'))
    expect(() => inventory.assertCurrent()).toThrow()
  } finally { inventory.close(); fs.rmSync(root, { recursive: true, force: true }) }
})
