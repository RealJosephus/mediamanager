import { nativeTextBytes } from '../../src/database/native-text.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createTestRuntime } from '../helpers/runtime.js';
import { nativeGuid } from '../../src/users/native.js';
import { tableDefinition } from '../../src/database/model.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/splashscreen-query/native.json', import.meta.url)));
const source = fixture.results.find(row => row.sample.Name === 'type-rating-version-and-first-image');
const inputImage = new URL('../images/fixtures/splashscreen/assets/portrait.jpg', import.meta.url);
const convert = (table, row) => Object.fromEntries(tableDefinition(table).columns.map(column => [column.name,
  row[column.name] != null && column.clrType.includes('Guid') ? nativeGuid(row[column.name]) : row[column.name]]));

async function runtimeFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'splashscreen-runtime-'));
  const database = await createPostgresTestDatabase(null, 'splashscreen_runtime');
  const storage = new StorageRegistry(); storage.registerType('memory', () => new MemoryStorageAdapter());
  await storage.createInstance('media', 'memory', {});
  const vfs = new VirtualFileSystem(storage); vfs.mount({ path: '/media', instanceId: 'media', capabilities: { create: true, replace: true } });
  const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot: 'Z:\\Splashscreen', accessRoot: '/media', style: 'windows',
    returnAccess: 'Isolated splashscreen runtime media.' });
  let runtime;
  t.after(async () => {
    try { if (runtime) await runtime.close(); else await database.close(); }
    finally { await dropPostgresTestDatabase(database); await storage.close();
      assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('splashscreen-runtime-'));
      await rm(root, { recursive: true, force: true }); }
  });
  runtime = await createTestRuntime({ database, programDataPath: root, vfs, identityMap, serverId: 'splashscreen-runtime',
    configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true } });
  await mkdir(path.join(root, 'data'), { recursive: true });
  const item = source.rows.find(row => row.Name === 'Item 1'), ItemId = nativeGuid(item.Id);
  await database.insert('BaseItems', convert('BaseItems', item));
  for (const [index, ImageType] of [0, 5].entries()) await database.insert('BaseItemImageInfos', {
    ...convert('BaseItemImageInfos', source.imageRows[index]), ItemId, ImageType, Path: 'Z:\\Splashscreen\\portrait.jpg',
  });
  return { runtime, root, database, vfs, ItemId };
}

test('postgres: the registered splashscreen task reads mapped media through VFS and preserves output on an unmapped host path', {
  skip: !postgresTestConnectionString,
}, async t => {
  const { runtime, root, database, vfs, ItemId } = await runtimeFixture(t);
  await vfs.write('/media/portrait.jpg', await readFile(inputImage));
  const open = vfs.openRead.bind(vfs); let opened = 0, closed = 0;
  vfs.openRead = async (...args) => {
    assert.equal(args[0], '/media/portrait.jpg'); opened++; const handle = await open(...args);
    return { ...handle, async close() { closed++; return handle.close(); } };
  };
  assert.equal(runtime.libraryScanLifecycle.postScanTasks[0], runtime.splashscreenPostScanTask);
  assert.equal(runtime.splashscreenPostScanTask.imageGenerator, runtime.splashscreen);
  await runtime.splashscreenPostScanTask.run({ signal: AbortSignal.abort(), reportProgress: () => assert.fail('No splashscreen progress') });
  const filename = path.join(root, 'data', 'splashscreen.png'), before = await readFile(filename), metadata = await sharp(before).metadata();
  assert.equal(metadata.format, 'png'); assert.equal(metadata.width, 1920); assert.equal(metadata.height, 1080);
  assert.ok(opened > 0); assert.equal(closed, opened);
  await database.client.query({ text: 'UPDATE "BaseItemImageInfos" SET "Path" = $1 WHERE "ItemId" = $2', values: [nativeTextBytes(fileURLToPath(inputImage)), nativeTextBytes(ItemId)] });
  await assert.rejects(runtime.splashscreenPostScanTask.run(), { code: 'unmapped-path' });
  assert.equal(closed, opened); assert.deepEqual(await readFile(filename), before);
});

test('postgres: runtime shutdown releases an active VFS splashscreen stream and queued generations', {
  skip: !postgresTestConnectionString,
}, async t => {
  const { runtime, root, vfs } = await runtimeFixture(t), started = Promise.withResolvers(); let opened = 0, closed = 0;
  vfs.openRead = async (filename, { signal }) => {
    opened++; started.resolve();
    return { kind: 'file', size: 1, modified: '2026-01-01T00:00:00Z',
      stream: (async function* () { await new Promise((resolve, reject) => {
        if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }); yield Buffer.from('unreachable'); })(),
      async close() { closed++; },
    };
  };
  vfs.stat = async () => ({ kind: 'file', size: 1, modified: '2026-01-01T00:00:00Z' });
  const admitted = Promise.withResolvers(), generate = runtime.splashscreen.createSplashscreen.bind(runtime.splashscreen); let admissions = 0;
  runtime.splashscreen.createSplashscreen = (...args) => {
    if (++admissions === 2) admitted.resolve(); return generate(...args);
  };
  const first = runtime.splashscreenPostScanTask.run(), second = runtime.splashscreenPostScanTask.run();
  const completed = Promise.allSettled([first, second]); await Promise.all([started.promise, admitted.promise]);
  await runtime.close();
  for (const result of await completed) { assert.equal(result.status, 'rejected'); assert.equal(result.reason.name, 'AbortError'); }
  assert.equal(opened, 1); assert.equal(closed, opened);
  await assert.rejects(readFile(path.join(root, 'data', 'splashscreen.png')), { code: 'ENOENT' });
});
