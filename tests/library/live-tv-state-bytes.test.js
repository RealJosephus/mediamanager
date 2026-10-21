import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { quoteIdentifier as q } from '../../src/database/model.js';
import { decodeLiveTvDocument, liveTvStateKey } from '../../src/library/live-tv-state.js';
import { initializeLiveTvState } from '../../src/database/live-tv-state-import.js';
import { queryPostgresProgramRecordingInfo } from '../../src/library/postgres-live-tv-state-query.js';
import { idKey } from '../../src/library/records.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const inputUrl = new URL('./fixtures/live-tv-state-bytes/input.json', import.meta.url);
const inputBytes = await readFile(inputUrl), input = JSON.parse(inputBytes);
const hash = value => createHash('sha256').update(value).digest('hex');
const project = entry => entry == null ? null : Object.fromEntries(Object.entries({ id: entry.Id, name: entry.Name,
  programId: entry.ProgramId, seriesId: entry.SeriesId, seriesTimerId: entry.SeriesTimerId,
  startDate: entry.StartDate, status: String(entry.Status) }).filter(([, value]) => value != null));

test('native saved timer bytes preserve lazy string decoding and PostgreSQL recording links', {
  skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL || !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 240000,
}, async () => {
  const output = path.join(validationOutputRoot(), 'live-tv-state-bytes-' + randomUUID());
  await mkdir(output);
  const directory = await mkdtemp(path.join(tmpdir(), 'mm-tv-state-bytes-'));
  const observations = [], differences = [], cleanup = {};
  let database, failure;
  try {
    const record = await recordOracle({ project: 'tests/library/fixtures/live-tv-state/Oracle.csproj',
      output: path.join(output, 'native'), args: [fileURLToPath(inputUrl), '{output}/native.json'] });
    const native = JSON.parse(await readFile(path.join(output, 'native/native.json')));
    assert.ok(record.passed && native.actualItemDataProvider && native.actualRecordingInfo && native.privateInputsRemoved);
    assert.equal(native.recordingExecutorsStarted, false);
    assert.equal(native.inputSha256, hash(inputBytes));
    assert.equal(native.documents.length, input.documents.length);
    assert.equal(native.lookups.length, input.lookups.length);
    database = await createPostgresTestDatabase(null, 'tv_state_bytes');
    const program = input.lookups[0].programs[0];
    await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: program.id.toUpperCase(),
      Name: 'Saved byte program', Type: 'MediaBrowser.Controller.LiveTv.LiveTvProgram',
      ExternalId: program.externalId, ExternalSeriesId: program.externalSeriesId }));
    const dataPath = path.join(directory, 'data');
    await mkdir(path.join(dataPath, 'livetv'), { recursive: true });
    for (const sample of input.documents) {
      const expected = native.documents.find(value => value.name === sample.name);
      const lookup = input.lookups.find(value => value.name === sample.name);
      const nativeLookup = native.lookups.find(value => value.name === sample.name);
      let decoded, items, issue;
      try {
        decoded = decodeLiveTvDocument(sample.kind, Buffer.from(sample.bytesHex, 'hex'));
        // A reader conversion error makes that service unusable. The actual
        // manager workflow below proves its observable empty-service result.
        assert.deepEqual(decoded.entries.map(project), expected.entries ?? [], sample.name);
        issue = decoded.issue;
        const sources = [['timers', 'timers.json', lookup.timersHex], ['seriesTimers', 'seriestimers.json', lookup.seriesTimersHex]];
        for (const [, filename, hex] of sources) await writeFile(path.join(dataPath, 'livetv', filename), Buffer.from(hex, 'hex'));
        await database.client.query(`DELETE FROM ${q(database.controlSchema)}.state WHERE key = $1`, [liveTvStateKey]);
        assert.equal(await database.transaction(db => initializeLiveTvState(db, { dataPath })), true);
        const before = await database.getState(liveTvStateKey), state = JSON.parse(before);
        for (const [kind, , hex] of sources) {
          assert.equal(state[kind].sourceHex, hex);
          assert.equal(state[kind].sourceSha256, hash(Buffer.from(hex, 'hex')));
        }
        const values = await database.transaction(db => queryPostgresProgramRecordingInfo(db, [program.id]));
        items = [{ id: idKey(program.id), ...values.get(idKey(program.id)) }];
        assert.equal(nativeLookup.error, undefined);
        assert.deepEqual(items, nativeLookup.items, sample.name);
        assert.equal(await database.getState(liveTvStateKey), before);
      } catch (error) { differences.push({ name: sample.name, message: error.message }); }
      observations.push({ name: sample.name, kind: sample.kind, rawSha256: hash(Buffer.from(sample.bytesHex, 'hex')),
        issue, nativeReaderError: expected.error, entries: decoded?.entries.map(project), items });
    }
    assert.deepEqual(differences, []);
  } catch (error) { failure = error; }
  finally {
    const errors = [];
    try { await dropPostgresTestDatabase(database); cleanup.postgresSchemasRemoved = true; } catch (error) { errors.push(error); }
    try {
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
      assert.ok(path.basename(directory).startsWith('mm-tv-state-bytes-'));
      await rm(directory, { recursive: true }); cleanup.privateInputsRemoved = true;
    } catch (error) { errors.push(error); }
    cleanup.errors = errors.map(error => error.message);
    await writeFile(path.join(output, 'comparison.json'), JSON.stringify({ passed: !failure && !errors.length,
      releaseAcceptance: false, observations, differences, cleanup,
      error: failure && { message: failure.message, stack: failure.stack },
      boundary: 'Actual native byte reader and recording-info workflow, PostgreSQL import/query, exact raw bytes. No native server HTTP, recording execution or complete Live TV acceptance.' }, null, 2) + '\n');
    if (!failure && errors.length) failure = new AggregateError(errors, 'Saved timer byte cleanup failed.');
  }
  if (failure) throw failure;
});
