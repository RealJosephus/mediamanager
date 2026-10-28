import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { nativeInsertionOrderedTables, scanNativeRelationRows } from '../../src/database/native-relation-order.js';
import { tableDefinition } from '../../src/database/model.js';
import { canonicalCell } from '../../src/database/values.js';
import { completeSnapshot } from './library-exchange-state.js';

/** All native values and every externally consumed insertion sequence, in bounded reads. */
export async function orderedExchangeSnapshot(database, { signal, rowTransform, insertionRowTransform = rowTransform } = {}) {
  if (insertionRowTransform !== undefined && typeof insertionRowTransform !== 'function') {
    throw new TypeError('insertionRowTransform must be a function');
  }
  const snapshot = await completeSnapshot(database, { signal, rowTransform }), insertionOrder = {};
  for (const name of nativeInsertionOrderedTables) {
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
