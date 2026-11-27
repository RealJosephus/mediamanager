import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { portAvailable, unusedPort } from '../helpers/library-exchange-state.js';
import { idKey } from '../../src/library/records.js';
import fixture from './fixtures/boxset-collapse/input.json' with { type: 'json' };
import capture from './fixtures/boxset-collapse/native.json' with { type: 'json' };

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance'];

test('the designated Jellyfin returns the numeric child on both item routes under each grouping configuration', async t => {
  const current = await currentNativeReference();
  const root = await mkdtemp(path.join(tmpdir(), 'boxset-prefix-'));
  const clone = path.join(root, 'instance'), port = await unusedPort(), origin = 'http://127.0.0.1:' + port;
  const headers = { Authorization: 'MediaBrowser Token="' + current.accessToken + '"', 'Content-Type': 'application/json' };
  const request = (url, options = {}) => fetch(origin + url, { headers, signal: AbortSignal.timeout(60000), ...options });
  let native;
  t.after(async () => {
    try {
      if (native) {
        const stopped = await native.stop(async () => (await request('/System/Shutdown', { method: 'POST' })).status, () => portAvailable(port));
        assert.ok(stopped.cleanShutdown && stopped.pidGone && stopped.portAvailable);
      }
    } finally {
      try { await current.finish(); } finally { await rm(root, { recursive: true, force: true }); }
    }
  });
  await cp(current.sourceRoot, clone, { recursive: true });
  await mkdir(path.join(clone, 'log'), { recursive: true });
  await current.prepareClone(clone, port);
  // The collection manager locates its physical folder by the running
  // instance's data path. Rebase the same rows as the PostgreSQL fixture.
  const collectionPath = path.join(clone, 'data', 'data', 'collections');
  await mkdir(collectionPath, { recursive: true });
  const db = new DatabaseSync(path.join(clone, 'data', 'data', 'jellyfin.db'));
  try {
    const historicalRoot = fixture.items.find(item => item.key === 'aggregate').id.toUpperCase();
    const aggregate = db.prepare("SELECT Id FROM BaseItems WHERE Type LIKE '%.AggregateFolder' LIMIT 1").get();
    assert.ok(aggregate);
    db.exec('BEGIN; PRAGMA defer_foreign_keys=ON');
    for (const [table, rows] of [['BaseItems', capture.stages.before.database.baseItems],
      ['AncestorIds', capture.stages.before.database.ancestorIds], ['LinkedChildren', capture.stages.before.database.linkedChildren]]) {
      const keys = Object.keys(rows[0]);
      const insert = db.prepare('INSERT INTO "' + table + '" (' + keys.map(k => '"' + k + '"').join(',') + ') VALUES (' + keys.map(() => '?').join(',') + ')');
      for (const row of rows) insert.run(...keys.map(k => row[k] === historicalRoot ? aggregate.Id : row[k]));
    }
    const updatePath = db.prepare('UPDATE BaseItems SET Path=? WHERE Id=?');
    for (const item of fixture.items.filter(item => item.key === 'collections' || item.type === 'BoxSet')) {
      const filename = item.key === 'collections' ? collectionPath : path.join(collectionPath, item.key);
      assert.equal(updatePath.run(filename, item.id.toUpperCase()).changes, 1);
    }
    db.exec('COMMIT');
  } finally { db.close(); }
  native = current.start({ referenceRoot: clone, outputRoot: root, label: 'boxset-prefix', origin });
  await native.ready();
  const config = await request('/System/Configuration');
  assert.equal(config.status, 200);
  const original = await config.json();
  const movie = idKey(fixture.items.find(item => item.name === '21 Jump Street').id);
  for (const { name, ...options } of fixture.configurations) {
    const set = await request('/System/Configuration', { method: 'POST', body: JSON.stringify({ ...original, ...options }) });
    assert.equal(set.status, 204);
    if (name === 'disabled') {
      const keys = ['nonmanual', 'solo', 'sharedSet'].map(key => idKey(fixture.items.find(item => item.key === key).id));
      const range = '/Items?UserId=' + current.userId + '&Ids=' + keys.join(',') + '&SortBy=SortName&EnableImages=false&EnableUserData=false';
      const unicodeBounds = new URLSearchParams({ NameStartsWithOrGreater: 'İ', NameLessThan: 'ẞ' });
      for (const [filters, ids] of [['', keys], ['&' + unicodeBounds, [keys[1]]]]) {
        const response = await request(range + filters);
        assert.equal(response.status, 200);
        assert.deepEqual((await response.json()).Items.map(item => idKey(item.Id)), ids);
      }
    }
    for (const record of capture.http.records.filter(row => row.configuration === name && row.name === 'memory-name-child')) {
      const route = record.route.replaceAll(fixture.userId, current.userId).replaceAll(idKey(fixture.userId), idKey(current.userId));
      const response = await request(route);
      assert.equal(response.status, 200, route);
      const body = await response.json();
      const expected = options.EnableGroupingMoviesIntoCollections ? [] : [[movie, '0000000021 jump street']];
      assert.deepEqual(body.Items.map(item => [idKey(item.Id), item.SortName]), expected, name + ' ' + record.endpoint);
      assert.deepEqual([body.TotalRecordCount, body.StartIndex], [expected.length, 0]);
    }
  }
});
