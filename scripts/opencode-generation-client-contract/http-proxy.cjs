// Independent Node HTTP observer. Fault bytes originate at a controlled TEST server,
// never a native OpenCode server. Every socket and upstream request belongs to this process.
const http = require('node:http');
const fs = require('node:fs');
const root = process.cwd();
const marker = JSON.parse(fs.readFileSync(root + '/.test-project-owner.json', 'utf8'));
if (marker.root !== root || marker.task !== 'hosted-v1-opencode-dual-q0-client-20261001') throw Error('Non-TEST proxy');
const target = Number(process.argv[2]);
let processBirth = null;
try {
  const fields = fs.readFileSync('/proc/self/stat', 'utf8').split(') ')[1].trim().split(/\s+/);
  processBirth = { format: 'linux-start-ticks', value: fields[19],
    bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() };
} catch { /* Owned stdin process handle remains cleanup authority; never use a PID kill fallback. */ }
const emit = row => process.stdout.write(JSON.stringify(row) + '\n');
const sockets = new Set();
const upstreams = new Set();
let requests = 0, closes = 0;
const server = http.createServer((request, response) => {
  requests++;
  const upstream = http.request({ hostname: '127.0.0.1', port: target,
    method: request.method, path: request.url, headers: request.headers }, incoming => {
    response.writeHead(incoming.statusCode, incoming.headers);
    response.flushHeaders();
    incoming.pipe(response);
  });
  upstreams.add(upstream);
  upstream.on('close', () => upstreams.delete(upstream));
  upstream.on('error', () => response.destroy());
  response.on('close', () => { closes++; upstream.destroy(); emit({ closed: closes, requests }); });
  request.pipe(upstream);
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
server.listen(0, '127.0.0.1', () => emit({ ready: true, port: server.address().port,
  pid: process.pid, processBirth, runNonce: marker.nonce, cwd: root,
  node: process.version, arch: process.arch, platform: process.platform }));
let closing = false;
async function cleanup() {
  if (closing) return;
  closing = true;
  // server.close may run before each destroyed handle emits close. Observe both.
  const handles = [...upstreams, ...sockets];
  const drained = Promise.all(handles.map(handle => new Promise(resolve => {
    handle.once('close', resolve);
    handle.destroy();
  })));
  const stopped = new Promise(resolve => server.close(resolve));
  await Promise.all([drained, stopped]);
    emit({ cleanup: true, requests, closes, sockets: sockets.size, upstreams: upstreams.size });
    process.exit(0);
}
process.stdin.on('data', cleanup);
process.stdin.on('end', cleanup);
