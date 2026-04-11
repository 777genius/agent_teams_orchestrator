export type TeamBootstrapStartupOptions = {
  continue?: boolean
  resume?: string | boolean
  resumeSessionAt?: string
  forkSession?: boolean
  rewindFiles?: string
  teamBootstrapSpecPath?: string
  teamBootstrapUserPromptFile?: string
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
