import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { nativeGuid } from '../../src/users/native.js';
import { quoteIdentifier as q } from '../../src/database/model.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';
const fixture = new URL('./fixtures/guid-contract/', import.meta.url);
const [inputBytes, nativeBytes, proofBytes] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(name => readFile(new URL(name, fixture))));
const input = JSON.parse(inputBytes), native = JSON.parse(nativeBytes), proof = JSON.parse(proofBytes);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('GUID contract binds actual System.Guid.Parse and Jellyfin JSON converters', async () => {
  assert.equal(hash(inputBytes), proof.inputSha256); assert.equal(hash(nativeBytes), proof.nativeSha256);
  assert.equal(native.inputSha256, proof.inputSha256); assert.equal(native.actualGuidParse, true);
  assert.equal(native.actualJsonGuidConverter, true); assert.equal(native.actualJsonDefaults, true);
  assert.equal(native.mediaOpened, false); assert.equal(native.portOpened, false);
  assert.deepEqual(native.cases.map(row => ({ Name: row.Name, Value: row.value })), input.Cases);
  assert.equal(proof.build.status, 0); assert.equal(proof.process.status, 0);
  assert.equal(proof.completeBuildInputClosure, false); assert.equal(proof.phaseAcceptance, false);
  assert.equal(hash(await readFile(proof.rawRecording.filename)), proof.nativeSha256);
  assert.equal(hash(await readFile(proof.oracleAssembly.filename)), proof.oracleAssembly.sha256);
  for (const source of proof.oracleSources) assert.equal(hash(await readFile(source.name === 'Directory.Build.props'
    ? new URL('../Directory.Build.props', import.meta.url) : new URL(source.name, fixture))), source.sha256);
  for (const source of proof.sources) for (const root of ['D:/jellyfin', proof.buildSource]) {
    assert.equal(hash(await readFile(path.join(root, source.path))), source.sha256);
  }
  for (const assembly of proof.assemblies) assert.equal(hash(await readFile(assembly.filename)), assembly.sha256, assembly.name);
  for (const assembly of proof.matchingLibraryAssemblies) assert.equal(hash(await readFile(assembly.filename)), assembly.sha256, assembly.name);
  assert.ok(proof.assemblies.some(row => row.name === 'System.Private.CoreLib'));
  assert.ok(proof.matchingLibraryAssemblies.some(row => row.name === 'Jellyfin.Extensions'));
});

test('nativeGuid follows actual Guid.Parse whitespace and X UInt32/byte grammar', () => {
  for (const sample of native.cases) {
    if (!sample.guidParse.supported) continue;
    if (sample.guidParse.success) assert.equal(nativeGuid(sample.value).toLowerCase(), sample.guidParse.value, sample.Name);
    else assert.throws(() => nativeGuid(sample.value), sample.Name);
  }
});

test('postgres: typed JSON GUID gate and key follow actual JSON GuidConverter results',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const db = await createPostgresTestDatabase(t, 'guid_contract');
    const safeData = q(db.schemaName) + '.' + q('mm_safe_native_item_data');
    const guidKey = q(db.schemaName) + '.' + q('mm_native_json_guid_key');
    for (const sample of native.cases) {
      const source = JSON.stringify({ OwnerUserId: sample.value });
      if (sample.jsonGuid.failure?.type === 'FormatException') {
        await assert.rejects(db.client.query('SELECT ' + safeData + '($1,$2)',
          ['MediaBrowser.Controller.Playlists.Playlist', source]), error => error.code === 'MM001', sample.Name);
      } else {
        const document = (await db.client.query('SELECT ' + safeData + '($1,$2) AS value',
          ['MediaBrowser.Controller.Playlists.Playlist', source])).rows[0].value;
        assert.deepEqual(document, sample.jsonGuid.success ? JSON.parse(source) : {}, sample.Name);
      }
      if (typeof sample.value !== 'string' && sample.value !== null) continue;
      if (sample.jsonGuid.success) {
        const key = (await db.client.query('SELECT ' + guidKey + '($1::json) AS value',
          [JSON.stringify(sample.value)])).rows[0].value;
        assert.equal(key, sample.jsonGuid.value.replaceAll('-', ''), sample.Name);
      } else await assert.rejects(db.client.query('SELECT ' + guidKey + '($1::json)',
        [JSON.stringify(sample.value)]), error => error.code === 'MM001', sample.Name);
    }
    const jsonNull = native.cases.find(row => row.value === null);
    assert.equal(jsonNull.guidParse.success, false);
    assert.equal(jsonNull.jsonGuid.value, '00000000-0000-0000-0000-000000000000');
    assert.equal(jsonNull.nullableJsonGuid.value, null);
  });
