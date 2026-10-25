import test from 'node:test';
import assert from 'node:assert/strict';
import { bindSyncPlayDto } from '../../src/http/syncplay-binding.js';
import { parseJsonDateTime } from '../../src/http/json-date-time.js';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';
import { formatUtcTicks } from '../../src/syncplay/time.js';
import { runtimeDateFixture, syncplayBindingFixture } from './runtime-date-fixture.js';
import { observeComparison } from '../comparison-observations.js';

const dateDifferences = runtimeDateFixture();
const cases = syncplayBindingFixture();
for (const { input, result } of cases) test(`SyncPlay ${dateDifferences.syncplay[input.source] ? 'runtime date difference' : 'native ' + input.kind + ' binding'}: ${input.name ?? ''} ${input.source}`, t => {
  const body = parseLosslessJson(input.source);
  if (input.kind === 'date') {
    if (result.error) assert.throws(() => parseJsonDateTime(body), error => {
      observeComparison(t, 'date rejection', { name: error.name, message: error.message, stack: error.stack, ...error }, result);
      return true;
    });
    else {
      const actual = parseJsonDateTime(body);
      const difference = dateDifferences.syncplay[input.source];
      if (difference) {
        assert.deepEqual({ ticks: result.ticks, kind: result.kind }, difference.reference);
        assert.deepEqual({ ticks: String(actual.ticks), kind: actual.kind }, difference.candidate);
      } else assert.equal(actual.ticks.toString(), result.ticks);
      assert.equal(actual.kind, result.kind);
      if (actual.kind === 'Utc') assert.equal(JSON.stringify(formatUtcTicks(actual.ticks)), result.wire);
    }
  } else {
    if (result.error) {
      assert.throws(() => bindSyncPlayDto(input.name, body, input.source), error => {
        observeComparison(t, 'binding error', { name: error.name, message: error.message, stack: error.stack, ...error }, result);
        assert.equal(error.status, 400);
        assert.equal(error.message, result.Message); assert.equal(error.path, result.Path);
        assert.equal(error.line, result.LineNumber); assert.equal(error.position, result.BytePositionInLine);
        return true;
      });
    } else {
      const actual = bindSyncPlayDto(input.name, body, input.source);
      for (const [field, date] of Object.entries(result.dates ?? {})) {
        assert.equal(actual[field].ticks.toString(), date.ticks); assert.equal(actual[field].kind, date.kind);
        actual[field] = result.value[field];
      }
      assert.deepEqual(parseLosslessJson(stringifyNativeJson(actual)), result.value ?? null);
    }
  }
});
