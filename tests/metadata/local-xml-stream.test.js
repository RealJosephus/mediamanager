import test from 'node:test';
import assert from 'node:assert/strict';
import { currentLocalXml, functionalReader, functionalSave, input } from './local-xml-current-fixture.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];

for (const sample of input.cases) test('local XML current Native save and Node-output readback: ' + sample.name, async () => {
  const fixture = await currentLocalXml(), index = input.cases.indexOf(sample);
  const first = fixture.native.observations[0].results[index], repeat = fixture.native.observations[1].results[index];
  const candidate = fixture.candidate[index], readback = fixture.native.candidateReads[index];
  const expected = { save: functionalSave(first), reader: functionalReader(first.reader) };
  const actual = { save: functionalSave(candidate), reader: functionalReader(readback.reader) };
  await fixture.recordComparison({ name: sample.name, expected, actual });
  assert.deepEqual(functionalSave(repeat), expected.save, 'Two private Native saves must agree on functional file results.');
  assert.deepEqual(functionalReader(repeat.reader), expected.reader, 'Both Native files must preserve the same consumer-visible prefix.');
  assert.deepEqual(actual, expected, 'The actual Native reader must accept the Node result, including values committed before failure.');
  assert.equal(candidate.fileExists, true); assert.equal(candidate.changed, true); assert.ok(candidate.file.bytes > 0);
  assert.equal(candidate.resources.fileReleased, true); assert.deepEqual(candidate.resources.spoolEntries, []);
  if (sample.fault === 'none') {
    const result = readback.reader.result;
    assert.equal(result.Name, input.item.Name); assert.equal(result.Overview, input.item.Overview);
    const paths = sample.paths ?? input.defaultPaths, count = sample.count ?? paths.length;
    assert.deepEqual(result.links.map(link => link.path), Array.from({ length: count }, (_, offset) => paths[offset % paths.length]).filter(Boolean));
  }
  if (sample.type === 'Playlist') {
    const result = readback.reader.result;
    assert.equal(result.ownerUserId, sample.filePlaylist ? '00000000000000000000000000000000' : input.item.OwnerUserId.replaceAll('-', ''));
    assert.deepEqual(result.shares, input.item.Shares.map(share => ({ userId: share.UserId.replaceAll('-', ''), CanEdit: share.CanEdit })));
    assert.equal(result.playlistMediaType, input.item.PlaylistMediaType);
    if (sample.filePlaylist) { assert.deepEqual(result.links, []); assert.equal(candidate.saveFailed, false); }
  }
  if (sample.mode === 'prepared') {
    assert.equal(candidate.resources.memberSnapshotClosed, true);
    assert.equal(candidate.resources.closedPreparedStreamRejectsRead, true);
    assert.equal(readback.reader.result.links.length, sample.count);
  }
  if (sample.mode === 'remote') {
    assert.equal(candidate.writes.length, 1);
    assert.equal(candidate.writes[0].destination, '/box/collection.xml');
    assert.equal(candidate.writes[0].options.ifMatch, 'explicit-version'); assert.equal(candidate.writes[0].options.atomic, true);
    assert.equal(BigInt(candidate.writes[0].options.size), BigInt(candidate.file.bytes));
    assert.deepEqual(candidate.writes[0].file, { bytes: candidate.file.bytes, sha256: candidate.file.sha256 });
  }
  if (sample.mode === 'manager') {
    assert.deepEqual(candidate.effects, ['begin', 'logged-failure', 'complete', 'other']);
    assert.deepEqual(candidate.resources.saverOutcomes, [{ failed: true }, { failed: false }]);
  }
});
