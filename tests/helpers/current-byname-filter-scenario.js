import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tableDefinition } from '../../src/database/model.js';
import { dateTicks, idKey } from '../../src/library/records.js';
import { assertCompleteFilterHttpResponses } from '../library/full-filter-wire.js';
import { projectIdentifiers, projectNativeByNameCandidateInput, seedNativeByNameFilterInput } from './byname-filter-input.js';
import { recordItemFilterCandidate } from '../library/item-filter-http-scenario.js';
import { filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? entry.toString() : entry, 2) + '\n';

export async function loadCurrentByNameScenario(kind, root, fixtureBytes, executionInterval,
  { fixture = JSON.parse(fixtureBytes), mode = 'main' } = {}) {
  const load = async name => JSON.parse(await readFile(path.join(root, name), 'utf8'));
  const provenance = await load('provenance.json');
  for (const artifact of provenance.artifacts) {
    assert.equal(path.basename(artifact.path), artifact.path);
    assert.equal(digest(await readFile(path.join(root, artifact.path))), artifact.sha256, artifact.path);
  }
  const [profile, http, stages, summary, filesystem, contract] = await Promise.all([
    'current-profile.json', 'native-http.json', 'database-stages.json', 'summary.json', 'filesystem-stages.json', 'native-contract.json',
  ].map(load));
  assert.equal(profile.kind, 'current-designated-source-http');
  assert.equal(profile.initializedFromEmpty, true);
  assert.equal(profile.stopped, true);
  assert.equal(profile.historicalRecordingReused, false);
  assert.equal(summary.passed, true);
  const cleanup = await load('private-cleanup.json');
  assert.equal(cleanup.privateInstanceRemoved, true);
  assert.equal(cleanup.publicFilesAreReportsOnly, true);
  assert.equal(contract.fixtureInputSha256, digest(fixtureBytes));
  assert.equal(contract.mode, mode);
  assert.equal(contract.cases.length, fixture.cases.length);
  assert.deepEqual(contract.cases.map(entry => entry.name), fixture.cases.map(entry => entry.name));
  const setup = kind === 'artist' ? null : await load('native-setup.json');
  const mapping = setup?.graph.fixtureKeyMapping ?? {};
  const identifiers = new Map(Object.values(mapping).map(entry => [idKey(entry.actualId), entry.fixtureId]));
  assert.equal(identifiers.size, Object.keys(mapping).length);
  assert.equal(new Set([...identifiers.values()].map(idKey)).size, identifiers.size);
  const [identity, ...remaining] = http.records;
  assert.equal(identity.request.route, '/Users/Me');
  assert.equal(identity.response.status, 200);
  assert.equal(idKey(identity.response.bodyJson.Id), idKey(profile.actualUserId));
  assert.equal(identity.response.bodyJson.Policy.IsAdministrator, true);
  const shutdown = remaining.pop();
  assert.equal(shutdown.request.route, '/System/Shutdown');
  assert.equal(shutdown.response.status, 204);
  const records = remaining.map(record => {
    assert.equal(record.request.method, 'GET');
    const separator = record.name.lastIndexOf(':');
    const name = record.name.slice(0, separator), endpoint = record.name.slice(separator + 1);
    assert.ok(separator > 0 && ['items', 'legacy'].includes(endpoint));
    const response = { ...record.response, contentType: record.response.headers['content-type'] };
    if (response.contentType?.includes('json')) {
      assert.deepEqual(JSON.parse(response.bodyText), response.bodyJson);
      response.bodyJson = projectIdentifiers(response.bodyJson, identifiers);
      response.bodyText = JSON.stringify(response.bodyJson);
    } else if (response.bodyJson === null) delete response.bodyJson;
    return { name, endpoint, request: record.request, response };
  });
  assert.equal(records.length, fixture.cases.reduce((sum, entry) => sum + (entry.endpoints ?? ['items', 'legacy']).length, 0));
  return { kind, mode, root, fixture, profile, http, records, stages, filesystem, contract, mapping, identifiers, executionInterval,
    nativeServerId: profile.nativeServerId };
}

