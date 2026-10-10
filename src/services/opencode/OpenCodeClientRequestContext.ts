export type OpenCodeClientRequestContext = {
  signal?: AbortSignal
  remainingMs?: () => number
  /** O0 final/fallback reads: bounded pages, status and interactions before parsing. */
  boundedReconciliation?: boolean
}
