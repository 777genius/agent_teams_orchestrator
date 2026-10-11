import { readFile, writeFile } from 'node:fs/promises'
if (process.platform !== 'win32' || process.arch !== 'x64' || process.versions.bun !== '1.3.11') throw new Error('native Windows x64 Bun 1.3.11 required')
const output = process.argv[2]
if (!output) throw new Error('TEST evidence output path required')
if (process.env.TEST_WINDOWS_OFFICIAL_SHELL_BUNDLED === '1') await writeFile(output, JSON.stringify({ phase: 'before-boundary-import', qualified: false, fullTaskQualified: false }) + '\n')
process.env.TEST_WINDOWS_OFFICIAL_SHELL = '1'
await import('../opencode-v2-windows-boundary.ts')
const evidence = JSON.parse(await readFile(output, 'utf8'))
const passed = evidence.filesystemPassed === true && evidence.jobPassed === true && evidence.report?.attempts?.officialShellCheckpoint?.passed === true && evidence.officialArtifactsRetained === true && evidence.httpBridgeCheckpoint?.passed === true && evidence.httpBridgeServerCancellation === true && evidence.cleanupActiveProcesses === 0 && evidence.cleanupProcessExited === true && evidence.cleanupHeldHandlesClosed === true && evidence.ancestorOwnAcesRemoved === true && !evidence.cleanupErrors
// A Shell seam checkpoint is narrower than packaged V2 task qualification.
evidence.officialShellSeamPassed = passed
evidence.qualified = false
evidence.fullTaskQualified = false
await writeFile(output, JSON.stringify(evidence, null, 2) + '\n')
console.log(JSON.stringify({ officialShellSeamPassed: passed, qualified: false }))
process.exitCode = passed ? 0 : 2
