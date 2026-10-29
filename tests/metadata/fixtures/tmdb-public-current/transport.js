import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { errorObservation } from '../../../helpers/error-observation.js';
import { requestShape } from './input.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const keyFor = request => JSON.stringify([request.path, request.query]);

export async function publicTmdbTransport({ output, apiKey, signal, report }) {
  const root = path.join(output, 'public-responses'); await mkdir(root);
  const responses = new Map();
  let mode = 'live', cancellation, configurationResponse;
  const fetch = async (value, settings = {}) => {
    const url = new URL(value), request = requestShape(url);
    assert.equal(url.origin, 'https://api.themoviedb.org');
    assert.ok(url.pathname.startsWith('/3/'));
    assert.ok(url.searchParams.get('api_key') === apiKey, 'The actual TMDB client must use the designated built-in credential.');
    const record = { request, mode, startedAt: new Date().toISOString(), startedMs: performance.now() };
    report.requests.push(record);
    if (mode === 'blocked') throw new Error('A cold HTTP/PG read must not contact TMDB.');
    if (mode === 'limited' && url.pathname.includes('/movie/')) {
      record.controlled = true; record.status = 429; record.retryAfter = '0'; record.completedMs = performance.now();
      return Response.json({ status_code: 25, status_message: 'Controlled rate limit over an already verified public endpoint.' },
        { status: 429, headers: { 'retry-after': '0' } });
    }
    const combined = AbortSignal.any([signal, ...(settings.signal ? [settings.signal] : []), AbortSignal.timeout(20000)]);
    let response;
    try {
      const pending = globalThis.fetch(url, { ...settings, signal: combined });
      if (cancellation && url.pathname.includes('/movie/')) {
        const entered = cancellation; cancellation = undefined; entered.resolve();
      }
      response = await pending;
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.ok(!bytes.includes(Buffer.from(apiKey)), 'A public response containing a credential cannot be published.');
      const filename = path.join(root, String(report.requests.length).padStart(3, '0') + '.json');
      await writeFile(filename, bytes, { flag: 'wx' });
      Object.assign(record, { publicResponse: true, status: response.status, contentType: response.headers.get('content-type'),
        retryAfter: response.headers.get('retry-after'), filename, bytes: bytes.length, sha256: hash(bytes), completedMs: performance.now() });
      if (response.ok) {
        responses.set(keyFor(request), record);
        if (url.pathname.endsWith('/configuration')) configurationResponse = record;
      }
      return new Response(bytes.length ? bytes : null, { status: response.status, headers: response.headers });
    } catch (error) {
      record.failure = errorObservation(error); record.completedMs = performance.now();
      try { await response?.body?.cancel(); } catch { /* The failed consumer already owns the original reason. */ }
      throw error;
    }
  };
  return {
    fetch,
    setMode(value) { assert.ok(['live', 'limited', 'blocked'].includes(value)); mode = value; },
    armCancellation() { assert.equal(cancellation, undefined); cancellation = Promise.withResolvers(); return cancellation.promise; },
    providerResponses(language) {
      const movie = [...responses.values()].findLast(record => record.request.path.includes('/movie/')
        && record.request.query.some(([key, value]) => key === 'language' && value === language));
      assert.ok(configurationResponse && movie, 'A nonempty provider result must bind its actual public response bytes.');
      return [configurationResponse, movie].map(({ request, status, contentType, filename, sha256, bytes }) => ({
        request, status, contentType, filename, sha256, bytes,
      }));
    },
  };
}
