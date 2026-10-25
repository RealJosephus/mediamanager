import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createTestRuntime } from '../helpers/runtime.js';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import { readConfigurationFile } from '../../src/core/configuration-file.js';
import { cloneNativeValue, parseLosslessJson } from '../../src/core/json.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';
import { MIN_DATE } from '../../src/library/records.js';
import { nativeGuid } from '../../src/users/native.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['postgres'];
const picture = await fs.readFile(new URL('../images/fixtures/processor/single.png', import.meta.url));
const json = value => JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? JSON.rawJSON(entry.toString()) : entry, 2) + '\n';
const bytesValue = value => ({ bytes: value.length, sha256: createHash('sha256').update(value).digest('hex'), base64: value.toString('base64') });

function diagnostic(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map(entry => diagnostic(entry, seen));
    return Object.fromEntries((value instanceof Error ? [...new Set(['name', ...Object.getOwnPropertyNames(value)])] : Object.keys(value))
      .map(name => [name, diagnostic(value[name], seen)]));
  } finally { seen.delete(value); }
}

test('an image downloaded across full configuration replacement uses the current naming convention in files and SQL', {
  skip: !postgresTestConnectionString, timeout: 120000,
}, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'configuration-image-save-')); assertValidationOutputChild(root);
  const report = { schemaVersion: 1, scope: 'Actual PostgreSQL/Local metadata repository and HTTP image download across full configuration replacement; one fixed metadata root.',
    image: bytesValue(picture), requests: [], cases: [], onError: [], cleanup: {},
    actualNativeExecuted: false, phaseAcceptance: false, releaseAcceptance: false };
  const failures = [], pending = new Set();
  let database, runtime, imageServer, active, token, origin;
  const cancelled = Promise.withResolvers(); void cancelled.promise.catch(() => {});
  const abort = () => { active?.release.resolve(); cancelled.reject(t.signal.reason); };
  t.signal.addEventListener('abort', abort, { once: true });
  const call = async (route, { body, binary = false } = {}) => {
    const observation = { route, method: body === undefined ? 'GET' : 'POST',
      ...(body !== undefined && { requestBody: json(body) }), open: true };
    report.requests.push(observation);
    try {
      const response = await fetch(origin + route, { method: observation.method, signal: t.signal,
        headers: { 'X-Emby-Token': token, ...(body !== undefined && { 'Content-Type': 'application/json' }) },
        ...(body !== undefined && { body: observation.requestBody }) });
      const bytes = Buffer.from(await response.arrayBuffer());
      Object.assign(observation, { status: response.status, headers: Object.fromEntries(response.headers), payload: bytesValue(bytes) });
      if (!binary) {
        observation.text = bytes.toString('utf8');
        observation.body = observation.text && response.headers.get('content-type')?.includes('json')
          ? parseLosslessJson(observation.text) : observation.text;
      }
      return observation;
    } catch (error) { observation.error = diagnostic(error); throw error; }
    finally { observation.open = false; }
  };
  const imageRows = id => database.rows('BaseItemImageInfos', { where: { ItemId: nativeGuid(id) } });
  try {
    database = await createPostgresTestDatabase(null, 'config_image');
    runtime = await createTestRuntime({ database, programDataPath: path.join(root, 'data'), configurationDirectoryPath: path.join(root, 'config'),
      serverId: 'current-configuration-image-save',
      configuration: { ...defaultConfiguration('server'), IsStartupWizardCompleted: true, ImageSavingConvention: 'Legacy' },
      onError: error => report.onError.push(diagnostic(error)) });
    await runtime.apiKeys.create('Image configuration writer'); token = (await runtime.apiKeys.list()).Items[0].AccessToken;
    origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http' && entry.bound).port}`;
    const status = await call('/Storage/Status'); assert.equal(status.status, 200);
    assert.equal(status.body.application.ready, true);
    assert.ok(status.body.instances.some(instance => instance.type === 'local' && instance.available));
    const metadataPath = runtime.applicationPaths.metadataPath;
    imageServer = createServer((request, response) => {
      const current = active;
      if (!current || request.url !== current.imageRoute) { response.writeHead(404).end(); return; }
      current.observation.download = { route: request.url, requestHeaders: { ...request.headers }, entered: true, status: 200, responseCompleted: false };
      response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': picture.length }); response.flushHeaders();
      current.observation.download.responseHeaders = { ...response.getHeaders() };
      response.once('finish', () => { current.observation.download.responseCompleted = true; });
      current.entered.resolve();
      void current.release.promise.then(() => {
        if (!response.destroyed) response.end(picture);
      });
    });
    imageServer.on('error', error => report.onError.push(diagnostic(error)));
    await new Promise((resolve, reject) => {
      imageServer.once('error', reject); imageServer.listen(0, '127.0.0.1', () => { imageServer.off('error', reject); resolve(); });
    });

    for (const scenario of [
      { name: 'legacy-to-compatible', before: 'Legacy', after: 'Compatible', expected: 'poster.png', rejected: 'folder.png' },
      { name: 'compatible-to-legacy', before: 'Compatible', after: 'Legacy', expected: 'folder.png', rejected: 'poster.png' },
    ]) {
      const observation = { ...scenario }; report.cases.push(observation);
      active = { imageRoute: '/' + scenario.name + '.png', entered: Promise.withResolvers(), release: Promise.withResolvers(), observation };
      const before = await call('/System/Configuration'); assert.equal(before.status, 200);
      assert.equal(before.body.ImageSavingConvention, scenario.before);
      const item = await runtime.library.getStudio('Convention ' + scenario.name);
      observation.item = { Id: item.Id, Name: item.Name, Path: item.Path, Type: item.Type };
      observation.before = { item: await database.rows('BaseItems', { where: { Id: nativeGuid(item.Id) } }), images: await imageRows(item.Id) };
      assert.deepEqual(observation.before.images, []);
      const expectedFile = path.join(item.Path, scenario.expected), rejectedFile = path.join(item.Path, scenario.rejected);
      observation.expectedFile = expectedFile; observation.rejectedFile = rejectedFile;
      const imageUrl = `http://127.0.0.1:${imageServer.address().port}${active.imageRoute}`;
      let loaded;
      const work = (async () => {
        loaded = await runtime.metadata.loadContext(item.Id);
        try {
          observation.loaded = { metadataPath: loaded.metadataPath, globalOptions: cloneNativeValue(loaded.globalOptions),
            libraryOptions: cloneNativeValue(loaded.libraryOptions), itemPath: loaded.item.Path };
          return await runtime.metadataUpdates.update(loaded, { Item: loaded.item, Images: [{ Type: 'Primary', Path: imageUrl,
            DateModified: MIN_DATE, Width: 0, Height: 0, Blurhash: null }] }, ItemUpdateType.ImageUpdate, { signal: t.signal });
        } finally { await loaded.dispose(); }
      })();
      pending.add(work); void work.catch(() => {});
      try {
        await Promise.race([active.entered.promise, cancelled.promise,
          work.then(() => { throw new Error('The actual image download must be reached before the repository save completes.'); })]);
        const replacement = await call('/System/Configuration', { body: { ...before.body, ImageSavingConvention: scenario.after } });
        assert.equal(replacement.status, 204); assert.equal(replacement.text, '');
        const current = await call('/System/Configuration'); assert.equal(current.status, 200);
        assert.equal(current.body.ImageSavingConvention, scenario.after);
        assert.equal(runtime.applicationPaths.metadataPath, metadataPath);
        const saved = await fs.readFile(path.join(root, 'config', 'system.xml'));
        observation.configurationXml = bytesValue(saved);
        assert.equal((await readConfigurationFile(path.join(root, 'config', 'system.xml'), 'server')).ImageSavingConvention, scenario.after);
        active.release.resolve();
        observation.saves = diagnostic(await work);
        pending.delete(work);
        observation.after = { item: await database.rows('BaseItems', { where: { Id: nativeGuid(item.Id) } }), images: await imageRows(item.Id) };
        observation.files = await Promise.all((await fs.readdir(item.Path, { withFileTypes: true })).filter(entry => entry.isFile())
          .map(async entry => { const filename = path.join(item.Path, entry.name); return { filename, ...bytesValue(await fs.readFile(filename)) }; }));
        const [image] = observation.after.images;
        assert.equal(observation.after.images.length, 1);
        assert.equal(image.ImageType, 0); assert.equal(image.Width, 1); assert.equal(image.Height, 1);
        assert.equal(image.Path, expectedFile);
        assert.equal(observation.after.item[0].Name, observation.before.item[0].Name);
        const savedBytes = await runtime.fileSystem.readFile(expectedFile);
        observation.savedImage = { filename: expectedFile, ...bytesValue(savedBytes) };
        assert.deepEqual(savedBytes, picture); assert.deepEqual(await fs.readFile(expectedFile), picture);
        await assert.rejects(fs.stat(rejectedFile), { code: 'ENOENT' });
        const delivered = await call('/Items/' + item.Id + '/Images/Primary', { binary: true });
        assert.equal(delivered.status, 200); assert.equal(delivered.headers['content-type']?.split(';')[0], 'image/png');
        assert.equal(delivered.payload.base64, picture.toString('base64'));
        assert.equal(observation.download.responseCompleted, true);
        assert.deepEqual(report.onError, []);
      } finally { active.release.resolve(); active = undefined; }
    }
    await runtime.close(); report.cleanup.runtimeClosed = true;
    assert.ok(runtime.networkHost.listeners.every(entry => !entry.server.listening)); runtime = undefined;
    await assert.rejects(database.rows('BaseItems'), /closed|not open/iu);
    report.cleanup.databaseReadsClosed = true; assert.deepEqual(report.onError, []);
  } catch (error) { failures.push(error); }
  finally {
    t.signal.removeEventListener('abort', abort);
    active?.release.resolve();
    for (const result of await Promise.allSettled([...pending])) if (result.status === 'rejected' && !failures.includes(result.reason)) failures.push(result.reason);
    try { await runtime?.close(); if (runtime) report.cleanup.runtimeClosed = true; } catch (error) { failures.push(error); }
    if (imageServer) try {
      await new Promise((resolve, reject) => { imageServer.close(error => error ? reject(error) : resolve()); imageServer.closeAllConnections(); });
      report.cleanup.downloadServerClosed = true;
    } catch (error) { failures.push(error); }
    try { assert.deepEqual(report.onError, []); } catch (error) { failures.push(error); }
    try { await dropPostgresTestDatabase(database); report.cleanup.postgresSchemasRemoved = true; } catch (error) { failures.push(error); }
    try {
      assert.equal(path.dirname(root), output); assert.match(path.basename(root), /^configuration-image-save-/u);
      assert.equal(path.relative(path.toNamespacedPath(root), path.toNamespacedPath(await fs.realpath(root))), '');
      await fs.rm(root, { recursive: true, force: true }); report.cleanup.privateDirectoryRemoved = true;
    } catch (error) { failures.push(error); }
    report.failures = failures.map(error => diagnostic(error)); report.completed = failures.length === 0;
    const filename = path.join(output, path.basename(root) + '.json');
    try { await fs.writeFile(filename, json(report), { flag: 'wx' }); t.diagnostic(json({ report: filename, completed: report.completed })); }
    catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'Current image configuration and cleanup failed.', { cause: failures[0] });
});
