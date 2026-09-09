const http = require('node:http');

const args = process.argv.slice(2);
const fs = require('node:fs');
const logPath = require('node:path').join(__dirname, 'fake-opencode-invocations.jsonl');
fs.appendFileSync(logPath, JSON.stringify({ pid: process.pid, ppid: process.ppid, execPath: process.execPath, argv: process.argv, cwd: process.cwd() }) + '\n');
const write = value => process.stdout.write(value + '\n');

if (args[0] === '--version') {
  write('1.15.10');
  process.exit(0);
}

if (args[0] === 'providers' && args[1] === 'list') {
  write('Credentials C:\\fake\\auth.json\n● opencode api');
  process.exit(0);
}

if (args[0] === 'models') {
  if (args.includes('--verbose')) {
    write('opencode/big-pickle\n{"cost":{"input":0,"output":0},"limit":{"context":1000,"output":1000}}');
  } else {
    write('opencode/big-pickle');
  }
  process.exit(0);
}

if (args[0] === 'agent' && args[1] === 'list') {
  write('teammate (subagent)');
  process.exit(0);
}

if (args[0] === 'serve') {
  const port = Number(args[args.indexOf('--port') + 1]);
  setTimeout(() => process.exit(0), 60_000);
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const url = req.url || '/';
    if (url === '/global/health') return res.end(JSON.stringify({ healthy: true, version: '1.15.10' }));
    if (url === '/config') return res.end(JSON.stringify({ model: 'opencode/big-pickle' }));
    if (url === '/config/providers') {
      return res.end(JSON.stringify({
        providers: [{
          id: 'opencode',
          name: 'OpenCode Zen',
          models: {
            'big-pickle': {
              name: 'Big Pickle',
              cost: { input: 0, output: 0 },
              limit: { context: 1000, output: 1000 }
            }
          }
        }]
      }));
    }
    if (url === '/provider') return res.end(JSON.stringify({ all: [{ id: 'opencode', name: 'OpenCode Zen' }], connected: ['opencode'] }));
    if (url === '/provider/auth') return res.end(JSON.stringify({ opencode: [{ type: 'api' }] }));
    if (url === '/doc') return res.end(JSON.stringify({}));
    if (url === '/agent') return res.end(JSON.stringify([]));
    if (url === '/mcp') return res.end(JSON.stringify({}));
    if (url === '/global/dispose') {
      res.end(JSON.stringify(true));
      setTimeout(() => process.exit(0), 20);
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found', url }));
  });
  server.listen(port, '127.0.0.1');
  return;
}

console.error('Unexpected fake OpenCode args: ' + args.join(' '));
process.exit(1);
