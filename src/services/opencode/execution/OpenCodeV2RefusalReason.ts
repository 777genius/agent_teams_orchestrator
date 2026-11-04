/** User-facing causes for V2 refusals a user can act on. Only fixed text: never an
 * SDK message, caller path or credential. Anything else stays generic. */
export type OpenCodeV2Refusal = Readonly<{
  message: string
  /** Stays true until the user changes the system or the selection; false keeps a retry. */
  settled: boolean
}>
type Reason = Readonly<{ text: (platform: string) => string; settled: boolean }>
const reasons: Readonly<Record<string, Reason>> = Object.freeze({
  opencode_v2_version_unqualified: { settled: true, text: platform =>
    `The selected OpenCode V2 version is not qualified on ${platform}. Select another OpenCode version.` },
  opencode_v2_version_out_of_range: { settled: true, text: () =>
    'The selected OpenCode version is outside the supported V2 range.' },
})

/** The refusal named by the error itself. A wrapped cause is not read: our cleanup
 * wrappers (cleanup_unknown) mean physical state is unknown, which outranks any refusal. */
export function openCodeV2Refusal(error: unknown, platform = `${process.platform}-${process.arch}`): OpenCodeV2Refusal | null {
  if (!(error instanceof Error) || !Object.hasOwn(reasons, error.message)) return null
  const reason = reasons[error.message]!
  return Object.freeze({ message: reason.text(platform), settled: reason.settled })
}
