import { expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createNativeBehaviorNamespaceCheck } from './native-behavior-custody.js'
import { retainOpenCodeBehaviorInventory } from '../../../src/services/opencode/OpenCodeBehaviorInventory.js'

// Real retained descriptors; kernel mount/status observations are simulated.
// Independent root-mounted namespace and remount negatives remain root gates.
test('native behavior requires readonly custody before bytes, then revalidates mount and credentials', () => {
  for (const mutation of ['initial-writable', 'remount', 'mount-id', 'saved-uid'] as const) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'native-behavior-r1127-')))
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'selected behavior')
    const readFile = fs.readFileSync, read = fs.readSync
    let readonly = mutation !== 'initial-writable', id = '42', uidChanged = false, byteReads = 0
    const uid = process.getuid!()
    const mocks = [
      spyOn(fs, 'readFileSync').mockImplementation(((target: fs.PathOrFileDescriptor, options: any) => {
        if (target === '/proc/self/status') return `Uid:\t${uid} ${uid} ${uidChanged ? uid + 1 : uid} ${uid}\nNoNewPrivs:\t1\nCapEff:\t0\nCapPrm:\t0\nCapAmb:\t0\n`
        if (target === '/proc/self/mountinfo') return `42 1 8:1 / / ${readonly ? 'ro' : 'rw'} - ext4 /fixture rw\n`
        if (typeof target === 'string' && target.startsWith('/proc/self/fdinfo/')) return `mnt_id:\t${id}\n`
        return readFile(target, options)
      }) as typeof fs.readFileSync),
      spyOn(fs, 'readSync').mockImplementation(((...args: any[]) => {
        byteReads++; return (read as any)(...args)
      }) as typeof fs.readSync),
    ]
    let inventory: ReturnType<typeof retainOpenCodeBehaviorInventory> | undefined
    try {
      const acquire = () => retainOpenCodeBehaviorInventory(root, createNativeBehaviorNamespaceCheck(root))
      if (mutation === 'initial-writable') {
        expect(acquire).toThrow(); expect(byteReads).toBe(0)
      } else {
        inventory = acquire()
        expect(() => inventory!.assertCurrent()).not.toThrow()
        if (mutation === 'remount') readonly = false
        if (mutation === 'mount-id') id = '43'
        if (mutation === 'saved-uid') uidChanged = true
        expect(() => inventory!.assertCurrent()).toThrow()
      }
    } finally {
      inventory?.close()
      for (const mock of mocks.reverse()) mock.mockRestore()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
})
