import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { LiveTvConfigurationStore, liveTvConfigurationReader as reader } from '../../src/core/live-tv-configuration-store.js';

async function fixture(t, fileSystem = fs) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'mm-live-tv-store-'));
  const service = new LiveTvConfigurationStore({ configurationDirectoryPath: directory, fileSystem });
  t.after(async () => {
    await service.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('mm-live-tv-store-'));
    await fs.rm(directory, { recursive: true });
  });
  return { service, filename: path.join(directory, 'livetv.xml'), directory };
}

test('named Live TV reads preserve missing and malformed files and retry an I/O failure', async t => {
  let failRead = false;
  const fileSystem = { ...fs, readFile: (...args) => failRead
    ? Promise.reject(Object.assign(new Error('Controlled configuration read failure.'), { code: 'EIO' })) : fs.readFile(...args) };
  const { service, filename, directory } = await fixture(t, fileSystem);
  assert.deepEqual(await service.getConfiguration(), reader.defaultConfiguration('livetv'));
  assert.deepEqual(await fs.readdir(directory), [], 'Reading defaults must not create a native configuration file.');
  const original = Buffer.from('<LiveTvOptions><GuideDays>broken</GuideDays></LiveTvOptions>');
  await fs.writeFile(filename, original);
  const errors = [];
  service.onError = error => errors.push(error.message);
  assert.deepEqual(await service.getConfiguration('LiveTv'), reader.defaultConfiguration('livetv'));
  assert.equal(errors.length, 1);
  assert.deepEqual(await fs.readFile(filename), original);
  await fs.writeFile(filename, '<LiveTvOptions><GuideDays>5</GuideDays></LiveTvOptions>');
  failRead = true;
  await assert.rejects(service.getConfiguration('LIVETV'), { code: 'EIO' });
  failRead = false;
  assert.equal((await service.getConfiguration('LIVETV')).GuideDays, 5);
  assert.equal((await service.getConfiguration('LiveTv')).GuideDays, null, 'A recovered live cache stays warm.');
});

test('named Live TV persistence preserves the new live value and file prefix when writing fails', async t => {
  const writeFailure = Object.assign(new Error('Controlled configuration write failure.'), { code: 'EIO' });
  let failWrite = false;
  const fileSystem = { ...fs, async open(...args) {
    const file = await fs.open(...args);
    if (!failWrite) return file;
    return { close: () => file.close(), async writeFile(bytes) { await file.writeFile(bytes.subarray(0, 40)); throw writeFailure; } };
  } };
  const { service, filename } = await fixture(t, fileSystem);
  const events = [];
  service.on('updating', ({ key, configuration }) => events.push(['updating', key, configuration.GuideDays]));
  service.on('updated', ({ key, configuration }) => events.push(['updated', key, configuration.GuideDays]));
  const first = { ...reader.defaultConfiguration('livetv'), GuideDays: 3 };
  await service.saveConfiguration(first);
  assert.equal(await service.getConfiguration(), first);
  const upper = await service.getConfiguration('LIVETV');
  failWrite = true;
  const second = { ...reader.defaultConfiguration('livetv'), GuideDays: 9 };
  await assert.rejects(service.saveConfiguration(second), error => error === writeFailure);
  assert.equal(await service.getConfiguration(), second);
  assert.equal(await service.getConfiguration('LIVETV'), upper);
  assert.equal((await fs.readFile(filename)).length, 40);
  assert.deepEqual(events, [['updating', 'livetv', 3], ['updated', 'livetv', 3], ['updating', 'livetv', 9]]);
  failWrite = false;
  await service.saveConfiguration(first);
  assert.deepEqual(reader.parseConfigurationXml(await fs.readFile(filename), 'livetv'), first);
});

test('a cold configuration key cannot read a file while a save has truncated it', { timeout: 10000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const fileSystem = { ...fs, async open(...args) {
    const file = await fs.open(...args);
    return { close: () => file.close(), async writeFile(bytes) { entered.resolve(); await release.promise; await file.writeFile(bytes); } };
  } };
  const { service } = await fixture(t, fileSystem);
  const saved = service.saveConfiguration({ ...reader.defaultConfiguration('livetv'), GuideDays: 6 });
  let cold;
  try {
    await entered.promise;
    cold = service.getConfiguration('LiveTv');
    let read = false;
    cold.then(() => { read = true; });
    await Promise.resolve();
    assert.equal(read, false);
    release.resolve();
    await saved;
    assert.equal((await cold).GuideDays, 6);
  } finally { release.resolve(); await Promise.allSettled([saved, cold]); }
});

test('named Live TV close drains admitted writes in order and rejects new work', { timeout: 10000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let writes = 0, closed = 0;
  const fileSystem = { ...fs, async open(...args) {
    const file = await fs.open(...args);
    return { async close() { closed++; await file.close(); }, async writeFile(bytes) {
      if (++writes === 1) { entered.resolve(); await release.promise; }
      await file.writeFile(bytes);
    } };
  } };
  const { service, filename } = await fixture(t, fileSystem);
  const first = service.saveConfiguration({ ...reader.defaultConfiguration('livetv'), GuideDays: 2 });
  const second = service.saveConfiguration({ ...reader.defaultConfiguration('livetv'), GuideDays: 8 });
  try {
  await entered.promise;
  const closing = service.close();
  assert.equal(service.close(), closing);
  let finished = false;
  closing.then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  await assert.rejects(service.getConfiguration(), { status: 503 });
  await assert.rejects(service.saveConfiguration(reader.defaultConfiguration('livetv')), { status: 503 });
  release.resolve();
  await Promise.all([first, second, closing]);
  assert.equal(closed, 2);
  assert.equal(reader.parseConfigurationXml(await fs.readFile(filename), 'livetv').GuideDays, 8);
  } finally { release.resolve(); await Promise.allSettled([first, second]); }
});
