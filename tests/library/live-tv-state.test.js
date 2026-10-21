import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { idKey } from '../../src/library/records.js';
import { decodeLiveTvDocument, liveTvStateKey } from '../../src/library/live-tv-state.js';
import { initializeLiveTvState } from '../../src/database/live-tv-state-import.js';
import { queryPostgresProgramRecordingInfo } from '../../src/library/postgres-live-tv-state-query.js';
import { createPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const inputUrl = new URL('./fixtures/live-tv-state/input.json', import.meta.url);
const inputBytes = await readFile(inputUrl), input = JSON.parse(inputBytes);
const project = entry => entry == null ? null : Object.fromEntries(Object.entries({ id: entry.Id, name: entry.Name,
  programId: entry.ProgramId, seriesId: entry.SeriesId, seriesTimerId: entry.SeriesTimerId,
  startDate: entry.StartDate, status: String(entry.Status) }).filter(([, value]) => value != null));

test('native timer documents and recording-info selection match persisted PostgreSQL state', {
  skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL || !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 240000,
}, async t => {
  const output = path.join(validationOutputRoot(), 'live-tv-state-' + randomUUID());
  await mkdir(output);
  const record = await recordOracle({ project: 'tests/library/fixtures/live-tv-state/Oracle.csproj',
    output: path.join(output, 'native'), args: [fileURLToPath(inputUrl), '{output}/native.json'] });
  const native = JSON.parse(await readFile(path.join(output, 'native/native.json'), 'utf8'));
  assert.ok(record.passed && native.actualItemDataProvider && native.actualRecordingInfo && native.privateInputsRemoved);
  assert.equal(native.recordingExecutorsStarted, false);
  assert.equal(native.caseInsensitiveProperties, false);
  assert.equal(native.inputSha256, createHash('sha256').update(inputBytes).digest('hex'));
  const differences = [], observations = [];
  for (const sample of input.documents) {
    const actual = decodeLiveTvDocument(sample.kind, sample.text), expected = native.documents.find(item => item.name === sample.name);
    observations.push({ name: sample.name, issue: actual.issue, entries: actual.entries.map(project) });
    try { assert.deepEqual(actual.entries.map(project), expected.entries, sample.name); }
    catch (error) { differences.push({ name: sample.name, message: error.message }); }
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'mm-live-tv-state-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('mm-live-tv-state-'));
    await rm(directory, { recursive: true });
  });
  const lookups = [];
  for (const [index, sample] of input.lookups.entries()) {
    const database = await createPostgresTestDatabase(t, 'tv_state_' + index), store = new DomainStore(database);
    const dataPath = path.join(directory, String(index));
    await mkdir(path.join(dataPath, 'livetv'), { recursive: true });
    for (const [filename, text] of [['timers.json', sample.timers], ['seriestimers.json', sample.seriesTimers]]) {
      await writeFile(path.join(dataPath, 'livetv', filename), text);
    }
    for (const program of sample.programs) await database.insert('BaseItems', postgresTestRow('BaseItems', {
      Id: program.id.toUpperCase(), Name: 'Guide program', Type: 'MediaBrowser.Controller.LiveTv.LiveTvProgram',
      ExternalId: program.externalId, ExternalSeriesId: program.externalSeriesId,
    }));
    const errors = [];
    assert.equal(await store.transaction(db => initializeLiveTvState(db, { dataPath, logger: { error: error => errors.push(error.message) } })), true);
    const before = await database.getState(liveTvStateKey);
    let actual, failure;
    try { actual = await store.run(db => queryPostgresProgramRecordingInfo(db, sample.programs.map(program => program.id))); }
    catch (error) { failure = { status: error.status, message: error.message, collationDefinition: error.collationDefinition }; }
    const expected = native.lookups.find(item => item.name === sample.name);
    const items = actual && sample.programs.map(program => ({ id: idKey(program.id), ...actual.get(idKey(program.id)) }));
    lookups.push({ name: sample.name, items, failure, errors });
    try {
      if (expected.error) assert.equal(failure?.status, 500, sample.name);
      else { assert.equal(failure, undefined, sample.name); assert.deepEqual(items, expected.items, sample.name); }
      assert.equal(await database.getState(liveTvStateKey), before);
      assert.equal(await readFile(path.join(dataPath, 'livetv/timers.json'), 'utf8'), sample.timers);
      // A source-file edit cannot replace the PostgreSQL business frame.
      await writeFile(path.join(dataPath, 'livetv/timers.json'), '[]');
      assert.equal(await store.transaction(db => initializeLiveTvState(db, { dataPath })), false);
      assert.equal(await database.getState(liveTvStateKey), before);
    } catch (error) { differences.push({ name: sample.name, message: error.message }); }
    await store.close();
    const reopened = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema: database.schemaName });
    const second = new DomainStore(reopened);
    try {
      assert.equal(await second.transaction(db => initializeLiveTvState(db, { dataPath })), false);
      assert.equal(await reopened.getState(liveTvStateKey), before);
      if (!expected.error) {
        const restored = await second.run(db => queryPostgresProgramRecordingInfo(db, sample.programs.map(program => program.id)));
        assert.deepEqual(sample.programs.map(program => ({ id: idKey(program.id), ...restored.get(idKey(program.id)) })), expected.items);
      }
      lookups.at(-1).coldReopenVerified = true;
    } catch (error) { differences.push({ name: sample.name + ' cold reopen', message: error.message }); }
    finally { await second.close(); }
  }
  await writeFile(path.join(output, 'comparison.json'), JSON.stringify({ passed: differences.length === 0,
    phaseAcceptance: false, documents: observations, lookups, differences,
    boundary: 'Actual native ItemDataProvider and AddRecordingInfo with file/config boundaries isolated; no native server HTTP or recording execution.' }, null, 2) + '\n');
  assert.deepEqual(differences, []);
});
