export type TeamBootstrapStartupOptions = {
  continue?: boolean
  resume?: string | boolean
  resumeSessionAt?: string
  forkSession?: boolean
  rewindFiles?: string
  teamBootstrapSpecPath?: string
  teamBootstrapUserPromptFile?: string
}

function readProcessArgvOption(name: string, argv: string[] = process.argv): string | undefined {
  const inlinePrefix = `${name}=`
  const inlineValue = argv.find(arg => arg.startsWith(inlinePrefix))
  if (inlineValue) {
    return inlineValue.slice(inlinePrefix.length) || undefined
  }
  const index = argv.indexOf(name)
  if (index < 0) {
    return undefined
  }
  const value = argv[index + 1]
  return value && !value.startsWith('-') ? value : undefined
}

export function resolveTeamBootstrapSpecPath(
  optionValue: unknown,
  argv: string[] = process.argv,
): string | undefined {
  if (typeof optionValue === 'string' && optionValue.trim().length > 0) {
    return optionValue.trim()
  }
  return readProcessArgvOption('--team-bootstrap-spec', argv)
}

export function validateTeamBootstrapStartupOptions(params: {
  options: TeamBootstrapStartupOptions
  inputPrompt?: string | AsyncIterable<string>
}): string | null {
  if (!params.options.teamBootstrapSpecPath) {
    return null
  }

  if (params.options.continue) {
    return 'Error: --team-bootstrap-spec cannot be combined with --continue\n'
  }
  if (params.options.resume) {
    return 'Error: --team-bootstrap-spec cannot be combined with --resume\n'
  }
  if (params.options.resumeSessionAt) {
    return 'Error: --team-bootstrap-spec cannot be combined with --resume-session-at\n'
  }
  if (params.options.forkSession) {
    return 'Error: --team-bootstrap-spec cannot be combined with --fork-session\n'
  }
  if (params.options.rewindFiles) {
    return 'Error: --team-bootstrap-spec cannot be combined with --rewind-files\n'
  }
  if (
    typeof params.inputPrompt === 'string' &&
    params.inputPrompt.trim().length > 0
  ) {
    return (
      'Error: --team-bootstrap-spec cannot be combined with an inline prompt. ' +
      'Use --team-bootstrap-user-prompt-file for the first real task.\n'
    )
  }

  return null
}
