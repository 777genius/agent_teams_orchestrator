/** Shared cold-start/catalog budget. Nested work must still honor the caller's
 * remaining time; this is not a fresh allowance for every stage or request.
 * Stop, lock expiry, cache TTL and ordinary execution deadlines are separate. */
export const OPEN_CODE_LOADING_TIMEOUT_MS = 3 * 60_000
