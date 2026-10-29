import assert from 'node:assert/strict';
import test from 'node:test';
import { stableRows } from '../helpers/stable-rows.js';

test('fresh snapshot sorting preserves full rows and leaves the source order intact', () => {
  const row = value => ({ value, Data: '{"traceId":"opaque","Path":"Z:\\\\媒体\\\\file.mkv","unknown":null}',
    ticks: 9007199254740993n, optional: undefined, metadata: { names: ['é', 'e\u0301', '\u0000'] } });
  const apple = row('apple'), mango = row('mango'), zebra = row('zebra');
  const rows = [zebra, apple, mango];
  const result = stableRows(rows);
  assert.deepEqual(result, [apple, mango, zebra]);
  assert.deepEqual(rows, [zebra, apple, mango]);
  assert.notEqual(result, rows);
  for (const [index, original] of [apple, mango, zebra].entries()) assert.equal(result[index], original);
  assert.equal(result[0].ticks, 9007199254740993n);
  assert.equal(Object.hasOwn(result[0], 'optional'), true);
  assert.equal(result[0].optional, undefined);
  assert.equal(result[0].metadata, apple.metadata);
});

test('equal snapshot sort keys retain duplicate, BigInt and undefined row occurrences', () => {
  const bigint = { value: 10n, optional: undefined };
  const string = { value: '10' };
  const anotherBigint = { value: 10n };
  const rows = [bigint, string, anotherBigint, bigint];
  const result = stableRows(rows);
  assert.equal(result.length, rows.length);
  for (const [index, original] of rows.entries()) assert.equal(result[index], original);
  assert.equal(typeof result[0].value, 'bigint');
  assert.equal(typeof result[1].value, 'string');
});