function assertMutations(actual, scenario, candidateInterval) {
  const nativeBefore = scenario.stages.beforeReads.tables, nativeAfter = scenario.stages.afterReads.tables;
  const candidateBefore = actual.beforeReads, candidateAfter = actual.afterReads;
  const added = (before, after) => {
    const ids = new Set(before.BaseItems.map(row => idKey(row.Id)));
    assert.deepEqual(after.BaseItems.filter(row => ids.has(idKey(row.Id))), before.BaseItems,
      'Every existing item remains unchanged during filter reads.');
    for (const table of Object.keys(before).filter(name => name !== 'BaseItems')) {
      assert.equal(filterEvidenceJson(after[table]), filterEvidenceJson(before[table]), `Filter reads preserve ${table}.`);
    }
    return after.BaseItems.filter(row => !ids.has(idKey(row.Id)));
  };
  const nativeRows = added(nativeBefore, nativeAfter), candidateRows = added(candidateBefore, candidateAfter);
  assert.equal(candidateRows.length, nativeRows.length);
  const key = row => JSON.stringify([row.Type, row.Name, JSON.parse(row.Data ?? '{}').ViewType ?? null]);
  const candidateByKey = new Map(candidateRows.map(row => [key(row), row]));
  assert.equal(candidateByKey.size, candidateRows.length, 'Created by-name entries have distinct observed identities.');
  const ids = new Map(scenario.identifiers);
  ids.set(idKey(scenario.profile.actualUserId), actual.userId);
  for (const row of nativeRows) {
    const candidate = candidateByKey.get(key(row));
    assert.ok(candidate, key(row));
    if (row.Type === 'MediaBrowser.Controller.Entities.UserView') {
      assert.equal(scenario.kind, 'album');
      assert.equal(JSON.parse(row.Data).ViewType, 'playlists');
      ids.set(idKey(row.Id), candidate.Id);
    } else assert.equal(idKey(candidate.Id), idKey(row.Id), 'By-name identity remains equal across isolated instance roots.');
  }
  const replaceIdentity = (value, mapping) => {
    if (Array.isArray(value)) return value.map(entry => replaceIdentity(entry, mapping));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, replaceIdentity(entry, mapping)]));
    if (typeof value !== 'string') return value;
    if (mapping.has(idKey(value))) return idKey(mapping.get(idKey(value)));
    // Only the generated UserView directory contains a per-user identifier.
    const match = /^(%MetadataPath%[\\/]views[\\/])([a-f0-9]{32})$/iu.exec(value);
    return match && mapping.has(idKey(match[2])) ? match[1] + idKey(mapping.get(idKey(match[2]))) : value;
  };
  const clocks = new Set(['DateCreated', 'DateModified', 'DateLastSaved', 'DateLastRefreshed']);
  const columns = tableDefinition('BaseItems').columns;
  const project = (row, mapping, interval) => Object.fromEntries(columns.map(column => {
    const name = column.name, value = row[name];
    if (clocks.has(name) && value != null) {
      const ticks = dateTicks(value);
      if (ticks === 0n) return [name, '$minimum-date'];
      assert.ok(ticks >= dateTicks(interval.startedAt) && ticks < dateTicks(interval.finishedAt) + 10000n,
        `Created ${name} falls within the actual operation interval.`);
      return [name, '$creation-clock'];
    }
    if (name === 'Data' && value != null) {
      const data = JSON.parse(value);
      if (data.DateLastSaved != null) {
        assert.equal(dateTicks(data.DateLastSaved), dateTicks(row.DateLastSaved));
        data.DateLastSaved = '$creation-clock';
      }
      return [name, replaceIdentity(data, mapping)];
    }
    if (column.clrType.replace('?', '') === 'Guid' && value != null) return [name, idKey(mapping.get(idKey(value)) ?? value)];
    return [name, typeof value === 'boolean' ? Number(value) : replaceIdentity(value, mapping)];
  }));
  for (const row of nativeRows) assert.deepEqual(project(candidateByKey.get(key(row)), new Map(), candidateInterval),
    project(row, ids, scenario.executionInterval), key(row));
  const nativeFilesystem = scenario.kind === 'artist'
    ? ['beforeReads', 'afterReads', 'finalAfterShutdown'].map(name => [
      ...(scenario.filesystem[name].exists ? [{ path: 'artists', type: 'directory' }] : []),
      ...scenario.filesystem[name].entries.map(entry => ({ ...entry, path: 'artists/' + entry.path })),
    ])
    : ['beforeReads', 'afterReads', 'finalAfterShutdown'].map(name => scenario.filesystem[name].metadata.entries);
  const mapEntries = entries => entries.map(entry => {
    const match = /^views\/([a-f0-9]{32})$/iu.exec(entry.path);
    return match && ids.has(idKey(match[1])) ? { ...entry, path: 'views/' + idKey(ids.get(idKey(match[1]))) } : entry;
  });
  assert.deepEqual(actual.filesystemBeforeReads, mapEntries(nativeFilesystem[0]));
  assert.deepEqual(actual.filesystemAfterReads, mapEntries(nativeFilesystem[1]));
  assert.deepEqual(actual.filesystemAfterShutdown, mapEntries(nativeFilesystem[2]));
  assert.deepEqual(actual.afterShutdown, actual.afterReads, 'Background completion and shutdown preserve the observed database.');
  if (scenario.kind === 'album' || scenario.mode !== 'main') {
    const stages = actual.sideEffect;
    assert.deepEqual(stages.before, actual.beforeReads, 'No filter writes before the materialization trigger.');
    assert.deepEqual(stages.filesystemBefore, actual.filesystemBeforeReads);
    assert.deepEqual(stages.afterRepeat, stages.afterFirst, 'The repeat endpoint preserves the created item.');
    assert.deepEqual(actual.afterReads, stages.afterFirst, 'Later reads preserve the first materialization.');
    assert.deepEqual(stages.filesystemAfterRepeat, stages.filesystemAfterFirst);
    assert.deepEqual(actual.filesystemAfterReads, stages.filesystemAfterFirst);
  }
  return { createdRows: nativeRows.length };
}

