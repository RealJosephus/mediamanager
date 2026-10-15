import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringifyNativeJson, parseLosslessJson } from '../../src/core/json.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { serializeNativeItemData } from '../../src/library/native-item-data.js';
import { assertProjectedEqual } from '../comparison-observations.js';

const root = new URL('./fixtures/native-json-encoder/', import.meta.url);
const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(async name => JSON.parse(await readFile(new URL(name, root), 'utf8'))));
test('native JSON encoder seals neutral UTF-16 inputs and independent exact-body captures', async () => {
  const sha = value => createHash('sha256').update(value).digest('hex');
  for (const file of Object.values(provenance.files)) assert.equal(sha(await readFile(path.resolve(fileURLToPath(root), file.filename))), file.sha256, file.filename);
  const first = await readFile(provenance.files.rawRecording.filename), repeat = await readFile(provenance.repeat.filename);
  assert.deepEqual(first, repeat); assert.equal(sha(repeat), provenance.repeat.sha256);
  assert.deepEqual(JSON.parse(first), native);
  assert.equal(native.actualFrozenJsonDefaultsEncoder, true); assert.equal(native.results.length, 18);
  assert.equal(native.inputSha256, provenance.files['input.json'].sha256);
  for (const descriptor of [provenance.jellyfin.assembly, provenance.runtime.dotnet, provenance.runtime.oracleAssembly])
    assert.equal(sha(await readFile(descriptor.filename)), descriptor.sha256, descriptor.filename);
  assert.equal(provenance.candidateVerified, false);
});
for (const recorded of native.results) test(`native JSON values: ${recorded.name}/${recorded.profile}`, t => {
  const sample = input.find(sample => sample.name === recorded.name), text = String.fromCharCode(...sample.codeUnits);
  const body = stringifyNativeJson({ UserId: text, Missing: null, Values: [text, null],
    Dictionary: new Map([[text, text], ['Null', null]]), Ticks: 9223372036854775807n }, { camel: recorded.profile === 'CamelCase' });
  assertProjectedEqual(t, 'HTTP/WS JSON', body, recorded.body, parseLosslessJson);
  assert.equal(parseLosslessJson(body)[recorded.profile === 'CamelCase' ? 'ticks' : 'Ticks'], 9223372036854775807n);
  // Typed entity Data uses the same native string encoder, but not the HTTP
  // null/naming rules. Compare its scalar token with the actual native token.
  const item = newNativeItemEntity('MediaBrowser.Controller.Entities.Video'); item.Container = text;
  const scalar = source => source.match(/"(?:UserId|userId|Container)":("(?:\\.|[^"\\])*")/)[1];
  assert.equal(scalar(serializeNativeItemData(item)), scalar(recorded.body));
});
