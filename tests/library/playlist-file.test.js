import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { normalizePlaylistItemPath, serializePlaylistFile } from '../../src/library/playlist-file.js';

const root = new URL('./fixtures/playlist-file/', import.meta.url);
const input = JSON.parse(await readFile(new URL('input.json', root)));
const native = JSON.parse(await readFile(new URL('native.json', root)));
const provenanceBytes = await readFile(new URL('provenance.json', root));
const provenance = JSON.parse(provenanceBytes);
const digest = value => createHash('sha256').update(value).digest('hex');
const children = input.children.map(item => ({
  Type: item.type, Path: item.path?.replace('$STATE', 'Z:\\playlist-oracle').replaceAll('/', '\\') ?? null,
  Name: item.name, Album: item.album, AlbumArtists: item.albumArtists, Artists: item.artists,
  RunTimeTicks: item.ticks == null ? null : BigInt(item.ticks),
}));
// Remote paths are URI strings, not filesystem identities.
input.children.forEach((item, index) => {
  if (item.path && !item.path.startsWith('$STATE')) children[index].Path = item.path;
});
const projectError = error => ({ type: error.nativeException ?? error.name, parameter: error.parameter ?? null });

test('playlist file oracle retains actual process, source and independent repeat seals', async () => {
  assert.equal(digest(provenanceBytes), '11127958680bca3b9ea88a3a445543652e96e856de3532d9970b0f93d4de4e79');
  assert.equal(provenance.candidateVerified, false);
  assert.equal(provenance.jellyfin.commit, '208c278b75abd897aefa1e1175126eac5e4dbfaa');
  assert.equal(provenance.playlistsNet.commit, '10a2a55eea67b6cca866022107686bdac9b19fba');
  assert.equal(provenance.playlistsNet.version, '1.4.1');
  assert.equal(provenance.repeat.projectionEqual, true);
  assert.equal(provenance.files.rawRecording.sha256, provenance.repeat.rawSha256);
  assert.deepEqual(provenance.counts, { writeCases: 34, pathCases: 51, operationCases: 12 });
  assert.equal(native.candidateVerified, false);
  assert.equal(native.inputSha256, provenance.files.input.sha256);
  assert.equal(native.writes.length, provenance.counts.writeCases);
  assert.equal(native.pathCases.length, provenance.counts.pathCases);
  assert.equal(native.operations.length, provenance.counts.operationCases);
  assert.deepEqual(native.assemblies, [
    { name: 'Emby.Server.Implementations', sha256: '6a29143fe5e6867f8e91b697680dce602aa422cf250786db1298911499369d62' },
    { name: 'MediaBrowser.Controller', sha256: 'a9a051747d55565befc425dd194779e2ae53c57f8740212dc929dd706b888306' },
    { name: 'PlaylistsNET', sha256: '5aa82f779725f5a70be2082118e797e6d84c8b6f174f6e9c10b08fe5a427afea' },
  ]);
  for (const descriptor of [provenance.files.input, provenance.files.native,
    provenance.files.oracle, provenance.files.project]) {
    assert.equal(digest(await readFile(new URL(descriptor.filename, root))), descriptor.sha256, descriptor.filename);
  }
});

test('external playlist serialization matches actual pinned PlaylistManager bytes and errors', async t => {
  for (const [index, sample] of input.writes.entries()) await t.test(sample.name, () => {
    const expected = native.writes[index];
    assert.equal(expected.name, sample.name);
    let bytes = null, error = null;
    try { bytes = serializePlaylistFile(`Z:\\playlist-oracle\\lists\\mix${sample.extension}`,
      sample.links?.map(id => children[id - 1]).filter(Boolean) ?? null); }
    catch (caught) { error = projectError(caught); }
    assert.deepEqual(error, expected.error);
    assert.equal(bytes?.toString('base64') ?? '//5vAGwAZAA=', expected.bytes);
  });
});

test('external playlist path normalization matches pinned Uri.MakeRelativeUri', async t => {
  for (const [index, sample] of input.pathCases.entries()) await t.test(sample.name, () => {
    const expected = native.pathCases[index];
    assert.equal(expected.name, sample.name);
    let result = null, error = null;
    try { result = normalizePlaylistItemPath(sample.playlistPath, sample.itemPath, { windows: true }); }
    catch (caught) { error = projectError(caught); }
    assert.deepEqual(error, expected.error);
    assert.equal(result, expected.result);
  });
});
