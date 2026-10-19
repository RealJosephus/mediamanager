import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeDateFromUnixNanoseconds } from '../../src/users/native.js';

test('filesystem timestamps preserve native 100ns database precision', () => {
  assert.equal(nativeDateFromUnixNanoseconds(1_790_419_820_783_667_600n), '2026-09-26 10:50:20.7836676');
  assert.equal(nativeDateFromUnixNanoseconds(1_000_000_000n), '1970-01-01 00:00:01');
  assert.equal(nativeDateFromUnixNanoseconds(1_000_100_000n), '1970-01-01 00:00:01.0001');
  assert.equal(nativeDateFromUnixNanoseconds(-100n), '1969-12-31 23:59:59.9999999');
  assert.throws(() => nativeDateFromUnixNanoseconds(1000), TypeError);
});
