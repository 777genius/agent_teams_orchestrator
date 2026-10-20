export type OpenCodeV2Pin = '2.0.0' | '2.0.32'

/** Each official graph owns its Effect and platform packages at this exact version. */
export function openCodeV2EffectVersion(pin: OpenCodeV2Pin): '4.0.0-rc.112' | '4.0.1' {
  return pin === '2.0.0' ? '4.0.0-rc.112' : '4.0.1'
}
export type OpenCodeReadGeneration =
  | { generation: 'v1'; version: string }
  | { generation: 'v2'; version: OpenCodeV2Pin; dialect: 'v2-2.0.0' | 'v2-2.0.32' }
  | { generation: 'unsupported'; version: string | null }

/** Admission uses the whole version output, never a substring from a banner. */
export function classifyOpenCodeReadGeneration(output: string): OpenCodeReadGeneration {
  const branded = /^opencode v([^\r\n]+)(?:\r?\n)?$/.exec(output)
  // RegExp's $ also matches before a final newline; require the entire match
  // to equal stdout so extra blank lines cannot become an official single line.
  const version = branded?.[0] === output ? branded[1] ?? '' : output.trim()
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    return { generation: 'unsupported', version: null }
  }
  if (version === '2.0.0' || version === '2.0.32') {
    return { generation: 'v2', version, dialect: `v2-${version}` }
  }
  const [major, minor] = version.split('.').map(Number)
  return major === 1 && minor !== undefined && minor >= 16
    ? { generation: 'v1', version }
    : { generation: 'unsupported', version }
}
