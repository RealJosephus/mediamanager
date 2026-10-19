import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseLosslessJson } from '../../src/core/json.js';
import { tableDefinition } from '../../src/database/model.js';
import { nativeTextBytes } from '../../src/database/native-text.js';
import { nativeGuid } from '../../src/users/native.js';
import { setupDatabaseCleanup, cleanupId } from './clean-database-fixture.js';

const root = new URL('./fixtures/clean-database/', import.meta.url);
const [nativeBytes, inputBytes, proofBytes] = await Promise.all(['native.json', 'input.json', 'provenance.json'].map(name => readFile(new URL(name, root))));
const native = parseLosslessJson(nativeBytes.toString('utf8')), input = JSON.parse(inputBytes), proof = JSON.parse(proofBytes);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cancellation = error => error?.name === 'AbortError' || error?.code === 'cancelled';
const nativeFailure = failure => !failure ? null : failure.type.endsWith('CanceledException') ? 'cancelled'
  : failure.type === 'SqliteException' ? 'values' : failure.Message;
const nodeFailure = error => !error ? null : cancellation(error) ? 'cancelled' : error.code === 'P0001' ? 'values' : error.message;
const taskCalls = calls => calls.filter(row => row.action !== 'lookup');

test('database cleanup binds 28 real native task, ordinary deletion, SQL and filesystem observations', async () => {
  assert.equal(hash(nativeBytes), proof.nativeSha256); assert.equal(hash(inputBytes), proof.inputSha256);
  assert.equal(native.inputSha256, proof.inputSha256);
  for (const [index, observation] of native.results.entries()) {
    const defaults = Object.fromEntries(Object.entries(observation.sample).map(([key, value]) => [key,
      key === 'Name' ? '' : key === 'Playlists' ? [] : typeof value === 'boolean' ? false : 0]));
    assert.deepEqual(observation.sample, { ...defaults, ...input[index] });
  }
  for (const name of ['actualPostScanTask', 'actualRepository', 'actualLibraryManagerDelete', 'actualSqlite', 'actualPathManager', 'inlineProgressContext']) assert.equal(native[name], true);
  assert.equal(native.mediaOpened, false); assert.equal(native.portOpened, false);
  assert.equal(proof.build.status, 0); assert.equal(proof.process.status, 0); assert.equal(native.results.length, 28);
  for (const observation of native.results) for (const state of [observation.before, observation.after]) {
    for (const row of state.rows) assert.deepEqual(Object.keys(row).sort(), tableDefinition('BaseItems').columns.map(column => column.name).sort());
  }
  for (const source of proof.oracleSources) assert.equal(hash(await readFile(source.name === 'Directory.Build.props'
    ? new URL('../Directory.Build.props', import.meta.url) : new URL(source.name, root))), source.sha256, source.name);
});

for (const observation of native.results) test('postgres: database cleanup matches native ' + observation.sample.Name, {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const value = await setupDatabaseCleanup(t, observation);
  let failure;
  try { await value.operation(); } catch (error) { failure = error; }
  assert.equal(nodeFailure(failure), nativeFailure(observation.failure), 'Failure boundary.');
  assert.deepEqual(await value.snapshot(), value.normalizeNative(observation.after), 'All item columns, values, mappings, directories and file bytes.');
  assert.deepEqual(value.progress, observation.progress, 'Progress and cancellation prefix.');
  assert.deepEqual(taskCalls(value.calls), taskCalls(observation.calls), 'Task and ordinary deletion side-effect prefix.');
  assert.equal((await value.database.client.query("SELECT count(*) AS count FROM pg_class WHERE relpersistence = 't' AND relname LIKE 'mm_clean_%'")).rows[0].count, 0n);
});

