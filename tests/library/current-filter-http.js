import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describeFile } from '../../tools/validation/inventory.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../tools/validation/paths.js';
import { filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { catalog, currentFilterCases } from './fixtures/filter-http-current/scenario.js';
import { recordCurrentItemFilterNative } from './fixtures/filter-http-current/record-native.js';
import { assertCompleteFilterHttpResponses, assertCompleteNativeFilterHttpRepeat } from './full-filter-wire.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const fixtureRoot = new URL('./fixtures/filter-http-current/', import.meta.url);
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const profileUrl = new URL('./fixtures/filter-http-current/current-profile.json', import.meta.url);
const digest = value => createHash('sha256').update(value).digest('hex');
const idKey = value => String(value).replaceAll('-', '').toLowerCase();
const json = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? entry.toString() : entry, 2) + '\n';
const captures = new Map();

export async function readCurrentFilterBoundFile(descriptor, label = 'Current filter input hash') {
  assert.equal(typeof descriptor?.filename, 'string', label);
  const filename = fileURLToPath(new URL(descriptor.filename, fixtureRoot));
  const bytes = await readFile(filename);
  if (descriptor.bytes !== undefined) assert.equal(bytes.length, descriptor.bytes, label + ': ' + descriptor.filename);
  assert.equal(digest(bytes), descriptor.sha256, label + ': ' + descriptor.filename);
  return bytes;
}

export async function verifyCurrentFilterInputs() {
  const profile = JSON.parse(await readFile(profileUrl, 'utf8'));
  assert.equal(profile.kind, 'same-workflow-current-native-filter-http');
  assert.equal(profile.historicalRecordingReused, false);
  for (const descriptor of profile.inputs) await readCurrentFilterBoundFile(descriptor);
  return profile;
}

// This is an explicit projection of only the initializer's user and aggregate
// identities. Every raw response, SQL snapshot and mapping remains in evidence.
function projectIdentity(value, mapping) {
  if (Array.isArray(value)) return value.map(entry => projectIdentity(entry, mapping));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([name, entry]) => [name, projectIdentity(entry, mapping)]));
  if (typeof value !== 'string') return value;
  for (const entry of mapping) {
    const actual = idKey(entry.actual), fixture = entry.fixture;
    if (idKey(value) === actual) return value.includes('-') ? fixture : idKey(fixture);
    const compact = new RegExp(`(?<![a-f0-9])${actual}(?![a-f0-9])`, 'giu');
    const dashed = new RegExp(entry.actual.replaceAll('-', '').replace(
      /^(.{8})(.{4})(.{4})(.{4})(.{12})$/u, '$1-$2-$3-$4-$5'), 'giu');
    value = value.replace(compact, idKey(fixture)).replace(dashed, fixture);
  }
  return value;
}

