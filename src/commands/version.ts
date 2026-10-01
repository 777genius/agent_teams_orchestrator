import type { Command, LocalCommandCall } from '../types/command.js'
import { getClientVersion } from '../utils/clientVersion.js'

const call: LocalCommandCall = async () => {
  return {
    type: 'text',
    value: MACRO.BUILD_TIME
      ? `${getClientVersion()} (built ${MACRO.BUILD_TIME})`
      : getClientVersion(),
  }
}

const version = {
  type: 'local',
  name: 'version',
  description:
    'Print the version this session is running (not what autoupdate downloaded)',
  isEnabled: () => process.env.USER_TYPE === 'ant',
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default version
