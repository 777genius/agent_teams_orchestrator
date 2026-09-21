import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { buildWorkSyncAdmissionRoot } from './workSyncContinuationAdmission.js'

export type WorkSyncAdmissionProviderId = 'codex' | 'anthropic'

export type WorkSyncAdmissionCapability = {
  schemaVersion: 1
  recoveryProtocolVersion: 2
  teamName: string
  teamIncarnation: string
  memberName: string
  providerId: WorkSyncAdmissionProviderId
  runtimeMode: 'app-server' | 'repl'
  runtimeInstanceId: string
  generation: number
  processorReady: true
  publishedAt: string
}

export function buildWorkSyncAdmissionCapabilityPath(input: {
  teamName: string
  memberName: string
  teamsDir?: string
}): string {
  return join(
    buildWorkSyncAdmissionRoot({
      teamName: input.teamName,
      memberName: input.memberName,
      teamsDir: input.teamsDir,
    }),
    'capability.json',
  )
}

export async function writeWorkSyncAdmissionCapability(
  capability: WorkSyncAdmissionCapability,
  teamsDir?: string,
): Promise<string> {
  const path = buildWorkSyncAdmissionCapabilityPath({
    teamName: capability.teamName,
    memberName: capability.memberName,
    teamsDir,
  })
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(capability)}\n`, 'utf8')
  return path
}
