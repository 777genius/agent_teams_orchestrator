import { test, expect } from 'bun:test';
import { createServer } from 'node:http';
import { Wire, RequestFailure } from './wire';

// Same public Wire and physical assertion in OLD5315 and NEW. No injected policy.
// Server receipts count independently of fetch invocations and transport errors.
for (const method of ['POST', 'DELETE', 'PATCH', 'PUT']) {
  for (const reset of ['body-after-200', 'headers-after-effect', 'connection-after-effect']) {
    test(`physical single-send ${method} ${reset} after consumed 650ms pooled GET`, async () => {
      const sockets = new Set<any>(), timers = new Set<ReturnType<typeof setTimeout>>();
      const records = new Map<string, Buffer>();
      const receipts: any[] = []; let effects = 0, transportCalls = 0, errorTransportCount = 0;
      let ordinarySocket: any, elapsed = 0, error: any;
      const schedule = (f: () => void, ms: number) => {
        const timer = setTimeout(() => { timers.delete(timer); f(); }, ms); timers.add(timer);
      };
      const server = createServer((req, res) => {
        const receipt = { method: req.method, path: req.url, rawHeaders: req.rawHeaders,
          body: '', sameConnectionAsGET: req.socket === ordinarySocket };
        receipts.push(receipt);
        req.on('data', chunk => { receipt.body += chunk.toString(); });
        req.on('end', () => {
          if (req.url === '/ordinary') {
            ordinarySocket = req.socket;
            res.writeHead(200, { 'content-type': 'application/json' }); res.write('{');
            schedule(() => res.end('"TEST":true}'), 650);
          } else {
            effects++; // Fully drained request has already produced its server effect.
            if (reset === 'body-after-200') {
              res.writeHead(200, { 'content-type': 'application/json' }); res.write('{');
              schedule(() => res.destroy(), 30);
            } else if (reset === 'headers-after-effect') {
              req.socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n');
              schedule(() => req.socket.destroy(), 30);
            } else schedule(() => req.socket.destroy(), 30);
          }
        });
        req.resume();
      });
      server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
      try {
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        const global = new AbortController();
        const wire = new Wire(`http://127.0.0.1:${(server.address() as any).port}`,
          async () => ({ 'x-test': 'physical-single-send' }), async (n, b) => { records.set(n, Buffer.from(b)); },
          global.signal, (async (...args: Parameters<typeof fetch>) => { transportCalls++; return fetch(...args); }) as typeof fetch);
        const start = performance.now();
        expect((await wire.call('/ordinary')).value).toEqual({ TEST: true }); elapsed = performance.now() - start;
        expect(elapsed).toBeGreaterThanOrEqual(620);
        try { await wire.call('/mutation', method, { TEST: method }); } catch (e) { error = e; errorTransportCount++; }
        await Bun.sleep(100); // Include any delayed physical dispatch before asserting.
        console.log(JSON.stringify({ TEST: 'physical-matrix', bun: Bun.version, method, reset, ordinaryElapsedMs: elapsed,
          transportCalls, mutationFetchInvocationCount: transportCalls - 1, errorTransportCount,
          serverReceiptCount: receipts.filter(r => r.path === '/mutation').length, serverEffectCount: effects,
          errorClass: error?.constructor.name, errorCode: error?.cause?.code,
          partial: records.get('response-1.raw')?.toString(), receipts,
          records: Object.fromEntries([...records].map(([n, b]) => [n, b.toString('base64')])) }));
        expect(error instanceof RequestFailure).toBe(true);
        expect(errorTransportCount).toBe(1); expect(transportCalls).toBe(2);
        expect(global.signal.aborted).toBe(false); expect(wire.calls).toHaveLength(2);
        expect(receipts.filter(r => r.path === '/mutation')).toHaveLength(1);
        expect(effects).toBe(1); // Physical server effect, never inferred from fetch count.
        expect(receipts[1].body).toBe(JSON.stringify({ TEST: method }));
        expect(JSON.parse(records.get('request-1.json')!.toString()).method).toBe(method);
        if (reset === 'body-after-200') {
          expect(error.cause.code).toBe('ECONNRESET');
          expect(JSON.parse(records.get('headers-1.json')!.toString()).status).toBe(200);
          // Bun may expose a trailing chunk CRLF on reset; preserve those bytes verbatim.
          // A second '{' is never accepted, and physical receipt/effect assertions remain exact.
          expect(records.get('response-1.raw')?.toString()).toMatch(/^\{(?:\r\n)?$/);
        }
      } finally {
        for (const timer of timers) clearTimeout(timer);
        for (const socket of sockets) socket.destroy();
        if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
        expect(server.listening).toBe(false); expect(sockets.size).toBe(0); expect(timers.size).toBe(0);
        console.log(JSON.stringify({ TEST: 'physical-cleanup', method, reset, listening: server.listening, sockets: sockets.size, timers: timers.size }));
      }
    }, 5000);
  }
}
