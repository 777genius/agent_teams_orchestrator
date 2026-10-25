/** User-facing causes for V2 refusals a user can act on. Only fixed text: never an
 * SDK message, launcher stderr, caller path or credential. Anything else stays generic. */
const BWRAP_REQUIREMENT = 'OpenCode V2 on Linux needs bubblewrap 0.12.0 or later at /usr/bin/bwrap'
const reasons: Readonly<Record<string, (platform: string) => string>> = Object.freeze({
  opencode_v2_version_unqualified: platform =>
    `The selected OpenCode V2 version is not qualified on ${platform}. Select another OpenCode version.`,
  opencode_v2_version_out_of_range: () => 'The selected OpenCode version is outside the supported V2 range.',
  execution_containment_launcher_missing: () => `bubblewrap was not found. ${BWRAP_REQUIREMENT}.`,
  execution_containment_launcher_unsupported: () =>
    `The installed bubblewrap (/usr/bin/bwrap) is older than 0.12.0, the first release that fixes CVE-2026-87766, or did not report its version. ${BWRAP_REQUIREMENT}.`,
  execution_containment_launcher_unsafe: () =>
    `The installed bubblewrap (/usr/bin/bwrap) is affected by CVE-2026-87766: sandbox setup can create files outside the sandbox. ${BWRAP_REQUIREMENT}.`,
  execution_containment_launcher_denied: () =>
    `bubblewrap (/usr/bin/bwrap) could not create the OpenCode V2 sandbox. ${BWRAP_REQUIREMENT} and unprivileged user namespaces, which this system may disable or restrict (for example with AppArmor).`,
  execution_containment_launcher_authority: () =>
    `/usr/bin/bwrap must be a regular file that is not setuid, setgid or writable by group or others. ${BWRAP_REQUIREMENT}.`,
})

/** The first known code on the error or its direct cause, as one sentence. */
export function openCodeV2RefusalReason(error: unknown, platform = `${process.platform}-${process.arch}`): string | null {
  for (let current: unknown = error, depth = 0; current instanceof Error && depth < 2; current = current.cause, depth++) {
    const reason = Object.hasOwn(reasons, current.message) ? reasons[current.message] : undefined
    if (reason) return reason(platform)
  }
  return null
}