export async function compareCurrentByNameCandidate(scenario) {
  const scenarioName = `current-${scenario.kind}-filter${scenario.mode === 'main' ? '' : '-' + scenario.mode.slice(6)}`;
  const fixture = projectNativeByNameCandidateInput(scenario.fixture);
  const candidateInterval = { startedAt: new Date().toISOString() };
  const actual = await recordItemFilterCandidate({
    dialect: 'postgres', connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, fixture, scenarioName,
    fields: scenario.kind === 'artist' ? 'ProductionYear' : 'ParentId', captureResponseBodies: true,
    captureOrder: true, captureParentItems: scenario.kind !== 'artist', captureStartIndex: scenario.kind !== 'artist',
    trackFilesystem: true, captureEndpointStages: true,
    trackSideEffectCase: scenario.kind === 'album' ? 'user-root-album-filter-dispatches-repository-query'
      : scenario.mode === 'main' ? null : fixture.cases[0].name,
    prepareScenario: context => seedNativeByNameFilterInput(context, { ...scenario,
      identifiers: new Map([...scenario.identifiers, [idKey(scenario.profile.actualUserId), context.user.Id]]) }),
    afterEndpoint: async ({ testCase, runtime }) => {
      if (testCase.name === 'user-root-album-filter-dispatches-repository-query') await runtime.library.userViews.drain();
    },
  });
  candidateInterval.finishedAt = new Date().toISOString();
  await writeFile(path.join(scenario.root, 'candidate.json'), filterEvidenceJson(actual), { flag: 'wx' });
  await writeFile(path.join(scenario.root, 'execution-intervals.json'), json({ native: scenario.executionInterval,
    candidate: candidateInterval }), { flag: 'wx' });
  const wire = assertCompleteFilterHttpResponses(actual, { records: scenario.records },
    { scenarioName, nativeServerId: scenario.nativeServerId });
  const mutations = assertMutations(actual, scenario, candidateInterval);
  assert.deepEqual(actual.runtimeErrors, []);
  assert.deepEqual(actual.handledExpectedRuntimeErrors, fixture.cases.filter(entry => (entry.expectedStatus ?? 200) >= 400)
    .flatMap(entry => (entry.endpoints ?? ['items', 'legacy']).map(endpoint => ({ caseName: entry.name, endpoint,
      error: { name: 'Error', message: 'Error processing request.' } }))));
  assert.deepEqual(actual.cleanup, { runtimeClosed: true, databaseClosed: true, portReleased: true,
    postgresSchemasRemoved: true, programDataDirectoryRemoved: true });
  await writeFile(path.join(scenario.root, 'comparison.json'), json({ kind: scenario.kind, ...wire, ...mutations,
    completeHttpResponses: true, completeCreatedRows: true, existingRowsAndRelationshipsUnchanged: true, cleanup: actual.cleanup }), { flag: 'wx' });
}
