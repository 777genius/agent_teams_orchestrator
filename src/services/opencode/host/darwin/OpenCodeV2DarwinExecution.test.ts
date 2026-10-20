import { describe, expect, test } from 'bun:test'
import path from 'node:path'
import { minimalReadOnlyRoots, uncoveredReadAncestorDirectories } from './OpenCodeV2DarwinExecution.js'

// Evaluate the read union independently using path-component containment.
function permits(roots: readonly string[], candidate: string): boolean {
  return roots.some(root => {
    const relative = path.posix.relative(root, candidate)
    return relative === '' || (!path.posix.isAbsolute(relative) &&
      relative.split('/')[0] !== '..')
  })
}

describe('Darwin read-only policy root reduction', () => {
  test('retains root grants and prefix-lookalike siblings', () => {
    expect(minimalReadOnlyRoots([
      '/test/sdk/a/deep', '/test/sdk-extra', '/test/sdk/a', '/test/sdk',
      '/test/sdk2', '/test/sd', '/test/other',
    ])).toEqual(['/test/sd', '/test/sdk', '/test/sdk2', '/test/other', '/test/sdk-extra'])
  })

  test('collapses duplicates without mutating caller input', () => {
    const input = Object.freeze(['/test/a/b', '/test/a', '/test/a', '/test/z'])
    const before = [...input]
    const result = minimalReadOnlyRoots(input)
    expect(result).toEqual(['/test/a', '/test/z'])
    expect(input).toEqual(before)
    expect(result).not.toBe(input)
  })

  test('preserves the old read union for positive paths and neighboring denials', () => {
    const original = Object.freeze([
      '/test/vendor/effect/dist', '/test/vendor/effect', '/test/vendor/effect/dist/chunks',
      '/test/vendor/effect-extra', '/test/vendor/effect2', '/test/data/public',
      '/test/vendor/effect',
    ])
    const reduced = minimalReadOnlyRoots(original)
    const positives = [
      '/test/vendor/effect', '/test/vendor/effect/index.js',
      '/test/vendor/effect/dist/chunks/module.js', '/test/vendor/effect-extra/file.js',
      '/test/vendor/effect2/package.json', '/test/data/public', '/test/data/public/child',
    ]
    const negatives = [
      '/test', '/test/vendor', '/test/vendor/effects', '/test/vendor/effect-extra2',
      '/test/vendor/effect20', '/test/data', '/test/data/publicity', '/test/data/private',
    ]
    for (const candidate of positives) {
      expect(permits(original, candidate)).toBe(true)
      expect(permits(reduced, candidate)).toBe(true)
    }
    for (const candidate of negatives) {
      expect(permits(original, candidate)).toBe(false)
      expect(permits(reduced, candidate)).toBe(false)
    }
    expect(reduced.length).toBe(4)
  })
})

