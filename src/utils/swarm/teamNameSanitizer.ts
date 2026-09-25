import { safeWindowsPathSegment } from '../windowsReservedNames.js'

/**
 * Sanitizes a name for use in tmux window names, worktree paths, and file paths.
 * Replaces all non-alphanumeric characters with hyphens and lowercases.
 * Kept dependency-light so hosted-control can use it without the swarm tool graph.
 */
export function sanitizeName(name: string): string {
  return safeWindowsPathSegment(name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase())
}
