import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parsePasswordHash, verifyPasswordHash } from '../../src/core/password.js';
import { stringifyNativeJson, parseLosslessJson, withNativeFloats } from '../../src/core/json.js';
import { ScheduledTaskFileStore } from '../../src/tasks/scheduled-task-store.js';
import { ServerConfigurationStore, replaceContentTypes } from '../../src/core/server-configuration-store.js';
import { parsePlaylist } from '../../src/metadata/playlist-items.js';
import { consumerFixture } from './fixture.js';
import { assertProjectedEqual, observeComparison } from '../comparison-observations.js';

const { input, native } = await consumerFixture('readers');

test('real native password verifier accepts candidate CSPRNG and contained-zero salts in both directions', async () => {
  assert.equal(native.passwordResults.length, input.passwords.length);
  for (const result of native.passwordResults) {
    const sample = input.passwords.find(sample => sample.name === result.name);
    assert.equal(result.canonical, sample.hash); assert.equal(result.hashLength, 64);
    assert.equal(result.verified, true); assert.equal(result.changedPassword, false);
    assert.equal(await verifyPasswordHash(parsePasswordHash(result.canonical), sample.password), true);
  }
  assert.ok(parsePasswordHash(native.nativeZeroHash).salt.includes(0));
  assert.equal(await verifyPasswordHash(parsePasswordHash(native.nativeZeroHash), native.nativeZeroPassword), true);
  assert.equal(await verifyPasswordHash(parsePasswordHash(native.nativeZeroHash), native.nativeZeroPassword + 'x'), false);
});

test('public JSON preserves native Single, Double negative zero, Int64, null, surrogate and date precision semantics', t => {
  const value = withNativeFloats({ Value: 1.00000006, NegativeZero: -0, NegativeDoubleZero: -0,
    MinTicks: -(2n ** 63n), MaxTicks: 2n ** 63n - 1n, Date: '2026-10-11T01:02:03.1234567Z', Missing: null,
    Dictionary: new Map([['Null', null], ['Tmdb', '123']]), Values: [null, '\uD800'], InvalidKey: new Map([['\uD800', '\uD800']]) }, ['Value', 'NegativeZero']);
  const actual = stringifyNativeJson(value);
  assertProjectedEqual(t, 'typed public JSON boundary', actual, native.jsonBoundary, parseLosslessJson);
  const parsed = parseLosslessJson(actual);
  assert.ok(Object.is(parsed.NegativeZero, -0)); assert.ok(Object.is(parsed.NegativeDoubleZero, -0));
  assert.equal(parsed.Date, value.Date);
  for (const [index, number] of [NaN, Infinity, -Infinity].entries()) {
    assert.equal(native.nonFinite[index].rejected, true);
    for (const payload of [number, [number], new Map([['value', number]]), { Value: number }, withNativeFloats({ Value: number }, ['Value'])])
      assert.throws(() => stringifyNativeJson(payload), TypeError);
    observeComparison(t, 'non-finite rejection', 'TypeError', native.nonFinite[index]);
  }
  assert.throws(() => stringifyNativeJson({ Date: new Date(value.Date) }), /precision/u);
});

test('actual task DTO read/write retains integer tokens, enum, dates and imported history text', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'consumer-tasks-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ScheduledTaskFileStore({ taskId: '97230000000000000000000000000001', programDataPath: path.join(directory, 'data'), configurationDirectoryPath: path.join(directory, 'config') });
  t.after(() => store.close());
  for (const expected of native.tasks) {
    const sample = input.tasks.find(sample => sample.name === expected.name);
    assertProjectedEqual(t, sample.name + ' native reads candidate file', sample.text, expected.text, parseLosslessJson);
    if (sample.kind === 'triggers') {
      await store.saveTriggers(parseLosslessJson(expected.text));
      const loaded = await store.loadTriggers();
      assert.equal(loaded[0].TimeOfDayTicks, 9223372036854775807n);
      assert.equal(loaded[0].DayOfWeek, 'Saturday');
      assertProjectedEqual(t, sample.name + ' candidate reads native file', await readFile(store.configurationPath, 'utf8'), expected.text, parseLosslessJson);
    } else {
      await store.saveHistory(parseLosslessJson(expected.text));
      assert.deepEqual(await store.loadHistory(), parseLosslessJson(expected.text));
      assertProjectedEqual(t, sample.name + ' candidate writes imported history', await readFile(store.historyPath, 'utf8'), expected.text, parseLosslessJson);
    }
  }
});

test('actual configuration serializer reads Node changes while unmodeled namespaces and mixed text remain preserved', async t => {
  const [before, after] = native.configurations;
  assert.deepEqual(after.unknown, before.unknown);
  assert.equal(after.unknown.length, 2);
  assert.deepEqual(after.ContentTypes, input.contentTypes);
  for (const name of ['ServerName', 'UICulture', 'MetadataCountryCode']) assert.equal(after[name], before[name]);
  // Native serialization drops these unmodeled fields. Retain this counterexample;
  // a writer of only the known subset would lose actual user configuration.
  assert.deepEqual(after.nativeRewrittenUnknown, []);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'consumer-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'system.xml');
  await writeFile(filename, input.configurations[0].xml);
  const store = new ServerConfigurationStore({ configuration: { ContentTypes: before.ContentTypes }, configurationDirectoryPath: directory });
  t.after(() => store.close());
  await store.updateContentTypes(() => input.contentTypes);
  const saved = await readFile(filename, 'utf8');
  assert.equal(saved, input.configurations[1].xml);
  assert.equal(saved, replaceContentTypes(input.configurations[0].xml, input.contentTypes));
  observeComparison(t, 'native configuration resave loses unmodeled elements', after.nativeRewrittenUnknown, after.unknown);
});

test('actual WPL/ZPL reader and writer preserve entry metadata and Node reads native rewritten sidecars', t => {
  assert.equal(native.playlists.length, 6);
  for (const result of native.playlists) {
    const sample = input.playlists.find(sample => sample.name === result.name);
    assert.deepEqual(result.reread, result.entries, result.name + ' metadata after native rewrite');
    const extension = path.extname(sample.path);
    const before = parsePlaylist(Buffer.from(sample.bytes, 'base64'), extension);
    const after = parsePlaylist(Buffer.from(result.rewritten), extension);
    assertProjectedEqual(t, result.name + ' Node → native → Node paths and duplicates', after, before);
    assert.equal(after.length, 3); assert.equal(after[0], after[2]);
  }
});

test('590 newline and allowed WebVTT tail variants preserve actual SubtitleEdit cue values and failures', t => {
  assert.equal(native.subtitles.length, 590);
  const projection = ({ parsed, error }) => ({ parsed, error: error && { type: error.type } });
  for (const sample of input.subtitles) {
    const actual = native.subtitles.find(result => result.name === sample.name);
    const base = native.subtitles.find(result => result.name === sample.originalName + '--crlf');
    assert.ok(actual); assert.ok(base);
    assertProjectedEqual(t, sample.name, actual, base, projection);
  }
});
