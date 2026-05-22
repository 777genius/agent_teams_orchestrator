import { runtimeOpenCodeCommand } from '../cli/handlers/runtimeOpenCodeCommand.js'

function readOption(args: string[], name: string): string | undefined {
  const inlinePrefix = `${name}=`
  const inlineValue = args.find(arg => arg.startsWith(inlinePrefix))
  if (inlineValue) {
    return inlineValue.slice(inlinePrefix.length) || undefined
  }

  const index = args.indexOf(name)
  if (index < 0) {
    return undefined
  }
  const value = args[index + 1]
  return value && !value.startsWith('--') ? value : undefined
}

const args = process.argv.slice(2)
const input = readOption(args, '--input')

if (!input) {
  process.stderr.write('Missing required option --input <path>\n')
  process.exit(1)
}

await runtimeOpenCodeCommand({
  input,
  output: readOption(args, '--output'),
  json: args.includes('--json'),
})
