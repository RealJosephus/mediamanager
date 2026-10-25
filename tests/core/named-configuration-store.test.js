import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NamedConfigurationStore } from '../../src/core/named-configuration-store.js';
import { defaultConfiguration, parseConfigurationXml } from '../../src/core/configuration-xml.js';
import { readConfigurationFile, serializeConfiguration } from '../../src/core/configuration-file.js';

const metadata = value => ({ ...defaultConfiguration('metadata'), UseFileCreationTimeForDateAdded: value });
const failureValue = error => ({ message: error.message, code: error.code, status: error.status,
  ...(error.cause && { cause: failureValue(error.cause) }), ...(error.errors && { errors: Array.from(error.errors, failureValue) }) });
const deferred = () => Promise.withResolvers();

async function setup(t, options = {}) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'named-configuration-'));
  const errors = [], store = new NamedConfigurationStore({ configurationDirectoryPath: directory, onError: error => errors.push(error), ...options });
  t.after(async () => {
    await store.close();
    for (const name of ['encoding.xml', 'metadata.xml']) try {
      const filename = path.join(directory, name); if ((await fs.stat(filename)).isFile()) await fs.chmod(filename, 0o666);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const target = await fs.realpath(directory);
    assert.equal(path.dirname(target), temporaryRoot); assert.match(path.basename(target), /^named-configuration-/u);
    await fs.rm(target, { recursive: true, force: true });
  });
  return { directory, store, errors, filename: root => path.join(directory, root + '.xml') };
}

test('named lazy defaults preserve missing, malformed and externally replaced files with independently warm public keys', async t => {
  const { store, directory, filename, errors } = await setup(t);
  assert.deepEqual(await store.getConfiguration('metadata'), metadata(true));
  assert.deepEqual(await fs.readdir(directory), []);
  const malformed = Buffer.from('<MetadataConfiguration><UseFileCreationTimeForDateAdded>broken</UseFileCreationTimeForDateAdded></MetadataConfiguration>');
  await fs.writeFile(filename('metadata'), malformed);
  let expected;
  try { parseConfigurationXml(malformed, 'metadata'); } catch (error) { expected = error; }
  assert.deepEqual(await store.getConfiguration('METADATA'), metadata(true));
  assert.deepEqual(await fs.readFile(filename('metadata')), malformed);
  assert.deepEqual(errors.map(failureValue), [failureValue(expected)]);
  await fs.writeFile(filename('metadata'), serializeConfiguration('metadata', metadata(false)));
  assert.deepEqual(await store.getConfiguration('MeTaDaTa'), metadata(false));
  assert.deepEqual(await store.getConfiguration('metadata'), metadata(true));
  assert.deepEqual(await store.getConfiguration('METADATA'), metadata(true));
  await store.close(); assert.deepEqual(store.getCurrentConfiguration('MeTaDaTa'), metadata(false));
});

test('named replacement retains incoming/current writes while old warm aliases and prior roots stay independent', async t => {
  const { store, filename, errors } = await setup(t);
  const previous = await store.getConfiguration('metadata'); await store.getConfiguration('METADATA');
  const incoming = metadata(false); await store.saveConfiguration('metadata', incoming);
  incoming.UseFileCreationTimeForDateAdded = true;
  assert.equal((await store.getConfiguration('metadata')).UseFileCreationTimeForDateAdded, true);
  store.getCurrentConfiguration('metadata').UseFileCreationTimeForDateAdded = false;
  assert.equal(incoming.UseFileCreationTimeForDateAdded, false);
  previous.UseFileCreationTimeForDateAdded = true;
  assert.equal(store.getCurrentConfiguration('metadata').UseFileCreationTimeForDateAdded, false);
  assert.equal((await store.getConfiguration('METADATA')).UseFileCreationTimeForDateAdded, true);
  await store.saveConfiguration('metadata', incoming);
  assert.deepEqual(await readConfigurationFile(filename('metadata'), 'metadata'), metadata(false));
  const cold = new NamedConfigurationStore({ configurationDirectoryPath: path.dirname(filename('metadata')) });
  try { assert.deepEqual(await cold.getConfiguration('metadata'), metadata(false)); } finally { await cold.close(); }
  assert.deepEqual(errors, []);
});

