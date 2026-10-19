import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseLosslessJson } from '../../src/core/json.js';
import { deserializeNativeItemData, NativeItemJsonError, serializeNativeItemData } from '../../src/library/native-item-data.js';
import { cloneNativeItemEntity, hydrateNativeItemEntity,
  nativeItemJsonDateState } from '../../src/library/native-item-entity.js';
import { dateText, dateTicks, mapRecord } from '../../src/library/records.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'native-item-json-boundaries');
const read = name => fs.readFileSync(path.join(fixture, name));
const input = JSON.parse(read('input.json'));
const native = parseLosslessJson(read('native.json').toString('utf8'));
const inputR2 = JSON.parse(read('input-r2.json'));
const nativeR2 = parseLosslessJson(read('native-r2.json').toString('utf8'));
const inputR3 = JSON.parse(read('input-r3.json'));
const nativeR3 = parseLosslessJson(read('native-r3.json').toString('utf8'));
const inputR4 = JSON.parse(read('input-r4.json'));
const nativeR4 = parseLosslessJson(read('native-r4.json').toString('utf8'));
const provenance = JSON.parse(read('provenance.json'));
const videoType = 'MediaBrowser.Controller.Entities.Video';
const photoType = 'MediaBrowser.Controller.Entities.Photo';
const kinds = Object.freeze({
  date: Object.freeze({ nativeType: videoType, property: 'DateLastSaved' }),
  enum: Object.freeze({ nativeType: videoType, property: 'VideoType' }),
  int: Object.freeze({ nativeType: videoType, property: 'Width' }),
  long: Object.freeze({ nativeType: videoType, property: 'Size' }),
  double: Object.freeze({ nativeType: photoType, property: 'ExposureTime' }),
});
const videoTypes = ['VideoFile', 'Iso', 'Dvd', 'BluRay'];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function scalarToken(text, property) {
  const marker = JSON.stringify(property) + ':';
  const start = text.indexOf(marker);
  assert.notEqual(start, -1, property);
  let index = start + marker.length;
  if (text[index] === '"') {
    for (index++; index < text.length; index++) {
      if (text[index] === '\\') index++;
      else if (text[index] === '"') return text.slice(start + marker.length, index + 1);
    }
  }
  const end = text.slice(index).search(/[,}]/u);
  assert.notEqual(end, -1, property);
  return text.slice(start + marker.length, index + end);
}

function dateOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);
  return sign + String(Math.floor(absolute / 60)).padStart(2, '0') + ':' + String(absolute % 60).padStart(2, '0');
}

function utcMilliseconds(year, month, day, hour, minute, second, millisecond) {
  const value = new Date(0);
  value.setUTCFullYear(year, month - 1, day);
  value.setUTCHours(hour, minute, second, millisecond);
  return value.getTime();
}

function projectDate(item, property) {
  const canonical = dateText(item[property]);
  const state = nativeItemJsonDateState(item, property);
  assert.ok(state, property);
  const wall = canonical.slice(0, 19), fraction = canonical.slice(20, 27);
  const text = wall + '.' + fraction + (state.kind === 'Utc' ? 'Z' : state.kind === 'Local' ? dateOffset(state.offsetMinutes) : '');
  const [year, month, day, hour, minute, second] = wall.match(/\d+/gu).map(Number);
  let instant;
  if (state.kind === 'Unspecified') {
    const local = new Date(0);
    local.setFullYear(year, month - 1, day);
    local.setHours(hour, minute, second, Number(fraction.slice(0, 3)));
    instant = local.getTime();
  } else {
    const offset = state.kind === 'Local' ? state.offsetMinutes : 0;
    instant = utcMilliseconds(year, month, day, hour, minute, second, Number(fraction.slice(0, 3))) - offset * 60000;
  }
  const utcText = new Date(instant).toISOString().slice(0, 19) + '.' + fraction + 'Z';
  return { text, kind: state.kind, ticks: dateTicks(canonical), utcText };
}

function projectValue(item, descriptor, serialized) {
  const value = item[descriptor.property];
  if (descriptor.property === 'DateLastSaved') return projectDate(item, descriptor.property);
  if (descriptor.property === 'VideoType') {
    const numeric = typeof value === 'number' ? value : videoTypes.indexOf(value);
    return { text: String(value), numeric, defined: numeric >= 0 && videoTypes[numeric] != null };
  }
  if (descriptor.property === 'Width' || descriptor.property === 'Size') return { value };
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeDoubleBE(value);
  return { text: scalarToken(serialized, descriptor.property), bits: bytes.readBigInt64BE(),
    negativeZero: Object.is(value, -0) };
}

function nativeExceptionKind(entry) {
  if (entry.Error == null) return null;
  return entry.Error.type === 'System.Text.Json.JsonException' ? 'json-fallback' : 'non-json-throw';
}

function candidateOutcome(source) {
  const descriptor = kinds[source.kind];
  let error = null;
  // The native generic probe uses Value for every occurrence, including
  // duplicates; map all of them to the declared entity property unchanged.
  const valueJson = source.valueJson.replaceAll('"Value":', JSON.stringify(descriptor.property) + ':');
  const item = deserializeNativeItemData(descriptor.nativeType,
    `{${JSON.stringify(descriptor.property)}:${valueJson}}`, { onJsonError: event => { error = event.error; } });
  if (error) {
    assert.ok(error instanceof NativeItemJsonError, source.id);
    return { exceptionKind: 'json-fallback', reserialized: null, item: null, serialized: null };
  }
  const serialized = serializeNativeItemData(item);
  return { exceptionKind: null,
    reserialized: `{"Value":${scalarToken(serialized, descriptor.property)}}`, item, serialized };
}

