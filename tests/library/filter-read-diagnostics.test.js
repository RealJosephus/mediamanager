import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describeReadDifference, retainReadDiagnosticRows } from './fixtures/filter-http-current/read-diagnostics.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function observation(tables) {
  const snapshot = { tableSummaries: tables.map(table => ({ name: table.name, rowCount: table.rows.length,
    rowsSha256: hash(table.rows), sqlSha256: hash(table.name), columnsSha256: hash(table.primaryKey),
    foreignKeysSha256: hash([]), indexesSha256: hash([]) })), sequences: [], sequencesSha256: hash([]),
  pragmas: { journalMode: 'wal' }, foreignKeyCheck: [], integrityCheck: [{ integrity_check: 'ok' }] };
  return retainReadDiagnosticRows(snapshot, tables);
}

test('read failure diagnostics identify exact table, primary-key and cell fingerprints without publishing secret or unknown SQL values', () => {
  const timestamp = '2026-10-27 14:26:47.1234567', nextTimestamp = '2026-10-27 14:26:48.7654321';
  const before = observation([{ name: 'Devices', primaryKey: ['Id'], rows: [{ Id: 5, DateLastActivity: timestamp,
    AccessToken: 'private-original-token', Data: 'unknown opaque metadata', Blob: { type: 'blob', base64: Buffer.from('private bytes').toString('base64') } }] },
  { name: 'Users', primaryKey: ['Id'], rows: [{ Id: 'private-key', Password: 'unchanged secret' }] }]);
  const after = observation([{ name: 'Devices', primaryKey: ['Id'], rows: [{ Id: 5, DateLastActivity: nextTimestamp,
    AccessToken: 'private-changed-token', Data: 'changed unknown metadata', Blob: { type: 'blob', base64: Buffer.from('different bytes').toString('base64') } }] },
  { name: 'Users', primaryKey: ['Id'], rows: [{ Id: 'private-key', Password: 'unchanged secret' }] }]);
  const original = JSON.stringify(before), result = describeReadDifference(before, after);
  assert.deepEqual(result.tables.map(table => [table.name, table.beforeCount, table.afterCount, table.stable]), [['Devices', 1, 1, false], ['Users', 1, 1, true]]);
  assert.equal(result.changes.length, 1); assert.equal(result.changes[0].changedRows, 1);
  const row = result.changes[0].rows[0]; assert.match(row.keySha256, /^[a-f0-9]{64}$/u);
  const cells = new Map(row.cells.map(cell => [cell.column, cell]));
  assert.equal(cells.get('DateLastActivity').before.value, timestamp); assert.equal(cells.get('DateLastActivity').after.value, nextTimestamp);
  for (const key of ['AccessToken', 'Data', 'Blob']) {
    assert.match(cells.get(key).before.sha256, /^[a-f0-9]{64}$/u); assert.match(cells.get(key).after.sha256, /^[a-f0-9]{64}$/u);
    assert.notEqual(cells.get(key).before.sha256, cells.get(key).after.sha256);
    assert.equal(Object.hasOwn(cells.get(key).before, 'value'), false);
  }
  const text = JSON.stringify(result);
  for (const secret of ['private-original-token', 'private-changed-token', 'unknown opaque metadata', 'changed unknown metadata', 'private bytes', 'different bytes', 'private-key', 'unchanged secret']) assert.equal(text.includes(secret), false);
  assert.equal(result.truncated, false); assert.equal(JSON.stringify(before), original, 'Diagnostics cannot change the complete read gate.');
});

test('diagnostic row and cell budgets retain every table SHA and count when detailed differences exceed their bound', () => {
  const tables = changed => [{ name: 'BaseItems', primaryKey: ['Id'], rows: Array.from({ length: 100 }, (_, index) => ({ Id: index,
    ...Object.fromEntries(Array.from({ length: 20 }, (_, field) => ['Column' + field, (changed ? 'after-secret-' : 'before-secret-') + index])) })) },
  { name: 'UserData', primaryKey: ['Id'], rows: [] }];
  const result = describeReadDifference(observation(tables(false)), observation(tables(true)));
  assert.equal(result.tables.length, 2); assert.equal(result.tables[0].beforeCount, 100); assert.equal(result.tables[0].afterCount, 100);
  assert.equal(result.changes[0].changedRows, 100); assert.equal(result.truncated, true);
  assert.equal(result.retainedRows, result.limits.rows); assert.equal(result.retainedCells, result.limits.cells);
  assert.ok(result.changes.flatMap(table => table.rows).length <= 64);
  assert.ok(result.changes.flatMap(table => table.rows).flatMap(row => row.cells).length <= 256);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});
