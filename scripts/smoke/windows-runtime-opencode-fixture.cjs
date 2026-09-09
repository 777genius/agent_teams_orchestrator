const http = require('node:http');

// Importable for focused HTTP contract tests without launching a provider CLI.
function createFixtureServer(onDispose) {
  const mcpConfig = {};
  const mcpStatus = {};
  const dispose = () => onDispose ? onDispose() : server.close();
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    const url = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    if (url === '/global/health') return res.end(JSON.stringify({ healthy: true, version: '1.15.10' }));
    if (url === '/config') return res.end(JSON.stringify({ model: 'opencode/big-pickle', mcp: mcpConfig }));
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
    // Simulate OpenCode's HTTP control API only. No MCP command is executed,
    // and a connected status here is not evidence of a bundled app MCP server.
    if (url === '/mcp') {
      if (req.method === 'GET') return res.end(JSON.stringify(mcpStatus));
      if (req.method !== 'POST') {
        res.statusCode = 405;
        return res.end(JSON.stringify({ error: 'method not allowed' }));
      }
      let body;
      try {
        let raw = '';
        req.setEncoding('utf8');
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 64 * 1024) throw new Error('attach body too large');
        }
        body = JSON.parse(raw);
      } catch {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'invalid attach JSON' }));
      }
      const config = body?.config;
      if (body?.name !== 'agent-teams' || config?.type !== 'local' ||
          config.enabled !== true || !Array.isArray(config.command) ||
          config.command.length === 0 ||
          !config.command.every(part => typeof part === 'string' && part.trim()) ||
          (config.environment !== undefined && (!config.environment ||
            typeof config.environment !== 'object' || Array.isArray(config.environment) ||
            !Object.values(config.environment).every(value => typeof value === 'string')))) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'fixture requires an enabled local agent-teams config' }));
      }
      mcpConfig[body.name] = config;
      mcpStatus[body.name] = { status: 'connected' };
      return res.end(JSON.stringify(mcpStatus));
    }
    if (url === '/mcp/agent-teams/connect' && req.method === 'POST' && mcpConfig['agent-teams']) {
      return res.end(JSON.stringify(mcpStatus));
    }
    // These OpenCode endpoints return arrays, not MCP JSON-RPC tools/list.
    // This fixture has no executable tools. Production direct MCP proof must
    // still fail against the harness's deliberately non-server MCP entry.
    if ((url === '/experimental/tool/ids' || url === '/experimental/tool') && req.method === 'GET') {
      return res.end(JSON.stringify([]));
    }
    if (url === '/global/dispose') {
      res.end(JSON.stringify(true));
      setTimeout(dispose, 20);
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found', url }));
  });
  return server;
}

module.exports = { createFixtureServer };

if (require.main === module) {
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
    createFixtureServer(() => process.exit(0)).listen(port, '127.0.0.1');
  } else {
    console.error('Unexpected fake OpenCode args: ' + args.join(' '));
    process.exit(1);
  }
}
