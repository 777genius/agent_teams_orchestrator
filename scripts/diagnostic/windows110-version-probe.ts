import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createOpenCodeV2ReadRoots } from '../../src/services/opencode/profile/OpenCodeV2ManagedConfig.js'
import { readOpenCodeOwnedVersion } from '../../src/services/opencode/compatibility/OpenCodeVersionProbe.js'

assert.equal(process.platform, 'win32')
assert.equal(process.env.TEST_SOURCE_COMMIT, 'd64fda3f249153e1d6a828817343a508053099b9')
assert(process.env.TEST_VERSION_DIAGNOSTIC_TRACE)
assert(process.env.TEST_NODE_EXECUTABLE && path.isAbsolute(process.env.TEST_NODE_EXECUTABLE))
const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'TEST-win110-version-observation-'))
const fixture = path.join(fixtureRoot, 'short-lived.cjs')
const launcher = path.join(fixtureRoot, 'opencode.cmd')
await writeFile(fixture, 'process.stdout.write("1.15.10\\n");\n')
await writeFile(launcher, `@echo off\r\n"${process.env.TEST_NODE_EXECUTABLE}" "${fixture}" %*\r\n`)
const roots = await createOpenCodeV2ReadRoots()
const started = Date.now()
let result: unknown
try {
  result = { status: 'RETURNED', version: await readOpenCodeOwnedVersion(launcher, roots), elapsedMs: Date.now() - started }
} catch (error) {
  result = { status: 'THREW', name: error instanceof Error ? error.name : 'unknown', message: error instanceof Error ? error.message : 'unknown', elapsedMs: Date.now() - started }
}
await writeFile(process.env.TEST_VERSION_DIAGNOSTIC_RESULT ?? path.join(fixtureRoot, 'result.json'), JSON.stringify({ schema: 1, diagnosticOnly: true, sourceCommit: process.env.TEST_SOURCE_COMMIT, fixtureRoot, privateRoot: roots.root, result, noModel: true, cleanup: 'Retained; no extra kill authority or acceptance change' }, null, 2))
console.log(JSON.stringify({ fixtureRoot, result }))