function assertEvidenceSet(sourceInput, sourceNative, label) {
  assert.equal(sourceNative.caseCount, sourceInput.cases.length, label);
  assert.equal(sourceNative.cases.length, sourceInput.cases.length, label);
  assert.deepEqual(sourceNative.cases.map(value => [value.Id, value.Kind, value.ValueJson]),
    sourceInput.cases.map(value => [value.id, value.kind, value.valueJson]), label);
  for (const [index, source] of sourceInput.cases.entries()) {
    const expected = sourceNative.cases[index];
    const actual = candidateOutcome(source);
    assert.equal(actual.exceptionKind, nativeExceptionKind(expected), source.id + ' exception kind');
    assert.equal(actual.reserialized, expected.Reserialized, source.id + ' reserialized bytes');
    if (actual.item) assert.deepEqual(projectValue(actual.item, kinds[source.kind], actual.serialized), expected.Value, source.id);
  }
}

test('JsonDefaults boundary fixture retains the exact independent source evidence bytes', () => {
  assert.equal(input.cases.length, 23);
  assert.equal(native.caseCount, 23);
  assert.equal(native.cases.length, 23);
  assert.equal(native.timezone, 'Taipei Standard Time');
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, 'Asia/Taipei');
  for (const entry of provenance.fixtureFiles) {
    const bytes = read(path.basename(entry.path));
    assert.equal(bytes.length, entry.bytes, entry.path);
    assert.equal(sha256(bytes), entry.sha256, entry.path);
  }
  assert.deepEqual(native.cases.map(value => [value.Id, value.Kind, value.ValueJson]),
    input.cases.map(value => [value.id, value.kind, value.valueJson]));
  assert.equal(inputR2.cases.length, 34);
  assert.equal(inputR3.cases.length, 1);
  assert.equal(inputR4.cases.length, 9);
  assert.equal(nativeR2.caseCount, 34);
  assert.equal(nativeR3.caseCount, 1);
  assert.equal(nativeR4.caseCount, 9);
});

test('all pinned JsonDefaults boundary cases match fallback kind, semantic value and exact reserialized bytes', () => {
  assertEvidenceSet(input, native, 'base');
  assertEvidenceSet(inputR2, nativeR2, 'r2');
  assertEvidenceSet(inputR3, nativeR3, 'r3');
  assertEvidenceSet(inputR4, nativeR4, 'r4');
});

test('DateTime Kind and repository frames survive copies while DB overlays and doubles retain native behavior', () => {
  const dates = [
    ['2025-01-01T00:00:00.123', '2025-01-01T00:00:00.123'],
    ['2025-01-01T00:00:00.123+08:00', '2025-01-01T00:00:00.123+08:00'],
    ['2025-01-01T00:00:00.123+02:00', '2025-01-01T06:00:00.123+08:00'],
    ['2025-01-01T00:00:00.123-05:00', '2025-01-01T13:00:00.123+08:00'],
    ['2025-01-01T00:00:00.123Z', '2025-01-01T00:00:00.123Z'],
  ];
  for (const [source, expected] of dates) {
    const item = deserializeNativeItemData(videoType, JSON.stringify({ DateLastSaved: source }));
    const copy = cloneNativeItemEntity(item);
    assert.equal(JSON.parse(serializeNativeItemData(item)).DateLastSaved, expected, source);
    assert.equal(JSON.parse(serializeNativeItemData(copy)).DateLastSaved, expected, source + ' clone');
  }
  const row = { Type: videoType, Id: 'a1000000-0000-0000-0000-000000000001',
    Data: '{"DateLastSaved":"2025-01-01T00:00:00.123"}', DateLastSaved: '2026-02-03T04:05:06.1230000Z' };
  const mapped = mapRecord(row);
  assert.equal(nativeItemJsonDateState(mapped, 'DateLastSaved'), null);
  assert.equal(JSON.parse(serializeNativeItemData(mapped)).DateLastSaved, '2026-02-03T04:05:06.123Z');

  const stored = { NativeType: videoType }, frame = Object.freeze({ Id: row.Id, DateLastSaved: row.DateLastSaved });
  Object.defineProperty(stored, 'NativeRepositoryColumns', {
    value: frame, enumerable: false, writable: false, configurable: true
  });
  const hydrated = hydrateNativeItemEntity(stored);
  const property = Object.getOwnPropertyDescriptor(hydrated, 'NativeRepositoryColumns');
  assert.equal(property.value, frame);
  assert.deepEqual([property.enumerable, property.writable, property.configurable], [false, false, true]);
  assert.equal(Object.isFrozen(property.value), true);

  for (const [source, expected] of [['1e-4', '0.0001'], ['1e-5', '1E-05'], ['1e-6', '1E-06'],
    ['1e16', '10000000000000000'], ['1e17', '1E+17'], ['1.23456789e17', '1.23456789E+17']]) {
    const item = deserializeNativeItemData(photoType, `{"ExposureTime":${source}}`);
    assert.equal(scalarToken(serializeNativeItemData(item), 'ExposureTime'), expected, source);
  }
});

test('JsonDefaults boundary candidate verification gate is promoted only after the controlled comparison', () => {
  assert.equal(provenance.candidateVerified, true);
  assert.ok(provenance.candidateComparison);
  assert.equal(provenance.r4CandidateVerified, true);
  assert.ok(provenance.r4CandidateComparison);
});
