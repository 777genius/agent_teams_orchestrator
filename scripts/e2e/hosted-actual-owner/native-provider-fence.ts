import type { OneUseFence } from '../../../src/services/opencode/OpenCodeSupervisedHostCustody.js'

/** Composition of existing retained authorities. No token is itself a root or
 * activation issuer; every owned token is consumed even on a failed fence. */
export function combineNativeProviderFences(tokens: readonly OneUseFence[], current: () => boolean,
  revoke: () => void): OneUseFence {
  const consume = tokens.map(token => token.consume.bind(token))
  let used = false
  return Object.freeze({ consume() {
    if (used) return false
    used = true
    let valid = false
    try { valid = current() } catch {}
    for (const token of consume) {
      try { valid = token() && valid } catch { valid = false }
    }
    try { valid = current() && valid } catch { valid = false }
    if (!valid) revoke()
    return valid
  } })
}
