/**
 * Central color and output control using Chalk.
 *
 * Chalk natively handles NO_COLOR, FORCE_COLOR, and TERM=dumb.
 * See https://github.com/chalk/chalk#supportscolor for detection logic.
 */

import chalk from "chalk";

// --- Brand palette (os-eco brand colors) ---

/** Forest green — Overstory primary brand color. */
export const brand = chalk.rgb(46, 125, 50);

/** Amber — highlights, warnings. */
export const accent = chalk.rgb(255, 183, 77);

/** Stone gray — secondary text, muted content. */
export const muted = chalk.rgb(120, 120, 110);

// --- Standard color functions ---

/**
 * Color functions that wrap text with ANSI codes.
 * Each value is a function: color.red("text") returns "\x1b[31mtext\x1b[39m".
 * Chalk auto-resets when wrapping, so color.reset is not needed.
 */
export const color = {
	bold: chalk.bold,
	dim: chalk.dim,
	red: chalk.red,
	green: chalk.green,
	yellow: chalk.yellow,
	blue: chalk.blue,
	magenta: chalk.magenta,
	cyan: chalk.cyan,
	white: chalk.white,
	gray: chalk.gray,
} as const;

// Re-export chalk for direct use (chaining, custom RGB, etc.)
export { chalk };

/** Type for color function values (for consumers that store colors in variables). */
export type ColorFn = (text: string) => string;

/** Identity function for "no color" cases (replaces old color.white as default). */
export const noColor: ColorFn = (text: string) => text;

// --- ANSI strip utilities (for visible-width calculations in dashboard) ---

// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC (0x1B) is required to match ANSI escape sequences
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

/** Strip ANSI escape codes from a string. */
export function stripAnsi(str: string): string {
	return str.replace(ANSI_REGEX, "");
}

/** Visible string length (excluding ANSI escape codes). */
export function visibleLength(str: string): number {
	return stripAnsi(str).length;
}

// --- Quiet mode ---

let quietMode = false;

/** Enable quiet mode (suppress non-error output). */
export function setQuiet(enabled: boolean): void {
	quietMode = enabled;
}

/** Check if quiet mode is active. */
export function isQuiet(): boolean {
	return quietMode;
}

// --- Standardized message formatters (visual-spec.md Message Formats) ---

/** Success: brand checkmark + brand message. Optional accent-colored ID. */
export function printSuccess(msg: string, id?: string): void {
	if (isQuiet()) return;
	const idPart = id ? ` ${accent(id)}` : "";
	process.stdout.write(`${brand.bold("\u2713")} ${brand(msg)}${idPart}\n`);
}

/** Warning: yellow ! + yellow message. Optional dim hint. */
export function printWarning(msg: string, hint?: string): void {
	if (isQuiet()) return;
	const hintPart = hint ? ` ${chalk.dim(`\u2014 ${hint}`)}` : "";
	process.stdout.write(`${chalk.yellow.bold("!")} ${chalk.yellow(msg)}${hintPart}\n`);
}

/** Error: red cross + red message. Optional dim hint. Always to stderr. */
export function printError(msg: string, hint?: string): void {
	const hintPart = hint ? ` ${chalk.dim(`\u2014 ${hint}`)}` : "";
	process.stderr.write(`${chalk.red.bold("\u2717")} ${chalk.red(msg)}${hintPart}\n`);
}

/** Hint/info: dim indented text. */
export function printHint(msg: string): void {
	if (isQuiet()) return;
	process.stdout.write(`${chalk.dim(`  ${msg}`)}\n`);
}
