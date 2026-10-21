import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { quoteIdentifier as q } from '../../src/database/model.js';
import { transferDatabase, databaseDigest } from '../../src/migration/database-transfer.js';
import { cloneStoppedInstance } from '../../src/migration/instance-copy.js';
import { discoverInstanceState } from '../../src/migration/instance-state.js';
import { createIsolatedOfflineCopyCaptureSession } from '../../src/migration/capture-session.js';
import { createStatePackage, restoreStatePackage, verifyStatePackage } from '../../src/migration/state-package.js';
import { liveTvStateKey } from '../../src/library/live-tv-state.js';
import { initializeLiveTvState } from '../../src/database/live-tv-state-import.js';
import { queryPostgresProgramRecordingInfo } from '../../src/library/postgres-live-tv-state-query.js';
import { idKey } from '../../src/library/records.js';
import { currentNativeSqliteInputs } from '../../tools/validation/current-native-sqlite-inputs.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';

export const requiredValidationServices = ['postgres', 'currentNativeSqlite', 'dotnet', 'jellyfinDll'];
const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2) + '\n';

test('current native state package binds saved Live TV documents to PostgreSQL and reimports their native meaning', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || !process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE
    || !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 300000,
}, async () => {
  const output = path.join(validationOutputRoot(), 'live-tv-state-package-' + randomUUID());
  await mkdir(output);
  const directory = await mkdtemp(path.join(tmpdir(), 'mm-tv-state-package-'));
  const report = { cleanup: {} };
  let database, reimported, source, restored, failure;
  try {
    const supplied = await currentNativeSqliteInputs();
    const sourceState = await discoverInstanceState({ instanceRoot: supplied.initialization.root });
    const cloned = await cloneStoppedInstance({ instanceState: sourceState, destination: path.join(directory, 'instance') });
    assert.equal(hash(await readFile(cloned.paths.sqlite)), supplied.receipt.input.sha256);
    source = new SqliteDatabase(cloned.paths.sqlite, { requireMigrationHistory: true });
    source.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    source.database.exec('PRAGMA journal_mode=DELETE');
    const sample = JSON.parse(await readFile(new URL('../library/fixtures/live-tv-state/input.json', import.meta.url))).lookups[0];
    const liveTvPath = path.join(cloned.paths.programData, 'data/livetv');
    await mkdir(liveTvPath, { recursive: true });
    const documents = [['timers.json', sample.timers], ['seriestimers.json', sample.seriesTimers]];
    for (const [filename, text] of documents) await writeFile(path.join(liveTvPath, filename), text);
    const state = await discoverInstanceState({ instanceRoot: cloned.instanceRoot });
    database = await createPostgresTestDatabase(null, 'tv_package');
    const binding = current => ({ serverId: current.identity.serverId, originIdentityDigest: current.identity.digest });
    report.imported = await transferDatabase(source, database, {
      instanceBinding: binding(state), portableMountContract: supplied.receipt.mountContract,
    });
    source.close(); source = undefined;
    for (const program of sample.programs) await database.insert('BaseItems', postgresTestRow('BaseItems', {
      Id: program.id.toUpperCase(), Name: 'Saved guide program', Type: 'MediaBrowser.Controller.LiveTv.LiveTvProgram',
      ExternalId: program.externalId, ExternalSeriesId: program.externalSeriesId,
    }));
    assert.equal(await database.transaction(db => initializeLiveTvState(db, { dataPath: path.dirname(liveTvPath) })), true);
    const originalState = await database.getState(liveTvStateKey), before = await databaseDigest(database);
    const lookup = db => queryPostgresProgramRecordingInfo(db, sample.programs.map(program => program.id));
    const project = values => sample.programs.map(program => ({ id: idKey(program.id), ...values.get(idKey(program.id)) }));
    const originalLinks = project(await database.transaction(lookup));
    const capture = async name => {
      const instanceState = await discoverInstanceState({ instanceRoot: cloned.instanceRoot });
      return createStatePackage({ database, instanceState, destination: path.join(directory, name),
        baseline: 'current-native-' + supplied.receipt.input.sha256,
        captureSession: createIsolatedOfflineCopyCaptureSession({ instanceState,
          ownerId: path.basename(directory), assertHeld: () => database.preflight() }) });
    };
    const manifest = await capture('package');
    assert.equal(manifest.source.database.liveTvState.files.length, 2);
    assert.deepEqual(manifest.source.database.liveTvState.files.map(file => ({ bytes: file.bytes, sha256: file.sha256 })),
      documents.map(([, text]) => ({ bytes: Buffer.byteLength(text), sha256: hash(text) })));
    await verifyStatePackage(path.join(directory, 'package'));
    const returned = await restoreStatePackage(path.join(directory, 'package'), path.join(directory, 'restored'));
    const returnedState = await discoverInstanceState({ instanceRoot: returned.destination });
    restored = new SqliteDatabase(returnedState.paths.sqlite, { readOnly: true, requireMigrationHistory: true });
    assert.deepEqual(await databaseDigest(restored), manifest.database.tables);
    const returnedDocuments = [];
    for (const [filename, text] of documents) {
      const actual = await readFile(path.join(returnedState.paths.programData, 'data/livetv', filename));
      assert.deepEqual(actual, Buffer.from(text));
      returnedDocuments.push(actual.toString('utf8'));
    }
    reimported = await createPostgresTestDatabase(null, 'tv_returned');
    await transferDatabase(restored, reimported, {
      instanceBinding: binding(returnedState), portableMountContract: supplied.receipt.mountContract,
    });
    assert.equal(await reimported.transaction(db => initializeLiveTvState(db, {
      dataPath: path.join(returnedState.paths.programData, 'data'),
    })), true);
    assert.equal(await reimported.getState(liveTvStateKey), originalState);
    assert.deepEqual(project(await reimported.transaction(lookup)), originalLinks);
    restored.close(); restored = undefined;

    const nativeInput = { documents: returnedDocuments.map((text, index) => ({ text,
      name: documents[index][0], kind: index === 0 ? 'timers' : 'seriesTimers' })),
    lookups: [{ ...sample, timers: returnedDocuments[0], seriesTimers: returnedDocuments[1] }] };
    const nativeInputFile = path.join(output, 'native-input.json'), inputBytes = Buffer.from(json(nativeInput));
    await writeFile(nativeInputFile, inputBytes, { flag: 'wx' });
    const record = await recordOracle({ project: 'tests/library/fixtures/live-tv-state/Oracle.csproj',
      output: path.join(output, 'native'), args: [nativeInputFile, '{output}/native.json'] });
    const native = JSON.parse(await readFile(path.join(output, 'native/native.json')));
    assert.ok(record.passed && native.actualItemDataProvider && native.actualRecordingInfo && native.privateInputsRemoved);
    assert.equal(native.recordingExecutorsStarted, false);
    assert.equal(native.inputSha256, hash(inputBytes));
    assert.equal(native.lookups[0].error, undefined);
    assert.deepEqual(native.lookups[0].items, originalLinks);

    const timerFile = path.join(liveTvPath, 'timers.json');
    await writeFile(timerFile, '[]');
    assert.equal(await database.transaction(db => initializeLiveTvState(db, { dataPath: path.dirname(liveTvPath) })), false);
    assert.deepEqual(project(await database.transaction(lookup)), originalLinks);
    await assert.rejects(capture('edited-source'), /native file differs from PostgreSQL Live TV state/u);
    await unlink(timerFile);
    await assert.rejects(capture('deleted-source'), /native file differs from PostgreSQL Live TV state/u);
    await writeFile(timerFile, documents[0][1]);
    const corrupt = JSON.parse(originalState);
    corrupt.timers.sourceSha256 = 'f'.repeat(64);
    await database.setState(liveTvStateKey, json(corrupt));
    await assert.rejects(capture('invalid-state'), /invalid native exchange documents/u);
    await database.setState(liveTvStateKey, originalState);

    // Missing native files are a distinct saved state. A file appearing after
    // that import cannot silently become the exported authority either.
    for (const [filename] of documents) await unlink(path.join(liveTvPath, filename));
    await database.client.query(`DELETE FROM ${q(database.controlSchema)}.state WHERE key = $1`, [liveTvStateKey]);
    assert.equal(await database.transaction(db => initializeLiveTvState(db, { dataPath: path.dirname(liveTvPath) })), true);
    const absent = await capture('absent-documents');
    assert.deepEqual(absent.source.database.liveTvState.files.map(file => [file.bytes, file.sha256]), [[null, null], [null, null]]);
    await verifyStatePackage(path.join(directory, 'absent-documents'));
    await writeFile(timerFile, '[]');
    await assert.rejects(capture('unexpected-source'), /native file differs from PostgreSQL Live TV state/u);
    for (const [filename, text] of documents) await writeFile(path.join(liveTvPath, filename), text);
    await database.setState(liveTvStateKey, originalState);
    assert.equal(await database.getState(liveTvStateKey), originalState);
    assert.deepEqual(project(await database.transaction(lookup)), originalLinks);
    assert.deepEqual(await databaseDigest(database), before);
    report.input = { sqliteSha256: supplied.receipt.input.sha256, bindings: supplied.inputs,
      build: supplied.initialization.build, nativeInputSha256: hash(inputBytes) };
    report.comparison = { passed: true, releaseAcceptance: false, liveTvState: manifest.source.database.liveTvState,
      rawDocumentsPreserved: true, completeNativeDatabasePreserved: true, reimportedLinks: originalLinks,
      nativeReaderDocuments: native.documents.length, nativeReaderLinks: native.lookups[0].items.length,
      changedAndDeletedSourcesRejected: true, invalidPostgresSourceDigestRejected: true,
      absentDocumentsPreserved: true, unexpectedSourceRejected: true,
      postgresSourceUnchanged: true, recordingExecutorsStarted: false };
  } catch (error) { failure = error; report.error = { message: error.message, stack: error.stack }; }
  finally {
    const errors = [];
    for (const handle of [source, restored]) try { handle?.close(); } catch (error) { errors.push(error); }
    for (const db of [database, reimported]) try { await dropPostgresTestDatabase(db); } catch (error) { errors.push(error); }
    report.cleanup.postgresSchemasRemoved = errors.length === 0;
    try {
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
      assert.ok(path.basename(directory).startsWith('mm-tv-state-package-'));
      await rm(directory, { recursive: true });
      report.cleanup.privateInstanceRemoved = true;
    } catch (error) { errors.push(error); }
    report.cleanup.errors = errors.map(error => error.message);
    await writeFile(path.join(output, 'report.json'), json(report));
    if (!failure && errors.length) failure = new AggregateError(errors, 'Live TV state package cleanup failed.');
  }
  if (failure) throw failure;
});
