import { test, expect } from 'bun:test';
import { mkdir, writeFile, readFile, lstat, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { testSpace } from './test-space';
import { Wire } from './wire';
import { facts } from './facts';
import { measure } from './run';
import { sha } from '../opencode-generation-spikes/sandbox';
import { SOURCE_SHA } from './contracts';
const temp = () => testSpace('safety');
const absent = async (path: string) => { try { await lstat(path); return false; } catch (e: any) { if (e.code === 'ENOENT') return true; throw e; } };
// TEST-only independent inputs generated explicitly; no historical captures required.
async function options(parent: string) {
  const inputs = join(parent, 'TEST-inputs'); await mkdir(inputs);
  const subject = { generation: 'v2', version: '2.0.0', sourceManifestSha256: SOURCE_SHA, ruleID: 'TEST-route',
    logicalImplementation: '@opencode/ai/providers/openai-compatible', reportedSelector: 'aisdk:@ai-sdk/openai-compatible',
    configuredSelector: 'aisdk:@ai-sdk/openai-compatible', binarySha256: '1'.repeat(64), resolverSha256: '2'.repeat(64),
    platformMetadataSha256: '3'.repeat(64) };
  const acceptance = JSON.stringify({ schemaVersion: 1, kind: 'fresh-schema2-observation-acceptance', decision: 'accepted', subject });
  const receipt = JSON.stringify({ sourceManifestSha256: SOURCE_SHA, fullS3aLinuxX64BundledFourPins: true,
    results: [{ generation: 'v2', version: '2.0.0', qualificationStatus: 'PASS', sourceManifestSha256: SOURCE_SHA,
      ruleID: 'TEST-route', acceptanceSha256: sha(acceptance) }] });
  await writeFile(join(inputs, 'acceptance.json'), acceptance); await writeFile(join(inputs, 'receipt.json'), receipt);
  return { generation: 'v2', version: '2.0.0', scenario: 'default', root: join(parent, 'TEST-root'), evidence: join(parent, 'TEST-evidence'),
    acceptance: { path: join(inputs, 'acceptance.json'), sha256: sha(acceptance) },
    receipt: { path: join(inputs, 'receipt.json'), sha256: sha(receipt) },
    bundle: join(inputs, 'TEST-missing-bundle'), binary: join(inputs, 'TEST-missing-binary'), platformMetadataSha256: subject.platformMetadataSha256 } as const;
}

test('R2 invalid selected artifacts reject before creating roots or starting any subprocess', async () => {
  const parent = await temp(), spawn = Bun.spawn; let spawned = 0;
  try {
    const selected = await options(parent);
    (Bun as any).spawn = () => { spawned++; throw Error('unexpected subprocess'); };
    await expect(measure(selected)).rejects.toThrow();
    expect(await absent(selected.root)).toBe(true); expect(await absent(selected.evidence)).toBe(true); expect(spawned).toBe(0);
    await mkdir(selected.bundle);
    await writeFile(join(selected.bundle, 'root.metadata.json'), '{}');
    await expect(measure(selected)).rejects.toThrow('metadata differs');
    expect(await absent(selected.root)).toBe(true); expect(await absent(selected.evidence)).toBe(true); expect(spawned).toBe(0);
  } finally { (Bun as any).spawn = spawn; await rm(parent, { recursive: true, force: true }); }
});

test('R3 admission refuses fresh children of every Git marker kind, preserving user project bytes', async () => {
  const parent = await temp();
  try {
    const selected = await options(parent), project = join(parent, 'TEST-user-project'); await mkdir(project);
    const peer = join(project, 'user.txt'); await writeFile(peer, 'preserve user bytes');
    const marker = join(project, '.git');
    for (const variant of ['directory', 'file', 'symlink', 'malformed']) {
      if (variant === 'directory') await mkdir(marker);
      else if (variant === 'symlink') await symlink(join(project, 'missing'), marker);
      else await writeFile(marker, variant === 'file' ? 'gitdir: /TEST-other' : 'broken');
      const nested = { ...selected, root: join(project, 'TEST-child'), evidence: join(project, 'TEST-evidence') };
      await expect(measure(nested)).rejects.toThrow('Git ancestor');
      expect(await absent(nested.root)).toBe(true); expect(await absent(nested.evidence)).toBe(true);
      expect(await readFile(peer, 'utf8')).toBe('preserve user bytes');
      await rm(marker, { recursive: true, force: true });
    }
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('R4 headers recorder rejection and post-fetch abort cancel unowned received bodies', async () => {
  for (const failure of ['recorder', 'abort']) {
    let cancelled = false;
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from('partial')); }, cancel() { cancelled = true; } });
    const wire = new Wire('http://127.0.0.1:12345', async () => ({}), async name => {
      if (name.startsWith('headers')) {
        if (failure === 'recorder') throw Error('disk-write-failure');
        controller.abort(Error('post-fetch-abort'));
      }
    }, controller.signal, (async () => new Response(body)) as typeof fetch);
    try { await expect(wire.call('/readback')).rejects.toThrow(); expect(cancelled).toBe(true); }
    finally { if (!cancelled) await body.cancel(); }
  }
});

