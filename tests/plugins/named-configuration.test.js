import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { PluginHost } from '../../src/plugins/host.js';
import { NamedConfigurationStore } from '../../src/core/named-configuration-store.js';
import { parseConfigurationXml } from '../../src/core/configuration-xml.js';
import { createConfigurationBinding, namedConfigurationCodec } from '../../packages/plugin-sdk/configuration.js';
import { localStateStorage } from '../helpers/local-state-storage.js';
import { validationOutputRoot, assertValidationOutputChild } from '../../tools/validation/paths.js';
import { namedError } from '../core/named-configuration-current.js';
import { configurationJson } from '../core/fixtures/configuration/observations.js';

test('third-party named configuration binding saves without stopping an admitted real reader and drains its mutation lane', { timeout: 30000 }, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'plugin-named-binding-')); assertValidationOutputChild(root);
  const directory = path.join(root, 'config'), filename = path.join(directory, 'xbmcmetadata.xml');
  const report = { schemaVersion: 1, scope: 'A third-party package declares the same named binding as NFO; actual Local read/write and named current remain available during mutation drain.',
    errors: [], failures: [], phaseAcceptance: false, releaseAcceptance: false };
  const failures = [], readEntered = Promise.withResolvers(), readRelease = Promise.withResolvers(), writeEntered = Promise.withResolvers(), writeRelease = Promise.withResolvers();
  const release = () => { readRelease.resolve(); writeRelease.resolve(); }; t.signal.addEventListener('abort', release);
  let store, host, storage, reading, saving, captureWrite = false;
  try {
    storage = await localStateStorage(root); await storage.fileSystem.writeFile(path.join(root, 'original.nfo'), '<movie><title>Original body</title></movie>');
    store = new NamedConfigurationStore({ configurationDirectoryPath: directory, onError: error => report.errors.push(namedError(error)),
      fileSystem: { ...fs, async open(name, flags, ...args) {
        const file = await fs.open(name, flags, ...args);
        return { write: async (...values) => { const result = await file.write(...values);
          if (captureWrite && name === filename) { captureWrite = false; writeEntered.resolve(); await writeRelease.promise; }
          return result; }, close: () => file.close() };
      } } });
    await store.getConfiguration('xbmcmetadata');
    const bindings = new Map([['xbmcmetadata', createConfigurationBinding({ getCurrent: () => store.getCurrentConfiguration('xbmcmetadata'),
      save: value => store.saveConfiguration('xbmcmetadata', value), fields: namedConfigurationCodec('xbmcmetadata').fields })]]);
    host = await PluginHost.open({ directory: path.join(root, 'plugins'), preinstalled: false, configurationBindings: bindings,
      options: { 'named-fixture': { vfs: storage.fileSystem.vfs, pause: async () => { readEntered.resolve(); await readRelease.promise; } } },
      onError: error => report.errors.push(namedError(error)) });
    const source = path.join(root, 'package'); await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: '@test/named-fixture', version: '0.1.0', type: 'module',
      mediamanager: { id: 'named-fixture', name: 'Named fixture', entry: 'index.js', configurationKey: 'xbmcmetadata' },
      dependencies: { '@mediamanager/plugin-sdk': '0.1.0' } }));
    await fs.writeFile(path.join(source, 'index.js'), `
import { namedConfigurationCodec } from '@mediamanager/plugin-sdk/configuration';
const codec = namedConfigurationCodec('xbmcmetadata');
export const validateConfiguration = value => codec.validate(value);
export async function activate(context) {
  await context.register('metadata', { id: context.id, name: 'Named fixture', providers: [{ id: 'named-reader', name: 'Named fixture', kind: 'local', itemTypes: ['Movie'],
    async getMetadata(item, { signal }) {
      const handle = await context.options.vfs.openRead('/state/original.nfo', { signal });
      try { const chunks = []; for await (const bytes of handle.stream) { await context.options.pause(); signal.throwIfAborted(); chunks.push(Buffer.from(bytes)); }
        return { HasMetadata: true, Item: { ...item, Name: context.getConfiguration().ReleaseDateFormat, Overview: Buffer.concat(chunks).toString() }, People: [] };
      } finally { await handle.close(); }
    } }] });
  return { get configuration() { return context.getConfiguration(); }, fields: codec.fields };
}
`);
    await host.install(source);
    reading = host.entries('metadata')[0].providers[0].getMetadata({ Type: 'Movie' }, { signal: t.signal }); void reading.catch(() => {});
    const boundary = await Promise.race([readEntered.promise.then(() => true), reading.then(() => false)]);
    assert.equal(boundary, true, 'The package opened its actual Local read before configuration changes.');
    captureWrite = true; saving = host.configure('named-fixture', { ReleaseDateFormat: 'dd/MM/yyyy', SaveImagePathsInNfo: false }); void saving.catch(() => {});
    await Promise.race([writeEntered.promise, saving.then(() => { throw new Error('The named write did not reach its controlled file boundary.'); })]);
    const draining = host.beginClose();
    await assert.rejects(host.configure('named-fixture', {}), { status: 503 });
    writeRelease.resolve(); report.saved = await saving; await draining;
    await store.close();
    readRelease.resolve(); report.reader = await reading;
    assert.equal(report.reader.Item.Name, 'dd/MM/yyyy');
    assert.equal(report.reader.Item.Overview, '<movie><title>Original body</title></movie>');
    report.xml = (await fs.readFile(filename)).toString('base64');
    assert.equal(parseConfigurationXml(Buffer.from(report.xml, 'base64'), 'xbmcmetadata').ReleaseDateFormat, 'dd/MM/yyyy');
    await host.close(); host = undefined;
    const cold = new NamedConfigurationStore({ configurationDirectoryPath: directory });
    try { report.cold = await cold.getConfiguration('xbmcmetadata'); assert.deepEqual(report.cold, report.saved.configuration); }
    finally { await cold.close(); }
    await storage.fileSystem.writeFile(path.join(root, 'original.nfo'), '<movie><title>Released source</title></movie>');
    assert.equal((await storage.fileSystem.readFile(path.join(root, 'original.nfo'))).toString(), '<movie><title>Released source</title></movie>');
    assert.deepEqual(report.errors, []);
  } catch (error) { failures.push(error); }
  finally {
    t.signal.removeEventListener('abort', release); release();
    for (const result of await Promise.allSettled([reading, saving])) if (result.status === 'rejected') failures.push(result.reason);
    for (const operation of [() => host?.close(), () => store?.close(), () => storage?.close()]) try { await operation(); } catch (error) { failures.push(error); }
    try { assert.deepEqual(report.errors, []); } catch (error) { failures.push(error); }
    report.failures = failures.map(namedError); await fs.writeFile(path.join(root, 'comparison.json'), configurationJson(report), { flag: 'wx' });
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'Third-party named binding failed.', { cause: failures[0] });
});
