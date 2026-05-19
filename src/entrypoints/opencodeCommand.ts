import { runtimeOpenCodeCommand } from '../cli/handlers/runtimeOpenCodeCommand.js'

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) {
    return undefined
  }
  return args[index + 1]
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
