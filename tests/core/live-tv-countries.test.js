import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { Worker } from 'node:worker_threads';
import { createHash, randomUUID } from 'node:crypto';
import { LiveTvCountriesClient } from '../../src/core/live-tv-countries.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const payload = Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0xff, 0x00, 0x7d, 0x0a]);
const other = Buffer.from('raw replacement, not parsed as JSON\0\n');
const b64 = bytes => bytes.toString('base64');
const actualUrl = 'https://json.schedulesdirect.org/20141201/available/countries';
const cases = () => [
  { name: 'download-memory-forever', actions: [{ bytesBase64: b64(payload) }, { bytesBase64: b64(other), cacheBase64: b64(other), ageDays: 20 },
    { bytesBase64: b64(other), deleteCache: true }, { bytesBase64: b64(other), restart: true }] },
  { name: 'fresh-malformed-cache', actions: [{ cacheBase64: b64(payload), bytesBase64: b64(other) }, { deleteCache: true, bytesBase64: b64(other) }] },
  { name: 'fresh-empty-cache', actions: [{ cacheBase64: '', bytesBase64: b64(payload) }, { bytesBase64: b64(other) }] },
  { name: 'future-cache-is-fresh', actions: [{ cacheBase64: b64(payload), ageDays: -10, bytesBase64: b64(other) }] },
  { name: 'seven-day-cache-is-stale', actions: [{ cacheBase64: b64(other), ageDays: 7, bytesBase64: b64(payload) }] },
  { name: 'failed-http-does-not-cache', actions: [{ status: 503, bytesBase64: b64(other) }, { bytesBase64: b64(payload) }, { bytesBase64: b64(other) }] },
  { name: 'parent-file-write-failure', actions: [{ parentFile: true, bytesBase64: b64(payload) }, { removeParentFile: true, bytesBase64: b64(other) }] },
  { name: 'cache-directory-write-failure', actions: [{ cacheDirectory: true, bytesBase64: b64(payload) }, { removeDirectory: true, bytesBase64: b64(other) }] },
];
const exception = error => error?.nativeException ?? (['EACCES', 'EPERM', 'EISDIR'].includes(error?.code) ? 'UnauthorizedAccessException'
  : error?.code ? 'IOException' : error?.name) ?? null;

async function serverFixture(t, handle) {
  const sockets = new Map(), server = createServer(handle);
  server.on('connection', socket => {
    const closed = Promise.withResolvers(); sockets.set(socket, closed.promise);
    socket.once('close', () => { sockets.delete(socket); closed.resolve(); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await Promise.all([...sockets.values()]); assert.equal(sockets.size, 0);
  });
  return 'http://127.0.0.1:' + server.address().port;
}
async function temp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mm-live-tv-countries-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('mm-live-tv-countries-')); await fs.rm(root, { recursive: true, force: true }); });
  return root;
}
async function fileExists(filename) { try { return !(await fs.stat(filename)).isDirectory(); } catch { return false; } }
async function directoryExists(filename) { try { return (await fs.stat(filename)).isDirectory(); } catch { return false; } }
async function prepareAction(cachePath, action) {
  const filename = path.join(cachePath, 'sd-countries.json');
  if (action.removeDirectory && await directoryExists(filename)) await fs.rmdir(filename);
  if (action.removeParentFile && await fileExists(cachePath)) await fs.unlink(cachePath);
  if (action.parentFile) { await fs.mkdir(path.dirname(cachePath), { recursive: true }); await fs.writeFile(cachePath, 'controlled blocker'); }
  if (action.cacheDirectory) await fs.mkdir(filename, { recursive: true });
  if (action.cacheBase64 !== undefined) {
    await fs.mkdir(cachePath, { recursive: true }); await fs.writeFile(filename, Buffer.from(action.cacheBase64, 'base64'));
    const modified = new Date(Date.now() - (action.ageDays ?? 0) * 86400000); await fs.utimes(filename, modified, modified);
  }
  if (action.deleteCache) await fs.unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; });
}

