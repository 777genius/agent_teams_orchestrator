import { types as nodeUtilTypes } from 'node:util'

import {
  decodeOpenCodeLaunchAttemptRequest,
  type OpenCodeLaunchAttemptRequest,
} from './OpenCodeBridgeContractV2.js'

export class OpenCodeLaunchRoutingError extends Error {
  readonly code: 'unsupported' | 'not_authorized'

  constructor(code: 'unsupported' | 'not_authorized', readonly field: string) {
    super(code === 'not_authorized'
      ? `OpenCode launch unsupported/not-authorized: ${field}`
      : `OpenCode launch unsupported: ${field}`)
    this.name = 'OpenCodeLaunchRoutingError'
    this.code = code
  }
}

/**
 * Decodes the only production launch authorization accepted by the command
 * handler. The envelope version remains optional for the compatibility window,
 * but the complete launchAttempt body never is: genuinely legacy requests fail
 * closed instead of falling through to the former provisioning/session path.
 */
export function decodeStrictOpenCodeProductionLaunch(
  value: unknown,
): OpenCodeLaunchAttemptRequest {
  const candidate = addOptionalProductionVersion(value)
  const decoded = decodeOpenCodeLaunchAttemptRequest(candidate)
  if (decoded.ok === false) {
    throw new OpenCodeLaunchRoutingError(
      decoded.error.code === 'unsupported_version' ? 'unsupported' : 'not_authorized',
      decoded.error.field,
    )
  }
  if (decoded.value.kind !== 'v2') {
    throw new OpenCodeLaunchRoutingError('not_authorized', 'launchAttempt')
  }
  return decoded.value.request
}

function addOptionalProductionVersion(value: unknown): unknown {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || nodeUtilTypes.isProxy(value)
  ) return value

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return value
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).some(key => typeof key === 'symbol')) return value
  if (Object.prototype.hasOwnProperty.call(descriptors, 'launchContractVersion')) return value

  const attempt = descriptors.launchAttempt
  if (!attempt || !('value' in attempt)) return value
  return Object.freeze({
    launchContractVersion: 1,
    launchAttempt: attempt.value,
  })
}
