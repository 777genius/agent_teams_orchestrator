export function shouldBypassStdinForHeadlessTeammateTextInput({
  inputFormat,
  isHeadlessTeammateRuntime,
  teammateRuntimeEnv,
}: {
  inputFormat: 'text' | 'stream-json'
  isHeadlessTeammateRuntime?: boolean
  teammateRuntimeEnv?: string
}): boolean {
  return (
    inputFormat === 'text' &&
    (isHeadlessTeammateRuntime === true || teammateRuntimeEnv === 'headless')
  )
}
