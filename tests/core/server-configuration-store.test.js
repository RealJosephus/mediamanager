import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ServerConfigurationStore, replaceContentTypes } from '../../src/core/server-configuration-store.js';

const retained = '<!-- <ContentTypes/> --><Extra attribute="&gt;">mixed<![CDATA[<ContentTypes/>]]><ContentTypes>nested</ContentTypes></Extra><?state untouched?>';
const old = '<ContentTypes><NameValuePair><Name>Old</Name><Value>movies</Value></NameValuePair></ContentTypes>';
const original = `<?xml version="1.0" encoding="utf-8"?>\r\n<ServerConfiguration xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${old}${retained}</ServerConfiguration>`;

async function setup(t, fileSystem = fs) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-config-store-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'system.xml'), original);
  const configuration = { ContentTypes: [{ Name: 'Old', Value: 'movies' }] };
  const store = new ServerConfigurationStore({ configuration, configurationDirectoryPath: directory, fileSystem });
  t.after(() => store.close());
  return { directory, configuration, store, filename: path.join(directory, 'system.xml') };
}

test('content-type XML preserves unknown bytes, comments, declarations and nested array names', () => {
  const edited = replaceContentTypes(original, [{ Name: 'A&B', Value: 'tvshows' }]);
  assert.equal(edited, original.replace(old, '<ContentTypes><NameValuePair><Name>A&amp;B</Name><Value>tvshows</Value></NameValuePair></ContentTypes>'));
  assert.equal(replaceContentTypes('<ServerConfiguration/>', []), '<ServerConfiguration><ContentTypes></ContentTypes></ServerConfiguration>');
  assert.equal(replaceContentTypes('<ServerConfiguration><ContentTypes /></ServerConfiguration>', []), '<ServerConfiguration><ContentTypes></ContentTypes></ServerConfiguration>');
  assert.equal(replaceContentTypes('<ServerConfiguration/>', [{ Name: null, Value: 'tvshows' }]), '<ServerConfiguration><ContentTypes><NameValuePair><Value>tvshows</Value></NameValuePair></ContentTypes></ServerConfiguration>');
  assert.throws(() => replaceContentTypes('<ServerConfiguration><ContentTypes/><ContentTypes/></ServerConfiguration>', []), { code: 'invalid-configuration' });
  assert.throws(() => replaceContentTypes('<!DOCTYPE ServerConfiguration><ServerConfiguration/>', []), { code: 'invalid-configuration' });
});

test('configuration persistence serializes concurrent updates and drains accepted writes on close', async t => {
  const { store, configuration, directory, filename } = await setup(t);
  const first = store.updateContentTypes(types => [...types, { Name: 'First', Value: 'tvshows' }]);
  const second = store.updateContentTypes(types => [...types, { Name: 'Second', Value: 'music' }]);
  const closing = store.close();
  await assert.rejects(store.updateContentTypes(() => []), { code: 'closed', status: 503 });
  await Promise.all([first, second, closing]);
  assert.deepEqual(configuration.ContentTypes.map(entry => entry.Name), ['Old', 'First', 'Second']);
  assert.equal(await fs.readFile(filename, 'utf8'), replaceContentTypes(original, configuration.ContentTypes));
  assert.deepEqual(await fs.readdir(directory), ['system.xml']);
});

test('failed atomic replacement leaves old disk bytes and the native new live configuration', async t => {
  const { store, configuration, filename, directory } = await setup(t, { ...fs,
    rename: async () => { throw new Error('Injected configuration save failure'); } });
  const next = [{ Name: 'Next', Value: 'tvshows' }];
  await assert.rejects(store.updateContentTypes(() => next), /Injected configuration save failure/u);
  assert.deepEqual(configuration.ContentTypes, next);
  assert.equal(await fs.readFile(filename, 'utf8'), original);
  assert.deepEqual(await fs.readdir(directory), ['system.xml']);
});

test('a read-only configuration keeps its bytes while the failed save retains the new live value', async t => {
  const { store, configuration, filename, directory } = await setup(t);
  const next = [{ Name: 'Next', Value: 'tvshows' }];
  await fs.chmod(filename, 0o444);
  try {
    await assert.rejects(store.updateContentTypes(() => next), error => ['EACCES', 'EPERM'].includes(error.code));
    assert.deepEqual(configuration.ContentTypes, next);
    assert.equal(await fs.readFile(filename, 'utf8'), original);
    assert.deepEqual(await fs.readdir(directory), ['system.xml']);
  } finally { await fs.chmod(filename, 0o666); }
});

test('competing configuration bytes are preserved and reject the stale replacement', async t => {
  let count = 0, filename;
  const external = original.replace('Old', 'External');
  const fixture = await setup(t, { ...fs, readFile: async (...args) => {
    if (++count === 2) await fs.writeFile(filename, external);
    return fs.readFile(...args);
  } });
  filename = fixture.filename;
  await assert.rejects(fixture.store.updateContentTypes(() => []), { code: 'configuration-conflict', status: 409 });
  assert.equal(await fs.readFile(filename, 'utf8'), external);
  assert.deepEqual(await fs.readdir(fixture.directory), ['system.xml']);
});

test('configuration state refuses a linked directory before touching its target file', async t => {
  const { directory, configuration } = await setup(t);
  const alias = path.join(directory, 'alias');
  await fs.symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const store = new ServerConfigurationStore({ configuration, configurationDirectoryPath: alias });
  await assert.rejects(store.updateContentTypes(() => []), { code: 'unsafe-configuration-path' });
  assert.equal(await fs.readFile(path.join(directory, 'system.xml'), 'utf8'), original);
  await fs.rm(alias); await store.close();
});
