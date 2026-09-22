/**
 * Parse a CLI flag value early, before Commander.js processes arguments.
 * Supports both space-separated (--flag value) and equals-separated (--flag=value) syntax.
 *
 * This function is intended for flags that must be parsed before init() runs,
 * such as --settings which affects configuration loading. For normal flag parsing,
 * rely on Commander.js which handles this automatically.
 *
 * @param flagName The flag name including dashes (e.g., '--settings')
 * @param argv Optional argv array to parse (defaults to process.argv)
 * @returns The value if found, undefined otherwise
 */
export function eagerParseCliFlag(
  flagName: string,
  argv: string[] = process.argv,
): string | undefined {
  return eagerParseCliFlags(flagName, argv)[0]
}

export function eagerParseCliFlags(
  flagName: string,
  argv: string[] = process.argv,
): string[] {
  const values: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    // Handle --flag=value syntax
    if (arg?.startsWith(`${flagName}=`)) {
      values.push(arg.slice(flagName.length + 1))
      continue
    }
    // Handle --flag value syntax
    if (arg === flagName && i + 1 < argv.length) {
      values.push(argv[i + 1]!)
      i += 1
    }
  }
  return values
}

type JsonObject = Record<string, unknown>

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJsonObject(value: string): JsonObject | null {
  try {
    const parsed = JSON.parse(value) as unknown
    return isJsonObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

function deepMergeJsonObjects(target: JsonObject, source: JsonObject): JsonObject {
  const merged: JsonObject = { ...target }
  for (const [key, value] of Object.entries(source)) {
    const current = merged[key]
    if (isJsonObject(current) && isJsonObject(value)) {
      merged[key] = deepMergeJsonObjects(current, value)
      continue
    }
    merged[key] = value
  }
  return merged
}

export function mergeJsonObjectCliFlagValues(values: string[]): string | undefined {
  if (values.length === 0) {
    return undefined
  }

  let merged: JsonObject = {}
  for (const value of values) {
    const parsed = parseJsonObject(value)
    if (!parsed) {
      return values[0]
    }
    merged = deepMergeJsonObjects(merged, parsed)
  }

  return JSON.stringify(merged)
}

/**
 * Handle the standard Unix `--` separator convention in CLI arguments.
 *
 * When using Commander.js with `.passThroughOptions()`, the `--` separator
 * is passed through as a positional argument rather than being consumed.
 * This means when a user runs:
 *   `cmd --opt value name -- subcmd --flag arg`
 *
 * Commander parses it as:
 *   positional1 = "name", positional2 = "--", rest = ["subcmd", "--flag", "arg"]
 *
 * This function corrects the parsing by extracting the actual command from
 * the rest array when the positional is `--`.
 *
 * @param commandOrValue - The parsed positional that may be "--"
 * @param args - The remaining arguments array
 * @returns Object with corrected command and args
 */
export function extractArgsAfterDoubleDash(
  commandOrValue: string,
  args: string[] = [],
): { command: string; args: string[] } {
  if (commandOrValue === '--' && args.length > 0) {
    return {
      command: args[0]!,
      args: args.slice(1),
    }
  }
  return { command: commandOrValue, args }
}
