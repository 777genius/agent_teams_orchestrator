import type { NormalizedBootstrapMember } from './teamBootstrapTypes.js'

type BootstrapSpawnStaggerPolicy = {
  key: string
  stepMs: number
  maxDelayMs: number
  matches: (member: NormalizedBootstrapMember) => boolean
}

const BOOTSTRAP_SPAWN_STAGGER_POLICIES: readonly BootstrapSpawnStaggerPolicy[] = [
  {
    key: 'provider:gemini',
    stepMs: 1500,
    maxDelayMs: 4500,
    matches: member => member.provider === 'gemini',
  },
]

export function getBootstrapSpawnDelayMs(
  members: readonly NormalizedBootstrapMember[],
  memberIndex: number,
): number {
  const member = members[memberIndex]
  if (!member) {
    return 0
  }

  for (const policy of BOOTSTRAP_SPAWN_STAGGER_POLICIES) {
    if (!policy.matches(member)) {
      continue
    }
    let sameBucketOrdinal = 0
    for (let index = 0; index < memberIndex; index += 1) {
      if (policy.matches(members[index]!)) {
        sameBucketOrdinal += 1
      }
    }
    return Math.min(policy.maxDelayMs, sameBucketOrdinal * policy.stepMs)
  }

  return 0
}
