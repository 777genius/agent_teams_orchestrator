import { isEnvTruthy } from '../../utils/envUtils.js'

function readEnabledFlag(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (value == null) {
    return defaultValue
  }
  return isEnvTruthy(value)
}

export function isBoardTaskLinksWriteEnabled(): boolean {
  return readEnabledFlag(
    process.env.CLAUDE_TEAM_BOARD_TASK_LINKS_WRITE_ENABLED,
    true,
  )
}
