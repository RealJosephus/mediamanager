import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import schema from '../../src/http/resources/playback-body-schema.json' with { type: 'json' };
import recordedSchema from './fixtures/json-model-binding/schema.json' with { type: 'json' };
import { bindJsonModel } from '../../src/http/json-model-binding.js';
import { bindDeviceProfile, bindPlaybackBody } from '../../src/http/playback-binding.js';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';

const input = JSON.parse(await readFile(new URL('./fixtures/json-model-binding/input.json', import.meta.url), 'utf8'));
// JSON module imports round Int64 values before assertions can inspect them.
const expected = parseLosslessJson(await readFile(new URL('./fixtures/json-model-binding/output.json', import.meta.url), 'utf8'));
const project = value => parseLosslessJson(stringifyNativeJson(value));
const native = new Map(expected.map(entry => [entry.name, entry]));

test('PlaybackInfo model schema matches the actual frozen DLL reflection snapshot', () => {
  assert.deepEqual(schema, recordedSchema);
  assert.equal(input.length, 163);
  assert.equal(expected.length, input.length);
  assert.equal(native.size, input.length);
  for (const entry of input) assert.ok(native.has(entry.name), entry.name);
});

test('PlaybackInfo pure JSON deserialization matches 163 actual DLL values and errors', () => {
  for (const entry of input) {
    const oracle = native.get(entry.name);
    const run = () => bindJsonModel(parseLosslessJson(entry.json), { schema, root: schema.playback, source: entry.json });
    if (oracle.error) {
      assert.throws(run, error => {
        assert.equal(error.nativeException, oracle.error, `${entry.name} exception`);
        assert.equal(error.nativeMessage ?? error.message, oracle.Message, `${entry.name} message`);
        assert.equal(error.path, oracle.Path, `${entry.name} path`);
        assert.equal(error.line, oracle.LineNumber, `${entry.name} line`);
        assert.equal(error.position, oracle.BytePositionInLine, `${entry.name} UTF-8 byte position`);
        return true;
      }, entry.name);
    } else {
      // The CLR oracle serializes with JsonDefaults.Options, which omits nullable
      // object properties but retains Guid.Empty as an explicit serialized null.
      assert.deepEqual(project({ name: entry.name, value: run() }), oracle, entry.name);
    }
  }
});

test('PlaybackInfo body wrappers retain deserialized values and the optional root-null contract', () => {
  for (const entry of input) {
    const oracle = native.get(entry.name);
    if (oracle.error) continue;
    const body = parseLosslessJson(entry.json);
    const actual = bindPlaybackBody(body, entry.json);
    assert.deepEqual(project(actual), oracle.value ?? {}, entry.name);
    if (body?.DeviceProfile !== undefined) {
      const profileSource = JSON.stringify(body.DeviceProfile);
      assert.deepEqual(project(bindDeviceProfile(body.DeviceProfile, profileSource)), oracle.value?.DeviceProfile ?? null, `${entry.name} standalone profile`);
    }
  }
  assert.equal(bindJsonModel(null, { schema, root: schema.playback, source: 'null' }), null);
  assert.deepEqual(bindPlaybackBody(null, 'null'), {});
});
