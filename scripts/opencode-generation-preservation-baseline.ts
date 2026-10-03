#!/usr/bin/env bun
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { cp } from 'node:fs/promises'
import { renderReport } from './opencode-generation-preservation/report'
import { safeWrite, assertNoSymlinks } from './opencode-generation-preservation/isolation'
import { auditEvidence } from './opencode-generation-preservation/audit'
import { runBaseline, sealArtifacts, persistentRoot, ownerSource } from './opencode-generation-preservation/baseline'

const get = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined }
const run = `S5a-${Date.now()}`
const evidenceDir = path.resolve(get('--evidence-dir') ?? path.join(persistentRoot, run))
const testParent = path.resolve(get('--test-parent') ?? path.join(persistentRoot, `${run}-TEST-projects`))
const report = await runBaseline({ evidenceDir, testParent, trace: process.argv.includes('--trace') })
await safeWrite(path.join(evidenceDir, 'report.md'), renderReport(report))
const audit = await auditEvidence(evidenceDir)
await safeWrite(path.join(evidenceDir, 'audit.json'), JSON.stringify(audit, null, 2))
if (!audit.ok) throw new Error(audit.failures.join('\n'))
await sealArtifacts(evidenceDir)
// Explicit final workspace export is separate from external evidence roots.
if (!process.argv.includes('--no-export')) {
  const output = path.join(ownerSource, '.task-output')
  await assertNoSymlinks(path.join(output, run))
  await mkdir(output, { recursive: true })
  await mkdir(path.join(output, run)) // Exclusive fresh export; never overwrite an earlier packet.
  await cp(evidenceDir, path.join(output, run), { recursive: true })
}
console.log(JSON.stringify({ evidenceDir, workspaceOutput: process.argv.includes('--no-export') ? null : path.join(ownerSource, '.task-output', run), testParent, counts: report.counts, fullSupport: false, preservationQualified: false }))
