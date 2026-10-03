import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// Runtime TMPDIR may itself be a Git checkout. Tests can redirect this independently.
export async function testSpace(label: string) {
  const base = process.env.S1A_TEST_TMPDIR ?? tmpdir();
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, 'TEST-s1a-' + label + '-'));
}
