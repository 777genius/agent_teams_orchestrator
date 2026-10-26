/** Full completed assistant output only, never a preview. */
export function isGroupNonResponseText(text: string): boolean {
  const normalized = text.trim()
  // Reserved, unescaped final control token cancels the ENTIRE peer fallback,
  // including preceding commentary or answer text. Quoted/embedded forms are
  // ordinary content; human-origin and explicit tool sends bypass this policy.
  const lastLine = normalized.slice(normalized.lastIndexOf('\n') + 1)
  if (!/^[ \t]*>/.test(lastLine) && /(?:^|\s)\[\[AGENT_TEAMS_NO_REPLY\]\]$/.test(normalized)) return true
  // Narrow legacy forms produced by existing models. Arbitrary explanations or
  // suffixes may contain real answers and must remain visible.
  return /^No reply needed[.!]?$/i.test(normalized) ||
    /^No (?:reply needed|action)[;:— -]+(?:peer (?:meta|status|informational) message(?: with no task|, not a request)?|peer FYI about task completion|peer acknowledgement ignored)\.?$/i.test(normalized)
}