test('encoding validates changed paths before updating and preserves unchanged or blank path values', async t => {
  const { store, directory, filename, errors } = await setup(t), phases = [];
  store.on('updating', event => phases.push({ key: event.key, path: event.configuration.TranscodingTempPath }));
  const initial = { ...defaultConfiguration('encoding'), EncoderAppPath: 'existing-encoder', TranscodingTempPath: 'unchanged-missing-path' };
  await fs.writeFile(filename('encoding'), serializeConfiguration('encoding', initial));
  assert.deepEqual(await store.getConfiguration('encoding'), initial);
  const before = await fs.readFile(filename('encoding'));
  await assert.rejects(store.saveConfiguration('encoding', { ...initial, TranscodingTempPath: path.join(directory, 'missing') }),
    error => error.code === 'ENOENT' && error.status === 404 && error.cause.code === 'ENOENT');
  await assert.rejects(store.saveConfiguration('encoding', { ...initial, EncoderAppPath: 'changed-encoder' }),
    { message: 'Unable to update encoder app path.', code: 'encoder-path-change-not-supported' });
  assert.deepEqual(phases, []); assert.deepEqual(store.getCurrentConfiguration('encoding'), initial);
  assert.deepEqual(await fs.readFile(filename('encoding')), before);
  const target = path.join(directory, 'transcodes'); await fs.mkdir(target);
  await store.saveConfiguration('encoding', { ...initial, TranscodingTempPath: target });
  await store.saveConfiguration('encoding', { ...initial, TranscodingTempPath: '', EncoderAppPath: '' });
  assert.equal((await readConfigurationFile(filename('encoding'), 'encoding')).EncoderAppPath, '');
  assert.deepEqual(phases.map(event => event.path), [target, '']); assert.deepEqual(errors, []);
});

test('sync updating failure keeps the old live/file and sync updated failure keeps the new durable value', async t => {
  const { store, filename, errors } = await setup(t);
  await store.saveConfiguration('metadata', metadata(true)); const before = await fs.readFile(filename('metadata'));
  const preflight = Object.assign(new Error('Controlled named updating failure.'), { code: 'updating-failed', cause: new Error('Original observer cause.') });
  const updating = () => { throw preflight; }; store.on('updating', updating);
  await assert.rejects(store.saveConfiguration('metadata', metadata(false)), error => {
    assert.deepEqual(failureValue(error), failureValue(preflight)); return true;
  });
  assert.deepEqual(store.getCurrentConfiguration('metadata'), metadata(true)); assert.deepEqual(await fs.readFile(filename('metadata')), before);
  store.off('updating', updating);
  const updated = Object.assign(new Error('Controlled named updated failure.'), { code: 'updated-failed' });
  store.on('updated', () => { throw updated; });
  await assert.rejects(store.saveConfiguration('metadata', metadata(false)), error => {
    assert.deepEqual(failureValue(error), failureValue(updated)); return true;
  });
  assert.deepEqual(store.getCurrentConfiguration('metadata'), metadata(false));
  assert.deepEqual(await readConfigurationFile(filename('metadata'), 'metadata'), metadata(false));
  await store.close(); assert.deepEqual(errors, []);
});

test('a formatter failure keeps adopted encoding values and the actual truncated XML prefix', async t => {
  const { store, filename, errors } = await setup(t);
  const old = defaultConfiguration('encoding'); await store.saveConfiguration('encoding', old);
  const incoming = { ...old, EnableFallbackFont: true, HardwareAccelerationType: 999 };
  await assert.rejects(store.saveConfiguration('encoding', incoming));
  assert.equal(store.getCurrentConfiguration('encoding').HardwareAccelerationType, 999);
  incoming.EnableFallbackFont = false; assert.equal(store.getCurrentConfiguration('encoding').EnableFallbackFont, false);
  const prefix = await fs.readFile(filename('encoding'));
  assert.ok(prefix.length > 0); assert.ok(prefix.length < serializeConfiguration('encoding', old).length);
  assert.match(prefix.toString(), /<EnableFallbackFont>true<\/EnableFallbackFont>/u);
  const cold = parseConfigurationXml(prefix, 'encoding');
  assert.equal(cold.EnableFallbackFont, true); assert.equal(cold.HardwareAccelerationType, old.HardwareAccelerationType);
  assert.deepEqual(errors, []);
});

