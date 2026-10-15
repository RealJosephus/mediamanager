import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setupPlaylistDeletion } from './playlist-deletion-fixture.js';
import { parseLosslessJson } from '../../src/core/json.js';

const root = new URL('./fixtures/playlist-deletion/', import.meta.url);
const input = JSON.parse(await readFile(new URL('input.json', root)));
const native = parseLosslessJson(await readFile(new URL('native.json', root), 'utf8'));
const provenance = JSON.parse(await readFile(new URL('provenance.json', root), 'utf8'));
test('Playlist deletion recording seals independent complete initial/final frames and native repeat', async () => {
  for (const key of ['input', 'native', 'oracle', 'project', 'buildProperties', 'readme']) {
    const descriptor = provenance.files[key];
    assert.equal(createHash('sha256').update(await readFile(new URL(descriptor.filename, root))).digest('hex'), descriptor.sha256);
  }
  assert.equal(native.actualPlaylistDeletion, true); assert.equal(native.candidateVerified, false);
  assert.equal(provenance.candidateVerified, false); assert.equal(native.inputSha256, provenance.files.input.sha256);
  assert.deepEqual(native.assemblies, provenance.assemblies); assert.equal(native.scope, provenance.scope);
  assert.equal(provenance.repeat.rawSha256, provenance.files.rawRecording.sha256);
  assert.equal(provenance.repeat.byteEqual, true); assert.equal(provenance.repeat.projectionEqual, true);
  assert.equal(native.results.length, 30); assert.equal(provenance.counts.cases, 30);
  assert.deepEqual(native.results.map(result => result.name), input.map(sample => sample.name));
  assert.deepEqual(native.results.map(result => result.exception), input.map(sample => sample.expectException ?? null));
  for (const result of native.results) {
    assert.ok(result.initialRows.every(row => Object.keys(row).length === 72));
    assert.ok(result.rows.every(row => Object.keys(row).length === 72));
    assert.ok(result.initialRows.some(row => row.Type === 'MediaBrowser.Controller.Playlists.Playlist'));
    assert.ok(result.initialFiles.length > 0); assert.ok(result.initialLinks.length > 0);
  }
  assert.equal(native.results.find(result => result.name === 'owned-video-warm').closureLookup, true);
  assert.equal(native.results.find(result => result.name === 'owned-video-cold').closureLookup, false);
});
for (const sample of input) test(`postgres: Playlist deletion matches native ${sample.name}`, {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const expected = native.results.find(result => result.name === sample.name);
  const value = await setupPlaylistDeletion(t, sample, expected);
  let error;
  try { await value.operation(); } catch (caught) { error = caught; }
  assert.equal(Boolean(error), expected.exception != null, error?.stack);
  if (error && expected.exception === 'IOException') assert.equal(error.nativeException, 'IOException');
  if (error && expected.exception === 'SqliteException') assert.match(error.message, /Controlled deletion failure/);
  const projection = await value.project(expected.exception);
  assert.deepEqual(projection, { name: expected.name, exception: expected.exception, calls: expected.calls,
    rows: value.normalizeRows(expected.rows), links: expected.links, files: expected.files, targetParentId: expected.targetParentId,
    targetLookup: expected.targetLookup, closureLookup: expected.closureLookup,
    parentChildrenCleared: expected.parentChildrenCleared, parentUserDataCleared: expected.parentUserDataCleared });
});
