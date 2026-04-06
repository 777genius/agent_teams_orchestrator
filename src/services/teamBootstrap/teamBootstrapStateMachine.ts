export type TeamBootstrapPhase =
  | 'validating_spec'
  | 'loading_existing_state'
  | 'acquiring_bootstrap_lock'
  | 'creating_team'
  | 'spawning_members'
  | 'auditing_truth'
  | 'completed'
  | 'failed'
  | 'canceled'

const ALLOWED_TRANSITIONS: Record<TeamBootstrapPhase, TeamBootstrapPhase[]> = {
  validating_spec: ['loading_existing_state', 'failed', 'canceled'],
  loading_existing_state: [
    'acquiring_bootstrap_lock',
    'failed',
    'canceled',
  ],
  acquiring_bootstrap_lock: ['creating_team', 'spawning_members', 'failed', 'canceled'],
  creating_team: ['spawning_members', 'failed', 'canceled'],
  spawning_members: ['auditing_truth', 'failed', 'canceled'],
  auditing_truth: ['completed', 'failed', 'canceled'],
  completed: [],
  failed: [],
  canceled: [],
}

export function isTerminalBootstrapPhase(phase: TeamBootstrapPhase): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'canceled'
}

export function assertBootstrapPhaseTransition(
  from: TeamBootstrapPhase,
  to: TeamBootstrapPhase,
): void {
  if (from === to) {
    return
  }
  const allowed = ALLOWED_TRANSITIONS[from]
  if (!allowed.includes(to)) {
    throw new Error(
      `Invalid bootstrap phase transition: ${from} -> ${to}`,
    )
  }
}
