import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parsePasswordHash, verifyPasswordHash } from '../../src/core/password.js';
import { stringifyNativeJson, parseLosslessJson, withNativeFloats } from '../../src/core/json.js';
import { ScheduledTaskFileStore } from '../../src/tasks/scheduled-task-store.js';
import { ServerConfigurationStore } from '../../src/core/server-configuration-store.js';
import { readConfigurationFile } from '../../src/core/configuration-file.js';
import { parsePlaylist } from '../../src/metadata/playlist-items.js';
import { currentReaders, publicJsonBoundary, taskId, configurationValues, subtitleObservation, functionalSubtitle } from './current-readers.js';
import { assertProjectedEqual, observeComparison } from '../comparison-observations.js';
import { localStateStorage } from '../helpers/local-state-storage.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];

test('current native and Node password verifiers accept fresh CSPRNG and contained-zero salts in both directions', async () => {
  const { input, candidate, native, recordCandidate } = await currentReaders();
  assert.equal(native.passwords.length, input.passwords.length);
  const observations = [];
  for (const [index, result] of native.passwords.entries()) {
    const sample = candidate.passwords[index];
    assert.equal(result.canonical, sample.hash); assert.equal(result.hashLength, 64);
    assert.equal(result.verified, true); assert.equal(result.changedPassword, false);
    const verified = await verifyPasswordHash(parsePasswordHash(result.canonical), sample.password);
    const changedPassword = await verifyPasswordHash(parsePasswordHash(result.canonical), sample.password + 'x');
    observations.push({ name: sample.name, verified, changedPassword });
    assert.equal(verified, true); assert.equal(changedPassword, false);
  }
  assert.ok(parsePasswordHash(candidate.passwords.find(sample => sample.name === 'node-contained-zero').hash).salt.includes(0));
  assert.equal(native.nativePasswords.length, 2);
  for (const sample of native.nativePasswords) {
    const hash = parsePasswordHash(sample.hash);
    if (sample.name === 'native-contained-zero') assert.ok(hash.salt.includes(0));
    const verified = await verifyPasswordHash(hash, sample.password), changedPassword = await verifyPasswordHash(hash, sample.password + 'x');
    observations.push({ name: sample.name, verified, changedPassword });
    assert.equal(verified, true); assert.equal(changedPassword, false);
  }
  await recordCandidate('passwords', observations);
});

test('current public JSON readers preserve floats, negative zero, Int64, null, surrogate and date precision semantics', async t => {
  const { candidate, native, recordCandidate } = await currentReaders();
  const value = publicJsonBoundary(), actual = candidate.jsonBoundary;
  assertProjectedEqual(t, 'Node public JSON and Native public JSON', actual, native.jsonBoundary, parseLosslessJson);
  assertProjectedEqual(t, 'Native reads and rewrites current Node public JSON', native.jsonReadBack, actual, parseLosslessJson);
  const parsed = parseLosslessJson(native.jsonBoundary);
  assert.ok(Object.is(parsed.NegativeZero, -0)); assert.ok(Object.is(parsed.NegativeDoubleZero, -0));
  assert.equal(parsed.MinTicks, value.MinTicks); assert.equal(parsed.MaxTicks, value.MaxTicks); assert.equal(parsed.Date, value.Date);
  const rejections = [];
  for (const [index, number] of [NaN, Infinity, -Infinity].entries()) {
    assert.equal(native.nonFinite[index].rejected, true);
    for (const [kind, payload] of [['number', number], ['array', [number]], ['dictionary', new Map([['value', number]])],
      ['object', { Value: number }], ['float', withNativeFloats({ Value: number }, ['Value'])]]) {
      let error;
      try { stringifyNativeJson(payload); } catch (caught) { error = { name: caught.name, message: caught.message }; }
      rejections.push({ index, kind, rejected: Boolean(error), error });
      assert.equal(Boolean(error), native.nonFinite[index].rejected, kind);
    }
    observeComparison(t, 'non-finite rejection diagnostics', rejections.slice(-5), native.nonFinite[index]);
  }
  assert.throws(() => stringifyNativeJson({ Date: new Date(value.Date) }));
  await recordCandidate('json', { actual, nativeReadBack: native.jsonReadBack, rejections });
});

