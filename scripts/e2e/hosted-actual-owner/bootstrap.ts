import { createHash } from 'node:crypto'
import { join } from 'node:path'

import type { HostedControlBootstrapAdmission } from '../../../src/services/hostedControl/HostedControlBootstrap.js'
import { validateHostedControlRuntimePaths } from '../../../src/services/hostedControl/HostedControlRuntimeConfig.js'
import {
  assertMarkerOwnedSandbox, HOSTED_APPROVAL_ADMISSION_FILE, HOSTED_APPROVAL_WAL_FILE, isWithin,
  sandboxAnchor,
  type ActualOwnerAcceptanceConfig,
} from './contracts.js'
import { readAnchoredFile, type SecureFileIdentity } from './secure-files.js'

export async function validateBootstrapAcceptance(
  config: ActualOwnerAcceptanceConfig,
  bootstrap: HostedControlBootstrapAdmission,
): Promise<{ admission: SecureFileIdentity; admissionSha256: string; configSha256: string }> {
  await assertMarkerOwnedSandbox(config.runtime)
  const runtimeConfig = bootstrap.config
  const teamRoot = join(runtimeConfig.claudeRoot, 'teams', runtimeConfig.legacyKey)
  if (!isWithin(config.sandboxRoot, runtimeConfig.claudeRoot) ||
    !isWithin(config.sandboxRoot, runtimeConfig.socketPath) ||
    !isWithin(config.sandboxRoot, teamRoot) ||
    config.admissionFile !== join(teamRoot, HOSTED_APPROVAL_ADMISSION_FILE) ||
    config.walFile !== join(teamRoot, HOSTED_APPROVAL_WAL_FILE)) {
    throw new Error('hosted_actual_owner_bootstrap_path_escaped_sandbox')
  }
  await validateHostedControlRuntimePaths(runtimeConfig)
  if (!(await bootstrap.guard.assertCurrent())) throw new Error('hosted_actual_owner_bootstrap_authority_lost')
  const admitted = await readAnchoredFile(config.admissionFile, sandboxAnchor(config.runtime), {
    minimumBytes: 2, maximumBytes: 16 * 1024 * 1024, mode: 0o600,
  })
  return {
    admission: admitted.identity,
    admissionSha256: createHash('sha256').update(admitted.bytes).digest('hex'),
    configSha256: createHash('sha256').update(JSON.stringify(runtimeConfig)).digest('hex'),
  }
}