async function readPublishedRun(root, scenarioName, fixtureBytes, profile) {
  const load = async filename => JSON.parse(await readFile(path.join(root, filename), 'utf8'));
  const provenance = await load('provenance.json');
  const expectedArtifacts = ['current-profile.json', 'identity-mapping.json', 'native-http.json',
    'native-input-templates.json', 'reference-stderr.log', 'reference-stdout.log', 'setup-http.json', 'stages.json', 'summary.json'];
  assert.deepEqual(provenance.artifacts.map(entry => entry.path).sort(), expectedArtifacts);
  for (const artifact of provenance.artifacts) {
    assert.equal(path.basename(artifact.path), artifact.path);
    assert.equal(digest(await readFile(path.join(root, artifact.path))), artifact.sha256, artifact.path);
  }
  const [preparation, summary, rawHttp, rawStages, identities, templates, setup, cleanup] = await Promise.all([
    'current-profile.json', 'summary.json', 'native-http.json', 'stages.json', 'identity-mapping.json',
    'native-input-templates.json', 'setup-http.json', 'private-cleanup.json',
  ].map(load));
  const fixture = JSON.parse(fixtureBytes), descriptor = catalog[scenarioName];
  const expectedCases = currentFilterCases(descriptor, fixture);
  assert.equal(preparation.kind, 'current-designated-source-http');
  assert.equal(preparation.initializedFromEmpty, true);
  assert.equal(preparation.stopped, true);
  assert.equal(preparation.historicalRecordingReused, false);
  assert.match(preparation.buildIdentitySha256, /^[a-f0-9]{64}$/u);
  assert.equal(preparation.nativeSources.length, profile.sourcePaths.length);
  for (const [index, source] of preparation.nativeSources.entries()) {
    assert.ok(source.path.replaceAll('\\', '/').endsWith('/' + profile.sourcePaths[index]));
    assert.equal(digest(await readFile(source.path)), source.sha256, profile.sourcePaths[index]);
  }
  assert.equal(summary.identity, profile.kind);
  assert.equal(summary.scenario, scenarioName);
  assert.equal(summary.passed, true, summary.error?.message);
  assert.equal(summary.fixtureSha256, digest(fixtureBytes));
  assert.equal(summary.recorderSha256, digest(await readFile(new URL('record-native.js', fixtureRoot))));
  assert.equal(summary.httpRecords, descriptor.expectedRecords);
  assert.equal(summary.cases, expectedCases.length);
  assert.equal(rawHttp.records.length, descriptor.expectedRecords);
  assert.equal(summary.completeDatabaseReadStableAndRestored, true);
  assert.equal(summary.selectedDatabaseStable, true);
  assert.equal(summary.foreignKeyCheckPassedAllStages, true);
  assert.equal(summary.integrityCheckPassedAllStages, true);
  assert.equal(summary.fullDatabaseCoverage.readGates.length, summary.cases);
  assert.ok(summary.fullDatabaseCoverage.readGates.every(entry => entry.stable && entry.beforeSha256 === entry.afterSha256));
  assert.equal(summary.fullDatabaseCoverage.baselineSha256, summary.fullDatabaseCoverage.afterShutdownSha256);
  assert.equal(summary.cleanShutdown, true);
  assert.deepEqual(summary.processResult, { code: 0, signal: null });
  for (const name of ['pidGone', 'portAvailable', 'databaseUnlocked', 'sourceUnchanged', 'executionInputsUnchanged'])
    assert.equal(summary[name], true, name);
  assert.deepEqual(summary.nativeLaunch.before, summary.nativeLaunch.after);
  assert.deepEqual(cleanup.privateInstanceRemoved, true);
  assert.deepEqual(cleanup.publicFilesAreReportsOnly, true);
  assert.equal(templates.sourceDatabase.sha256, preparation.sourceDatabase.sha256);
  assert.equal(templates.sourceDatabase.filename, preparation.sourceDatabase.filename);
  const expectedKinds = fixture.items.some(entry => entry.type === 'AggregateFolder') ? ['user', 'aggregate'] : ['user'];
  assert.deepEqual(identities.mapping.map(entry => entry.kind), expectedKinds);
  for (const entry of identities.mapping) {
    assert.match(idKey(entry.actual), /^[a-f0-9]{32}$/u);
    assert.match(idKey(entry.fixture), /^[a-f0-9]{32}$/u);
  }
  assert.equal(new Set(identities.mapping.map(entry => idKey(entry.actual))).size, identities.mapping.length);
  assert.equal(new Set(identities.mapping.map(entry => idKey(entry.fixture))).size, identities.mapping.length);
  const user = identities.mapping.find(entry => entry.kind === 'user');
  assert.equal(idKey(user.fixture), idKey(fixture.userId));
  assert.equal(idKey(user.actual), idKey(preparation.actualUserId));
  if (expectedKinds.includes('aggregate')) assert.equal(idKey(identities.mapping.find(entry => entry.kind === 'aggregate').fixture),
    idKey(fixture.items.find(entry => entry.type === 'AggregateFolder').id));
  const nativeHttp = projectIdentity(rawHttp, identities.mapping);
  const expectedRequests = expectedCases.flatMap(sample => sample.endpoints.map(endpoint => ({ sample, endpoint })));
  assert.equal(nativeHttp.records.length, expectedRequests.length);
  for (const [index, record] of rawHttp.records.entries()) {
    const { sample, endpoint } = expectedRequests[index], projected = nativeHttp.records[index];
    assert.deepEqual([record.name, record.query, record.endpoint], [sample.name, sample.query, endpoint]);
    assert.equal(record.method, 'GET');
    assert.equal(record.expectedStatus, endpoint === 'detail' ? sample.detailExpectedStatus : sample.expectedStatus ?? 200);
    const route = new URL(projected.route, 'http://127.0.0.1');
    const byKey = new Map(fixture.items.map(item => [item.key, item]));
    if (endpoint === 'items') assert.equal(route.pathname, '/Items');
    else {
      const parts = route.pathname.split('/');
      assert.deepEqual([parts.length, parts[0], parts[1]], endpoint === 'detail' ? [3, '', 'Items'] : [4, '', 'Users']);
      assert.equal(idKey(parts[2]), idKey(endpoint === 'detail' ? byKey.get(sample.detailKey).id : fixture.userId));
      if (endpoint === 'legacy') assert.equal(parts[3], 'Items');
    }
    const parameters = endpoint === 'detail' ? [] : [
      ['Ids', sample.scope.map(key => byKey.get(key).id).join(',')], ['SortBy', 'SortName'], ['Fields', descriptor.fields],
      ['EnableImages', 'false'], ['EnableUserData', 'false'], ...new URLSearchParams(sample.query),
    ];
    assert.deepEqual([...route.searchParams], parameters, sample.name + ':' + endpoint + ':complete request');
    if (descriptor.recordScope === 'scope') assert.deepEqual(projected.scope, sample.scope);
    if (descriptor.recordScope === 'scopeIds') assert.deepEqual(projected.scopeIds, sample.scope.map(key => byKey.get(key).id));
    if (['blockUnrated', 'ratingPolicy'].includes(descriptor.recordScope)) assert.deepEqual(record.blockUnrated, sample.blockUnrated);
    if (descriptor.recordScope === 'ratingPolicy') assert.equal(record.maxRating, sample.maxRating);
    if (descriptor.recordScope === 'tagPolicy') {
      assert.deepEqual(record.allowedTags, sample.allowedTags); assert.deepEqual(record.blockedTags, sample.blockedTags);
    }
    assert.equal(record.response.status, record.expectedStatus);
    assert.ok(record.response.contentType?.startsWith('application/json'));
    assert.deepEqual(JSON.parse(record.response.bodyText), record.response.bodyJson);
    projected.response.bodyText = JSON.stringify(projected.response.bodyJson);
  }
  const nativeStages = projectIdentity(rawStages, identities.mapping);
  assert.deepEqual(nativeStages.before.database, nativeStages.afterReads.database);
  assert.deepEqual(nativeStages.afterReads.database, nativeStages.afterShutdown.database);
  if (descriptor.policyReadback) {
    const readbacks = setup.records.filter(entry => entry.kind === 'static-source-policy-readback');
    assert.equal(readbacks.length, descriptor.cases.length);
    for (const [index, entry] of readbacks.entries()) {
      assert.equal(entry.name, descriptor.cases[index].name);
      assert.equal(entry.status, 200);
      assert.deepEqual(entry.requestedPolicy, descriptor.cases[index].transcodingPolicy);
      assert.deepEqual(entry.effectivePolicy, entry.requestedPolicy);
    }
  }
  await writeFile(path.join(root, 'comparison-identity-projection.json'), json({ mapping: identities.mapping,
    rawHttpSha256: digest(await readFile(path.join(root, 'native-http.json'))),
    projectedHttpSha256: digest(json(nativeHttp)), unchangedFields: 'All fields except the explicitly mapped user/aggregate identifiers.' }), { flag: 'wx' });
  return { root, preparation, summary, nativeHttp, nativeStages, templates, identities };
}

