import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import model from '../../src/core/resources/configuration-model.json' with { type: 'json' };
import { NamedConfigurationStore } from '../../src/core/named-configuration-store.js';
import { ServerConfigurationStore } from '../../src/core/server-configuration-store.js';
import { defaultConfiguration, readConfigurationDocument, parseConfigurationXml } from '../../src/core/configuration-xml.js';
import { serializeConfiguration } from '../../src/core/configuration-file.js';
import { localStateStorage } from '../helpers/local-state-storage.js';

const original = '<ServerConfiguration xmlns:u="urn:future" u:flag="kept">before<u:extra a="v">x<u:child/>y</u:extra>after'
  + '<ContentTypes><NameValuePair><Name>Old</Name><Value>movies</Value></NameValuePair></ContentTypes></ServerConfiguration>';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const missing = error => error.code === 'ENOENT';

async function setup(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'server-config-store-'));
  const directory = path.join(root, 'config'), filename = path.join(directory, 'system.xml');
  await fs.mkdir(directory); await fs.writeFile(filename, original);
  const storage = await localStateStorage(root), errors = [];
  const configuration = parseConfigurationXml(Buffer.from(original), 'server');
  const networkConfiguration = defaultConfiguration('network');
  const applicationPaths = { programDataPath: root, defaultMetadataPath: path.join(root, 'metadata'),
    metadataPath: path.join(root, 'metadata'), cachePath: path.join(root, 'cache') };
  const options = typeof overrides === 'function' ? overrides({ root, directory, filename, configuration, applicationPaths, storage }) : overrides;
  const store = new ServerConfigurationStore({ configuration, configurationDirectoryPath: directory, applicationPaths,
    metadataFileSystem: storage.fileSystem, fileSystem: fs, onError: error => errors.push(error), ...options });
  const namedConfiguration = new NamedConfigurationStore({ configurationDirectoryPath: directory, loadedConfigurations: [['network', networkConfiguration]], fileSystem: options.fileSystem ?? fs });
  t.after(async () => {
    await namedConfiguration.close(); await store.close(); await storage.close();
    try { if ((await fs.stat(filename)).isFile()) await fs.chmod(filename, 0o666); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.rm(root, { recursive: true, force: true });
  });
  await store.initialize();
  return { root, directory, filename, configuration, namedConfiguration, networkConfiguration, applicationPaths, storage, store, errors };
}

const readServer = async filename => parseConfigurationXml(await fs.readFile(filename), 'server');

test('plain configuration callers receive complete defaults with independently supplied named settings', async t => {
  const { directory, applicationPaths, storage, filename, namedConfiguration, networkConfiguration: network } = await setup(t);
  const configuration = { ServerName: 'Plain initial', UICulture: null, ContentTypes: [] };
  const store = new ServerConfigurationStore({ configuration, configurationDirectoryPath: directory, applicationPaths, metadataFileSystem: storage.fileSystem });
  try {
    await store.initialize(); await store.updateServerValues({ ServerName: 'Plain saved' });
    const defaults = defaultConfiguration('server');
    for (const name of serverFields()) if (!['ServerName', 'UICulture', 'ContentTypes'].includes(name)) assert.deepEqual(configuration[name], defaults[name], name);
    assert.equal(configuration.UICulture, null);
    const persisted = await readServer(filename);
    assert.equal(persisted.ServerName, 'Plain saved'); assert.deepEqual(persisted.MetadataOptions, defaults.MetadataOptions);
    assert.equal(persisted.UICulture, defaults.UICulture);
    network.EnableRemoteAccess = false; await namedConfiguration.saveConfiguration('network', network); assert.equal(network.EnableRemoteAccess, false);
    assert.doesNotMatch(await fs.readFile(filename, 'utf8'), /NetworkConfiguration|<BaseUrl\b/u);
  } finally { await store.close(); }
});

function serverFields() { return Object.keys(model.definitions.ServerConfiguration.defaults); }

