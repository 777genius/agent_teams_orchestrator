/** User-facing causes for V2 refusals a user can act on. Only fixed text: never an
 * SDK message, launcher stderr, caller path or credential. Anything else stays generic. */
export type OpenCodeV2Refusal = Readonly<{
  message: string
  /** Stays true until the user changes the system or the selection; false keeps a retry. */
  settled: boolean
}>
type Reason = Readonly<{ text: (platform: string) => string; settled: boolean; linuxOnly: boolean }>
const BWRAP_REQUIREMENT = 'OpenCode V2 on Linux needs bubblewrap 0.12.0 or later at /usr/bin/bwrap'
const reasons: Readonly<Record<string, Reason>> = Object.freeze({
  opencode_v2_version_unqualified: { settled: true, linuxOnly: false, text: platform =>
    `The selected OpenCode V2 version is not qualified on ${platform}. Select another OpenCode version.` },
  opencode_v2_version_out_of_range: { settled: true, linuxOnly: false, text: () =>
    'The selected OpenCode version is outside the supported V2 range.' },
  // The launcher codes below are named by the Linux bwrap adapter only; the darwin and
  // Windows adapters reuse `denied` for unrelated helper failures, which stay generic.
  execution_containment_launcher_missing: { settled: true, linuxOnly: true, text: () =>
    `bubblewrap was not found. ${BWRAP_REQUIREMENT}.` },
  execution_containment_launcher_unsupported: { settled: true, linuxOnly: true, text: () =>
    `The installed bubblewrap (/usr/bin/bwrap) is older than 0.12.0, the first release that fixes CVE-2026-87766. ${BWRAP_REQUIREMENT}.` },
  execution_containment_launcher_unsafe: { settled: true, linuxOnly: true, text: () =>
    `The installed bubblewrap (/usr/bin/bwrap) is affected by CVE-2026-87766: sandbox setup can create files outside the sandbox. ${BWRAP_REQUIREMENT}.` },
  execution_containment_launcher_authority: { settled: true, linuxOnly: true, text: () =>
    `/usr/bin/bwrap must be a root-owned regular file that is not setuid, setgid or writable by group or others. ${BWRAP_REQUIREMENT}.` },
  // A version report can time out under load; a retry must stay possible.
  execution_containment_launcher_version_unknown: { settled: false, linuxOnly: true, text: () =>
    `bubblewrap (/usr/bin/bwrap) did not report its version. ${BWRAP_REQUIREMENT}.` },
  // Usually the AppArmor restriction, which an administrator can lift; a retry must stay possible.
  execution_containment_launcher_denied: { settled: false, linuxOnly: true, text: () =>
    `bubblewrap (/usr/bin/bwrap) could not create the OpenCode V2 sandbox. ${BWRAP_REQUIREMENT} and unprivileged user namespaces. Ubuntu 23.10 and later restrict them with AppArmor unless /usr/bin/bwrap has a profile that allows userns.` },
})

/** The refusal named by the error itself. A wrapped cause is not read: our cleanup
 * wrappers (cleanup_unknown) mean physical state is unknown, which outranks any refusal. */
export function openCodeV2Refusal(error: unknown, platform = `${process.platform}-${process.arch}`): OpenCodeV2Refusal | null {
  if (!(error instanceof Error) || !Object.hasOwn(reasons, error.message)) return null
  const reason = reasons[error.message]!
  if (reason.linuxOnly && !platform.startsWith('linux-')) return null
  return Object.freeze({ message: reason.text(platform), settled: reason.settled })
}
