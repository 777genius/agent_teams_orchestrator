// Stands in for the Product MCP bundle's hosted task command in Owner tests. It records what the
// Owner passed, then answers as `mode.json` in the Claude root says: the Owner hands it no other
// environment to steer it by.
const fs = require('fs')
const path = require('path')

const root = process.env.AGENT_TEAMS_MCP_CLAUDE_DIR
const mode = JSON.parse(fs.readFileSync(path.join(root, 'mode.json'), 'utf8'))
let input = ''
process.stdin.on('data', chunk => { input += chunk })
process.stdin.on('end', () => {
  fs.writeFileSync(path.join(root, 'seen.json'), JSON.stringify({
    argv: process.argv.slice(2),
    env: Object.keys(process.env).sort(),
    cwd: process.cwd(),
    input: JSON.parse(input),
  }))
  const finish = () => {
    if (mode.stdout) process.stdout.write(mode.stdout)
    process.exitCode = mode.exit ?? 0
  }
  if (mode.delayMs) setTimeout(finish, mode.delayMs)
  else finish()
})
