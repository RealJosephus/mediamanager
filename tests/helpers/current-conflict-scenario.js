import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tableDefinition } from '../../src/database/model.js';
import { decodeValue } from '../../src/database/values.js';
import { nativeTextBytes } from '../../src/database/native-text.js';
import { idKey } from '../../src/library/records.js';
import { nativeDateFromUnixNanoseconds } from '../../src/users/native.js';
import { filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { currentIdentityScenario, identityRowContract } from './current-identity-scenario.js';
import { recordItemFilterCandidate } from '../library/item-filter-http-scenario.js';
import { assertCompleteFilterHttpResponses } from '../library/full-filter-wire.js';

const columns = tableDefinition('BaseItems').columns;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const withoutFileContent = entries => entries.map(({ size, sha256, ...entry }) => entry);
const find = (rows, id) => rows.find(row => idKey(row.Id) === idKey(id));

export function assertCurrentConflictResult(actual, scenario, interval) {
  const { input, stages, caseStages, http, precondition } = scenario;
  const original = actual.beforeReads.BaseItems;
  const nativeOriginal = stages.before.database.BaseItems;
  const shadowId = precondition.identities.Shadow.row.Id;
  assert.equal(actual.caseStages.length, 4);
  const identities = [...new Map(Object.values(precondition.identities).map(value => [idKey(value.row.Id), value])).values()];
  for (const [index, stage] of actual.caseStages.entries()) {
    const reference = caseStages[index];
    assert.equal(stage.name, reference.name);
    assert.equal(stage.database.BaseItems.length - original.length, reference.after.database.BaseItems.length - nativeOriginal.length);
    assert.deepEqual(stage.filesystem, withoutFileContent(reference.after.filesystem));
    for (const identity of identities) {
      const row = find(stage.database.BaseItems, identity.row.Id), native = find(reference.after.database.BaseItems, identity.row.Id);
      assert.equal(Boolean(row), Boolean(native));
      if (!row) continue;
      assert.deepEqual(identityRowContract(row, interval, row.Type === input.entityType),
        identityRowContract(native, scenario.summary.interval, native.Type === input.entityType));
      if (row.Type === input.entityType) {
        const clock = actual.directoryClocks[index][identity.relative];
        assert.ok(clock);
        assert.equal(row.DateCreated, nativeDateFromUnixNanoseconds(BigInt(clock.birthtimeNs)));
        assert.equal(row.DateModified, nativeDateFromUnixNanoseconds(BigInt(clock.mtimeNs)));
      }
    }
    for (const [rows, before] of [[stage.database.BaseItems, original], [reference.after.database.BaseItems, nativeOriginal]]) {
      for (const old of before) if (!(stage.name === 'wrong-type-id' && idKey(old.Id) === idKey(shadowId))) {
        assert.deepEqual(find(rows, old.Id), old, 'Only the declared wrong-type row may replace an existing item.');
      }
    }
    for (const table of Object.keys(actual.beforeReads).filter(name => name !== 'BaseItems')) {
      assert.deepEqual(stage.database[table], actual.beforeReads[table], table);
    }
    for (const table of Object.keys(stages.before.database).filter(name => name !== 'BaseItems')) {
      assert.deepEqual(reference.after.database[table], stages.before.database[table], table);
    }
    const file = reference.after.filesystem.find(entry => entry.path === `${input.metadataDirectory}/Blocked`);
    assert.deepEqual(actual.blockedFiles[index], { size: file.size, sha256: file.sha256 });
  }
  assert.deepEqual(actual.filesystemBeforeReads, withoutFileContent(stages.before.filesystem));
  assert.deepEqual(actual.afterReads, actual.caseStages.at(-1).database);
  assert.deepEqual(actual.afterShutdown, actual.afterReads);
  assert.deepEqual(stages.afterShutdown, stages.afterReads);
  assert.deepEqual(actual.filesystemAfterReads, withoutFileContent(stages.afterReads.filesystem));
  assert.deepEqual(actual.filesystemAfterShutdown, actual.filesystemAfterReads);
  assert.deepEqual(actual.runtimeErrors, []);
  assert.deepEqual(actual.handledExpectedRuntimeErrors, []);
  assert.ok(Object.values(actual.cleanup).every(value => value === true));
  return assertCompleteFilterHttpResponses(actual, http,
    { scenarioName: `current-${input.kind}-conflict`, nativeServerId: scenario.summary.nativeServerId });
}

export async function compareCurrentConflicts(kind) {
  const discovery = await currentIdentityScenario(kind, 'conflict-discovery');
  assert.equal(discovery.summary.createdRows.length, 3);
  assert.deepEqual(discovery.caseStages[0].after, discovery.caseStages[1].after,
    'The second colliding name preserves the independently discovered native identity.');
  const byName = new Map(discovery.summary.createdRows.map(row => [row.Name, row]));
  const identities = Object.fromEntries(['Mirror/A', 'Mirror:A', 'Blocked', 'Shadow'].map(name => {
    const row = byName.get(name === 'Mirror:A' ? 'Mirror/A' : name);
    assert.ok(row);
    const relative = path.win32.basename(row.Path.replaceAll('/', '\\'));
    assert.equal(path.basename(relative), relative);
    return [name, { row, relative }];
  }));
  const precondition = { kind, identities,
    discoveryRoot: discovery.root, blockedText: `regular file prevents ${kind === 'artist' ? 'Artist' : 'Studio'} directory creation\n` };
  const scenario = { ...await currentIdentityScenario(kind, 'conflicts', { precondition }), precondition };
  const shadow = find(scenario.stages.before.database.BaseItems, identities.Shadow.row.Id);
  assert.equal(shadow.Type, 'MediaBrowser.Controller.Entities.Movies.Movie');
  const directoryClocks = [], blockedFiles = [];
  let directory;
  const interval = { startedAt: new Date().toISOString() };
  const actual = await recordItemFilterCandidate({ dialect: 'postgres', fixture: scenario.input.fixture,
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, scenarioName: `current-${kind}-conflict`,
    fields: 'SortName', captureStartIndex: true, captureResponseBodies: true, trackFilesystem: true, captureEndpointStages: true,
    async prepareScenario({ database, programDataPath }) {
      const row = Object.fromEntries(columns.map(column => [column.name, decodeValue(column,
        column.type === 'TEXT' && shadow[column.name] !== null ? nativeTextBytes(shadow[column.name]) : shadow[column.name], 'postgres')]));
      await database.insert('BaseItems', row);
      directory = path.join(programDataPath, 'metadata', scenario.input.metadataDirectory);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'Blocked'), precondition.blockedText, { flag: 'wx' });
    },
    async afterEndpoint() {
      const clocks = {};
      for (const identity of new Map(Object.values(identities).map(value => [value.relative, value])).values()) {
        const filename = path.join(directory, identity.relative);
        const info = await stat(filename, { bigint: true }).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (info?.isDirectory()) clocks[identity.relative] = { birthtimeNs: String(info.birthtimeNs), mtimeNs: String(info.mtimeNs) };
      }
      const bytes = await readFile(path.join(directory, 'Blocked'));
      blockedFiles.push({ size: bytes.length, sha256: digest(bytes) });
      directoryClocks.push(clocks);
    } });
  interval.finishedAt = new Date().toISOString();
  actual.caseStages = actual.caseStages.map(stage => ({ name: stage.name, ...stage.after }));
  Object.assign(actual, { directoryClocks, blockedFiles });
  await writeFile(path.join(scenario.root, 'candidate.json'), filterEvidenceJson(actual), { flag: 'wx' });
  const comparison = assertCurrentConflictResult(actual, scenario, interval);
  await writeFile(path.join(scenario.root, 'comparison.json'), filterEvidenceJson({ ...comparison, kind,
    completeCreatedAndReplacedRows: true, existingRowsAndRelationshipsUnchanged: true,
    directoryClocksVerified: true, blockedFileBytesVerified: true, cleanup: actual.cleanup }), { flag: 'wx' });
  return { actual, scenario, interval };
}
