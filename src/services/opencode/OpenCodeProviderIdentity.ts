import { isIP } from 'node:net'

import { normalizeOpenCodeProviderId } from './OpenCodeModelRef.js'

const OPEN_CODE_PROVIDER_ALIASES = new Map<string, string>([
  ['lm-studio', 'lmstudio'],
  ['llamacpp', 'llama.cpp'],
  ['minimax-token-plan', 'minimax-coding-plan'],
  ['minimax-token-plan-(minimax.io)', 'minimax-coding-plan'],
  ['xiaomi-token-plan-(europe)', 'xiaomi-token-plan-ams'],
  ['xiaomi-token-plan-(singapore)', 'xiaomi-token-plan-sgp'],
  ['xiaomi-token-plan-(china)', 'xiaomi-token-plan-cn'],
  ['xiaomi-mimo-token-plan---europe', 'xiaomi-token-plan-ams'],
  ['xiaomi-mimo-token-plan---singapore', 'xiaomi-token-plan-sgp'],
  ['xiaomi-mimo-token-plan---china', 'xiaomi-token-plan-cn'],
  ['z.ai-coding-plan', 'zai-coding-plan'],
  ['kimi-code-membership', 'kimi-for-coding'],
  ['amazon-q-developer-/-kiro', 'kiro'],
])

export function canonicalizeOpenCodeProviderId(value: string): string {
  const displayLabel = value.trim().toLowerCase().replace(/\s+/g, ' ')
  // The auth CLI prints the built-in provider's display name, not its ID.
  // Match the spaced label so a custom raw ID "opencode-zen" stays distinct.
  if (displayLabel === 'opencode zen') return 'opencode'
  const label = displayLabel.replace(/ /g, '-')
  return (
    OPEN_CODE_PROVIDER_ALIASES.get(label)
    ?? normalizeOpenCodeProviderId(label)
    ?? label
  )
}

const LOCAL_INEXACT_OPEN_CODE_LAUNCH_PROVIDER_IDS = new Set([
  'llama.cpp',
  'llamacpp',
  'lmstudio',
  'lm-studio',
  'local',
  'ollama',
  'vllm',
])

export function isLocalInexactOpenCodeLaunchProviderId(
  providerId: string | null | undefined,
): boolean {
  if (!providerId?.trim()) return false
  return LOCAL_INEXACT_OPEN_CODE_LAUNCH_PROVIDER_IDS.has(
    canonicalizeOpenCodeProviderId(providerId),
  )
}

export function isLiteralLoopbackOpenCodeUrl(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) {
    return false
  }

  const source = value.trim()
  const authority = /^[A-Za-z][A-Za-z\d+.-]*:\/\/([^/?#]*)/.exec(source)?.[1]
  if (!authority || authority.includes('@')) {
    return false
  }

  try {
    const url = new URL(source)
    if (url.username || url.password) {
      return false
    }

    let literalHostname: string
    if (authority.startsWith('[')) {
      const closingBracket = authority.indexOf(']')
      if (closingBracket < 0 || !/^(?::\d+)?$/.test(authority.slice(closingBracket + 1))) {
        return false
      }
      literalHostname = authority.slice(0, closingBracket + 1).toLowerCase()
    } else {
      const portSeparator = authority.lastIndexOf(':')
      literalHostname = (portSeparator < 0 ? authority : authority.slice(0, portSeparator)).toLowerCase()
      if (
        (portSeparator >= 0 && !/^:\d+$/.test(authority.slice(portSeparator)))
        || literalHostname.includes(':')
      ) {
        return false
      }
    }

    const hostname = url.hostname.toLowerCase()
    if (literalHostname === 'localhost' || literalHostname === '0.0.0.0') {
      return hostname === literalHostname
    }
    if (literalHostname.startsWith('[')) {
      const address = literalHostname.slice(1, -1)
      return address === '::1'
        && isIP(address) === 6
        && hostname === literalHostname
    }

    return isIP(literalHostname) === 4
      && Number(literalHostname.split('.')[0]) === 127
      && hostname === literalHostname
  } catch {
    return false
  }
}
