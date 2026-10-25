import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tableDefinition } from '../../src/database/model.js';
import { decodeValue } from '../../src/database/values.js';
import { nativeTextBytes } from '../../src/database/native-text.js';
import { idKey } from '../../src/library/records.js';
import { nativeDateFromUnixNanoseconds } from '../../src/users/native.js';
import { assertValidationOutputChild } from '../../tools/validation/paths.js';
import { assertCompleteFilterHttpResponses } from './full-filter-wire.js';
import { recordItemFilterCandidate } from './item-filter-http-scenario.js';
import { assertNativeConflictOutput, nativeConflictBinding, verifyNativeConflictRecording } from './native-conflict-inputs.js';

const columns = tableDefinition('BaseItems').columns;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const guid = value => {
  const key = idKey(value);
  assert.match(key, /^[a-f0-9]{32}$/u);
  return `${key.slice(0, 8)}-${key.slice(8, 12)}-${key.slice(12, 16)}-${key.slice(16, 20)}-${key.slice(20)}`.toUpperCase();
};
const projectRow = source => {
  assert.deepEqual(Object.keys(source).sort(), columns.map(column => column.name).sort());
  return Object.fromEntries(columns.map(column => [column.name,
    source[column.name] != null && column.clrType.replace('?', '') === 'Guid'
      ? guid(source[column.name]) : decodeValue(column,
        column.type === 'TEXT' && source[column.name] !== null ? nativeTextBytes(source[column.name]) : source[column.name], 'postgres')]));
};

function comparableRow(row, byNameType) {
  if (row == null) return null;
  assert.deepEqual(Object.keys(row).sort(), columns.map(column => column.name).sort());
  return Object.fromEntries(columns.map(column => {
    let value = row[column.name];
    if (row.Type === byNameType && ['DateCreated', 'DateModified'].includes(column.name)) {
      assert.match(value, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d{1,7})?$/u);
      value = '$directory-clock';
    } else if (value != null && ['long', 'uint'].includes(column.clrType.replace('?', ''))) {
      if (typeof value === 'number') assert.equal(Number.isSafeInteger(value), true);
      value = BigInt(value).toString();
    } else if (typeof value === 'boolean') value = Number(value);
    return [column.name, value];
  }));
}