test('shared live version setters keep public values and direct-save XML consistent', async t => {
  const { store, configuration, filename } = await setup(t);
  configuration.PreviousVersionStr = ' +3 . 04 .5 ';
  assert.equal(configuration.PreviousVersion, '3.4.5');
  await store.saveConfiguration(); assert.equal((await readServer(filename)).PreviousVersion, '3.4.5');
  configuration.PreviousVersionStr = 'not-a-version'; configuration.PreviousVersionStr = null;
  assert.equal(configuration.PreviousVersionStr, '3.4.5');
  await store.saveConfiguration(); assert.equal((await readServer(filename)).PreviousVersionStr, '3.4.5');
  configuration.PreviousVersion = null; assert.equal(configuration.PreviousVersionStr, null);
  await store.saveConfiguration(); assert.equal((await readServer(filename)).PreviousVersion, null);
});

test('partial saves serialize accepted changes and close drains actual updated handlers', async t => {
  const { store, configuration, directory, filename } = await setup(t);
  const started = deferred(), released = deferred(), phases = [];
  store.on('updating', () => { phases.push('unexpected full replacement'); });
  store.on('updated', async () => { started.resolve(); await released.promise; phases.push(configuration.ContentTypes.map(entry => entry.Name)); });
  const first = store.updateContentTypes(types => [...types, { Name: 'First', Value: 'tvshows' }]);
  const second = store.updateContentTypes(types => [...types, { Name: 'Second', Value: 'music' }]);
  let drained = false; const closing = store.close().then(() => { drained = true; });
  try {
    await assert.rejects(store.updateContentTypes(() => []), { code: 'closed', status: 503 });
    await Promise.all([first, second, started.promise]);
    assert.equal(drained, false);
  } finally { released.resolve(); await closing; }
  assert.deepEqual(configuration.ContentTypes.map(entry => entry.Name), ['Old', 'First', 'Second']);
  assert.deepEqual(await readServer(filename), configuration);
  assert.equal(phases.length, 2); assert.ok(phases.every(names => names.join(',') === 'Old,First,Second'));
  assert.deepEqual(await fs.readdir(directory), ['system.xml']);
  const document = readConfigurationDocument(await fs.readFile(filename), 'server');
  assert.equal(document.node.attributes['u:flag'], 'kept');
  assert.equal(document.node.children.find(node => node.name === 'u:extra').text, 'xy');
  assert.match(document.node.text, /before.*after/u);
});

test('a failed direct write keeps new live values and the real truncated file prefix', async t => {
  const writeFailure = Object.assign(new Error('Controlled configuration write failure.'), { code: 'ENOSPC', cause: new Error('Storage is full.') });
  let written = 0;
  const fileSystem = { ...fs, open: async (filename, flags, ...args) => {
    const file = await fs.open(filename, flags, ...args);
    if (path.basename(filename) !== 'system.xml' || flags !== 'w') return file;
    return { write: async (buffer, offset, length) => {
      if (written === 37) throw writeFailure;
      const result = await file.write(buffer, offset, Math.min(length, 37 - written)); written += result.bytesWritten; return result;
    }, close: () => file.close() };
  } };
  const { store, configuration, filename, directory } = await setup(t, { fileSystem });
  const next = [{ Name: 'Next', Value: 'tvshows' }];
  await assert.rejects(store.updateContentTypes(() => next), error => error.code === 'ENOSPC'
    && error.message === writeFailure.message && error.cause.message === 'Storage is full.');
  assert.deepEqual(configuration.ContentTypes, next);
  assert.deepEqual(await fs.readFile(filename), serializeConfiguration('server', configuration).subarray(0, 37));
  assert.deepEqual(await fs.readdir(directory), ['system.xml']);
});

test('save preserves ordered write and actual handle-close failures', async t => {
  const writeFailure = Object.assign(new Error('Controlled write failure.'), { code: 'ENOSPC', status: 507 });
  const closeFailure = Object.assign(new Error('Controlled handle close failure.'), { code: 'EIO' });
  const fileSystem = { ...fs, open: async (filename, flags, ...args) => {
    const file = await fs.open(filename, flags, ...args);
    if (path.basename(filename) !== 'system.xml' || flags !== 'w') return file;
    return { write: async () => { throw writeFailure; }, close: async () => { await file.close(); throw closeFailure; } };
  } };
  const { store, filename } = await setup(t, { fileSystem });
  await assert.rejects(store.updateServerValues({ ServerName: 'New live name' }), error => {
    assert.equal(error.code, 'ENOSPC'); assert.equal(error.status, 507);
    assert.equal(error.cause.message, writeFailure.message);
    assert.deepEqual(error.errors.map(failure => ({ code: failure.code, message: failure.message })),
      [writeFailure, closeFailure].map(failure => ({ code: failure.code, message: failure.message }))); return true;
  });
  assert.equal((await fs.readFile(filename)).length, 0);
});