test('current native task DTOs and Node files retain integer tokens, enum, dates and imported history text', async t => {
  const { input, candidate, native, output, recordCandidate } = await currentReaders();
  const directory = path.join(output, 'candidate/native-tasks');
  const store = new ScheduledTaskFileStore({ taskId, programDataPath: path.join(directory, 'data'),
    configurationDirectoryPath: path.join(directory, 'config') });
  const observations = [];
  try {
    for (const [index, expected] of native.tasks.entries()) {
      const sample = candidate.tasks[index], triggers = sample.kind === 'triggers';
      assert.equal(expected.inputText, sample.text, sample.name + ' Native read the actual candidate file');
      assertProjectedEqual(t, sample.name + ' current Node persisted values', sample.text, input.tasks[index].text, parseLosslessJson);
      assertProjectedEqual(t, sample.name + ' native reads candidate file', sample.text, expected.text, parseLosslessJson);
      const filename = triggers ? store.configurationPath : store.historyPath;
      await mkdir(path.dirname(filename), { recursive: true });
      const nativeBytes = await readFile(expected.filename);
      assert.equal(nativeBytes.toString('utf8'), expected.text);
      await writeFile(filename, nativeBytes, { flag: 'wx' });
      const loaded = await store[triggers ? 'loadTriggers' : 'loadHistory']();
      const loadedText = stringifyNativeJson(loaded);
      assertProjectedEqual(t, sample.name + ' Node read the Native file', loadedText, expected.text, parseLosslessJson);
      if (triggers) {
        const values = parseLosslessJson(loadedText);
        assert.equal(values[0].TimeOfDayTicks, 9223372036854775807n); assert.equal(values[0].DayOfWeek, 'Saturday');
      }
      await store[triggers ? 'saveTriggers' : 'saveHistory'](loaded);
      const rewritten = await readFile(filename, 'utf8');
      assertProjectedEqual(t, sample.name + ' candidate writes imported file', rewritten, expected.text, parseLosslessJson);
      observations.push({ name: sample.name, filename, loaded, rewritten });
    }
  } finally { await store.close(); }
  await recordCandidate('tasks', observations);
});

function configurationUnknownContent(node) {
  if (Object.hasOwn(node, 'text')) return { ...node };
  const children = [];
  for (const child of node.children) {
    const current = configurationUnknownContent(child), previous = children.at(-1);
    if (Object.hasOwn(current, 'text') && previous && Object.hasOwn(previous, 'text')) previous.text += current.text;
    else children.push(current);
  }
  return { ...node, children };
}

test('current configuration readers retain Node changes, unmodeled namespaces and mixed text', async t => {
  const { input, candidate, native, output, recordCandidate } = await currentReaders();
  const [before, after] = native.configurations;
  assert.equal(before.inputXml, input.configurations[0].xml); assert.equal(after.inputXml, candidate.configurations[1].xml);
  // Rewritten XML is consumed by both real readers; lexical layout is not a
  // persisted value. The original untouched input remains in the capture.
  assert.deepEqual(after.unknown.map(configurationUnknownContent), before.unknown.map(configurationUnknownContent));
  assert.equal(after.unknown.length, 2);
  assert.deepEqual(after.ContentTypes, input.contentTypes);
  for (const name of ['ServerName', 'UICulture', 'MetadataCountryCode']) assert.equal(after[name], before[name]);
  // Keep the serializer's loss of unmodeled data visible in the observations.
  assert.deepEqual(after.nativeRewrittenUnknown, []);
  const parsed = await readConfigurationFile(after.filename, 'server');
  const nativeRead = structuredClone(configurationValues(parsed));
  assert.deepEqual(nativeRead, configurationValues(after), 'Node reads the actual Native rewrite');
  const directory = path.join(output, 'candidate/native-configuration');
  await mkdir(directory);
  const filename = path.join(directory, 'system.xml');
  await writeFile(filename, await readFile(after.filename), { flag: 'wx' });
  const storage = await localStateStorage(directory), programDataPath = path.join(directory, 'data');
  const store = new ServerConfigurationStore({ configuration: parsed, configurationDirectoryPath: directory,
    applicationPaths: { programDataPath, defaultMetadataPath: path.join(programDataPath, 'metadata'),
      metadataPath: path.join(programDataPath, 'metadata'), cachePath: path.join(programDataPath, 'cache') },
    metadataFileSystem: storage.fileSystem });
  try { await store.initialize(); await store.updateContentTypes(() => before.ContentTypes); }
  finally { try { await store.close(); } finally { await storage.close(); } }
  const reloaded = await readConfigurationFile(filename, 'server');
  assert.deepEqual(configurationValues(reloaded), configurationValues(before));
  observeComparison(t, 'native configuration resave loses unmodeled elements', after.nativeRewrittenUnknown, after.unknown);
  await recordCandidate('configuration', { parsed: nativeRead, reloaded: configurationValues(reloaded),
    nativeRewrite: await readFile(after.filename, 'utf8'), nodeRewrite: await readFile(filename, 'utf8') });
});

