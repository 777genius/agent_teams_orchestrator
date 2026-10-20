/** The only environment keys an app-owned gateway member may override. */
export const MEMBER_ENV_PATCH_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CODEX_API_KEY',
] as const

export type MemberEnvPatch = Partial<
  Record<(typeof MEMBER_ENV_PATCH_KEYS)[number], string>
>

export function assertMemberEnvPatch(patch: MemberEnvPatch): void {
  for (const [key, value] of Object.entries(patch)) {
    if (
      !MEMBER_ENV_PATCH_KEYS.includes(key as (typeof MEMBER_ENV_PATCH_KEYS)[number]) ||
      typeof value !== 'string' ||
      value.length > 8192 ||
      value.includes('\0') ||
      (key === 'ANTHROPIC_API_KEY' ? value !== '' : value.length === 0)
    ) {
      // Values may be credentials. Keep validation errors value-free.
      throw new Error('invalid per-member gateway environment patch')
    }
  }
}
