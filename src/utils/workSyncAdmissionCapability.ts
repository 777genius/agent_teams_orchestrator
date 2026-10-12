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
  groupChatProtocolVersion?: 1
  groupReactionProtocolVersion?: 1
  groupRunKey?: string
  runKey?: string
  bootstrapRunId?: string
  runtimeRunId?: string
  pid?: number
  nativeInboxAttachmentsVersion?: 1
  publishedAt: string
}

type CapabilityPublicationState = {
  runtimeInstanceId: string
  sawAttachmentReady: boolean
  tail: Promise<void>
}

const capabilityPublications = new Map<string, CapabilityPublicationState>()

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
  const previous = capabilityPublications.get(path)
  if (
    previous?.sawAttachmentReady &&
    previous.runtimeInstanceId === capability.runtimeInstanceId &&
    capability.nativeInboxAttachmentsVersion !== 1
  ) {
    return path
  }
  const state: CapabilityPublicationState = {
    runtimeInstanceId: capability.runtimeInstanceId,
    sawAttachmentReady:
      (previous?.runtimeInstanceId === capability.runtimeInstanceId &&
        previous.sawAttachmentReady) ||
      capability.nativeInboxAttachmentsVersion === 1,
    tail: previous?.tail ?? Promise.resolve(),
  }
  capabilityPublications.set(path, state)
  const publication = state.tail.then(async () => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(capability)}\n`, 'utf8')
  })
  state.tail = publication.catch(() => undefined)
  await publication
  return path
}
