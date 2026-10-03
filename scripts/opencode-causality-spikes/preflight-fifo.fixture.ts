// Fresh TEST child: only the public read-only preflight boundary, no executable input.
import { preflightArtifact } from './preflight';
const bundle = process.argv[2];
console.log('READY');
try {
  await preflightArtifact({ generation: 'v2', version: '2.0.0', scenario: 'default', bundle,
    binary: bundle + '/unused', platformMetadataSha256: '3'.repeat(64) },
    { platformMetadataSha256: '3'.repeat(64), rootMetadataSha256: '4'.repeat(64) });
  console.log('RESOLVED');
} catch (error) { console.log('REJECTED ' + String(error)); }