function nativeTree(stage, kind) {
  const domain = kind === 'artist' ? 'artists' : 'Studio';
  return [{ path: domain, type: 'directory' }, ...stage[kind + 'Tree']
    .map(entry => ({ path: `${domain}/${entry.path}`, type: entry.type }))]
    .sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

export function assertNativeConflictResult(actual, scenario) {
  const { kind, recording, reference, stages, nativeServerId, scenarioName } = scenario;
  const byNameType = kind === 'artist' ? 'MediaBrowser.Controller.Entities.Audio.MusicArtist' : 'MediaBrowser.Controller.Entities.Studio';
  const comparison = assertCompleteFilterHttpResponses(actual,
    { records: reference.records.map(record => ({ ...record, endpoint: 'items' })) }, { scenarioName, nativeServerId });
  assert.equal(actual.httpCases, reference.records.length);
  assert.equal(actual.caseStages.length, reference.records.length);
  for (const [index, record] of reference.records.entries()) {
    const endpoint = actual.cases[index].endpoints[0].contract;
    const expected = record.response.bodyJson;
    assert.equal(endpoint.status, record.response.status, record.name);
    assert.equal(endpoint.contentType, record.response.contentType, record.name);
    assert.equal(endpoint.totalRecordCount, expected.TotalRecordCount, record.name);
    assert.equal(endpoint.startIndex, expected.StartIndex, record.name);
    assert.equal(endpoint.keys.length, expected.Items.length, record.name);
    const stage = actual.caseStages[index];
    const nativeStage = stages[record.name];
    assert.equal(stage.name, record.name);
    assert.equal(stage.database.BaseItems.length - actual.beforeReads.BaseItems.length,
      nativeStage.database.baseItemsCount - stages.before.database.baseItemsCount, record.name);
    assert.deepEqual(stage.filesystem, nativeTree(nativeStage, kind), record.name + ':tree');
    for (const watched of nativeStage.database.watchedRows) {
      const observed = stage.database.BaseItems.find(row => idKey(row.Id) === idKey(watched.id)) ?? null;
      assert.deepEqual(comparableRow(observed, byNameType), comparableRow(watched.row, byNameType),
        record.name + ':' + watched.name + ':all72');
      if (observed?.Type === byNameType) {
        const clock = actual.directoryClocks[index][watched.name];
        assert.ok(clock);
        assert.equal(observed.DateCreated, nativeDateFromUnixNanoseconds(BigInt(clock.birthtimeNs)));
        assert.equal(observed.DateModified, nativeDateFromUnixNanoseconds(BigInt(clock.mtimeNs)));
      }
    }
    for (const old of actual.beforeReads.BaseItems) {
      const isReplacedShadow = record.name === 'wrong-type-id'
        && idKey(old.Id) === idKey(recording.nativeMeasuredIdentities.Shadow.Id);
      if (!isReplacedShadow) assert.deepEqual(stage.database.BaseItems.find(row => row.Id === old.Id), old);
    }
    for (const table of Object.keys(actual.beforeReads).filter(name => name !== 'BaseItems')) {
      assert.deepEqual(stage.database[table], actual.beforeReads[table], record.name + ':' + table);
    }
    const file = nativeStage[kind + 'Tree'].find(entry => entry.path === recording.nativeMeasuredIdentities.Blocked.relative);
    assert.deepEqual(actual.blockedFiles[index], { size: file.size, sha256: file.sha256 });
  }
  assert.deepEqual(actual.filesystemBeforeReads, nativeTree(stages.before, kind));
  assert.deepEqual(actual.filesystemAfterReads, nativeTree(stages['wrong-type-id'], kind));
  assert.deepEqual(actual.filesystemAfterShutdown, actual.filesystemAfterReads);
  for (const table of Object.keys(actual.beforeReads).filter(name => name !== 'BaseItems')) {
    assert.deepEqual(actual.afterReads[table], actual.beforeReads[table], table);
  }
  assert.deepEqual(actual.runtimeErrors, []);
  assert.deepEqual(actual.handledExpectedRuntimeErrors, []);
  assert.deepEqual(actual.cleanup, { runtimeClosed: true, databaseClosed: true, portReleased: true,
    postgresSchemasRemoved: true, programDataDirectoryRemoved: true });
  return { ...comparison, watchedRows: reference.records.length * stages.before.database.watchedRows.length,
    observedTables: Object.keys(actual.beforeReads), full72ColumnComparison: true, candidateDirectoryClocksVerified: true,
    blockedFileBytesVerified: true, releaseAcceptance: false };
}

export async function recordNativeConflictCandidate(kind, connectionString) {
  const scenario = { ...await verifyNativeConflictRecording(kind), kind, scenarioName: kind + '-conflict' };
  const { recording, reference, stages, scenarioName } = scenario;
  const bootstrap = JSON.parse(await readFile(nativeConflictBinding.preparationInputFiles[0].filename, 'utf8'));
  scenario.nativeServerId = bootstrap.observations.find(entry => entry.route === '/Users/AuthenticateByName').responseBody.SessionInfo.ServerId;
  const initialRows = stages.before.fullDatabase.tables.BaseItems;
  const selectedId = new URL(reference.records[0].route, reference.origin).searchParams.get('Ids');
  const movie = initialRows.find(row => idKey(row.Id) === idKey(selectedId));
  assert.equal(movie.Type, 'MediaBrowser.Controller.Entities.Movies.Movie');
  const root = initialRows.find(row => idKey(row.Id) === idKey(movie.ParentId));
  assert.equal(root.Type, 'MediaBrowser.Controller.Entities.Folder');
  const fixture = { schemaVersion: 1, userId: recording.preparation.identityRemapping.fixtureUserId, rootId: root.Id,
    items: [{ key: 'root', id: root.Id, name: root.Name, type: 'Folder', isFolder: true },
      { key: 'controlledMovie', id: movie.Id, name: movie.Name, type: 'Movie', parentId: root.Id, topParentId: root.Id }],
    cases: reference.records.map(record => ({ name: record.name,
      query: `${kind === 'artist' ? 'Artists' : 'Studios'}=${encodeURIComponent(record[kind])}`,
      scope: ['controlledMovie'], omitParentId: true, recursive: null, omitSortBy: true, endpoints: ['items'] })) };
  const directoryClocks = [], blockedFiles = [];
  const domain = kind === 'artist' ? 'artists' : 'Studio';
  let metadataDirectory;
  const actual = await recordItemFilterCandidate({ dialect: 'postgres', fixture, connectionString, scenarioName,
    fields: 'SortName', captureStartIndex: true, captureResponseBodies: true, trackFilesystem: true, captureCaseStages: true,
    async prepareScenario({ database, programDataPath }) {
      // Only sealed pre-request rows and native discovery identities seed input.
      for (const source of [root, movie]) {
        const { Id, ...values } = projectRow(source);
        assert.equal(await database.update('BaseItems', { Id }, values), 1n);
      }
      const shadow = initialRows.find(row => idKey(row.Id) === idKey(recording.nativeMeasuredIdentities.Shadow.Id));
      assert.equal(shadow.Type, 'MediaBrowser.Controller.Entities.Movies.Movie');
      await database.insert('BaseItems', projectRow(shadow));
      metadataDirectory = path.join(programDataPath, 'metadata', domain);
      await mkdir(metadataDirectory, { recursive: true });
      const relative = recording.nativeMeasuredIdentities.Blocked.relative;
      assert.equal(path.basename(relative), relative);
      const bytes = Buffer.from(`regular file prevents ${kind === 'artist' ? 'Artist' : 'Studio'} directory creation\n`);
      const sourceFile = stages.before[kind + 'Tree'].find(entry => entry.path === relative);
      assert.equal(bytes.length, sourceFile.size);
      assert.equal(sha256(bytes), sourceFile.sha256);
      await writeFile(path.join(metadataDirectory, relative), bytes, { flag: 'wx' });
    },
    async afterEndpoint() {
      const clocks = {};
      for (const [name, identity] of Object.entries(recording.nativeMeasuredIdentities)) {
        assert.equal(path.basename(identity.relative), identity.relative);
        const filename = path.join(metadataDirectory, identity.relative);
        const metadata = await stat(filename, { bigint: true }).catch(error => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (metadata?.isDirectory()) clocks[name] = { birthtimeNs: metadata.birthtimeNs.toString(), mtimeNs: metadata.mtimeNs.toString() };
        else if (name === 'Blocked') {
          assert.equal(metadata.isFile(), true);
          const bytes = await readFile(filename);
          assert.equal(BigInt(bytes.length), metadata.size);
          blockedFiles.push({ size: bytes.length, sha256: sha256(bytes) });
        }
      }
      directoryClocks.push(clocks);
    } });
  Object.assign(actual, { directoryClocks, blockedFiles });
  let output;
  if (process.env.MEDIAMANAGER_CONFLICT_EVIDENCE) {
    const evidenceRoot = assertNativeConflictOutput(assertValidationOutputChild(path.resolve(process.env.MEDIAMANAGER_CONFLICT_EVIDENCE)));
    await mkdir(evidenceRoot, { recursive: true });
    output = assertNativeConflictOutput(assertValidationOutputChild(path.join(evidenceRoot, scenarioName)));
    await mkdir(output);
    await writeFile(path.join(output, 'postgres.json'), JSON.stringify(actual,
      (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n', { flag: 'wx' });
  }
  const comparison = assertNativeConflictResult(actual, scenario);
  if (output) await writeFile(path.join(output, 'comparison.json'), JSON.stringify(comparison, null, 2) + '\n', { flag: 'wx' });
  return { actual, scenario, comparison };
}
