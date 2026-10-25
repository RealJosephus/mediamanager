import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createTestRuntime } from '../helpers/runtime.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import { defaultConfiguration, parseConfigurationXml } from '../../src/core/configuration-xml.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { beforeSaveFileMetadata } from '../../src/metadata/file-before-save.js';
import { dateText } from '../../src/library/records.js';
import { localStateStorage } from '../helpers/local-state-storage.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';
import { validationOutputRoot, assertValidationOutputChild } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['postgres'];
const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? JSON.rawJSON(item.toString()) : item, 2) + '\n';
const failureValue = error => error == null ? null : {
  message: error.message, code: error.code, status: error.status, statusCode: error.statusCode, stack: error.stack,
  ...(error.cause !== undefined && { cause: failureValue(error.cause) }),
  ...(error.errors !== undefined && { errors: Array.from(error.errors, failureValue) }),
};
const emptyItem = () => Object.fromEntries(tableDefinition('BaseItems').columns.filter(column => !column.generated)
  .map(column => [column.name, column.nullable ? null : column.clrType === 'bool' ? false
    : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));

test('postgres: named metadata POST reaches a retained file-save context and current encoding reaches real System Info paths', {
  skip: !postgresTestConnectionString, timeout: 120000,
}, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'named-configuration-runtime-')); assertValidationOutputChild(root);
  const programDataPath = path.join(root, 'data'), configurationDirectoryPath = path.join(root, 'config');
  const report = { schemaVersion: 1, scope: 'Formal runtime named HTTP registration, Local file lookup across metadata replacement, PostgreSQL save, encoding System Info directory creation and cold reopen.',
    actualNativeExecuted: false, excluded: ['whole metadata refresh and ffprobe', 'same-request Native concurrency replay'],
    http: [], cases: [], errors: [], cleanup: {}, phaseAcceptance: false, releaseAcceptance: false };
  const failures = [], pending = new Set();
  let runtime, database, storage, token, origin, active;
  const create = async () => {
    runtime = await createTestRuntime({ database, programDataPath, configurationDirectoryPath,
      configuration: { ...defaultConfiguration('server'), IsStartupWizardCompleted: true },
      serverId: 'named-configuration-runtime', vfs: storage.fileSystem.vfs, identityMap: storage.fileSystem.identityMap,
      onError: error => report.errors.push(failureValue(error)) });
    origin = 'http://127.0.0.1:' + runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port;
  };
  const call = async (route, body) => {
    const observation = { route, method: body === undefined ? 'GET' : 'POST', requestBody: body === undefined ? null : json(body) };
    report.http.push(observation);
    try {
      const response = await fetch(origin + route, { method: observation.method, signal: t.signal,
        headers: { Accept: 'application/json', 'X-Emby-Token': token,
          ...(body !== undefined && { 'Content-Type': 'application/json' }) },
        ...(body !== undefined && { body: observation.requestBody }) });
      const bytes = Buffer.from(await response.arrayBuffer()), text = bytes.toString();
      Object.assign(observation, { status: response.status, headers: Object.fromEntries(response.headers), text, bodyBase64: bytes.toString('base64'),
        value: text && response.headers.get('content-type')?.includes('json') ? parseLosslessJson(text) : null });
      assert.equal(response.status, body === undefined ? 200 : 204, route + ': ' + text);
      return observation.value;
    } catch (error) { observation.failure = failureValue(error); throw error; }
  };
  const cancelled = Promise.withResolvers(); void cancelled.promise.catch(() => {});
  const abort = () => { active?.release.resolve(); cancelled.reject(t.signal.reason); };
  t.signal.addEventListener('abort', abort);
  try {
    storage = await localStateStorage(root);
    database = await createPostgresTestDatabase(null, 'named_runtime');
    await create(); token = (await runtime.apiKeys.create('Named configuration runtime')).AccessToken;
    const metadataFile = path.join(configurationDirectoryPath, 'metadata.xml'), encodingFile = path.join(configurationDirectoryPath, 'encoding.xml');
    await call('/System/Configuration/metadata', { UseFileCreationTimeForDateAdded: false });
    const initialDate = '2020-01-01T00:00:00.0000000Z', sourceBytes = Buffer.from('Opaque original file bytes; this date-only operation does not start a media executor.');
    let encoding = await call('/System/Configuration/encoding');
    for (const [index, scenario] of [{ before: false, after: true }, { before: true, after: false }].entries()) {
      const observation = { ...scenario }; report.cases.push(observation);
      const Id = 'F82A0000-0000-0000-0000-' + String(index + 1).padStart(12, '0');
      const filename = path.join(root, 'media', 'dates-' + index + '.bin'); await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(filename, sourceBytes); await fs.utimes(filename, new Date('2024-06-02T12:34:56Z'), new Date('2024-06-02T12:34:56Z'));
      await database.insert('BaseItems', { ...emptyItem(), Id, Type: 'MediaBrowser.Controller.Entities.Audio.Audio', Name: 'Dates ' + index,
        SortName: 'dates ' + index, CleanName: 'dates ' + index, Path: filename, IsFolder: false, Data: '{}',
        DateCreated: initialDate, DateModified: '2000-01-01T00:00:00.0000000Z', DateLastRefreshed: '2026-01-01T00:00:00.0000000Z' });
      observation.beforeRows = await database.rows('BaseItems', { where: { Id } });
      const loaded = await runtime.metadata.loadContext(Id);
      active = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
      const admission = active;
      const work = (async () => {
        try {
          assert.equal(loaded.metadataConfiguration.UseFileCreationTimeForDateAdded, scenario.before);
          const fileInformation = loaded.fileSystemMetadata;
          loaded.fileSystemMetadata = async () => {
            const info = await fileInformation(); observation.fileInformation = info;
            admission.entered.resolve(); await admission.release.promise; return info;
          };
          observation.reason = await beforeSaveFileMetadata(loaded.item, loaded, { vfs: storage.fileSystem.vfs });
          observation.beforeRepository = { DateCreated: loaded.item.DateCreated, DateModified: loaded.item.DateModified };
          await runtime.metadataUpdates.update(loaded, { Item: loaded.item }, observation.reason);
        } finally { await loaded.dispose(); }
      })();
      pending.add(work); void work.catch(() => {});
      try {
        await Promise.race([admission.entered.promise, cancelled.promise, work.then(() => { throw new Error('The real file lookup must precede the save.'); })]);
        await call('/System/Configuration/metadata', { UseFileCreationTimeForDateAdded: scenario.after });
        observation.currentWhilePending = await call('/System/Configuration/metadata');
        assert.equal(loaded.metadataConfiguration.UseFileCreationTimeForDateAdded, scenario.after);
        admission.release.resolve(); await work;
        observation.afterRows = await database.rows('BaseItems', { where: { Id } });
        const saved = observation.afterRows[0], expectedDate = scenario.after ? dateText(observation.fileInformation.created) : initialDate;
        assert.equal(dateText(saved.DateCreated), expectedDate);
        assert.equal(dateText(saved.DateModified), dateText(observation.fileInformation.modified));
        const retained = await fs.readFile(filename); observation.originalFileBase64 = retained.toString('base64'); assert.deepEqual(retained, sourceBytes);
        const metadataBytes = await fs.readFile(metadataFile); observation.metadataXmlBase64 = metadataBytes.toString('base64');
        assert.equal(parseConfigurationXml(metadataBytes, 'metadata').UseFileCreationTimeForDateAdded, scenario.after);
      } finally { admission.release.resolve(); await Promise.allSettled([work]); pending.delete(work); active = undefined; }

      const transcodePath = path.join(root, 'transcodes-' + index); await fs.mkdir(transcodePath);
      encoding = { ...encoding, TranscodingTempPath: transcodePath };
      await call('/System/Configuration/encoding', encoding);
      assert.deepEqual(await call('/System/Configuration/encoding'), encoding);
      const info = await call('/System/Info'); observation.systemInfo = info;
      assert.equal(info.TranscodingTempPath, transcodePath);
      assert.equal((await fs.stat(transcodePath)).isDirectory(), true);
      assert.deepEqual(await fs.readFile(path.join(transcodePath, '.jellyfin-transcode')), Buffer.alloc(0));
      assert.deepEqual(await call('/System/Configuration/metadata'), { UseFileCreationTimeForDateAdded: scenario.after });
      observation.encodingXmlBase64 = (await fs.readFile(encodingFile)).toString('base64');
    }
    const audioRows = async () => (await database.rows('BaseItems', { where: { Type: 'MediaBrowser.Controller.Entities.Audio.Audio' } }))
      .sort((left, right) => left.Id < right.Id ? -1 : left.Id > right.Id ? 1 : 0);
    const expectedRows = await audioRows();
    const schema = database.schemaName; await runtime.close(); runtime = undefined;
    await assert.rejects(database.rows('BaseItems'), /closed|not open/iu);
    database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema }); await create();
    assert.deepEqual(await call('/System/Configuration/metadata'), { UseFileCreationTimeForDateAdded: false });
    assert.deepEqual(await call('/System/Configuration/encoding'), encoding);
    assert.equal((await call('/System/Info')).TranscodingTempPath, encoding.TranscodingTempPath);
    const coldRows = await audioRows();
    assert.deepEqual(coldRows, expectedRows); report.coldRows = coldRows; assert.deepEqual(report.errors, []);
  } catch (error) { failures.push(error); }
  finally {
    t.signal.removeEventListener('abort', abort); active?.release.resolve();
    for (const result of await Promise.allSettled([...pending])) if (result.status === 'rejected') failures.push(result.reason);
    try { await runtime?.close(); report.cleanup.runtimeClosed = runtime ? !runtime.networkHost.listeners.some(listener => listener.server.listening) : null; } catch (error) { failures.push(error); }
    try { await storage?.close(); report.cleanup.storageClosed = true; } catch (error) { failures.push(error); }
    try { await dropPostgresTestDatabase(database); report.cleanup.postgresSchemaRemoved = true; } catch (error) { failures.push(error); }
    try { assert.deepEqual(report.errors, []); } catch (error) { failures.push(error); }
    report.failures = failures.map(failureValue); report.completed = failures.length === 0;
    await fs.writeFile(path.join(root, 'comparison.json'), json(report), { flag: 'wx' });
    t.diagnostic(json({ report: path.join(root, 'comparison.json'), completed: report.completed }));
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'Named runtime consumers and cleanup failed.', { cause: failures[0] });
});