test('countries actual native discovery returns unparsed bytes and preserves physical disk/memory/error prefixes with default named HTTP client', { skip: !enabled, timeout: 240000 }, async t => {
  const definitions = cases(), requests = [];
  const origin = await serverFixture(t, (request, response) => {
    const url = new URL(request.url, 'http://localhost'), name = url.searchParams.get('name'), index = Number(url.searchParams.get('index'));
    const action = definitions.find(value => value.name === name)?.actions[index];
    if (!action) { response.writeHead(500); response.end(); return; }
    requests.push({ name, index, method: request.method });
    response.writeHead(action.status ?? 200, { 'content-type': 'text/plain' }); response.end(Buffer.from(action.bytesBase64, 'base64'));
  });
  const root = path.join(validationOutputRoot(), 'live-tv-countries-' + randomUUID()); await fs.mkdir(root);
  const input = { origin, cases: definitions }, bytes = Buffer.from(JSON.stringify(input)), inputFile = path.join(root, 'input.json');
  await fs.writeFile(inputFile, bytes, { flag: 'wx' }); const report = { comparisons: [], limits: [] }; let failure;
  try {
    const current = await currentNativeReference();
    report.sourceBindings = await current.sourceBindings(['src/Jellyfin.LiveTv/Listings/SchedulesDirect.cs', 'Jellyfin.Api/Controllers/LiveTvController.cs', 'MediaBrowser.Common/Net/NamedClient.cs', 'Jellyfin.Server/Startup.cs']);
    const worker = new Worker(new URL('./fixtures/live-tv-countries/oracle-worker.js', import.meta.url), { trackUnmanagedFds: true,
      workerData: { project: 'tests/core/fixtures/live-tv-countries/Oracle.csproj', output: path.join(root, 'native'), args: [inputFile, '{output}/native.json'] } });
    t.after(async () => { if (worker.threadId !== -1) await worker.terminate(); });
    let messages = 0, exitCode;
    await new Promise((resolve, reject) => {
      let result, workerError;
      worker.on('message', value => { messages++; result = value; }); worker.once('error', error => { workerError = error; });
      worker.once('exit', code => {
        exitCode = code;
        if (workerError) { reject(workerError); return; }
        if (code !== 0 || messages !== 1 || result?.record?.passed !== true) { reject(new Error(result?.error?.message ?? 'Country oracle worker exited without one successful receipt.')); return; }
        resolve();
      });
    });
    report.worker = { messages, exitCode, threadExited: worker.threadId === -1 }; assert.deepEqual(report.worker, { messages: 1, exitCode: 0, threadExited: true });
    const nativeBytes = await fs.readFile(path.join(root, 'native/native.json')), native = JSON.parse(nativeBytes);
    assert.ok(native.actualSchedulesDirect && native.actualGetAvailableCountries && native.actualLoadDailyLimitDate && native.actualTryDeleteFile && native.actualPhysicalCache);
    assert.equal(native.databaseOwnersOpened, false); assert.equal(native.executorsStarted, false); assert.equal(native.inputSha256, sha(bytes));
    assert.equal(sha(await fs.readFile(native.assembly.filename)), native.assembly.sha256); assert.equal(native.deleteDirectoryError, 'UnauthorizedAccessException');
    assert.equal(native.defaultHttpClientTimeoutMs, 100000);
    report.nativeSha256 = sha(nativeBytes); report.inputSha256 = sha(bytes); requests.length = 0;
    for (const sample of definitions) {
      const cachePath = path.join(root, 'node', sample.name), filename = path.join(cachePath, 'sd-countries.json'), observations = [], opened = [];
      let client, index = 0;
      const open = () => new LiveTvCountriesClient({ cachePath, url: actualUrl, fetch: async (url, options) => {
        assert.equal(url, actualUrl); assert.ok(options.signal instanceof AbortSignal); assert.equal(options.signal.aborted, false);
        opened.push({ url, clientName: 'Default' });
        return fetch(origin + '/countries?name=' + sample.name + '&index=' + index, options);
      } });
      try {
        for (const action of sample.actions) {
          await prepareAction(cachePath, action);
          if (!client || action.restart) { await client?.close(); client = open(); await client.initialize(); }
          let error = null, value = null, writable = null;
          try { value = b64(await client.getCountries()); writable = false; } catch (caught) { error = exception(caught); }
          observations.push({ index, error, value, writable, disk: await fileExists(filename) ? b64(await fs.readFile(filename)) : null,
            diskDirectory: await directoryExists(filename), parentFile: await fileExists(cachePath), requests: opened.length }); index++;
        }
      } finally { await client?.close(); }
      const actual = { name: sample.name, observations, requests: opened }, expected = native.results.find(value => value.name === sample.name);
      report.comparisons.push({ actual, expected }); assert.deepEqual(actual, expected, sample.name);
    }
    assert.equal(new Date().toISOString().slice(0, 10), native.today, 'Native and Node date-only samples must run on the same actual UTC day.');
    for (const expected of native.limits) {
      const cachePath = path.join(root, 'node', 'limit-' + expected.kind), filename = path.join(cachePath, 'sd-image-limit.txt'); await fs.mkdir(cachePath, { recursive: true });
      if (expected.fileBefore !== null) await fs.writeFile(filename, Buffer.from(expected.fileBefore, 'base64'));
      const client = new LiveTvCountriesClient({ cachePath, fetch: () => { throw new Error('No HTTP during daily limit observation.'); } });
      try {
        await client.initialize(); const first = await client.isImageDailyLimitActive(), afterInitialize = await fileExists(filename);
        const past = new Date(native.today + 'T00:00:00Z'); past.setUTCDate(past.getUTCDate() - 2); await fs.writeFile(filename, past.toISOString());
        const actual = { ...expected, first, afterInitialize, second: await client.isImageDailyLimitActive(), afterOverwrite: await fileExists(filename) };
        report.limits.push({ actual, expected }); assert.deepEqual(actual, expected, expected.kind);
      } finally { await client.close(); }
    }
    assert.ok(requests.every(value => value.method === 'GET'));
  } catch (error) { failure = error; }
  finally { await fs.writeFile(path.join(root, 'comparison.json'), JSON.stringify({ ...report, passed: !failure, phaseAcceptance: false, releaseAcceptance: false, error: failure?.stack }, null, 2) + '\n'); }
  if (failure) throw failure;
});

