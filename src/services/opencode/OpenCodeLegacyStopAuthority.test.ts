import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readOpenCodeLegacyStopCapability } from './OpenCodeLegacyStopAuthority.js'

test('legacy cleanup reads the original desktop capability and rejects foreign run/team/schema', async () => {
  const teamsPath = await mkdtemp(path.join(os.tmpdir(), 'cursor-stop-manifest-'))
  try {
    const input = { teamsPath, teamId: 'team', laneId: 'lane with spaces', runId: 'run' }
    const dir = path.join(teamsPath, 'team', '.opencode-runtime', 'lanes', encodeURIComponent(input.laneId))
    await mkdir(dir, { recursive: true })
    const manifest = { schemaVersion: 1, teamName: 'team', activeRunId: 'run',
      activeCapabilitySnapshotId: `opencode:${'a'.repeat(32)}` }
    for (const wrapped of [false, true]) {
      await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(wrapped ? { data: manifest } : manifest))
      assert.equal(await readOpenCodeLegacyStopCapability(input), manifest.activeCapabilitySnapshotId)
    }
    for (const patch of [{ teamName: 'other' }, { activeRunId: 'other' }, { schemaVersion: 2 },
      { activeCapabilitySnapshotId: null }]) {
      await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ ...manifest, ...patch }))
      await assert.rejects(readOpenCodeLegacyStopCapability(input))
    }
    await assert.rejects(readOpenCodeLegacyStopCapability({ ...input, teamId: '../other' }))
    await assert.rejects(readOpenCodeLegacyStopCapability({ ...input, laneId: '..' }))
  } finally { await rm(teamsPath, { recursive: true, force: true }) }
})

test('old unscoped desktop manifest is usable only without ambiguous sibling lane state', async () => {
  const teamsPath = await mkdtemp(path.join(os.tmpdir(), 'cursor-stop-old-manifest-'))
  try {
    const input = { teamsPath, teamId: 'team', laneId: 'primary', runId: 'run' }
    const root = path.join(teamsPath, 'team', '.opencode-runtime')
    await mkdir(root, { recursive: true })
    const capability = `opencode:${'b'.repeat(32)}`
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 1,
      teamName: 'team', activeRunId: 'run', activeCapabilitySnapshotId: capability }))
    assert.equal(await readOpenCodeLegacyStopCapability(input), capability)
    await writeFile(path.join(root, 'lanes.json'), JSON.stringify({ version: 1, lanes: { sibling: {} } }))
    await assert.rejects(readOpenCodeLegacyStopCapability(input), /ambiguous/)
    await rm(path.join(root, 'lanes.json'))
    await mkdir(path.join(root, 'lanes', 'sibling'), { recursive: true })
    await assert.rejects(readOpenCodeLegacyStopCapability(input), /ambiguous/)
  } finally { await rm(teamsPath, { recursive: true, force: true }) }
})
