import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeGuid } from '../../src/users/native.js';
import { quoteIdentifier as q } from '../../src/database/model.js';
import { nativeTextBytes } from '../../src/database/native-text.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';
import { currentGuidContract, functional, input, playlistType, readCandidate, recordCandidate,
  userViewType } from './native-guid-current-fixture.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const emptyGuid = '00000000000000000000000000000000';
const errorRecord = error => ({ name: error.name, message: error.message, code: error.code });

function parseGuid(value) {
  try { return { success: true, value: nativeGuid(value).toLowerCase(), failure: null }; }
  catch (error) { return { success: false, value: null, failure: errorRecord(error) }; }
}

test('GUID contract binds actual System.Guid.Parse and Jellyfin JSON converters', async () => {
  const { native, report, candidate } = await currentGuidContract();
  assert.equal(native.actualGuidParse, true);
  assert.equal(native.actualJsonGuidConverter, true); assert.equal(native.actualJsonDefaults, true);
  assert.equal(native.actualBaseItemMapper, true); assert.equal(report.nativeExecutionRecorded, true);
  assert.equal(native.mediaOpened, false); assert.equal(native.portOpened, false);
  assert.deepEqual(native.cases.map(row => ({ Name: row.Name, Value: row.value })), input.Cases);
  assert.deepEqual(candidate.cases.map(row => ({ Name: row.Name, Value: row.value })), input.Cases);
  assert.equal(native.cases.length, 43);
  assert.equal(report.capture.record.build.status, 0); assert.equal(report.capture.record.process.status, 0);
  assert.equal(report.phaseAcceptance, false); assert.equal(report.releaseAcceptance, false);
});

test('nativeGuid follows actual Guid.Parse whitespace and X UInt32/byte grammar', async () => {
  const { native, candidate } = await currentGuidContract();
  const comparisons = native.cases.map((sample, index) => ({
    Name: sample.Name, parse: sample.guidParse.supported ? parseGuid(sample.value) : null,
    consumers: [[playlistType, 'playlist'], [userViewType, 'userView']].map(([nativeType, key]) => {
      const expected = sample[key];
      return { nativeType, key, expected, original: candidate.cases[index][key], nodeToNative: native.nodeReads[index][key],
        nativeToNode: expected.success ? readCandidate(nativeType, expected.canonicalJson) : null };
    }),
  }));
  await recordCandidate('node-functional-comparisons', comparisons);
  for (const [index, row] of comparisons.entries()) {
    const sample = native.cases[index];
    if (sample.guidParse.supported) assert.deepEqual(functional(row.parse), functional(sample.guidParse), row.Name + ': Guid.Parse');
    for (const consumer of row.consumers) {
      const label = row.Name + ': ' + consumer.key;
      assert.deepEqual(functional(consumer.original), functional(consumer.expected), label + ' original Data');
      if (!consumer.expected.success) continue;
      const canonical = { success: true, value: consumer.expected.canonicalValue };
      assert.equal(consumer.nodeToNative.supported, true, label + ' Node serialized Data was read');
      assert.deepEqual(functional(consumer.nodeToNative), canonical, label + ' Node -> Native');
      assert.deepEqual(functional(consumer.nativeToNode), canonical, label + ' Native -> Node');
    }
  }
});

test('postgres: typed JSON GUID gate and key follow actual JSON GuidConverter results', async t => {
  const { native, candidate } = await currentGuidContract();
  const db = await createPostgresTestDatabase(t, 'guid_contract');
  const safeData = q(db.schemaName) + '.' + q('mm_safe_native_item_data');
  const guidKey = q(db.schemaName) + '.' + q('mm_native_json_guid_key');
  const query = `SELECT COALESCE(${guidKey}(data->'OwnerUserId'), $3::text) AS owner,
    COALESCE((data->>'OpenAccess')::boolean, false) AS "openAccess"
    FROM (SELECT ${safeData}($1::bytea, $2::bytea) AS data) AS source`;
  async function readPlaylist(data) {
    try {
      const result = await db.client.query(query, [nativeTextBytes(playlistType), nativeTextBytes(data), emptyGuid]);
      const row = result.rows[0];
      return { success: true, value: { owner: row.owner, openAccess: row.openAccess }, failure: null };
    } catch (error) { return { success: false, value: null, failure: errorRecord(error) }; }
  }
  const observations = [];
  for (const [index, sample] of native.cases.entries()) {
    const actual = candidate.cases[index];
    observations.push({ Name: sample.Name, original: await readPlaylist(actual.data),
      fromNode: actual.playlist.success ? await readPlaylist(actual.playlist.serializedData) : null,
      fromNative: sample.playlist.success ? await readPlaylist(sample.playlist.canonicalJson) : null });
  }
  await recordCandidate('postgres-final-playlist', { schemaName: db.schemaName, query, observations });
  for (const [index, row] of observations.entries()) {
    const expected = native.cases[index].playlist;
    assert.deepEqual(functional(row.original), functional(expected), row.Name + ': original Data');
    if (expected.success) {
      const canonical = { success: true, value: expected.canonicalValue };
      assert.ok(row.fromNode, row.Name + ': Node serialization succeeded');
      assert.deepEqual(functional(row.fromNode), canonical, row.Name + ': Node serialized Data');
      assert.deepEqual(functional(row.fromNative), canonical, row.Name + ': Native serialized Data');
    }
  }
  const jsonNull = native.cases.find(row => row.value === null);
  assert.equal(jsonNull.guidParse.success, false);
  assert.equal(jsonNull.jsonGuid.success, true); assert.equal(jsonNull.nullableJsonGuid.success, true);
  assert.equal(jsonNull.jsonGuid.value, '00000000-0000-0000-0000-000000000000');
  assert.equal(jsonNull.nullableJsonGuid.value, null); assert.equal(jsonNull.nullableJsonGuid.rereadValue, null);
  assert.deepEqual(jsonNull.playlist.value, { owner: emptyGuid, openAccess: true });
  assert.equal(jsonNull.userView.value.userId, null); assert.equal(jsonNull.userView.canonicalValue.userId, null);
});
