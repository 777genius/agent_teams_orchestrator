import { isEnvTruthy } from '../envUtils.js'

/**
 * Set only by the hosted native lifecycle lane. Desktop never sets it, so the
 * desktop print-mode lead keeps its existing behavior.
 */
export const HOSTED_LEAD_INBOX_POLL_ENV = 'CLAUDE_TEAM_HOSTED_LEAD_INBOX_POLL'

/**
 * Whether the print-mode team lead keeps polling its own inbox.
 *
 * Desktop delivers user messages to the lead through stdin, so the lead only
 * polls while teammates are active. A hosted native lead has no stdin relay:
 * hosted messages land in `inboxes/team-lead.json`, so the lead must keep
 * reading it while its team context exists. Once stdin is closed the hosted
 * lead falls back to the desktop rule, which lets the existing shutdown prompt
 * and exit path run instead of polling forever for an owner that is gone.
 */
export function shouldTeamLeadPollInbox(input: {
  hasActiveTeammates: boolean
  hasTeamContext: boolean
  inputClosed: boolean
  env?: NodeJS.ProcessEnv
}): boolean {
  if (input.hasActiveTeammates) return true
  const env = input.env ?? process.env
  return isEnvTruthy(env[HOSTED_LEAD_INBOX_POLL_ENV]) &&
    input.hasTeamContext &&
    !input.inputClosed
}
