import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { formatInvariantDate, parseInvariantDateExact } from '../../src/core/invariant-date-format.js';
import { observeComparison } from '../comparison-observations.js';
const oracle = JSON.parse(await readFile(new URL('./fixtures/nfo-date-format-oracle.json', import.meta.url), 'utf8'));
const edgeOracle = JSON.parse(await readFile(new URL('./fixtures/nfo-date-format-edge-oracle.json', import.meta.url), 'utf8'));
const referenceToday = new Date('2026-09-26T00:00:00Z');
const normalize = value => value?.replace('.0000000Z', '.000Z');
const rejectsFormat = (t, run, expected) => assert.throws(run, error => {
  assert.ok(error instanceof Error); assert.ok(error.message);
  observeComparison(t, 'NFO date format error', { name: error.name, message: error.message }, { name: expected });
  return true;
});

for (const expected of oracle) test(`invariant NFO date format ${JSON.stringify(expected.format)} for ${expected.source}`, t => {
  if (expected.error) { rejectsFormat(t, () => formatInvariantDate(expected.source, expected.format), expected.error); return; }
  assert.equal(formatInvariantDate(expected.source, expected.format), expected.text);
  const actual = parseInvariantDateExact(expected.text, expected.format, { now: () => referenceToday });
  assert.equal(actual != null, expected.accepted);
  assert.equal(actual, normalize(expected.parsed) ?? null);
});

for (const expected of edgeOracle.formatResults) test(`invariant NFO date edge format ${JSON.stringify(expected.format)} for ${expected.source}`, t => {
  if (expected.formatError) {
    rejectsFormat(t, () => formatInvariantDate(expected.source, expected.format), expected.formatError);
    return;
  }
  assert.equal(formatInvariantDate(expected.source, expected.format), expected.text);
  if (expected.parseError) {
    rejectsFormat(t, () => parseInvariantDateExact(expected.text, expected.format, { now: () => referenceToday }), expected.parseError);
    return;
  }
  assert.equal(parseInvariantDateExact(expected.text, expected.format, { now: () => referenceToday }), normalize(expected.parsed) ?? null);
});

for (const expected of edgeOracle.parseResults) test(`invariant NFO date edge parse ${expected.name}`, t => {
  if (expected.error) {
    rejectsFormat(t, () => parseInvariantDateExact(expected.value, expected.format, { now: () => referenceToday }), expected.error);
    return;
  }
  assert.equal(parseInvariantDateExact(expected.value, expected.format, { now: () => referenceToday }), normalize(expected.parsed) ?? null);
});

test('invariant NFO date formatter rejects values outside the DateTime and offset domains', () => {
  for (const value of ['0000-01-01', '2024-02-29T24:00:00Z', '2024-02-29T23:60:00Z', '2024-02-29T23:59:60Z', '2024-02-29T00:00:00+14:01']) {
    assert.throws(() => formatInvariantDate(value, 'O'), RangeError);
  }
});

test('invariant NFO date parser rejects impossible fields, mismatched weekdays and extra input', () => {
  for (const value of ['2023-02-29', '2024-13-01', '2024-01-32', '2024-01-01 trailing']) assert.equal(parseInvariantDateExact(value, 'yyyy-MM-dd'), null);
  assert.equal(parseInvariantDateExact('Fri, 29 Feb 2024', 'ddd, dd MMM yyyy'), null);
});