test('postgres: database cleanup freezes playlist objects across 128-row pages and cascaded deletion', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const observation = native.results.find(row => row.sample.Name === 'nested missing file playlists');
  const value = await setupDatabaseCleanup(t, observation), { database } = value;
  const template = (await database.rows('BaseItems', { where: { Id: nativeGuid(cleanupId(101)) } }))[0];
  assert.ok(template);
  const physicalTemplate = Object.fromEntries(tableDefinition('BaseItems').columns.map(column => [column.name,
    template[column.name] == null || column.type !== 'TEXT' ? template[column.name]
      : '\\x' + nativeTextBytes(template[column.name]).toString('hex')]));
  await database.client.query({ text: `INSERT INTO "BaseItems" SELECT created.* FROM generate_series(102, 360) AS generated(number)
    CROSS JOIN LATERAL jsonb_populate_record(NULL::"BaseItems", $1::jsonb || jsonb_build_object(
      'Id', convert_to('ba420000-0000-0000-0000-' || lpad(generated.number::text, 12, '0'), 'UTF8'),
      'Name', convert_to('Playlist ' || generated.number, 'UTF8'),
      'SortName', convert_to(lpad(generated.number::text, 12, '0'), 'UTF8'),
      'Path', $2::bytea || convert_to('\\playlist-' || generated.number || '.m3u', 'UTF8'))) created`,
    values: [JSON.stringify(physicalTemplate, (_, entry) => typeof entry === 'bigint' ? JSON.rawJSON(String(entry)) : entry),
      nativeTextBytes(path.join(value.stateRoot, 'media'))] });
  const select = database.client.query.bind(database.client); let largest = 0;
  database.client.query = async (...args) => { const result = await select(...args); largest = Math.max(largest, result.rows.length); return result; };
  await value.operation();
  assert.equal(value.calls.filter(call => call.action === 'delete').length, 261);
  assert.equal(value.calls.filter(call => call.action === 'removed').length, 261);
  assert.equal((await database.client.query('SELECT count(*) AS count FROM "BaseItems" WHERE "Type" = $1', [nativeTextBytes('MediaBrowser.Controller.Playlists.Playlist')])).rows[0].count, 0n);
  assert.ok(largest <= 128, `At most 128 database rows cross into Node; observed ${largest}.`);
});

test('postgres: playlist mount failure propagates after the committed value sweep', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const value = await setupDatabaseCleanup(t, native.results.find(row => row.sample.Name === 'missing file playlist'));
  value.cleaner.assets.stat = async () => { throw Object.assign(new Error('Controlled storage outage'), { code: 'unavailable' }); };
  await assert.rejects(value.operation, { code: 'unavailable' });
  assert.deepEqual(value.progress, [60, 80, 80]);
  assert.equal((await value.database.rows('ItemValues')).some(row => row.Value === 'Orphan'), false);
  assert.equal((await value.database.rows('BaseItems', { where: { Id: nativeGuid(cleanupId(100)) } })).length, 1);
  assert.equal(value.calls.some(row => row.action === 'delete'), false);
});

test('postgres: extracted directory failures warn and preserve ordinary deletion', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const value = await setupDatabaseCleanup(t, native.results.find(row => row.sample.Name === 'dead movie'));
  const location = '/media/dead-0.trickplay';
  const remove = value.adapter.delete.bind(value.adapter);
  value.adapter.delete = async (path, options) => {
    if (path === location) throw Object.assign(new Error('Controlled prune failure'), { code: 'permission-denied' });
    return remove(path, options);
  };
  await value.operation();
  assert.ok(value.logs.some(row => row.level === 'warn' && row.message.includes('Controlled prune failure')));
  assert.equal((await value.database.rows('BaseItems', { where: { Id: nativeGuid(cleanupId(10)) } })).length, 0);
  assert.equal((await value.adapter.stat(location)).kind, 'directory');
  assert.equal((await value.adapter.stat('/media/dead-0.mkv')).kind, 'file');
});

test('postgres: values orphaned by playlist deletion survive until the next maintenance sweep', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const value = await setupDatabaseCleanup(t, native.results.find(row => row.sample.Name === 'missing file playlist'));
  const mapped = (await value.database.rows('ItemValues')).find(row => row.Value === 'Mapped');
  assert.ok(mapped);
  const link = (await value.database.rows('ItemValuesMap', { where: { ItemValueId: mapped.ItemValueId } }))[0];
  assert.ok(link);
  const keys = Object.fromEntries(tableDefinition('ItemValuesMap').primaryKey.map(key => [key, link[key]]));
  assert.equal(await value.database.update('ItemValuesMap', keys, { ItemId: nativeGuid(cleanupId(100)) }), 1n);
  await value.operation();
  assert.deepEqual((await value.database.rows('ItemValues')).map(row => row.ItemValueId), [mapped.ItemValueId]);
  assert.deepEqual(await value.database.rows('ItemValuesMap'), []);
  assert.equal((await value.database.rows('BaseItems', { where: { Id: nativeGuid(cleanupId(100)) } })).length, 0);
  await value.operation();
  assert.deepEqual(await value.database.rows('ItemValues'), []);
  assert.equal(value.calls.filter(call => call.action === 'delete').length, 1);
});
