#!/usr/bin/env bun
import { isAbsolute, resolve } from 'node:path';
import { selection } from './opencode-causality-spikes/contracts';
import { measure } from './opencode-causality-spikes/run';

export function argumentsFor(argv: string[]) {
  const values = new Map<string, string>();
  const allowed = ['generation', 'pin', 'scenario', 'root', 'evidence', 's3a-receipt', 's3a-receipt-sha256',
    'controller-acceptance', 'controller-acceptance-sha256', 'official-bundle', 'binary', 'platform-metadata-sha256'];
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, ''), value = argv[i + 1];
    if (!argv[i]?.startsWith('--') || !allowed.includes(key) || !value || value.startsWith('--') || values.has(key)) throw new Error('invalid/duplicate CLI argument');
    values.set(key, value);
  }
  const get = (key: string) => { const v = values.get(key); if (!v) throw new Error('required explicit --' + key); return v; };
  const path = (key: string) => { const p = get(key); if (!isAbsolute(p) || resolve(p) !== p) throw new Error('absolute canonical --' + key + ' required'); return p; };
  return { ...selection(get('generation'), get('pin'), get('scenario')), root: path('root'), evidence: path('evidence'),
    receipt: { path: path('s3a-receipt'), sha256: get('s3a-receipt-sha256') },
    acceptance: { path: path('controller-acceptance'), sha256: get('controller-acceptance-sha256') },
    bundle: path('official-bundle'), binary: path('binary'), platformMetadataSha256: get('platform-metadata-sha256') };
}
if (import.meta.main) {
  try { await measure(argumentsFor(process.argv.slice(2))); }
  catch (e) { process.stderr.write(String(e) + '\n'); process.exitCode = 1; }
}
