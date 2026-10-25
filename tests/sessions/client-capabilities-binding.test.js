import test from 'node:test';
import assert from 'node:assert/strict';

import fixture from './fixtures/client-capabilities-binding.json' with { type: 'json' };
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';
import { bindClientCapabilitiesDto } from '../../src/http/client-capabilities-binding.js';
import { observeComparison } from '../comparison-observations.js';

test('ClientCapabilitiesDto JSON binding matches the frozen Jellyfin DLL', t => {
  for (const entry of fixture) {
    const body = parseLosslessJson(entry.json);
    Object.defineProperty(body, Symbol.for('mediamanager.jsonSource'), { value: entry.json });
    if (entry.error) {
      assert.throws(() => bindClientCapabilitiesDto(body), error => {
        observeComparison(t, entry.name + ' binding failure', { name: error.name, message: error.message, status: error.status, stack: error.stack }, entry.error);
        assert.equal(error.status, 400, entry.name);
        assert.equal(error.path, entry.error.path, entry.name);
        assert.equal(error.line, entry.error.line, entry.name);
        assert.equal(error.position, entry.error.position, entry.name);
        return true;
      });
    } else {
      const actual = parseLosslessJson(stringifyNativeJson(bindClientCapabilitiesDto(body), { camel: true }));
      assert.deepEqual(actual, entry.value, entry.name);
    }
  }
});
