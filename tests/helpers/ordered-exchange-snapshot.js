import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { nativeInsertionOrderedTables, scanNativeRelationRows } from '../../src/database/native-relation-order.js';
import { tableDefinition } from '../../src/database/model.js';
import { canonicalCell } from '../../src/database/values.js';
import { wireDate } from '../../src/users/native.js';
import { completeSnapshot } from './library-exchange-state.js';

/** All native values and every externally consumed insertion sequence, in bounded reads. */
export async function orderedExchangeSnapshot(database, { signal, rowTransform, insertionRowTransform = rowTransform } = {}) {
  if (insertionRowTransform !== undefined && typeof insertionRowTransform !== 'function') {
    throw new TypeError('insertionRowTransform must be a function');
  }
  const snapshot = await completeSnapshot(database, { signal, rowTransform }), insertionOrder = {};
  for (const name of nativeInsertionOrderedTables) {
    if (insertionRowTransform === rowTransform) {
      // databaseDigest already hashes these tables in their native insertion
      // order, including every cell. Reuse this scan at the same boundary.
      const { rows, sha256 } = snapshot.tables.find(table => table.name === name);
      insertionOrder[name] = { rows, sha256 };
      continue;
    }
    const columns = tableDefinition(name).columns;
    const hash = createHash('sha256');
    let after, rows = 0;
    for (;;) {
      signal?.throwIfAborted();
      const page = await scanNativeRelationRows(database, name, { after, limit: 128, consumer: 'exchange' });
      assert.ok(page.rows.length <= 128);
      for (const original of page.rows) {
        const row = insertionRowTransform ? insertionRowTransform(name, original) : original;
        hash.update(JSON.stringify(columns.map(column => canonicalCell(row[column.name]))) + '\n');
        rows++;
      }
      if (page.rows.length < 128) break;
      assert.notEqual(page.after, after);
      after = page.after;
    }
    insertionOrder[name] = { rows, sha256: hash.digest('hex') };
  }
  signal?.throwIfAborted();
  return { ...snapshot, insertionOrder };
}

export async function observeAuthenticatedExchangeRead(database, token, { signal } = {}) {
  const readDevice = async () => {
    const [device] = await database.rows('Devices', { where: { AccessToken: token }, columns: ['Id', 'DateLastActivity'],
      limit: 1, consumer: 'exchange' });
    assert.ok(device, 'The authenticated reader must have a fixture device.');
    return device;
  };
  const { Id: deviceId, DateLastActivity: before } = await readDevice();
  const started = Date.now();
  return async expected => {
    const { Id: observedId, DateLastActivity: after } = await readDevice();
    assert.equal(observedId, deviceId);
    if (after.equals(before)) {
      const snapshot = await orderedExchangeSnapshot(database, { signal });
      assert.deepEqual(snapshot, expected);
      return { snapshot, activity: null };
    }
    // Authentication can refresh this device's activity during a cold read.
    const refreshedAt = Date.parse(wireDate(after.string()));
    assert.ok(refreshedAt >= started && refreshedAt <= Date.now());
    assert.ok(refreshedAt - Date.parse(wireDate(before.string())) > 180000);
    const unchanged = await orderedExchangeSnapshot(database, { signal, rowTransform: (table, row) => table === 'Devices' && row.Id === deviceId
      ? { ...row, DateLastActivity: before } : row });
    assert.deepEqual(unchanged, expected);
    return { snapshot: await orderedExchangeSnapshot(database, { signal }), activity: { before: before.string(), after: after.string() } };
  };
}