test('a read-only configuration keeps its bytes and the failed save retains its new live value', async t => {
  const { store, configuration, filename } = await setup(t);
  await fs.chmod(filename, 0o444);
  await assert.rejects(store.updateServerValues({ ServerName: 'New live name' }), error => ['EACCES', 'EPERM'].includes(error.code));
  assert.equal(configuration.ServerName, 'New live name');
  assert.equal(await fs.readFile(filename, 'utf8'), original);
});

test('a direct save overwrites competing bytes without an extra generation admission check', async t => {
  const fileSystem = { ...fs, open: async (filename, flags, ...args) => {
    if (path.basename(filename) === 'system.xml' && flags === 'w') await fs.writeFile(filename, original.replace('Old', 'External'));
    return fs.open(filename, flags, ...args);
  } };
  const { store, configuration, filename } = await setup(t, { fileSystem });
  await store.updateContentTypes(() => [{ Name: 'Saved', Value: 'music' }]);
  assert.deepEqual(await readServer(filename), configuration);
  assert.equal(configuration.ContentTypes[0].Name, 'Saved');
});

test('full replacement retains incoming values, isolates old values and keeps named configuration separate', async t => {
  const { store, configuration: previous, namedConfiguration, networkConfiguration, filename, directory } = await setup(t);
  await store.updateServerValues({ ServerName: 'Old name' });
  const next = defaultConfiguration('server'); next.ServerName = null; next.MetadataOptions = null;
  next.ContentTypes = [{ Name: 'New', Value: 'tvshows' }]; next.PreviousVersion = '2.3.4'; next.PreviousVersionStr = '2.3.4';
  const firstIncomingTypes = next.ContentTypes;
  await store.replaceConfiguration(next);
  const persisted = await readServer(filename);
  for (const name of Object.keys(model.definitions.ServerConfiguration.defaults)) assert.deepEqual(store.configuration[name], next[name], name);
  assert.equal(persisted.ServerName, ''); assert.equal(persisted.CacheSize, next.CacheSize);
  // A null, nonnullable array is omitted by XML and a cold reader restores its constructor default.
  assert.deepEqual(persisted.MetadataOptions, defaultConfiguration('server').MetadataOptions);
  assert.doesNotMatch(await fs.readFile(filename, 'utf8'), /<ServerName\b|<MetadataOptions\b|NetworkConfiguration|<BaseUrl\b/u);
  next.ServerName = 'Late incoming'; next.PreviousVersionStr = ' +3 . 04 .5 ';
  next.ContentTypes = [{ Name: 'Incoming root', Value: 'music' }];
  assert.equal(store.configuration.ServerName, 'Late incoming'); assert.equal(store.configuration.PreviousVersion, '3.4.5');
  assert.deepEqual(store.configuration.ContentTypes, [{ Name: 'Incoming root', Value: 'music' }]);
  store.configuration.ServerName = 'Current writes retained'; store.configuration.PreviousVersion = '4.5.6';
  assert.equal(next.ServerName, 'Current writes retained'); assert.equal(next.PreviousVersionStr, '4.5.6');
  await store.updateContentTypes(() => [{ Name: 'Saved current root', Value: 'tvshows' }]);
  assert.deepEqual(next.ContentTypes, [{ Name: 'Saved current root', Value: 'tvshows' }]);
  previous.ServerName = 'Detached old name'; previous.PreviousVersionStr = '9.9.9';
  previous.ContentTypes = [{ Name: 'Detached old root', Value: 'books' }];
  firstIncomingTypes[0].Value = 'Detached first incoming root';
  assert.equal(store.configuration.ServerName, 'Current writes retained'); assert.equal(store.configuration.PreviousVersionStr, '4.5.6');
  assert.deepEqual(store.configuration.ContentTypes, [{ Name: 'Saved current root', Value: 'tvshows' }]);
  networkConfiguration.EnableRemoteAccess = false; await namedConfiguration.saveConfiguration('network', networkConfiguration); assert.equal(networkConfiguration.EnableRemoteAccess, false);
  assert.equal(parseConfigurationXml(await fs.readFile(path.join(directory, 'network.xml')), 'network').EnableRemoteAccess, false);
  await store.saveConfiguration();
  const cold = await readServer(filename);
  assert.equal(cold.ServerName, 'Current writes retained'); assert.equal(cold.PreviousVersionStr, '4.5.6');
  assert.deepEqual(cold.ContentTypes, [{ Name: 'Saved current root', Value: 'tvshows' }]);
  assert.doesNotMatch(await fs.readFile(filename, 'utf8'), /<MetadataOptions\b|NetworkConfiguration|<BaseUrl\b/u);
});

