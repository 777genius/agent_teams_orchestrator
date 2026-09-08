/** Source entry only. Root selects/builds the artifact and pins its complete map.
 * The resolver has explicit inputs; importing the desktop manager here is forbidden.
 */
export { prepareOpenCodeProfile, collectProjectBehaviorMetadata } from '../services/opencode/OpenCodeProfilePreparation.js'
export { retainPreparedProfile } from '../services/opencode/OpenCodePreparedProfileContract.js'
export { resolveOpenCodeAppMcpLaunchConfig } from '../services/opencode/OpenCodeAppMcpLaunchConfig.js'
export { buildResolvedConfigFingerprint } from '../services/opencode/OpenCodeResolvedConfigFingerprint.js'
export type { OpenCodeProfilePreparationInput } from '../services/opencode/OpenCodeProfilePreparation.js'
export type { OpenCodeBoundedExecutionPaths } from '../services/opencode/OpenCodeBoundedPaths.js'
