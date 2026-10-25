import { classifyOpenCodeV2Version, type OpenCodeV2Dialect, type OpenCodeV2Pin } from './OpenCodeV2Registry.ts'

export type { OpenCodeV2Pin } from './OpenCodeV2Registry.ts'
export type OpenCodeReadGeneration =
  | { generation: 'v1'; version: string }
  | { generation: 'v2'; version: OpenCodeV2Pin; dialect: OpenCodeV2Dialect }
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
  const v2 = classifyOpenCodeV2Version(version)
  if (v2.status === 'recognized') return { generation: 'v2', version: v2.version, dialect: v2.dialect }
  const [major, minor] = version.split('.').map(Number)
  return major === 1 && minor !== undefined && minor >= 16
    ? { generation: 'v1', version }
    : { generation: 'unsupported', version }
}