export function loadCurrentFilterScenario(name) {
  if (!captures.has(name)) captures.set(name, capture(name));
  return captures.get(name);
}

async function capture(name) {
  const profile = await verifyCurrentFilterInputs(), descriptor = catalog[name];
  assert.ok(descriptor, 'A declared filter scenario is required.');
  const fixtureUrl = pathToFileURL(path.join(repositoryRoot, descriptor.fixture)), fixtureBytes = await readFile(fixtureUrl);
  const root = assertValidationOutputChild(path.join(validationOutputRoot(), 'filter-http-current-' + name + '-' + randomUUID()));
  await mkdir(root);
  const report = { schemaVersion: 1, kind: profile.kind, scenario: name, fixtureSha256: digest(fixtureBytes),
    nativeExecutionRecorded: false, historicalRecordingReused: false, phaseAcceptance: false, releaseAcceptance: false, repetitions: [] };
  try {
    const runs = [];
    for (let repetition = 1; repetition <= 2; repetition++) {
      const destination = path.join(root, 'native-' + repetition);
      await recordCurrentItemFilterNative(name, destination, profile);
      const run = await readPublishedRun(destination, name, fixtureBytes, profile);
      report.repetitions.push({ directory: destination, summary: await describeFile(path.join(destination, 'summary.json')),
        provenance: await describeFile(path.join(destination, 'provenance.json')), httpRecords: run.nativeHttp.records.length,
        buildIdentitySha256: run.preparation.buildIdentitySha256 });
      runs.push(run);
    }
    assert.equal(runs[0].preparation.buildIdentitySha256, runs[1].preparation.buildIdentitySha256);
    assert.equal(runs[0].preparation.nativeServerId, runs[1].preparation.nativeServerId);
    const nativeServerId = runs[0].preparation.nativeServerId;
    const repeat = assertCompleteNativeFilterHttpRepeat(runs[0].nativeHttp, runs[1].nativeHttp,
      { leftServerId: nativeServerId, rightServerId: nativeServerId });
    assert.deepEqual(runs[0].nativeHttp.records.map(({ response, ...entry }) => entry),
      runs[1].nativeHttp.records.map(({ response, ...entry }) => entry));
    assert.equal(runs[0].summary.scenarioDefinitionSha256, runs[1].summary.scenarioDefinitionSha256);
    const templates = runs[0].templates;
    const inputs = { async readTemplates() {
      assert.equal(digest(await readFile(templates.sourceDatabase.filename)), templates.sourceDatabase.sha256);
      return structuredClone({ sourceDescriptor: templates.sourceDatabase,
        folderTemplate: templates.folderTemplate, movieTemplate: templates.movieTemplate });
    } };
    report.nativeExecutionRecorded = true; report.repeat = repeat;
    return { root, fixtureUrl, fixture: JSON.parse(fixtureBytes), binding: { cases: descriptor.cases },
      runs, inputs, nativeServerId, nativeHttp: runs[0].nativeHttp, nativeSummary: runs[0].summary, nativeStages: runs[0].nativeStages };
  } catch (error) { report.error = { name: error.name, message: error.message, stack: error.stack }; throw error; }
  finally { await writeFile(path.join(root, 'capture-report.json'), json(report), { flag: 'wx' }); }
}

export async function writeCurrentFilterCandidateEvidence(scenarioName, actual, options) {
  const scenario = await loadCurrentFilterScenario(scenarioName);
  await writeFile(path.join(scenario.root, 'postgres.json'), filterEvidenceJson(actual), { flag: 'wx' });
  const comparison = assertCompleteFilterHttpResponses(actual, scenario.nativeHttp,
    { ...options, nativeServerId: scenario.nativeServerId });
  await writeFile(path.join(scenario.root, 'comparison.json'), json({ ...comparison, ...options,
    currentNativeRepetitions: scenario.runs.length, completeHttpResponsesEqual: true,
    cleanup: actual.cleanup, phaseAcceptance: false, releaseAcceptance: false }), { flag: 'wx' });
}
