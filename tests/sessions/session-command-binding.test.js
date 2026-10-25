import test from 'node:test';
import assert from 'node:assert/strict';

import fixture from './fixtures/session-command-binding.json' with { type: 'json' };
import { parseLosslessJson } from '../../src/core/json.js';
import { bindGeneralCommandDto, bindMessageCommandDto } from '../../src/http/session-command-binding.js';
import { observeComparison } from '../comparison-observations.js';

function projection(value, { dictionary = false } = {}) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Map) return Object.fromEntries([...value].map(([key, entry]) => [key, projection(entry, { dictionary: true })]));
  if (Array.isArray(value)) return value.map(entry => projection(entry));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => dictionary || entry !== null)
    .map(([key, entry]) => [key[0].toLowerCase() + key.slice(1), projection(entry)]));
}

for (const [kind, bind] of [['general', bindGeneralCommandDto], ['message', bindMessageCommandDto]]) {
  test(`${kind} session command JSON binding matches the frozen DLL/MVC recording`, t => {
    for (const entry of fixture[kind]) {
      const body = parseLosslessJson(entry.json);
      if (entry.error) {
        assert.throws(() => bind(body, entry.json), error => {
          observeComparison(t, `${kind}/${entry.name}: binding error`, { name: error.name, message: error.message, stack: error.stack, ...error }, entry.error);
          assert.equal(error.status, 400, entry.name);
          if (entry.error.path !== undefined) {
            assert.equal(error.path, entry.error.path, entry.name);
            assert.equal(error.line, entry.error.line, entry.name);
            assert.equal(error.position, entry.error.position, entry.name);
          }
          return true;
        });
      } else assert.deepEqual(projection(bind(body, entry.json)), entry.value, entry.name);
    }
  });
}