test('replacement survives a real save target failure with retained incoming writes and later cold persistence', async t => {
  const { store, configuration: previous, filename } = await setup(t);
  await fs.unlink(filename); await fs.mkdir(filename);
  const incoming = { ...defaultConfiguration('server'), ServerName: 'Replacement before failed write',
    PreviousVersion: '2.3.4', ContentTypes: [{ Name: 'Incoming', Value: 'movies' }] };
  await assert.rejects(store.replaceConfiguration(incoming), error => ['EISDIR', 'EACCES', 'EPERM'].includes(error.code));
  assert.equal(store.configuration.ServerName, 'Replacement before failed write');
  assert.equal((await fs.stat(filename)).isDirectory(), true);
  incoming.ServerName = 'Late write after failed save'; incoming.PreviousVersionStr = '5.6.7';
  assert.equal(store.configuration.ServerName, 'Late write after failed save'); assert.equal(store.configuration.PreviousVersion, '5.6.7');
  store.configuration.ServerName = 'Current after failed save'; store.configuration.PreviousVersion = '6.7.8';
  assert.equal(incoming.ServerName, 'Current after failed save'); assert.equal(incoming.PreviousVersionStr, '6.7.8');
  previous.ServerName = 'Old current stays detached'; previous.ContentTypes = [];
  assert.equal(store.configuration.ServerName, 'Current after failed save');
  assert.deepEqual(store.configuration.ContentTypes, [{ Name: 'Incoming', Value: 'movies' }]);
  await fs.rmdir(filename); await store.saveConfiguration();
  const cold = await readServer(filename);
  assert.equal(cold.ServerName, 'Current after failed save'); assert.equal(cold.PreviousVersion, '6.7.8');
  assert.deepEqual(cold.ContentTypes, [{ Name: 'Incoming', Value: 'movies' }]);
});

test('changed metadata is probed through real storage before updating and failed delete leaves its probe', async t => {
  const deletion = Object.assign(new Error('Controlled metadata probe deletion failure.'), { code: 'EACCES', cause: new Error('Delete denied.') });
  const fixture = await setup(t, ({ storage }) => ({ metadataFileSystem: { stat: (...args) => storage.fileSystem.stat(...args),
    writeFile: (...args) => storage.fileSystem.writeFile(...args), unlink: async () => { throw deletion; },
    mkdir: (...args) => storage.fileSystem.mkdir(...args) } }));
  const { store, root, configuration, filename } = fixture;
  const metadata = path.join(root, 'new-metadata'); await fs.mkdir(metadata);
  const phases = []; store.on('updating', () => { phases.push('updating'); });
  const next = { ...defaultConfiguration('server'), MetadataPath: metadata, ServerName: 'Not admitted' };
  await assert.rejects(store.replaceConfiguration(next), error => error.code === 'EACCES' && error.cause.message === 'Delete denied.');
  assert.deepEqual(phases, []); assert.notEqual(configuration.ServerName, 'Not admitted');
  assert.equal(await fs.readFile(filename, 'utf8'), original);
  const probes = await fs.readdir(metadata); assert.equal(probes.length, 1);
  assert.match(probes[0], /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/u);
  assert.equal((await fs.readFile(path.join(metadata, probes[0]))).length, 0);
});

test('metadata missing directory rejects before updating with actionable Node failure and cause', async t => {
  const { store, root, filename } = await setup(t), phases = [];
  store.on('updating', () => { phases.push('updating'); });
  const metadata = path.join(root, 'not-created');
  await assert.rejects(store.replaceConfiguration({ ...defaultConfiguration('server'), MetadataPath: metadata }), error =>
    error.code === 'ENOENT' && error.status === 404 && error.message === `${metadata} does not exist.` && error.cause.code === 'ENOENT');
  assert.deepEqual(phases, []); assert.equal(await fs.readFile(filename, 'utf8'), original);
});

