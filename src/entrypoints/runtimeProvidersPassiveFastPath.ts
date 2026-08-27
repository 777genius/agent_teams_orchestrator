export function shouldUseOpenCodePassiveProviderDirectoryFastPath(input: {
  command: string | undefined
  summary: boolean
  runtime: string | undefined
}): boolean {
  return input.command === 'directory'
    && input.summary
    && (input.runtime === undefined || input.runtime === 'opencode')
}

/** Entry-point dispatcher seam: exactly one passive or active composition is reachable. */
export async function dispatchRuntimeProvidersDirectory<T>(
  input: { command: string | undefined; summary: boolean; runtime: string | undefined },
  deps: { readPassive(): Promise<T>; readActive(): Promise<T> },
): Promise<T> {
  return shouldUseOpenCodePassiveProviderDirectoryFastPath(input)
    ? deps.readPassive()
    : deps.readActive()
}
