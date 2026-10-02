import { expect, test } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runSpike } from '../opencode-generation-client-contract-spike';

// Run from the source only as a harness entrypoint; all client/build/HTTP execution is in fresh TEST Git.
// This test detects real dual SDK/import/transport regressions missed by the owner's V1 suites.
test('S6 isolated official dual Promise package/public transport checkpoint', async () => {
  const parent = process.env.S6_OUTPUT_DIR;
  if (!parent) throw new Error('Set S6_OUTPUT_DIR to this job persistent tmp/agent evidence directory');
  const report = await runSpike(join(parent, 'client-contract'));
  expect(report.testExitCode).toBe(0);
  expect(report.cases.length).toBeGreaterThan(0);
}, 180000);

// Regression: evidence mkdir used to precede project validation, leaving run-*
// directories in protected source. This rejects before any runtime child starts.
test('runSpike rejects protected evidence and preserves existing children', async () => {
  const protectedRoot = join(import.meta.dir, '../..', '.task-inputs');
  const before = (await readdir(protectedRoot)).sort();
  const sentinel = await readFile(join(protectedRoot, 'inputs.json'));
  await expect(runSpike(join(protectedRoot, 'TEST-must-not-create', 'evidence'))).rejects.toThrow();
  expect((await readdir(protectedRoot)).sort()).toEqual(before);
  expect(await readFile(join(protectedRoot, 'inputs.json'))).toEqual(sentinel);
});