test('updated failure is reported after committed files, stops later handlers and does not fail close', async t => {
  const { store, filename, errors } = await setup(t), phases = [];
  store.on('updated', async () => { phases.push((await readServer(filename)).ServerName); throw Object.assign(new Error('Controlled updated failure.'), { code: 'EIO' }); });
  store.on('updated', () => { phases.push('later handler'); });
  await store.updateServerValues({ ServerName: 'Saved' }); await store.close();
  assert.deepEqual(phases, ['Saved']); assert.deepEqual(errors.map(error => ({ code: error.code, message: error.message })), [{ code: 'EIO', message: 'Controlled updated failure.' }]);
  assert.equal((await readServer(filename)).ServerName, 'Saved');
});

test('named network save keeps separate ordering and never runs server path effects', async t => {
  const { store, namedConfiguration, networkConfiguration, configuration, root, filename, directory } = await setup(t), phases = [];
  namedConfiguration.on('updating', ({ key: name, configuration: next }) => { phases.push([name, 'updating', next.EnableRemoteAccess]); next.BaseUrl = '/named'; });
  namedConfiguration.on('updated', ({ key: name, configuration: next }) => { phases.push([name, 'updated', next.EnableRemoteAccess]); });
  store.on('updated', () => { phases.push(['unexpected server updated']); });
  configuration.MetadataPath = path.join(root, 'metadata-file'); await fs.writeFile(configuration.MetadataPath, 'a file');
  networkConfiguration.EnableRemoteAccess = false; await namedConfiguration.saveConfiguration('network', networkConfiguration); await namedConfiguration.close(); await store.close();
  assert.deepEqual(phases, [['network', 'updating', false], ['network', 'updated', false]]);
  const persisted = parseConfigurationXml(await fs.readFile(path.join(directory, 'network.xml')), 'network');
  assert.equal(persisted.EnableRemoteAccess, false); assert.equal(persisted.BaseUrl, '/named');
  assert.equal(await fs.readFile(filename, 'utf8'), original);
});

test('configuration saves through a linked directory and cold reads its actual target', async t => {
  const { root, directory, configuration, applicationPaths, storage } = await setup(t), alias = path.join(root, 'alias');
  await fs.symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const store = new ServerConfigurationStore({ configuration, configurationDirectoryPath: alias, applicationPaths, metadataFileSystem: storage.fileSystem });
  try {
    await store.initialize(); await store.updateContentTypes(() => []);
    assert.deepEqual((await readServer(path.join(directory, 'system.xml'))).ContentTypes, []);
    assert.deepEqual(await readServer(path.join(alias, 'system.xml')), store.configuration);
    assert.equal((await fs.lstat(alias)).isSymbolicLink(), true);
  } finally { await store.close(); await fs.rm(alias); }
});

test('unavailable metadata storage can initialize after recovery without undoing cache effects', async t => {
  const { root, configuration, directory, storage } = await setup(t);
  const applicationPaths = { programDataPath: root, defaultMetadataPath: path.join(root, 'retry-metadata'), cachePath: path.join(root, 'retry-cache') };
  const unavailable = Object.assign(new Error('Metadata storage is temporarily unavailable.'), { code: 'ENOTSUP', status: 501 });
  let available = false;
  const store = new ServerConfigurationStore({ configuration, applicationPaths, configurationDirectoryPath: directory,
    metadataFileSystem: { mkdir: (...args) => available ? storage.fileSystem.mkdir(...args) : Promise.reject(unavailable) } });
  try {
    await assert.rejects(store.initialize(), error => error.code === 'ENOTSUP' && error.status === 501);
    assert.equal((await fs.readFile(path.join(applicationPaths.cachePath, '.jellyfin-cache'))).length, 0);
    assert.match(await fs.readFile(path.join(applicationPaths.cachePath, 'CACHEDIR.TAG'), 'utf8'), /^Signature: /u);
    await assert.rejects(fs.stat(applicationPaths.metadataPath), missing);
    available = true; await store.initialize(); await store.initialize();
    assert.equal((await fs.stat(applicationPaths.metadataPath)).isDirectory(), true);
  } finally { await store.close(); }
});
