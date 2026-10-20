import { expect, test } from 'bun:test'
import { pathToFileURL } from 'node:url'

test('provider failures retain only privately minted operation/status and preserve the original error', async () => {
  // Isolate the TEST endpoint mock so it cannot alter another test's Host authority.
  const host = pathToFileURL(import.meta.dir + '/../host/OpenCodeV2ExecutionHost.ts').href
  const wire = pathToFileURL(import.meta.dir + '/OpenCodeV2ProviderWire.ts').href
  const script = `
    const { mock } = await import('bun:test');
    const secret = 'TEST-private-body-key';
    const endpoint = { baseUrl: 'http://127.0.0.1:1', password: secret, signal: new AbortController().signal };
    mock.module(${JSON.stringify(host)}, () => ({ requireExecutionEndpoint: () => endpoint }));
    const { OpenCodeV2ProviderWire, readOpenCodeV2ProviderWireFailure: read } = await import(${JSON.stringify(wire)});
    const failures = [];
    for (const network of [false, true]) {
      const original = new Error(secret);
      endpoint.fetch = async () => { if (network) throw original;
        return new Response(secret, { status: 503, headers: { 'content-type': 'application/json' } }); };
      const port = new OpenCodeV2ProviderWire({ pin: '2.0.32', directory: '/TEST-private-directory' }, Date.now() + 5000);
      try { await port.fetch(endpoint.baseUrl + '/api/provider?location%5Bdirectory%5D=%2FTEST-private-directory'); }
      catch (error) { failures.push({ metadata: read(error), sameError: network ? error === original : true,
        wrapped: read(new Error('cleanup_unknown', { cause: error })) }); }
      finally { await port.dispose(); }
    }
    const forged = Object.assign(new Error(secret), { operation: { operation: 'provider-read', stage: 'decode', status: 503 } });
    console.log(JSON.stringify({ failures, forgedRejected: read(forged) === undefined }));
  `
  const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  expect(exit).toBe(0); expect(stderr).toBe('')
  expect(stdout.includes('TEST-private-body-key')).toBe(false)
  expect(stdout.includes('/TEST-private-directory')).toBe(false)
  const value = JSON.parse(stdout)
  expect(value.forgedRejected).toBe(true)
  expect(value.failures).toEqual([
    { metadata: { operation: 'provider-read', stage: 'decode', status: 503 }, sameError: true,
      wrapped: { operation: 'provider-read', stage: 'decode', status: 503 } },
    { metadata: { operation: 'provider-read', stage: 'request', status: null }, sameError: true,
      wrapped: { operation: 'provider-read', stage: 'request', status: null } },
  ])
}, 10_000)

test('floor activation admits only the exact selected location and empty204 response', async () => {
  const host = pathToFileURL(import.meta.dir + '/../host/OpenCodeV2ExecutionHost.ts').href
  const wire = pathToFileURL(import.meta.dir + '/OpenCodeV2ProviderWire.ts').href
  const script = `
    const { mock } = await import('bun:test');
    let calls = 0, response = () => new Response(null, { status: 204 });
    const endpoint = { baseUrl: 'http://127.0.0.1:1', password: 'TEST', signal: new AbortController().signal,
      fetch: async () => { calls++; return response(); } };
    mock.module(${JSON.stringify(host)}, () => ({ requireExecutionEndpoint: () => endpoint }));
    const { OpenCodeV2ProviderWire, readOpenCodeV2ProviderWireFailure: read } = await import(${JSON.stringify(wire)});
    const url = endpoint.baseUrl + '/api/plugin/await-activation?location%5Bdirectory%5D=%2FTEST';
    const rejected = [];
    for (const [pin, target, init] of [
      ['2.0.32', url, { method: 'POST' }],
      ['2.0.0', url.replace('%2FTEST', '%2Fother'), { method: 'POST' }],
      ['2.0.0', url + '&extra=1', { method: 'POST' }],
      ['2.0.0', url + '&location%5Bdirectory%5D=%2FTEST', { method: 'POST' }],
      ['2.0.0', url.replace('await-activation', 'other'), { method: 'POST' }],
      ['2.0.0', url, { method: 'GET' }],
      ['2.0.0', url, { method: 'POST', body: '{}' }],
    ]) {
      const port = new OpenCodeV2ProviderWire({ pin, directory: '/TEST' }, Date.now() + 5000);
      const before = calls;
      try { await port.fetch(target, init); rejected.push(false); }
      catch { rejected.push(calls === before); }
      finally { await port.dispose(); }
    }
    const port = new OpenCodeV2ProviderWire({ pin: '2.0.0', directory: '/TEST' }, Date.now() + 5000);
    const accepted = await port.fetch(url, { method: 'POST' });
    const failures = [];
    for (const body of ['', 'not-empty']) {
      response = () => new Response(body, { status: 200 });
      try { await port.fetch(url, { method: 'POST' }); }
      catch (error) { failures.push(read(error)); }
    }
    // A forged204 with bytes must also fail, even if a transport supplies such a response.
    response = () => ({ status: 204, body: new Response('not-empty').body, redirected: false, url: '' });
    try { await port.fetch(url, { method: 'POST' }); }
    catch (error) { failures.push(read(error)); }
    await port.dispose();
    console.log(JSON.stringify({ rejected, accepted: accepted.status === 204 && await accepted.text() === '', calls, failures }));
  `
  const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  expect(exit).toBe(0); expect(stderr).toBe('')
  const result = JSON.parse(stdout)
  expect(result.rejected).toEqual(Array(7).fill(true))
  expect(result.accepted).toBe(true); expect(result.calls).toBe(4)
  expect(result.failures).toEqual([200, 200, 204].map(status => ({ operation: 'activation-await', stage: 'decode', status })))
}, 10_000)
