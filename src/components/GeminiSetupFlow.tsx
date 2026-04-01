import * as React from 'react'
import { Box, Text } from '../ink.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { resolveGeminiBackend } from '../services/gemini/backendResolver.js'

type Props = {
  onDone(success: boolean): void
}

export function GeminiSetupFlow({ onDone }: Props): React.ReactNode {
  const [result, setResult] = React.useState<{
    loading: boolean
    success?: boolean
    message?: string
    hint?: string
    backend?: string
    endpoint?: string
  }>({ loading: true })

  React.useEffect(() => {
    void resolveGeminiBackend().then(resolution => {
      setResult({
        loading: false,
        success: Boolean(resolution.backend),
        message: resolution.backend
          ? 'Gemini authentication is configured correctly.'
          : resolution.status.message,
        hint: resolution.status.hint,
        backend: resolution.backend ? `gemini-${resolution.backend.kind}` : undefined,
        endpoint: resolution.status.endpointLabel,
      })
    })
  }, [])

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Gemini setup</Text>
      {result.loading ? (
        <Text>Validating Gemini authentication…</Text>
      ) : (
        <>
          <Text>{result.message}</Text>
          {result.backend ? <Text>Selected backend: {result.backend}</Text> : null}
          {result.endpoint ? <Text dimColor>{result.endpoint}</Text> : null}
          {result.hint ? <Text dimColor>{result.hint}</Text> : null}
          {!result.success ? (
            <>
              <Text>Use either `GEMINI_API_KEY`, Google ADC, or an existing Gemini CLI login.</Text>
              <Text dimColor>
                OAuth/ADC example: `gcloud auth application-default login
                --client-id-file=client_secret.json --scopes='https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/generative-language.retriever'`
              </Text>
              <Text dimColor>
                Then set `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_PROJECT_ID`, or
                `GCLOUD_PROJECT` to your billed Google Cloud project.
              </Text>
              <Text dimColor>
                For the CLI backend, sign in with the installed `gemini` CLI
                first.
              </Text>
            </>
          ) : null}
        </>
      )}
      <Text dimColor>Press Enter to continue.</Text>
      <GeminiSetupBindings
        onDone={onDone}
        enabled={!result.loading}
        success={result.success === true}
      />
    </Box>
  )
}

function GeminiSetupBindings({
  onDone,
  enabled,
  success,
}: {
  onDone(success: boolean): void
  enabled: boolean
  success: boolean
}): null {
  useKeybinding(
    'confirm:yes',
    () => {
      onDone(success)
    },
    {
      context: 'Confirmation',
      isActive: enabled,
    },
  )
  return null
}