test('write and handle-close failures preserve both original errors and the real physical prefix', async t => {
  const write = Object.assign(new Error('Controlled named write failure.'), { code: 'ENOSPC', status: 507, cause: new Error('Volume is full.') });
  const close = Object.assign(new Error('Controlled named handle-close failure.'), { code: 'EIO' });
  let written = 0;
  const { store, filename } = await setup(t, { fileSystem: { ...fs, async open(...args) {
    const file = await fs.open(...args);
    return { async write(buffer, offset, length) {
      if (written >= 37) throw write;
      const result = await file.write(buffer, offset, Math.min(length, 37 - written)); written += result.bytesWritten; return result;
    }, async close() { await file.close(); throw close; } };
  } } });
  const incoming = metadata(false);
  await assert.rejects(store.saveConfiguration('metadata', incoming), error => {
    assert.equal(error.code, 'ENOSPC'); assert.equal(error.status, 507);
    assert.deepEqual(error.errors.map(failureValue), [write, close].map(failureValue));
    assert.deepEqual(failureValue(error.cause), failureValue(write)); return true;
  });
  assert.equal(store.getCurrentConfiguration('metadata').UseFileCreationTimeForDateAdded, false);
  assert.deepEqual(await fs.readFile(filename('metadata')), serializeConfiguration('metadata', incoming).subarray(0, 37));
});

test('read failures after existence propagate unchanged and the same public key can retry', async t => {
  let failure;
  const { store, filename, errors } = await setup(t, { fileSystem: { ...fs, async readFile(...args) {
    if (failure) throw failure; return fs.readFile(...args);
  } } });
  await fs.writeFile(filename('metadata'), serializeConfiguration('metadata', metadata(false)));
  failure = Object.assign(new Error('Controlled actual read failure.'), { code: 'EIO', cause: new Error('Original read cause.') });
  await assert.rejects(store.getConfiguration('metadata'), error => { assert.deepEqual(failureValue(error), failureValue(failure)); return true; });
  failure = undefined; assert.deepEqual(await store.getConfiguration('metadata'), metadata(false)); assert.deepEqual(errors, []);
});

test('close drains an admitted physical write/cold read and retains pure current reads after closing', async t => {
  const entered = deferred(), release = deferred(); let first = true;
  const { store, filename, errors } = await setup(t, { fileSystem: { ...fs, async open(...args) {
    const file = await fs.open(...args);
    return { async write(...writeArgs) { if (first) { first = false; entered.resolve(); await release.promise; } return file.write(...writeArgs); }, close: () => file.close() };
  } } });
  const saved = store.saveConfiguration('metadata', metadata(false)); let cold, closing;
  try {
    await entered.promise; cold = store.getConfiguration('METADATA');
    let complete = false; closing = store.close().then(() => { complete = true; }); await Promise.resolve();
    assert.equal(complete, false); assert.deepEqual(store.getCurrentConfiguration('metadata'), metadata(false));
    await assert.rejects(store.getConfiguration('metadata'), { code: 'closed', status: 503 });
    await assert.rejects(store.saveConfiguration('metadata', metadata(true)), { code: 'closed', status: 503 });
    release.resolve(); await saved; assert.deepEqual(await cold, metadata(false)); await closing;
    assert.deepEqual(await readConfigurationFile(filename('metadata'), 'metadata'), metadata(false));
    assert.deepEqual(store.getCurrentConfiguration('metadata'), metadata(false)); assert.deepEqual(errors, []);
  } finally { release.resolve(); await Promise.allSettled([saved, cold, closing]); }
});
