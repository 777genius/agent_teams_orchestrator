import type { Command } from '../../commands.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getAPIProvider } from '../../utils/model/providers.js'

export default {
  type: 'local-jsx',
  name: 'logout',
  description:
    getAPIProvider() === 'gemini'
      ? 'Clear local Gemini setup metadata'
      : 'Sign out from your Anthropic account',
  isEnabled: () => !isEnvTruthy(process.env.DISABLE_LOGOUT_COMMAND),
  load: () => import('./logout.js'),
} satisfies Command