test('countries returns isolated readonly-equivalent byte snapshots and keeps memory after disk deletion', async t => {
  const root = await temp(t); let calls = 0;
  const origin = await serverFixture(t, (_request, response) => { calls++; response.end(payload); });
  const client = new LiveTvCountriesClient({ cachePath: root, url: origin }); t.after(() => client.close());
  const first = await client.getCountries(); first.fill(0); await fs.unlink(path.join(root, 'sd-countries.json'));
  assert.deepEqual(await client.getCountries(), payload); assert.equal(calls, 1);
});

test('countries fresh-read IOException deletes and refetches but UnauthorizedAccess is propagated', async t => {
  for (const code of ['EIO', 'EACCES']) await t.test(code, async t => {
    const root = await temp(t), filename = path.join(root, 'sd-countries.json'); await fs.writeFile(filename, other);
    let deletes = 0, requests = 0;
    const origin = await serverFixture(t, (_request, response) => { requests++; response.end(payload); });
    const fileSystem = { ...fs, readFile: file => file === filename ? Promise.reject(Object.assign(new Error('Controlled read failure'), { code })) : fs.readFile(file),
      unlink: async file => { deletes++; return fs.unlink(file); } };
    const client = new LiveTvCountriesClient({ cachePath: root, fileSystem, url: origin }); t.after(() => client.close());
    if (code === 'EIO') { assert.deepEqual(await client.getCountries(), payload); assert.equal(deletes, 1); assert.equal(requests, 1); }
    else { await assert.rejects(client.getCountries(), { code }); assert.equal(deletes, 0); assert.equal(requests, 0); assert.deepEqual(await fs.readFile(filename), other); }
  });
});

test('countries failed write leaves truncation prefix and no memory publication, then real HTTP retries', async t => {
  const root = await temp(t), filename = path.join(root, 'sd-countries.json'); await fs.writeFile(filename, other);
  const old = new Date(Date.now() - 8 * 86400000); await fs.utimes(filename, old, old);
  let requests = 0, fail = true, open = 0, close = 0;
  const origin = await serverFixture(t, (_request, response) => { requests++; response.end(payload); });
  const fileSystem = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args); open++;
    return { writeFile: async bytes => { if (fail) { fail = false; throw Object.assign(new Error('Controlled write after create'), { code: 'EIO' }); } return handle.writeFile(bytes); },
      close: async () => { close++; await handle.close(); } };
  } };
  const client = new LiveTvCountriesClient({ cachePath: root, fileSystem, url: origin }); t.after(() => client.close());
  await assert.rejects(client.getCountries(), { code: 'EIO' }); assert.deepEqual(await fs.readFile(filename), Buffer.alloc(0)); assert.equal(open, close);
  // A newly truncated cache is fresh, so a cold/memory-empty native client
  // reads those empty bytes rather than downloading again.
  assert.deepEqual(await client.getCountries(), Buffer.alloc(0)); assert.equal(requests, 1);
  await client.close(); await fs.unlink(filename);
  const retry = new LiveTvCountriesClient({ cachePath: root, url: origin }); t.after(() => retry.close());
  assert.deepEqual(await retry.getCountries(), payload); assert.equal(requests, 2);
});

test('countries close rejects new work but drains held real HTTP without cancelling its body or write', async t => {
  const root = await temp(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const origin = await serverFixture(t, async (_request, response) => { response.writeHead(200); response.write(payload.subarray(0, 2)); entered.resolve(); await release.promise; response.end(payload.subarray(2)); });
  const client = new LiveTvCountriesClient({ cachePath: root, url: origin }); const pending = client.getCountries();
  t.after(async () => { release.resolve(); await Promise.allSettled([pending]); await client.close(); });
  await entered.promise; let drained = false; const closing = client.close().then(() => { drained = true; });
  await assert.rejects(client.getCountries(), { status: 503 }); await assert.rejects(client.initialize(), { status: 503 }); await assert.rejects(client.isImageDailyLimitActive(), { status: 503 });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false); release.resolve(); assert.deepEqual(await pending, payload); await closing;
  assert.equal(drained, true); assert.deepEqual(await fs.readFile(path.join(root, 'sd-countries.json')), payload);
});

