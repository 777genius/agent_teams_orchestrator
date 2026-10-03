import { expect, test } from 'bun:test';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertTestProject, createTestProject } from './isolation';

// Regression: late source checking leaves a marker, state dirs and Git inside
// protected inputs. Transport tests only ever used valid destinations, so missed it.
for (const kind of ['source', 'missing-descendant', 'external-alias', 'product-alias', 'reference-alias', 'linked-owner-alias']) {
  test(`TEST path preflight preserves sentinel/no children: ${kind}`, async () => {
    const parent = process.env.S6_OUTPUT_DIR;
    if (!parent) throw new Error('Set external S6_OUTPUT_DIR');
    const fixture = await createTestProject(join(parent, 'guard-fixtures'), 'path-guard');
    const source = join(fixture.root, 'TEST-protected-source');
    const product = join(source, '.task-inputs/product');
    const reference = join(source, '.task-inputs/reference');
    const owner = join(fixture.root, 'TEST-protected-linked-owner');
    for (const path of [source, product, reference, owner]) await mkdir(path, { recursive: true });
    await writeFile(join(source, '.git'), `gitdir: ${owner}/.git/worktrees/TEST-linked\n`);
    const protectedRoot = kind === 'product-alias' ? product : kind === 'reference-alias' ? reference :
      kind === 'linked-owner-alias' ? owner : source;
    await writeFile(join(protectedRoot, 'sentinel.txt'), 'TEST_SENTINEL_unchanged');
    const before = (await readdir(protectedRoot)).sort();
    let destination = protectedRoot;
    if (kind.endsWith('alias')) {
      destination = join(fixture.root, 'TEST-external-alias');
      await symlink(protectedRoot, destination);
    }
    if (kind !== 'source') destination = join(destination, 'not-created', 'nested');
    let rejected = false;
    try {
      const project = await createTestProject(destination, 'must-not-start', source);
      await assertTestProject(project.root, source);
    } catch { rejected = true; }
    // Both assertions are observable disk effects, not source inspection. The old
    // late guard rejects but fails this directory assertion after native Git ran.
    expect(rejected).toBe(true);
    expect(await readFile(join(protectedRoot, 'sentinel.txt'), 'utf8')).toBe('TEST_SENTINEL_unchanged');
    expect((await readdir(protectedRoot)).sort()).toEqual(before);
  });
}

test('disjoint external TEST destination remains executable with isolated Git identity', async () => {
  const parent = process.env.S6_OUTPUT_DIR;
  if (!parent) throw new Error('Set external S6_OUTPUT_DIR');
  const project = await createTestProject(join(parent, 'guard-fixtures', 'new-parent'), 'allowed');
  const protectedSource = join(parent, 'guard-fixtures', 'TEST-positive-protected-source');
  await mkdir(protectedSource, { recursive: true });
  const marker = await assertTestProject(project.root, protectedSource);
  expect(marker.root).toBe(project.root);
  expect(await readFile(join(project.root, '.git/config'), 'utf8')).toContain('email = iliyazelenkog@gmail.com');
});
