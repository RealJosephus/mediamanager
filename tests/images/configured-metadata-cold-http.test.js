import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRuntime } from '../../src/runtime.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import { readConfigurationFile, writeConfigurationFile } from '../../src/core/configuration-file.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';
import { dateText } from '../../src/library/records.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString, postgresTestRow } from '../database/postgres-fixture.js';
import { rawHttp } from './http-client.js';
import { currentColdMetadataImageNative, recordColdMetadataImageCandidate, picture, input, hash, json, wire, business,
  failureValue } from './fixtures/configured-metadata-cold-http/capture.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const current = await currentColdMetadataImageNative();
const id = 'c01d0000-0000-0000-0000-000000000001';
const nativeType = 'MediaBrowser.Controller.Entities.Movies.Movie';
const writable = { create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true };
const readonly = Object.fromEntries(Object.keys(writable).map(key => [key, false]));
const bytesValue = bytes => ({ bytes: bytes.length, sha256: hash(bytes), base64: bytes.toString('base64') });
const project = (root, value) => value?.replace(root, '$STATE').replaceAll(path.sep, '/');

test('postgres: a cold runtime at B reads a saved absolute A image through its explicit read-only metadata storage prefix', {
  skip: !postgresTestConnectionString, timeout: 120000,
}, async t => {
  const root = path.join(current.output, 'candidate-state'), programDataPath = path.join(root, 'program'),
    configurationDirectoryPath = path.join(root, 'config'), first = path.join(root, 'metadata-a'), second = path.join(root, 'metadata-b'),
    mediaRoot = path.join(root, 'media'), storageFile = path.join(root, 'storage.json'), configurationFile = path.join(configurationDirectoryPath, 'system.xml');
  for (const directory of [root, configurationDirectoryPath, mediaRoot, first, second]) await mkdir(directory, { recursive: true });
  const storage = {
    instances: [
      { id: 'metadata-a', type: 'local', config: { root: first, writable: true, createRoot: true } },
      { id: 'metadata-b', type: 'local', config: { root: second, writable: true, createRoot: true } },
      { id: 'media', type: 'local', config: { root: mediaRoot, writable: false } },
    ],
    mounts: [
      { path: '/metadata-a', instanceId: 'metadata-a', root: '/', capabilities: writable },
      { path: '/metadata-b', instanceId: 'metadata-b', root: '/', capabilities: writable },
      { path: '/media', instanceId: 'media', root: '/', capabilities: readonly },
    ],
    prefixes: [[first, '/metadata-a', 'metadata'], [second, '/metadata-b', 'metadata'], [mediaRoot, '/media', 'library']]
      .map(([identityRoot, accessRoot, purpose]) => ({ identityRoot, accessRoot, purpose,
        style: process.platform === 'win32' ? 'windows' : 'posix', caseSensitive: process.platform !== 'win32',
        returnAccess: 'Explicit isolated cold metadata HTTP identity.' })),
  };
  await writeFile(storageFile, json(storage));
  await writeFile(path.join(mediaRoot, 'movie.mkv'), 'Controlled media identity; no probe or encoder is installed.');
  await writeConfigurationFile(configurationFile, 'server', { ...defaultConfiguration('server'), UICulture: 'en-US',
    IsStartupWizardCompleted: true, MetadataPath: first, ImageSavingConvention: 'Compatible' });
  const networkFile = path.join(configurationDirectoryPath, 'network.xml');
  await writeConfigurationFile(networkFile, 'network', { ...defaultConfiguration('network'), InternalHttpPort: 0,
    LocalNetworkAddresses: ['127.0.0.1'], AutoDiscovery: false, EnablePublishedServerUriByRequest: true });
  let database, runtime, loaded, origin, token, oldImage;
  const failures = [], errors = [], report = { requests: [], responses: [], cleanup: {},
    scope: 'Real PG plus persisted server XML/storage JSON; A save, configuration POST B, A metadata prefix changed to read-only, complete runtime/connection close and new runtime open. Original ImageService HTTP bytes use explicit Local A/B metadata mappings. No Native third-party storage or full native server boot claim.',
    phaseAcceptance: false, releaseAcceptance: false };
  report.networkInput = bytesValue(await readFile(networkFile));
  const create = async () => {
    const opened = await createRuntime({ database, programDataPath, configurationDirectoryPath, storageConfiguration: storageFile,
      configuration: await readConfigurationFile(configurationFile, 'server'), serverId: 'configured-metadata-cold-http',
      onError: error => errors.push(failureValue(error)) });
    await opened.start(); return opened;
  };
  const selectOrigin = () => { origin = 'http://127.0.0.1:' + runtime.networkHost.listeners.find(entry => entry.scheme === 'http' && entry.bound).port; };
  const api = async (route, { body } = {}) => {
    const response = await rawHttp(origin + route, { method: body === undefined ? 'GET' : 'POST', signal: t.signal,
      headers: { 'X-Emby-Token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: json(body) }) });
    report.requests.push({ route, method: body === undefined ? 'GET' : 'POST', ...(body !== undefined ? { body } : {}),
      status: response.status, headers: response.headers, response: bytesValue(response.bytes) });
    return response;
  };
  try {
    database = await createPostgresTestDatabase(null, 'cold_meta_image');
    await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: id, Type: nativeType, Name: 'Cold metadata image',
      Path: path.join(mediaRoot, 'movie.mkv'), ProductionYear: 2026, IsInMixedFolder: true, Data: '{}',
      MediaType: 'Video', UnratedType: 'Movie', SortName: 'cold metadata image', CleanName: 'cold metadata image' }));
    runtime = await create(); await runtime.apiKeys.create('Cold metadata image configuration');
    token = (await runtime.apiKeys.list()).Items[0].AccessToken; selectOrigin();
    const ready = await api('/Storage/Status'); assert.equal(ready.status, 200); assert.equal(JSON.parse(ready.bytes).application.ready, true);
    loaded = await runtime.metadata.loadContext(id); loaded.saveLocalMetadataEnabled = false;
    await runtime.metadata.images.saveImage(loaded, loaded.context.images, { Type: 'Primary', bytes: picture, mimeType: 'image/png' });
    oldImage = loaded.context.images[0].Path;
    assert.equal(oldImage, path.join(first, 'library', 'c0', id.replaceAll('-', ''), 'poster.png'));
    // A controlled filesystem timestamp is an input to both Native and Node.
    // The Local plugin performs the real write/utimes; SQL is never fabricated.
    await runtime.storage.vfs.write('/metadata-a/' + path.relative(first, oldImage).replaceAll(path.sep, '/'), picture,
      { overwrite: true, modified: input.modified, size: BigInt(picture.length) });
    loaded.context.images[0].DateModified = (await loaded.imageAssets.stat(oldImage)).modified;
    await runtime.metadataUpdates.update(loaded, { Item: loaded.item, Images: loaded.context.images }, ItemUpdateType.ImageUpdate);
    await loaded.dispose(); loaded = undefined;
    const beforeRows = await database.rows('BaseItemImageInfos', { where: { ItemId: id } });
    assert.equal(beforeRows.length, 1); assert.equal(beforeRows[0].Path, oldImage); assert.equal(beforeRows[0].Width, 1); assert.equal(beforeRows[0].Height, 1);
    assert.ok(beforeRows[0].Blurhash?.length > 0);
    const currentConfiguration = await api('/System/Configuration'); assert.equal(currentConfiguration.status, 200);
    const replacement = await api('/System/Configuration', { body: { ...JSON.parse(currentConfiguration.bytes), MetadataPath: second } });
    assert.equal(replacement.status, 204); assert.equal(replacement.bytes.length, 0);
    assert.equal((await readConfigurationFile(configurationFile, 'server')).MetadataPath, second);
    const storageResponse = await api('/Storage/Configuration'); assert.equal(storageResponse.status, 200);
    const readOnlyA = JSON.parse(storageResponse.bytes);
    readOnlyA.instances.find(value => value.id === 'metadata-a').config.writable = false;
    readOnlyA.mounts.find(value => value.path === '/metadata-a').capabilities = readonly;
    const changedStorage = await api('/Storage/Configuration', { body: readOnlyA });
    assert.ok(changedStorage.status >= 200 && changedStorage.status < 300);
    const persistedStorage = JSON.parse(await readFile(storageFile));
    assert.equal(persistedStorage.instances.find(value => value.id === 'metadata-a').config.writable, false);
    report.beforeCold = { images: beforeRows, configurationXml: bytesValue(await readFile(configurationFile)), storageJson: bytesValue(await readFile(storageFile)) };
    await runtime.close(); assert.ok(runtime.networkHost.listeners.every(entry => !entry.server.listening)); report.cleanup.warmRuntime = true; runtime = undefined;
    await assert.rejects(database.rows('BaseItems')); report.cleanup.warmDatabaseClosed = true;
    database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema: database.schemaName });
    runtime = await create(); selectOrigin();
    assert.deepEqual(bytesValue(await readFile(networkFile)), report.networkInput);
    assert.equal(runtime.configuration.MetadataPath, second);
    const coldStorage = await api('/Storage/Configuration'); assert.equal(coldStorage.status, 200);
    assert.equal(JSON.parse(coldStorage.bytes).instances.find(value => value.id === 'metadata-a').config.writable, false);
    const [coldItem] = await database.rows('BaseItems', { where: { Id: id } });
    const coldRows = await database.rows('BaseItemImageInfos', { where: { ItemId: id } });
    assert.deepEqual(coldRows, beforeRows);
    for (const sample of input.cases) {
      const response = await rawHttp(origin + '/Items/' + id.replaceAll('-', '') + '/Images/Primary' + sample.query,
        { method: sample.method, signal: t.signal, headers: { Accept: 'image/png', ...sample.headers } });
      const observation = { name: sample.name, status: response.status, headers: response.headers, body: bytesValue(response.bytes) };
      report.responses.push(observation);
      const expected = current.native.responses.find(value => value.name === sample.name);
      assert.deepEqual(wire(observation), wire(expected));
    }
    assert.deepEqual(await database.rows('BaseItemImageInfos', { where: { ItemId: id } }), beforeRows);
    assert.deepEqual(await runtime.fileSystem.readFile(oldImage), picture);
    await assert.rejects(runtime.fileSystem.writeFile(oldImage, picture), error => {
      report.readOnlyWriteFailure = failureValue(error);
      return error.code === 'ENOTSUP' && error.storageCode === 'not-supported';
    });
    assert.deepEqual(await runtime.fileSystem.readFile(oldImage), picture);
    const newRootImages = (await readdir(second, { recursive: true, withFileTypes: true })).filter(value => value.isFile() && value.name.endsWith('.png'))
      .map(value => project(root, path.join(value.parentPath, value.name))).sort();
    report.business = { metadataPath: project(root, runtime.configuration.MetadataPath), itemPath: project(root, coldItem.Path),
      images: coldRows.map(value => ({ path: project(root, value.Path), Width: value.Width, Height: value.Height,
        blurhash: value.Blurhash == null ? null : Buffer.from(value.Blurhash).toString(), modified: dateText(value.DateModified) })),
      oldImage: { path: project(root, oldImage), bytes: picture.length, sha256: hash(await runtime.fileSystem.readFile(oldImage)) }, newRootImages };
    assert.deepEqual(business(report.business), business(current.native.business));
  } catch (error) { failures.push(error); }
  finally {
    for (const [name, close] of [['context', () => loaded?.dispose()], ['coldRuntime', async () => {
      if (!runtime) return;
      await runtime.close(); assert.ok(runtime.networkHost.listeners.every(entry => !entry.server.listening));
      await assert.rejects(database.rows('BaseItems'), error => { report.coldDatabaseReadFailure = failureValue(error); return true; });
      if (oldImage) await assert.rejects(runtime.fileSystem.readFile(oldImage), error => { report.closedStorageReadFailure = failureValue(error); return true; });
    }], ['postgresSchemas', () => dropPostgresTestDatabase(database)]]) {
      try { await close(); report.cleanup[name] = true; } catch (error) { failures.push(error); }
    }
    try {
      assert.equal(path.dirname(root), current.output); assert.equal(path.basename(root), 'candidate-state');
      await rm(root, { recursive: true, force: true }); report.cleanup.privateDirectory = true;
    } catch (error) { failures.push(error); }
    report.failures = failures.map(error => failureValue(error)); report.background = errors;
    try { await recordColdMetadataImageCandidate(report); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Cold metadata HTTP operation and cleanup failed.', { cause: failures[0] });
});
