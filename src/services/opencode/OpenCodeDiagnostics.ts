import type { RuntimeCapabilityInfo } from '../runtimeBackends/types.js'
import {
  hasOpenCodeBuiltinFreeModel,
  isOpenCodeBuiltinFreeModelId,
} from './OpenCodeInventoryService.js'
import type { OpenCodeInventorySnapshot } from './types.js'

function countProjectPluginSources(snapshot: OpenCodeInventorySnapshot): number {
  return snapshot.profile?.behaviorSources.filter(source =>
    source.startsWith('.opencode/plugins/'),
  ).length ?? 0
}

function formatBuiltinFreeModelCount(count: number): string {
  return `${count} built-in free model${count === 1 ? '' : 's'}`
}

export function buildOpenCodeCapabilityInfo(
  snapshot: OpenCodeInventorySnapshot,
): RuntimeCapabilityInfo[] {
  const uniqueConnectedProviders = Array.from(
    new Set(snapshot.connectedProviders.map(provider => provider.id)),
  )
  const builtinFreeModelCount = snapshot.models.filter(model =>
    isOpenCodeBuiltinFreeModelId(model, snapshot.modelMetadata)
  ).length
  const projectPluginSourceCount = countProjectPluginSources(snapshot)

  return [
    {
      id: 'managed-profile',
      label: snapshot.profile
        ? `Managed profile ${snapshot.profile.profileRootKey}`
        : 'Managed profile unavailable',
      enabled: snapshot.profile !== null,
    },
    {
      id: 'behavior-sources',
      label: snapshot.profile
        ? `${snapshot.profile.behaviorSources.length} behavior sources`
        : 'Behavior sources unavailable',
      enabled: Boolean(snapshot.profile && snapshot.profile.behaviorSources.length > 0),
    },
    {
      id: 'connected-providers',
      label: `${uniqueConnectedProviders.length} connected providers`,
      enabled: uniqueConnectedProviders.length > 0,
    },
    {
      id: 'builtin-free-models',
      label: formatBuiltinFreeModelCount(builtinFreeModelCount),
      enabled: builtinFreeModelCount > 0,
    },
    {
      id: 'models',
      label: `${snapshot.models.length} inventory models`,
      enabled: snapshot.models.length > 0,
    },
    {
      id: 'agents',
      label: `${snapshot.agents.length} detected agents`,
      enabled: snapshot.agents.length > 0,
    },
    {
      id: 'project-plugins',
      label: `${projectPluginSourceCount} project plugin files`,
      enabled: projectPluginSourceCount > 0,
    },
  ]
}

export function buildOpenCodeStatusMessage(
  snapshot: OpenCodeInventorySnapshot,
): string | null {
  const hasBuiltinFreeModel = hasOpenCodeBuiltinFreeModel(
    snapshot.models,
    snapshot.modelMetadata,
  )
  if (!snapshot.detected) {
    return 'OpenCode CLI not found'
  }

  if (
    snapshot.probeError
    && snapshot.models.length === 0
    && snapshot.connectedProviders.length === 0
  ) {
    return 'OpenCode probe incomplete'
  }

  if (snapshot.connectedProviders.length === 0 && !hasBuiltinFreeModel) {
    return 'No OpenCode providers connected'
  }

  return null
}

export function buildOpenCodeDetailMessage(
  snapshot: OpenCodeInventorySnapshot,
): string | null {
  const detailParts: string[] = []

  if (snapshot.version) {
    detailParts.push(`version ${snapshot.version}`)
  }

  if (snapshot.connectedProviders.length > 0) {
    detailParts.push(
      `connected ${snapshot.connectedProviders
        .map(provider => provider.id)
        .filter((value, index, values) => values.indexOf(value) === index)
        .join(', ')}`,
    )
  }

  const builtinFreeModelCount = snapshot.models.filter(model =>
    isOpenCodeBuiltinFreeModelId(model, snapshot.modelMetadata)
  ).length
  if (builtinFreeModelCount > 0) {
    detailParts.push(formatBuiltinFreeModelCount(builtinFreeModelCount))
  }

  if (snapshot.authStorePath) {
    detailParts.push(`auth ${snapshot.authStorePath}`)
  }

  if (snapshot.profile) {
    detailParts.push(
      `behavior ${snapshot.profile.projectBehaviorFingerprint.slice(0, 12)} (${snapshot.profile.behaviorSources.length} sources)`,
    )
    detailParts.push(`managed ${snapshot.profile.managedConfigFingerprint.slice(0, 12)}`)
    const projectPluginSourceCount = countProjectPluginSources(snapshot)
    if (projectPluginSourceCount > 0) {
      detailParts.push(`project plugins ${projectPluginSourceCount}`)
    }
  }

  if (snapshot.profile?.authState === 'stale') {
    detailParts.push('managed auth import is stale')
  }

  if (snapshot.probeError) {
    detailParts.push(snapshot.probeError)
  }

  return detailParts.length > 0 ? detailParts.join(' - ') : null
}
