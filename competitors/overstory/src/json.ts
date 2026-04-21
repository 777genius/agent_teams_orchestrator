/**
 * Standard JSON envelope for CLI output.
 *
 * Success: { success: true, command: "<name>", ...data }
 * Error: { success: false, command: "<name>", error: "<message>" }
 *
 * Matches the ecosystem convention used by mulch, seeds, and canopy.
 */

/**
 * Write a JSON success envelope to stdout.
 * Spreads data properties into the top-level envelope.
 */
export function jsonOutput(command: string, data: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify({ success: true, command, ...data })}\n`);
}

/**
 * Write a JSON error envelope to stdout (not stderr).
 * With --json, errors go to stdout inside the envelope per cli-standards.md.
 */
export function jsonError(command: string, error: string): void {
	process.stdout.write(`${JSON.stringify({ success: false, command, error })}\n`);
}
