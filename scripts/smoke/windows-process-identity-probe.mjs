// Diagnostic instrumentation only. Never supplies an acceptance identity or
// changes the production helper's argv, environment, stdio, or deadline.
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';

export function environmentSummary(env) {
  const entries = Object.entries(env).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return {
    environmentKeys: entries.map(([key]) => key),
    environmentHash: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
  };
}

export function traceSpawn(spawn, emit) {
  return (command, args, options) => {
    const started = performance.now();
    const mark = (event, details = {}) => emit({ phase: 'query-child', event,
      elapsedMs: performance.now() - started, ...details });
    const { env, ...transportOptions } = options;
    mark('invocation', { command, args, options: transportOptions, envExplicit: env !== undefined,
      cwd: options.cwd ?? process.cwd(),
      ...environmentSummary(options.env ?? process.env) });
    let child;
    try { child = spawn(command, args, options); }
    catch (error) { mark('spawn-throw', { code: error.code, message: error.message }); throw error; }
    const kill = child.kill.bind(child);
    child.kill = (...args) => {
      mark('kill-request', { args, exitCode: child.exitCode, signalCode: child.signalCode });
      return kill(...args);
    };
    child.once('spawn', () => mark('spawn', { pid: child.pid }));
    child.once('error', error => mark('error', { code: error.code, message: error.message }));
    child.once('exit', (code, signal) => mark('exit', { code, signal }));
    child.once('close', (code, signal) => mark('close', { code, signal }));
    child.stdin?.once('finish', () => mark('stdin-finish'));
    for (const name of ['stdout', 'stderr']) {
      const stream = child[name];
      let captured = 0;
      stream?.on('data', chunk => {
        // Bound evidence independently of the production output limit.
        if (captured >= 2048) return;
        const text = chunk.toString().slice(0, 2048 - captured);
        captured += text.length;
        mark(`${name}-data`, { text });
      });
      stream?.once('end', () => mark(`${name}-end`));
      stream?.once('close', () => mark(`${name}-close`));
      stream?.once('error', error => mark(`${name}-error`, { code: error.code, message: error.message }));
    }
    return child;
  };
}

export async function traceProductionIdentity({ processKill, pid, attempt, platform, powerShellOnly = false }) {
  const emit = item => console.error(JSON.stringify({ ...item, attempt }));
  const nativeSpawn = globalThis.Bun?.spawn;
  if (nativeSpawn) {
    Bun.spawn = function(options) {
      const started = performance.now();
      emit({ phase: 'query-native', event: 'invocation', command: options.cmd,
        stdio: options.stdio, lazy: options.lazy, cwd: options.cwd ?? process.cwd(),
        windowsHide: options.windowsHide, windowsVerbatimArguments: options.windowsVerbatimArguments,
        ...environmentSummary(options.env ?? process.env) });
      const onExit = options.onExit;
      return nativeSpawn({ ...options, onExit(...args) {
        emit({ phase: 'query-native', event: 'exit', elapsedMs: performance.now() - started,
          code: args[1], signal: args[2], error: args[3]?.message });
        return onExit?.(...args);
      } });
    };
  }
  // Bun 1.3.11 does not propagate default-export assignments into an already
  // bound named `spawn` import via syncBuiltinESMExports. Observe the actual
  // ChildProcess method instead; no mock module or replacement query is used.
  const prototype = childProcess.ChildProcess.prototype;
  const original = prototype.spawn;
  prototype.spawn = function(options) {
    let result;
    traceSpawn(() => {
      result = original.call(this, options);
      return this;
    }, emit)(options.file, options.args.slice(1), {
      stdio: options.stdio, windowsHide: options.windowsHide,
    });
    return result;
  };
  try {
    emit({ phase: 'before-production-import', bunVersion: globalThis.Bun?.version,
      ...environmentSummary(process.env) });
    const { readProcessStartTimeMs, readWindowsProcessStartTimeMsWithPowerShell } = await import(processKill);
    emit({ phase: 'before-production-query', bunVersion: globalThis.Bun?.version });
    const started = performance.now();
    const startedAtMs = await (powerShellOnly
      ? readWindowsProcessStartTimeMsWithPowerShell(pid)
      : readProcessStartTimeMs(pid, platform));
    emit({ phase: 'after-production-query', elapsedMs: performance.now() - started, startedAtMs });
    console.log(JSON.stringify({ startedAtMs }));
  } finally {
    prototype.spawn = original;
    if (nativeSpawn) Bun.spawn = nativeSpawn;
  }
}

// Replay the CAPTURED production invocation, not an approximate .NET script.
// Same 5s budget; no result from this function can replace first-call acceptance.
export async function replayIdentityQuery({ invocation, mode, timeoutMs = 5000 }) {
  if (!['exact', 'stderr-pipe', 'stdin-eof'].includes(mode)) throw new Error('Unknown transport mode');
  if (invocation.envExplicit) throw new Error('Cannot replay an uncaptured explicit environment');
  const emit = item => console.error(JSON.stringify(item));
  const options = { ...invocation.options, stdio: [...invocation.options.stdio] };
  if (mode === 'stderr-pipe') options.stdio[2] = 'pipe';
  if (mode === 'stdin-eof') options.stdio[0] = 'pipe';
  return new Promise(resolve => {
    let child;
    let done = false;
    let output = '';
    const finish = result => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      console.log(JSON.stringify({ ...result, output }));
      resolve();
    };
    const timer = setTimeout(() => {
      child?.kill('SIGKILL');
      finish({ timedOut: true });
    }, timeoutMs);
    try {
      child = traceSpawn(childProcess.spawn, emit)(invocation.command, invocation.args, options);
      child.once('error', error => finish({ error: error.message }));
      child.once('close', (code, signal) => finish({ code, signal, timedOut: false }));
      child.stdout?.on('data', chunk => { output = (output + chunk.toString()).slice(0, 65536); });
      // A piped input must receive EOF; no warmup command or interactive input.
      child.stdin?.on('error', error => emit({ phase: 'stdin-error', code: error.code }));
      if (mode === 'stdin-eof') child.stdin.end();
    } catch (error) { finish({ error: error.message }); }
  });
}
