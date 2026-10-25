import test from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/user-data-binding/dto-reference.json' with { type: 'json' };
import { runtimeDateFixture } from './runtime-date-fixture.js';
import { bindUserDataDto } from '../../src/http/user-data-binding.js';
import { jsonDateTimeUtcTicks } from '../../src/http/json-date-time.js';
import { formatUtcTicks } from '../../src/syncplay/time.js';
import { nativeDate } from '../../src/sessions/user-data.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { observeComparison } from '../comparison-observations.js';

test('UpdateUserItemDataDto retains native binding and records standard-runtime date differences', t => {
  const dateDifferences = runtimeDateFixture();
  for (const { name, source, expected } of fixture.cases) {
    if (expected.error) {
      assert.throws(() => bindUserDataDto(parseLosslessJson(source), source), error => {
        observeComparison(t, `${name}: binding error`, { name: error.name, message: error.message, stack: error.stack, ...error }, expected);
        assert.equal(error.status, 400, name);
        assert.equal(error.message, expected.Message, name);
        assert.equal(error.path, expected.Path, name);
        assert.equal(error.line, expected.LineNumber, name);
        assert.equal(error.position, expected.BytePositionInLine, name);
        return true;
      }, name);
      continue;
    }
    const value = bindUserDataDto(parseLosslessJson(source), source);
    const actual = value == null ? null : Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      if (typeof entry === 'bigint') return [key, { $integer: String(entry) }];
      if (typeof entry === 'number' && !Number.isFinite(entry)) return [key, { $float: String(entry) }];
      if (entry && key === 'LastPlayedDate') {
        const utc = jsonDateTimeUtcTicks(entry);
        return [key, { ticks: String(entry.ticks), kind: entry.kind, utcTicks: String(utc), stored: nativeDate(formatUtcTicks(utc)) }];
      }
      return [key, Object.is(entry, -0) ? 0 : entry];
    }));
    const difference = dateDifferences.userDataDto[name];
    if (difference) {
      assert.deepEqual(expected.value, difference.reference, `${name}: unchanged native evidence`);
      assert.deepEqual(actual, difference.candidate, `${name}: documented runtime date behavior`);
    } else assert.deepEqual(actual, expected.value, name);
  }
});
