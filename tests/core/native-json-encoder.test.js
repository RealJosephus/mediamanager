import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringifyNativeJson, parseLosslessJson } from '../../src/core/json.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { deserializeNativeItemData, serializeNativeItemData } from '../../src/library/native-item-data.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { assertProjectedEqual } from '../comparison-observations.js';

const root = new URL('./fixtures/native-json-encoder/', import.meta.url);
const inputBytes = await readFile(new URL('input.json', root));
const input = JSON.parse(inputBytes);
const profiles = ['Default', 'PascalCase', 'CamelCase'];
const videoType = 'MediaBrowser.Controller.Entities.Video';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const scalar = source => source.match(/"Container":("(?:\\.|[^"\\])*")/u)?.[1];
let recording;
async function recordCurrent() {
  const output = path.resolve(validationOutputRoot());
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(path.join(output, 'native-json-current-'));
  const cases = input.map(sample => {
    const text = String.fromCharCode(...sample.codeUnits);
    const item = newNativeItemEntity(videoType);
    item.Container = text;
    return { name: sample.name, data: serializeNativeItemData(item), bodies: profiles.map(profile => ({ profile,
      body: stringifyNativeJson({ UserId: text, Missing: null, Values: [text, null],
        Dictionary: new Map([[text, text], ['Null', null]]), Ticks: 9223372036854775807n }, { camel: profile === 'CamelCase' }) })) };
  });
  const nodeBytes = Buffer.from(JSON.stringify({ cases }, null, 2) + '\n');
  const nodeFile = path.join(directory, 'node.json');
  await writeFile(nodeFile, nodeBytes, { flag: 'wx' });
  const nativeRoot = path.join(directory, 'native');
  await recordOracle({ project: 'tests/core/fixtures/native-json-encoder/current/Oracle.csproj', output: nativeRoot,
    args: [fileURLToPath(new URL('input.json', root)), nodeFile, '{output}/native.json'] });
  const native = JSON.parse(await readFile(path.join(nativeRoot, 'native.json')));
  return { cases, nodeBytes, native };
}
const current = () => recording ??= recordCurrent();

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const enabled = { skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 240000 };

test('current Native JSON producer and reader consume the full neutral corpus and exact Node input', enabled, async () => {
  const { nodeBytes, native } = await current();
  assert.equal(native.inputSha256, hash(inputBytes));
  assert.equal(native.nodeInputSha256, hash(nodeBytes));
  assert.equal(input.length, 6);
  assert.deepEqual(native.results.map(({ name, profile }) => ({ name, profile })),
    input.flatMap(sample => profiles.map(profile => ({ name: sample.name, profile }))));
  assert.deepEqual(native.items.map(item => item.name), input.map(sample => sample.name));
});

for (const sample of input) for (const profile of profiles) {
  test(`current Native public JSON values and Node body readback: ${sample.name}/${profile}`, enabled, async t => {
    const { cases, native } = await current();
    const source = cases.find(value => value.name === sample.name).bodies.find(value => value.profile === profile);
    const actual = native.results.find(value => value.name === sample.name && value.profile === profile);
    assert.ok(actual);
    assertProjectedEqual(t, 'Public JSON values', source.body, actual.body, parseLosslessJson);
    assertProjectedEqual(t, 'Native reader of Node public JSON', actual.nodeReadBody, actual.body, parseLosslessJson);
    const key = profile === 'CamelCase' ? 'ticks' : 'Ticks';
    assert.equal(parseLosslessJson(source.body)[key], 9223372036854775807n);
    assert.equal(parseLosslessJson(actual.nodeReadBody)[key], 9223372036854775807n);
  });
}

for (const sample of input) {
  test(`current Native item Data string bytes and bidirectional typed readback: ${sample.name}`, enabled, async () => {
    const { cases, native } = await current();
    const source = cases.find(value => value.name === sample.name);
    const actual = native.items.find(value => value.name === sample.name);
    assert.ok(actual);
    assert.equal(typeof actual.data, 'string');
    assert.equal(typeof scalar(actual.data), 'string');
    assert.equal(scalar(source.data), scalar(actual.data), 'Persisted Container token retains exact bytes');
    assert.equal(deserializeNativeItemData(videoType, actual.data).Container, actual.nativeReadContainer,
      'Node reads Native item Data');
    assert.equal(actual.nodeReadContainer, actual.nativeReadContainer, 'Native reads Node item Data');
  });
}