test('countries independent HTTP deadline closes a held body and retains public 500 with upstream status as diagnostics', { timeout: 15000 }, async t => {
  const root = await temp(t), closed = Promise.withResolvers(); let mode = 'held';
  const origin = await serverFixture(t, (_request, response) => {
    response.once('close', () => { closed.resolve(); });
    if (mode === 'held') { response.writeHead(200); response.write(payload.subarray(0, 2)); }
    else { response.writeHead(503); response.end(payload); }
  });
  const client = new LiveTvCountriesClient({ cachePath: root, url: origin, timeoutMs: 250 }); t.after(() => client.close());
  await assert.rejects(client.getCountries(), { nativeException: 'TaskCanceledException', status: 500 });
  await closed.promise; assert.equal(await fileExists(path.join(root, 'sd-countries.json')), false);
  mode = 'failure'; await assert.rejects(client.getCountries(), { nativeException: 'HttpRequestException', status: 500, HttpStatusCode: 503 });
});

test('countries concurrent cold requests remain independent and last completion publishes memory', async t => {
  const root = await temp(t), entered = Promise.withResolvers(), firstRelease = Promise.withResolvers(), secondRelease = Promise.withResolvers();
  let requests = 0;
  const origin = await serverFixture(t, async (_request, response) => {
    const ordinal = ++requests; if (requests === 2) entered.resolve();
    await (ordinal === 1 ? firstRelease.promise : secondRelease.promise); response.end(ordinal === 1 ? payload : other);
  });
  const client = new LiveTvCountriesClient({ cachePath: root, url: origin }), first = client.getCountries(), second = client.getCountries();
  t.after(async () => { firstRelease.resolve(); secondRelease.resolve(); await Promise.allSettled([first, second]); await client.close(); });
  await entered.promise; secondRelease.resolve(); assert.deepEqual(await Promise.any([first, second]), other); firstRelease.resolve();
  assert.deepEqual((await Promise.all([first, second])).map(b64).sort(), [b64(payload), b64(other)].sort());
  assert.deepEqual(await client.getCountries(), payload); assert.deepEqual(await fs.readFile(path.join(root, 'sd-countries.json')), payload); assert.equal(requests, 2);
});

test('daily image limit loads once, honors future and clears before expired-delete permission failure', async t => {
  const root = await temp(t), filename = path.join(root, 'sd-image-limit.txt'); let now = new Date('2500-01-01T12:00:00Z'), reads = 0, deletes = 0;
  await fs.writeFile(filename, '2500-01-02T00:00:00.0000000Z');
  const client = new LiveTvCountriesClient({ cachePath: root, now: () => now, fetch: () => { throw new Error('No countries HTTP during image limits.'); },
    fileSystem: { ...fs, readFile: async (...args) => { reads++; return fs.readFile(...args); }, unlink: async () => { deletes++; throw Object.assign(new Error('Controlled denied cleanup'), { code: 'EACCES' }); } } });
  t.after(() => client.close()); await client.initialize(); assert.equal(await client.isImageDailyLimitActive(), true);
  await fs.writeFile(filename, 'not a date'); assert.equal(await client.isImageDailyLimitActive(), true); assert.equal(reads, 1);
  now = new Date('2500-01-03T00:00:00Z'); await assert.rejects(client.isImageDailyLimitActive(), { code: 'EACCES' });
  assert.equal(await client.isImageDailyLimitActive(), false); assert.equal(deletes, 1); assert.equal(reads, 1);
});

test('daily image limit initialization retries an expired IO deletion and propagates non-IO failures', async t => {
  for (const code of ['EIO', 'EACCES']) await t.test(code, async t => {
    const root = await temp(t), filename = path.join(root, 'sd-image-limit.txt'); await fs.writeFile(filename, '2000-01-01T00:00:00.0000000Z'); let deletes = 0;
    const client = new LiveTvCountriesClient({ cachePath: root, fileSystem: { ...fs, unlink: async () => { deletes++; throw Object.assign(new Error('Controlled limit deletion'), { code }); } } });
    t.after(() => client.close());
    if (code === 'EIO') { await client.initialize(); assert.equal(await client.isImageDailyLimitActive(), false); assert.equal(deletes, 2); }
    else { await assert.rejects(client.initialize(), { code }); assert.equal(deletes, 1); }
    assert.equal(await fileExists(filename), true);
  });
});
