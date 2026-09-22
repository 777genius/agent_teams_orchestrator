const CURSOR_RESOURCE_EXHAUSTED_ACTION_REQUIRED_SET_PATTERN =
  /([A-Za-z_$][\w$]*=new Set\(\[)([^\]]*?)([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*)\.FREE_USER_USAGE_LIMIT([^\]]*?\.GENERIC_RATE_LIMIT_EXCEEDED)([^\]]*)(\]\))/g

export const CURSOR_RESOURCE_EXHAUSTED_PATCH_DISABLED_ENV =
  'AGENT_TEAMS_CURSOR_RESOURCE_EXHAUSTED_PATCH_DISABLED'

export type CursorResourceExhaustedSourcePatchResult = {
  source: string
  applied: boolean
  compatible: boolean
}

export function patchCursorAgentResourceExhaustedClassification(
  source: string,
): CursorResourceExhaustedSourcePatchResult {
  const matches = Array.from(
    source.matchAll(new RegExp(CURSOR_RESOURCE_EXHAUSTED_ACTION_REQUIRED_SET_PATTERN.source, 'g')),
  )
  if (matches.length !== 1) {
    return { source, applied: false, compatible: false }
  }

  const match = matches[0]
  const enumReference = match[3]
  if (!enumReference || match.index === undefined) {
    return { source, applied: false, compatible: false }
  }
  if (match[0].includes(`${enumReference}.RESOURCE_EXHAUSTED`)) {
    return { source, applied: false, compatible: true }
  }

  const replacement = match[0].replace(
    /\]\)$/,
    `,${enumReference}.RESOURCE_EXHAUSTED])`,
  )
  return {
    source: `${source.slice(0, match.index)}${replacement}${source.slice(match.index + match[0].length)}`,
    applied: true,
    compatible: true,
  }
}

export function buildCursorAgentResourceExhaustedPreloadScript(): string {
  const patternSource = JSON.stringify(
    CURSOR_RESOURCE_EXHAUSTED_ACTION_REQUIRED_SET_PATTERN.source,
  )
  // No 'use strict' here: this block is appended to the attribution block in one
  // generated file, and only the first statement of that file is a directive.
  // The generated file emits the directive once, at its head.
  return [
    "const fs = require('node:fs')",
    "const Module = require('node:module')",
    "const originalJsLoader = Module._extensions['.js']",
    `const actionRequiredSetPattern = new RegExp(${patternSource}, 'g')`,
    'const normalizeModulePath = value => {',
    "  if (!value) return ''",
    '  try { return fs.realpathSync(value) } catch { return value }',
    '}',
    'const entryFilename = normalizeModulePath(process.argv[1])',
    "const originalNodeOptions = process.env.AGENT_TEAMS_CURSOR_ORIGINAL_NODE_OPTIONS || ''",
    'delete process.env.AGENT_TEAMS_CURSOR_ORIGINAL_NODE_OPTIONS',
    'if (originalNodeOptions) process.env.NODE_OPTIONS = originalNodeOptions',
    'else delete process.env.NODE_OPTIONS',
    'const agentTeamsCursorLoader = function (module, filename) {',
    '  if (normalizeModulePath(filename) !== entryFilename) {',
    '    return originalJsLoader(module, filename)',
    '  }',
    "  Module._extensions['.js'] = originalJsLoader",
    '  let source',
    '  try {',
    "    source = fs.readFileSync(filename, 'utf8')",
    '  } catch {',
    '    return originalJsLoader(module, filename)',
    '  }',
    '  const matches = Array.from(source.matchAll(actionRequiredSetPattern))',
    '  if (matches.length !== 1) return originalJsLoader(module, filename)',
    '  const match = matches[0]',
    '  const enumReference = match[3]',
    '  if (!enumReference || match.index === undefined) return originalJsLoader(module, filename)',
    '  if (!match[0].includes(`${enumReference}.RESOURCE_EXHAUSTED`)) {',
    '    const replacement = match[0].replace(/\\]\\)$/, `,${enumReference}.RESOURCE_EXHAUSTED])`)',
    '    source = `${source.slice(0, match.index)}${replacement}${source.slice(match.index + match[0].length)}`',
    '  }',
    '  return module._compile(source, filename)',
    '}',
    // The generated shim injects this preload unconditionally because the same
    // file also records process attribution, so the classification kill switch
    // is enforced here instead of at injection time.
    `if (process.env.${CURSOR_RESOURCE_EXHAUSTED_PATCH_DISABLED_ENV} !== '1') {`,
    "  Module._extensions['.js'] = agentTeamsCursorLoader",
    '}',
    '',
  ].join('\n')
}
