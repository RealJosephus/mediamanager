import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, stat, utimes, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { gzipSync } from 'node:zlib';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createXmlTvListingsProvider } from '../../plugins/xmltv/provider.js';
import { dateTicks } from '../../src/library/records.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const baseFile = new URL('./fixtures/xmltv/input.json', import.meta.url);
const xml = Buffer.from('<tv><channel id="c1"><display-name>Controlled channel 中文</display-name><icon src="https://example.invalid/channel.png"/></channel>\n'
  + '<programme channel="c1" start="20261021010000 +0000" stop="20261021020000 +0000"><title>Controlled programme</title>\n'
  + '<icon src="https://example.invalid/programme.png"/><rating><value>TV-G</value></rating></programme></tv>');
const changedXml = Buffer.from(xml.toString().replaceAll('Controlled channel', 'Updated channel'));
const comparable = value => {
  if (Array.isArray(value)) return value.map(comparable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry != null)
    .map(([key, entry]) => [key, ['StartDate', 'EndDate', 'OriginalAirDate'].includes(key)
      ? { ticks: String(dateTicks(entry)), utc: entry.endsWith('Z') } : comparable(entry)]));
  return value;
};

test('XMLTV actual HTTP downloads, gzip selection, cache/backoff, retries and cancellation match the native provider', {
  skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 240000,
}, async () => {
  const root = path.join(validationOutputRoot(), 'xmltv-cache-' + randomUUID()); await mkdir(root);
  const input = JSON.parse(await readFile(baseFile));
  const definitions = [
    { name: 'stale-fallback', actions: [{ mode: 'xml' }, { mode: 'error', ageCache: true }, { mode: 'changed' },
      { mode: 'changed', operation: 'validate', clearCache: true }, { mode: 'changed' }] },
    { name: 'first-failure-retry', actions: [{ mode: 'error' }, { mode: 'xml' }, { mode: 'xml', operation: 'validate' }, { mode: 'xml' }] },
    { name: 'gzip-redirect', actions: [{ mode: 'redirectGzip' }] },
    { name: 'gzip-extension', suffix: '.gzip?controlled=1', actions: [{ mode: 'gzip' }] },
    { name: 'broken-gzip', suffix: '.gz', actions: [{ mode: 'badGzip' }, { mode: 'xml' }] },
    { name: 'empty-download', actions: [{ mode: 'empty' }, { mode: 'xml' }] },
    { name: 'malformed-cache', actions: [{ mode: 'invalidXml' }, { mode: 'xml' }, { mode: 'xml', operation: 'validate', clearCache: true }, { mode: 'xml' }] },
    { name: 'http-client-timeout', actions: [{ mode: 'timeout' }, { mode: 'xml' }, { mode: 'xml', operation: 'validate' }, { mode: 'xml' }] },
    { name: 'caller-cancellation', actions: [{ mode: 'delayed', operation: 'programs', cancelAfterBody: true }, { mode: 'xml', operation: 'programs' }] },
  ];
  const ledger = [], timers = new Set(), sockets = new Set(), admittedBodies = new Set(), bodyWaiters = new Map();
  let state;
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/control') {
      const definition = definitions.find(value => value.name === url.searchParams.get('name'));
      const index = Number(url.searchParams.get('index'));
      state = { engine: url.searchParams.get('engine'), name: definition.name, index, action: definition.actions[index] };
      response.end('ok'); return;
    }
    if (url.pathname === '/wait-body') {
      const key = url.searchParams.get('engine') + ':' + url.searchParams.get('name') + ':' + url.searchParams.get('index');
      if (admittedBodies.has(key)) response.end('body admitted');
      else { bodyWaiters.set(key, response); response.once('close', () => bodyWaiters.delete(key)); }
      return;
    }
    if (!state) { response.writeHead(500); response.end('No controlled action.'); return; }
    ledger.push({ engine: state.engine, name: state.name, index: state.index, method: request.method, path: url.pathname + url.search });
    const mode = state.action.mode;
    if (mode === 'redirectGzip' && !url.pathname.startsWith('/files/')) {
      response.writeHead(302, { Location: '/files/' + state.name + '.gz?controlled=1' }); response.end(); return;
    }
    if (mode === 'error') { response.writeHead(503); response.end('Controlled unavailable guide.'); return; }
    let bytes = mode === 'changed' ? changedXml : mode === 'empty' ? Buffer.alloc(0) : mode === 'invalidXml' ? Buffer.from('<tv><channel')
      : mode === 'badGzip' ? Buffer.from('not a gzip stream') : mode === 'gzip' || mode === 'redirectGzip' ? gzipSync(xml) : xml;
    response.writeHead(200, { 'Content-Type': mode.includes('Gzip') || mode === 'gzip' ? 'application/gzip' : 'application/xml', 'Content-Length': bytes.length });
    if (mode === 'delayed') {
      response.flushHeaders(); response.write(bytes.subarray(0, 5));
      const key = state.engine + ':' + state.name + ':' + state.index;
      admittedBodies.add(key); bodyWaiters.get(key)?.end('body admitted'); bodyWaiters.delete(key);
      // The controlled body remains open until its caller cancels. The barrier
      // above admits an actual HTTP body before either engine aborts it.
      response.once('close', () => admittedBodies.delete(key));
    } else response.end(bytes);
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`, comparisons = [];
  let failure, native, recording, oracleWorker, oracleWorkerExitCode, oracleWorkerMessages = 0;
  try {
    input.controlOrigin = origin;
    input.cacheCases = definitions.map(definition => ({ ...definition, path: origin + '/feed/' + definition.name + (definition.suffix ?? '') }));
    const inputBytes = Buffer.from(JSON.stringify(input)), filename = path.join(root, 'input.json'); await writeFile(filename, inputBytes, { flag: 'wx' });
    // recordOracle deliberately uses spawnSync. Run that helper on a real
    // worker so this thread continues serving the actual native HTTP client.
    oracleWorker = new Worker(new URL('./fixtures/xmltv/oracle-worker.js', import.meta.url), {
      workerData: { project: 'tests/plugins/fixtures/xmltv/Oracle.csproj', output: path.join(root, 'native'), args: [filename, '{output}/native.json'] },
      trackUnmanagedFds: true,
    });
    recording = await new Promise((resolve, reject) => {
      let result, workerFailure;
      oracleWorker.on('message', message => { oracleWorkerMessages++; result = message; });
      oracleWorker.once('error', error => { workerFailure = error; });
      oracleWorker.once('exit', code => {
        oracleWorkerExitCode = code;
        if (workerFailure) { reject(workerFailure); return; }
        if (code !== 0 || oracleWorkerMessages !== 1 || !result || typeof result.ok !== 'boolean') {
          reject(new Error(`The XMLTV oracle worker exited without one valid result (exit ${code}, messages ${oracleWorkerMessages}).`)); return;
        }
        if (!result.ok) { reject(Object.assign(new Error(result.error?.message ?? 'The XMLTV oracle worker failed.'), {
          name: result.error?.name ?? 'Error', stack: result.error?.stack })); return; }
        if (!result.record || result.record.passed !== true) { reject(new Error('The XMLTV oracle worker did not return a passing execution receipt.')); return; }
        resolve(result.record);
      });
    });
    const nativeBytes = await readFile(path.join(root, 'native/native.json')); native = JSON.parse(nativeBytes);
    assert.equal(recording.passed, true); assert.equal(native.inputSha256, sha(inputBytes)); assert.equal(native.privateInputsRemoved, true);
    assert.equal(recording.outputs.find(value => path.basename(value.filename) === 'native.json').sha256, sha(nativeBytes));
    for (const definition of input.cacheCases) {
      const cachePath = path.join(root, 'node', definition.name, 'xmltv');
      const provider = createXmlTvListingsProvider({ cachePath, fetch: (url, options) => state.action.mode === 'timeout'
        ? Promise.reject(new DOMException('Controlled HttpClient timeout.', 'AbortError')) : fetch(url, options) });
      const expected = native.cacheCases.find(value => value.name === definition.name);
      try {
        for (const [index, action] of definition.actions.entries()) {
          await (await fetch(origin + '/control?engine=node&name=' + encodeURIComponent(definition.name) + '&index=' + index)).text();
          const cacheFile = path.join(cachePath, definition.name + '.xml');
          if (action.ageCache) { const old = new Date(Date.now() - 7200000); try { await utimes(cacheFile, old, old); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
          if (action.clearCache) try { await unlink(cacheFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          const cancellation = new AbortController();
          let value, kind;
          const operation = action.operation ?? 'lineups';
          try {
            const info = { Id: definition.name, Path: definition.path };
            if (operation === 'validate') await provider.validate(info, true, true);
            else if (operation === 'programs') {
              const pending = provider.getPrograms(info, 'c1', '2026-10-21T00:00:00Z', '2026-10-22T00:00:00Z', { signal: cancellation.signal });
              pending.catch(() => {});
              if (action.cancelAfterBody) {
                try {
                  await (await fetch(origin + '/wait-body?engine=node&name=' + encodeURIComponent(definition.name) + '&index=' + index,
                    { signal: AbortSignal.timeout(15000) })).text();
                } finally { cancellation.abort(); }
              }
              value = await pending;
            }
            else value = await provider.getLineups(info, 'US', 'ignored');
          } catch (error) { kind = cancellation.signal.aborted && error.name === 'AbortError' ? 'canceled'
            : error.name === 'TimeoutException' ? 'timeout' : error.name === 'XmlError' ? 'XmlException' : error.name; }
          let cached, files = [];
          try { cached = await readFile(cacheFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          try { files = (await readdir(cachePath)).map(name => 'xmltv/' + name).sort(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          const observed = { index, operation, value, failure: kind, cacheExists: cached !== undefined, cacheSha256: cached && sha(cached), cacheFiles: files };
          comparisons.push({ name: definition.name, observed, expected: expected.observations[index] });
          assert.deepEqual(comparable(observed), comparable(expected.observations[index]), definition.name + ':' + index);
        }
      } finally { await provider.close(); }
    }
    const requests = engine => ledger.filter(value => value.engine === engine).map(({ engine: _engine, ...value }) => value);
    assert.deepEqual(requests('node'), requests('native'), 'Cache reuse, failure backoff, validation retry and caller cancellation must make the same actual upstream requests.');
    assert.equal(ledger.filter(value => value.engine === 'node' && value.name === 'caller-cancellation').length, 2, 'Caller cancellation must not enter remote failure backoff.');
    const delayedFile = path.join(root, 'node/caller-cancellation/xmltv/caller-cancellation.xml');
    assert.equal((await stat(delayedFile)).size, xml.length);
  } catch (error) { failure = error; }
  finally {
    try { await oracleWorker?.terminate(); } catch (error) { failure ??= error; }
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const response of bodyWaiters.values()) response.destroy(); bodyWaiters.clear();
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections(); for (const socket of sockets) socket.destroy(); await closed;
    await writeFile(path.join(root, 'comparison.json'), JSON.stringify({ passed: !failure, phaseAcceptance: false, releaseAcceptance: false,
      actualHttpTransport: true, nativeTimeoutExceptionControlled: true, comparisons, ledger, error: failure?.stack,
      oracleWorker: { exitCode: oracleWorkerExitCode, messages: oracleWorkerMessages },
      cleanup: { listenerClosed: !server.listening, sockets: sockets.size, timers: timers.size,
        oracleWorkerStopped: oracleWorker === undefined || oracleWorker.threadId === -1 } }, null, 2) + '\n');
  }
  if (failure) throw failure;
});