describe('Darwin redundant ancestor directory grants', () => {
  test('removes only covered literals without changing either input', () => {
    const ancestors = Object.freeze([
      '/', '/test', '/test/sdk', '/test/sdk/dist', '/test/sdk-extra',
      '/test/work', '/test/mount/source', '/test/mount/target', '/usr', '/usr/local', '/usr2',
    ])
    const readSubpaths = Object.freeze([
      '/test/sdk', '/test/work', '/test/mount/source', '/test/mount/target', '/usr',
    ])
    const beforeAncestors = [...ancestors], beforeSubpaths = [...readSubpaths]
    expect(uncoveredReadAncestorDirectories(ancestors, readSubpaths)).toEqual([
      '/', '/test', '/test/sdk-extra', '/usr2',
    ])
    expect(ancestors).toEqual(beforeAncestors)
    expect(readSubpaths).toEqual(beforeSubpaths)
  })

  test('preserves directory-versus-file reads, neighboring denials and protected roots', () => {
    const ancestors = [
      '/', '/test', '/test/sdk', '/test/sdk/dist', '/test/work', '/test/work/private',
      '/test/mount/source', '/test/mount/target', '/System', '/usr/local', '/usr2',
    ]
    // The same read union includes readonly, writable, both mount paths and fixed system roots.
    const subpaths = [
      '/test/sdk', '/test/work', '/test/mount/source', '/test/mount/target',
      '/System', '/usr', '/bin', '/sbin', '/Library/Apple',
    ]
    const denied = ['/test/work/private', '/test/sdk/native']
    const reduced = uncoveredReadAncestorDirectories(ancestors, subpaths)
    const allowed = (literals: readonly string[], candidate: string, directory: boolean) =>
      !permits(denied, candidate) &&
      (permits(subpaths, candidate) || (directory && literals.includes(candidate)))
    const cases: ReadonlyArray<readonly [string, boolean, boolean]> = [
      ['/', true, true], ['/', false, false], ['/test', true, true], ['/test', false, false],
      ['/test/ungranted', true, false], ['/test/ungranted/file', false, false],
      ['/test/sdk', true, true], ['/test/sdk', false, true], ['/test/sdk/dist/file', false, true],
      ['/test/sdk-extra', true, false], ['/test/sdk2', false, false],
      ['/test/work/file', false, true], ['/test/work/private', true, false],
      ['/test/work/private/key', false, false], ['/test/sdk/native', true, false],
      ['/test/sdk/native/helper', false, false],
      ['/test/mount/source/file', false, true], ['/test/mount/target/file', false, true],
      ['/test/mount/target2', true, false], ['/System/Library/file', false, true],
      ['/usr/local', true, true], ['/usr/local/file', false, true],
      ['/usr2', true, true], ['/usr2', false, false], ['/usr2/file', false, false],
      ['/Library/Apple/file', false, true], ['/Library/Apples/file', false, false],
    ]
    for (const [candidate, directory, expected] of cases) {
      expect(allowed(ancestors, candidate, directory)).toBe(expected)
      expect(allowed(reduced, candidate, directory)).toBe(expected)
    }
    expect(reduced).toEqual(['/', '/test', '/usr2'])
  })

  test('compacts the same mixed grant union before ancestry checks while retaining protected denials', () => {
    const subpaths = Object.freeze([
      ...Array.from({ length: 256 }, (_, index) => `/test/sdk/package/${index}/dist`),
      '/test/sdk', '/test/work', '/test/mount/source/deep', '/test/mount/source',
      '/test/mount/target/deep', '/test/mount/target', '/usr', '/usr/local',
    ])
    const ancestors = Object.freeze([
      '/', '/test', '/test/sdk', '/test/sdk/package/99/dist', '/test/sdk2',
      '/test/work', '/test/work/private', '/test/mount/source', '/test/mount/target', '/usr2',
    ])
    const denied = ['/test/work/private', '/test/sdk/native']
    const before = [...subpaths]
    const reduced = uncoveredReadAncestorDirectories(ancestors, subpaths)
    const expected = ancestors.filter(directory => !permits(subpaths, directory))
    expect(reduced).toEqual(expected)
    expect(subpaths).toEqual(before)
    for (const [candidate, directory] of [
      ['/test/sdk/package/99/dist/file.js', false], ['/test/sdk2/file.js', false],
      ['/test/work/private/key', false], ['/test/sdk/native/helper', false],
      ['/test/mount/target/deep/file', false], ['/test/mount/target2/file', false],
      ['/usr2', true], ['/usr2', false],
    ] as const) {
      const oldAllows = !permits(denied, candidate) &&
        (permits(subpaths, candidate) || (directory && ancestors.includes(candidate)))
      const nextAllows = !permits(denied, candidate) &&
        (permits(subpaths, candidate) || (directory && reduced.includes(candidate)))
      expect(nextAllows).toBe(oldAllows)
    }
    expect(reduced).toEqual(['/', '/test', '/test/sdk2', '/usr2'])
  })
})
