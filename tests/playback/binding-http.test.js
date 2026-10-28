import { validationFileUrl } from '../../tools/validation/paths.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { createMediaFixture } from './http-scenario.js';
import { recordPlaybackBinding } from './binding-scenario.js';
import { createPlaybackState } from './runtime-state.js';
import { projectPlaybackInfoBody } from '../helpers/http-body-projection.js';
import libraryFixture from '../library/fixtures/reference-media.json' with { type: 'json' };
import streamsFixture from '../library/fixtures/reference-streams.json' with { type: 'json' };
import inputs from './fixtures/json-model-binding/http-input.json' with { type: 'json' };

const expected = parseLosslessJson(await readFile(validationFileUrl('./fixtures/json-model-binding/http-output.json', import.meta.url), 'utf8'));
const subtitleRoot = 'Z:\\BindingSidecars';
const nativeSubtitlePath = 'D:\\mediamanager\\.test-input\\evidence\\runtime-integration-20260926\\binding\\reference\\data\\fixture.srt';
const exactJson = value => JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? JSON.rawJSON(entry.toString()) : entry, 2);

async function seed(database) {
  for (const [table, rows] of Object.entries(libraryFixture.tables)) {
    const columns = tableDefinition(table).columns;
    const pending = [...rows], inserted = new Set();
    while (pending.length) {
      const index = table === 'BaseItems' ? pending.findIndex(row => [row.ParentId, row.OwnerId].every(id => !id || inserted.has(id))) : 0;
      assert.notEqual(index, -1, 'Native fixture parent ordering must be resolvable.');
      const [row] = pending.splice(index, 1);
      await database.insert(table, Object.fromEntries(Object.entries(row).map(([name, value]) => [name,
        value != null && columns.find(column => column.name === name)?.type === 'INTEGER' && typeof value === 'string' ? BigInt(value) : value])));
      inserted.add(row.Id);
    }
  }
  for (const row of streamsFixture.rows) await database.insert('MediaStreamInfos', row.StreamIndex === 5 ? { ...row, Path: `${subtitleRoot}\\fixture.srt`, Codec: 'subrip' } : row);
  await database.update('BaseItems', { Id: '22222222-2222-2222-2222-222222222222' }, { TotalBitrate: null });
}

// Only per-request identifiers and the isolated synthetic subtitle path vary.
const normalize = record => ({ ...record, body: projectPlaybackInfoBody(record.body, { status: record.status,
  path: value => value === nativeSubtitlePath || value === `${subtitleRoot}\\fixture.srt` ? '<synthetic-subtitle>' : value }) });

test('104 native PlaybackInfo HTTP binding cases on PostgreSQL match complete responses', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async () => {
  assert.equal(inputs.length, 104);
  assert.equal(expected.length, inputs.length);
  assert.deepEqual(expected.map(record => record.name), inputs.map(record => record.name));
  const schema = `playback_binding_${randomBytes(8).toString('hex')}`;
  const fixture = await createMediaFixture({ subtitleRoot });
  const state = await createPlaybackState();
  let database, runtime;
  try {
    database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
    await seed(database);
    runtime = await createTestRuntime({ database, configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true },
      serverId: libraryFixture.serverId, programDataPath: state.root,
      vfs: fixture.vfs, identityMap: fixture.identityMap, onError: () => {} });
    const user = await runtime.users.createUser({ Name: 'CoreFlowAdmin', Password: 'isolated-core-flow-password' });
    await runtime.users.updatePolicy(user.Id, { ...libraryFixture.user.Policy });
    await runtime.users.updateConfiguration(user.Id, { ...streamsFixture.user });

    const actual = await recordPlaybackBinding(`http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port}`, inputs);
    assert.equal(actual.length, expected.length);
    const differences = expected.flatMap((record, index) => isDeepStrictEqual(normalize(actual[index]), normalize(record)) ? [] :
      [{ name: record.name, expected: record, actual: actual[index] }]);
    if (process.env.MEDIAMANAGER_BINDING_EVIDENCE) {
      await mkdir(process.env.MEDIAMANAGER_BINDING_EVIDENCE, { recursive: true });
      await writeFile(path.join(process.env.MEDIAMANAGER_BINDING_EVIDENCE, 'postgres-durable-http.json'), `${exactJson(actual)}\n`);
      await writeFile(path.join(process.env.MEDIAMANAGER_BINDING_EVIDENCE, 'postgres-durable-http-report.json'), `${exactJson({
        cases: actual.length, equal: actual.length - differences.length, compatible: differences.length === 0,
        normalizations: ['Root ProblemDetails trace value, with presence retained', 'PlaybackInfoResponse correlation value, with presence retained', 'Declared synthetic subtitle stream path only'], differences,
      })}\n`);
    }
    assert.deepEqual(differences, [], 'All 104 native binding responses must match without static source capability exclusions.');
  } finally {
    await fixture.close();
    try {
      if (database) {
        await database.client.query(`DROP SCHEMA "${schema}" CASCADE`);
        await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
      }
    } finally {
      try { if (runtime) await runtime.close(); else await database?.close(); }
      finally { await state.close(); }
    }
  }
});