test('R5 raw V2 terminal candidates never become attributed without a native association join', () => {
  const assistant = { id: 'msg_foreign_assistant', type: 'assistant', time: { created: 1, completed: 2 }, finish: 'stop', content: [{ type: 'text', text: 'foreign output' }] };
  for (const rows of [[assistant], [{ id: 'msg_selected', type: 'user', text: 'marker' }, assistant]]) {
    const result = facts({ generation: 'v2', sessionID: 'ses_test', callerID: 'msg_selected', marker: 'marker', complete: true, rows });
    expect(result.terminalAssistantIDs).toEqual([]); expect(result.terminalCandidateIDs).toEqual(['msg_foreign_assistant']);
    expect(result.missing).toContain('canonical terminal assistant'); expect(result.status).toBe('MISSING');
  }
  const v1 = facts({ generation: 'v1', sessionID: 'ses_test', callerID: 'msg_selected', marker: 'marker', complete: true,
    rows: [{ info: { id: 'msg_selected', role: 'user' }, parts: [{ type: 'text', text: 'marker' }] },
      { info: { id: 'a', role: 'assistant', parentID: 'msg_selected', time: { completed: 2 }, finish: 'stop' }, parts: [] }] });
  expect(v1.terminalAssistantIDs).toEqual(['a']);
});

for (const stage of ['birth', 'ownership', 'start', 'endpoint', 'capture', 'wire']) {
  test(`R1 host drains intrinsic owned handle or exact birth tree after ${stage} failure`, async () => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'host-fault.fixture.ts'), stage], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: '', stderr: '' });
  });
}

test('R2 read-only TEST archive verifier binds all bytes and catches changed acquisition output', async () => {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'artifact-fault.fixture.ts')], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: '', stderr: '' });
});

test('R4 non-200 global stream and pre-consumer abort release stalled bodies', async () => {
  const { consumeSSE } = await import('./collect');
  for (const status of [503, 200]) {
    let cancelled = false;
    const abort = new AbortController();
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const wire = new Wire('http://127.0.0.1:12345', async () => ({}), async () => {}, abort.signal,
      (async () => new Response(body, { status })) as typeof fetch);
    if (status === 503) await expect(wire.stream('/api/event')).rejects.toThrow('unavailable');
    else {
      const opened = await wire.stream('/api/event'); abort.abort();
      await expect(consumeSSE(opened.body, abort.signal, async () => {}, () => {}, 'global')).rejects.toThrow();
    }
    expect(cancelled).toBe(true);
  }
});

test('R3 admission excludes SOURCE, staged/historical references, symlink ancestry and noncanonical/overlapping roots', async () => {
  const { admitRoots } = await import('./preflight');
  const { SOURCE } = await import('../opencode-generation-spikes/sandbox');
  const parent = await temp();
  try {
    const selected = await options(parent), reference = join(parent, 'TEST-historical'); await mkdir(reference);
    const trusted = { subject: { root: join(reference, 'TEST-prior') } };
    await admitRoots(selected, trusted);
    const alias = join(parent, 'TEST-link'); await symlink(reference, alias);
    for (const root of [join(SOURCE, 'TEST-child'), join(SOURCE, '.task-inputs', 'TEST-child'),
      join(reference, 'TEST-child'), join(alias, 'TEST-child'), selected.root + '/..', selected.evidence]) {
      await expect(admitRoots({ ...selected, root }, trusted)).rejects.toThrow();
    }
    await expect(admitRoots({ ...selected, evidence: join(parent, 'evidence-without-TEST') }, trusted)).rejects.toThrow();
    await expect(admitRoots({ ...selected, evidence: join(selected.root, 'TEST-nested') }, trusted)).rejects.toThrow();
    expect(await absent(selected.root)).toBe(true); expect(await absent(selected.evidence)).toBe(true);
  } finally { await rm(parent, { recursive: true, force: true }); }
});
