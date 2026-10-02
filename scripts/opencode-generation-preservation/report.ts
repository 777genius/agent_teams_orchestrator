/** Human output uses recorded execution/trace facts. No inferred native history. */
export function renderReport(report: any) {
  const count = (predicate: (c: any) => boolean) => report.cases.filter(predicate).length
  const traces = ['NOT_REQUESTED', 'CAPTURED', 'MISSING_PTRACE'].map(status => `${status}=${count(c => c.traceStatus === status)}`).join(', ')
  const qualifications = ['OBSERVED', 'MISSING'].map(status => `${status}=${count(c => c.qualification === status)}`).join(', ')
  const loads = count(c => c.observation.stage === 'reader-load')
  const privilege = count(c => c.observation.reason === 'Actual unprivileged EACCES unavailable')
  const rows = report.cases.map((c: any) => `| ${c.reader} | ${c.variant} | ${c.operation} | ${c.qualification} | ${c.preservation.status} | ${c.preservation.reason} |`)
  return `# S5a pre-change store preservation baseline

Bounded checkpoint, not full OpenCode support. Actual reader/file calls only; no native host/model/provider/agent was launched. FAIL means a detected old-reader preservation hazard. MISSING means the public boundary could not be qualified.

Owner base ${report.ownerBaseSha}; product INPUT ${report.productBaseSha}; plan ${report.planSha256}; Bun ${report.toolchain.bun}.
Input hashes before/after are in inputPreservation. The harness does not attest Git metadata or frozen installation; attach controller receipts.

Counts: ${JSON.stringify(report.counts)}. Final preservation qualified: false. Native disk history/downgrade and full support gates remain open.
Execution qualifications: ${qualifications}. Reader-load gaps=${loads}. EACCES privilege gaps=${privilege}.
Syscall trace receipts: ${traces}. NOT_REQUESTED means no tracing attempt; CAPTURED means tracing recorded; MISSING_PTRACE means an attempted trace was denied with a trace-unavailable.json receipt. EACCES privilege gaps are separate execution qualifications, never reader-load or trace failures.

| Reader | Variant | Public operation | Execution | Preservation | Assessment reason |
|---|---|---|---|---|---|
${rows.join('\n')}

## Recommendations

Recommendations follow the normative namespace policy; actual public-reader availability and returns are recorded per case. They do not qualify native ownership.

${Object.entries(report.recommendations).map(([key, value]) => `- ${key}: ${value}`).join('\n')}

## Boundary gaps

${report.boundaryGaps.map((g: any) => `- ${g.operation}: MISSING. ${g.reason} Proposed later extraction: ${g.extraction}`).join('\n')}

## Evidence and limitations

Case directories retain original.bin/after.bin when present, exact observation.json, process.json, byte hashes, TEST marker and exported quarantine copies. Syscall traces exist only where captured. Original fixtures are retained outside expendable TEST copies. Unknown-file mutation/prune/cleanup acceptance is a hazard even if no rows were removed. Host transport is explicitly fake. EACCES requires a nonroot child and an actual failed filesystem read. Complete external process/network qualification remains MISSING; snapshots and tripwires qualify their observed scope only. Reader tests do not prove native layout, full cleanup safety or final support.

Executable: scripts/opencode-generation-preservation-baseline.ts --evidence-dir <external> --test-parent <separate external> [--trace] using .task-inputs/toolchain/bun. Focused gate: .task-inputs/toolchain/bun test scripts/opencode-generation-preservation.
Owned hashes and artifact digests are in artifact-manifest.json. No production/dependency/lock/public-pin changes; no commit/merge/publication.
`
}
