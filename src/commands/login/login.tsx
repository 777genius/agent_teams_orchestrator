import { feature } from 'bun:bundle'
import * as React from 'react'
import { resetCostState } from '../../bootstrap/state.js'
import {
  clearTrustedDeviceToken,
  enrollTrustedDevice,
} from '../../bridge/trustedDevice.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js'
import { ConsoleOAuthFlow } from '../../components/ConsoleOAuthFlow.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { GeminiSetupFlow } from '../../components/GeminiSetupFlow.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { Text } from '../../ink.js'
import { refreshGrowthBookAfterAuthChange } from '../../services/analytics/growthbook.js'
import { refreshPolicyLimits } from '../../services/policyLimits/index.js'
import { refreshRemoteManagedSettings } from '../../services/remoteManagedSettings/index.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { stripSignatureBlocks } from '../../utils/messages.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import {
  checkAndDisableAutoModeIfNeeded,
  checkAndDisableBypassPermissionsIfNeeded,
  resetAutoModeGateCheck,
  resetBypassPermissionsCheck,
} from '../../utils/permissions/bypassPermissionsKillswitch.js'
import { resetUserCache } from '../../utils/user.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  return (
    <Login
      onDone={async success => {
        const apiProvider = getAPIProvider()
        context.onChangeAPIKey()
        context.setMessages(stripSignatureBlocks)
        if (success) {
          resetCostState()
          resetUserCache()
          refreshGrowthBookAfterAuthChange()
          if (apiProvider !== 'gemini') {
            void refreshRemoteManagedSettings()
            void refreshPolicyLimits()
            clearTrustedDeviceToken()
            void enrollTrustedDevice()
            resetBypassPermissionsCheck()
            const appState = context.getAppState()
            void checkAndDisableBypassPermissionsIfNeeded(
              appState.toolPermissionContext,
              context.setAppState,
            )
            if (feature('TRANSCRIPT_CLASSIFIER')) {
              resetAutoModeGateCheck()
              void checkAndDisableAutoModeIfNeeded(
                appState.toolPermissionContext,
                context.setAppState,
                appState.fastMode,
              )
            }
          }
          context.setAppState(prev => ({
            ...prev,
            authVersion: prev.authVersion + 1,
          }))
        }
        onDone(success ? 'Login successful' : 'Login interrupted')
      }}
    />
  )
}

export function Login(props: {
  onDone(success: boolean, mainLoopModel: string): void
  startingMessage?: string
}): React.ReactNode {
  const mainLoopModel = useMainLoopModel()
  const apiProvider = getAPIProvider()

  return (
    <Dialog
      title="Login"
      onCancel={() => props.onDone(false, mainLoopModel)}
      color="permission"
      inputGuide={exitState =>
        exitState.pending ? (
          <Text>Press {exitState.keyName} again to exit</Text>
        ) : (
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Confirmation"
            fallback="Esc"
            description="cancel"
          />
        )
      }
    >
      {apiProvider === 'gemini' ? (
        <GeminiSetupFlow
          onDone={success => props.onDone(success, mainLoopModel)}
        />
      ) : (
        <ConsoleOAuthFlow
          onDone={() => props.onDone(true, mainLoopModel)}
          startingMessage={props.startingMessage}
        />
      )}
    </Dialog>
  )
}
