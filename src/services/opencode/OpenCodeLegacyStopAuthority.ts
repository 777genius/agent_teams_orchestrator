import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

// Read only desktop-owned launch evidence. Never derive a replacement capability
// from current provider state, or trust the caller's capability without this bind.
export async function readOpenCodeLegacyStopCapability(input: {
  teamsPath: string; teamId: string; laneId: string; runId: string
}): Promise<string> {
  const { teamId, laneId, runId } = input
  if (!teamId || teamId === '.' || teamId === '..' || /[\\/]/.test(teamId)
    || !laneId || laneId === '.' || laneId === '..') {
    throw new Error('OpenCode legacy stop lane identity is invalid')
  }
  const root = path.join(input.teamsPath, teamId, '.opencode-runtime')
  let raw: string
  try {
    raw = await readFile(path.join(root, 'lanes', encodeURIComponent(laneId), 'manifest.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // Match the desktop's old unscoped manifest fallback only when no sibling
    // lane storage/index can make the selected lane ambiguous. Never mutate it.
    const dirs = await readdir(path.join(root, 'lanes')).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    })
    const indexRaw = await readFile(path.join(root, 'lanes.json'), 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    const index = indexRaw === null ? { version: 1, lanes: {} } : JSON.parse(indexRaw)
    if (dirs.length || index?.version !== 1 || !index.lanes
      || typeof index.lanes !== 'object' || Array.isArray(index.lanes)
      || Object.keys(index.lanes).some(id => id !== laneId)) {
      throw new Error('OpenCode legacy stop manifest lane is ambiguous')
    }
    raw = await readFile(path.join(root, 'manifest.json'), 'utf8')
  }
  const parsed = JSON.parse(raw)
  const manifest = parsed && Object.prototype.hasOwnProperty.call(parsed, 'data') ? parsed.data : parsed
  if (manifest?.schemaVersion !== 1 || manifest.teamName !== teamId
    || manifest.activeRunId !== runId
    || typeof manifest.activeCapabilitySnapshotId !== 'string'
    || !/^opencode:[a-f0-9]{32}$/.test(manifest.activeCapabilitySnapshotId)) {
    throw new Error('OpenCode legacy stop persisted launch authority mismatch')
  }
  return manifest.activeCapabilitySnapshotId
}