test('current WPL/ZPL writers and both readers retain entry metadata, paths, order and duplicate links', async t => {
  const { input, candidate, native, recordCandidate } = await currentReaders();
  assert.equal(native.playlists.length, 6);
  const entries = values => values.map(value => Object.fromEntries(
    ['AlbumTitle', 'AlbumArtist', 'Duration', 'TrackTitle', 'TrackArtist', 'Path'].map(name => [name, value[name]])));
  const observations = [];
  for (const [index, result] of native.playlists.entries()) {
    const sample = candidate.playlists[index], extension = path.extname(sample.path);
    assertProjectedEqual(t, sample.name + ' current writer metadata', result.entries, result.baseline, entries);
    assertProjectedEqual(t, sample.name + ' native rewrite metadata', result.reread, result.entries, entries);
    const before = parsePlaylist(Buffer.from(sample.bytes, 'base64'), extension);
    const neutral = parsePlaylist(Buffer.from(input.playlists[index].bytes, 'base64'), extension);
    const nativeBytes = await readFile(result.filename);
    assert.equal(nativeBytes.toString('utf8'), result.rewritten);
    const after = parsePlaylist(nativeBytes, extension);
    assertProjectedEqual(t, sample.name + ' Node → native → Node paths and duplicates', after, before);
    assert.deepEqual(before, neutral); assert.deepEqual(before, result.entries.map(entry => entry.Path));
    assert.equal(after.length, 3); assert.equal(after[0], after[2]);
    observations.push({ name: sample.name, before, after });
  }
  await recordCandidate('playlists', observations);
});

test('590 current subtitle layouts and timestamp maps retain cue values and failures through both readers and writers', async t => {
  const { input, candidate, native, recordCandidate } = await currentReaders();
  assert.equal(native.subtitles.length, 590);
  const baselines = new Map(native.subtitles.map(result => [result.name, result.baseline]));
  const observations = native.subtitles.map((result, index) => ({ name: result.name,
    reverse: result.baseline.rewritten == null ? null : subtitleObservation(result.baseline.rewritten, input.subtitles[index].format) }));
  await recordCandidate('subtitle-reverse', observations);
  assert.equal(native.subtitleTimeMaps.length, 10);
  const mappedObservations = native.subtitleTimeMaps.map((result, index) => ({ name: result.name,
    reverse: result.baseline.rewritten == null ? null : subtitleObservation(result.baseline.rewritten, input.subtitleTimeMaps[index].format) }));
  await recordCandidate('subtitle-time-map-reverse', mappedObservations);
  for (const [index, sample] of input.subtitles.entries()) {
    const result = native.subtitles[index], node = candidate.subtitles[index];
    const base = baselines.get(sample.originalName + '--crlf');
    assert.ok(base, sample.name);
    assertProjectedEqual(t, sample.name + ' Native layout values', result.baseline, base, functionalSubtitle);
    assertProjectedEqual(t, sample.name + ' Node reads input layout', node, result.baseline, functionalSubtitle);
    if (node.error) { assert.equal(result.node, null, sample.name); continue; }
    const rewritten = { json: result.baseline.rereadJson, error: result.baseline.error };
    assertProjectedEqual(t, sample.name + ' Native reads current Node output', result.node, rewritten, functionalSubtitle);
    assertProjectedEqual(t, sample.name + ' Node reads current Native rewrite', observations[index].reverse, rewritten, functionalSubtitle);
  }
  for (const [index, sample] of input.subtitleTimeMaps.entries()) {
    const result = native.subtitleTimeMaps[index], node = candidate.subtitleTimeMaps[index];
    assert.equal(result.baseline.error, null, sample.name);
    assertProjectedEqual(t, sample.name + ' mapped playback window', node, result.baseline, functionalSubtitle);
    const rewritten = { json: result.baseline.rereadJson, error: result.baseline.error };
    assertProjectedEqual(t, sample.name + ' Native reads mapped Node output', result.node, rewritten, functionalSubtitle);
    assertProjectedEqual(t, sample.name + ' Node reads mapped Native output', mappedObservations[index].reverse, rewritten, functionalSubtitle);
  }
});
