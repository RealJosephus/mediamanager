import { nativeByNameFilterBinding, verifyNativeByNameFilterRecording, resolveNativeByNameFilterInput } from './native-byname-filter-inputs.js';
import { validationFileUrl } from '../../tools/validation/paths.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';

const recordingBinding = await verifyNativeByNameFilterRecording('album');

const sourceEvidence = '.agent-docs/evidence/byname-filter-inputs/album-filter-restoration-v1/native-contract.json';
const fixtureInput = 'tests/library/fixtures/album-filters/input.json';
const trackedFixture = 'tests/library/fixtures/album-filters/native.json';
const integrityTest = 'tests/library/album-filter-native-fixture.test.js';
const projector = 'tools/compat/project-album-filter-fixture.js';
const projectionBinding = 'tests/library/fixtures/album-filters/projection.json';
const projectionSpec = Object.freeze({
  id: 'album-filter-native-v7-contract-projection',
  version: 1,
  topLevel: 'Drop only kind and mode; add frozenJellyfin, the exact source path, and its SHA-256; preserve schemaVersion, fixtureInputSha256, endpoints, setup, and cases.',
  cases: 'Preserve every case, response item, JSON field, and array order verbatim. The authoritative contract excludes all runtime-native ids.',
  authority: 'Create the projection only from the pinned main native contract, with complete HTTP, state and source preparation evidence; no legacy development fixture is required.',
});

const inputUrl = validationFileUrl('./fixtures/album-filters/input.json', import.meta.url);
const nativeUrl = validationFileUrl('./fixtures/album-filters/native.json', import.meta.url);
const sourceContractUrl = validationFileUrl('../../' + sourceEvidence, import.meta.url);
const projectionBindingUrl = validationFileUrl('../../' + projectionBinding, import.meta.url);
const testUrl = validationFileUrl(import.meta.url);
const projectorUrl = validationFileUrl('../../' + projector, import.meta.url);
const recorderUrl = validationFileUrl('../../tools/compat/record-album-filters.js', import.meta.url);
const repoRootUrl = validationFileUrl('../../', import.meta.url);
const evidenceRootUrl = validationFileUrl('../../.agent-docs/evidence/byname-filter-inputs/album-filter-restoration-v1/', import.meta.url);
const summaryUrl = validationFileUrl('summary.json', evidenceRootUrl);
const databaseStagesUrl = validationFileUrl('database-stages.json', evidenceRootUrl);
const filesystemStagesUrl = validationFileUrl('filesystem-stages.json', evidenceRootUrl);
const setupHttpUrl = validationFileUrl('setup-http.json', evidenceRootUrl);
const nativeHttpUrl = validationFileUrl('native-http.json', evidenceRootUrl);
const nativeSetupUrl = validationFileUrl('native-setup.json', evidenceRootUrl);
const provenanceUrl = validationFileUrl('provenance.json', evidenceRootUrl);
const runtimeManifestUrl = validationFileUrl('reference-runtime-manifest.json', evidenceRootUrl);
const evidenceUrls = [summaryUrl, databaseStagesUrl, filesystemStagesUrl, setupHttpUrl, nativeHttpUrl, nativeSetupUrl,
  provenanceUrl, runtimeManifestUrl];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const idKey = value => String(value).replaceAll('-', '').toLowerCase();

function verifyPlaylistUserViewDatabaseDelta(before, after, input, nativeSetup) {
  assert.deepEqual(after.scope, before.scope);
  assert.deepEqual(before.foreignKeyCheck, []);
  assert.deepEqual(after.foreignKeyCheck, []);
  assert.deepEqual(Object.keys(after.tables), Object.keys(before.tables));
  for (const table of Object.keys(before.tables)) {
    if (table !== 'BaseItems') {
      assert.deepEqual(after.tables[table], before.tables[table], table);
      assert.equal(after.rowCounts[table], before.rowCounts[table], table);
    }
  }
  const beforeRows = before.tables.BaseItems;
  const afterRows = after.tables.BaseItems;
  const beforeIds = new Set(beforeRows.map(row => idKey(row.Id)));
  const addedRows = afterRows.filter(row => !beforeIds.has(idKey(row.Id)));
  assert.equal(addedRows.length, 1);
  const row = addedRows[0];
  const dynamicId = idKey(row.Id);
  assert.match(dynamicId, /^[0-9a-f]{32}$/u);
  assert.deepEqual(afterRows.filter(entry => idKey(entry.Id) !== dynamicId), beforeRows);
  assert.equal(after.rowCounts.BaseItems, before.rowCounts.BaseItems + 1);
  assert.equal(row.Type, 'MediaBrowser.Controller.Entities.UserView');
  assert.equal(row.Name, 'Playlists');
  assert.equal(row.CleanName, 'playlists');
  assert.equal(row.SortName, 'playlists');
  assert.equal(row.ParentId, null);
  assert.equal(row.TopParentId, null);
  assert.equal(row.IsFolder, 1);
  assert.equal(row.MediaType, 'Unknown');
  assert.equal(row.Path, `%MetadataPath%\\views\\${dynamicId}`);
  assert.equal(row.PresentationUniqueKey, dynamicId);
  const data = JSON.parse(row.Data);
  assert.deepEqual(Object.keys(data).sort(), [
    'DateLastSaved', 'DisplayParentId', 'Height', 'IsHD', 'IsRoot', 'IsShortcut', 'RemoteTrailers', 'UserId',
    'ViewType', 'Width'
  ].sort());
  assert.equal(data.ViewType, 'playlists');
  assert.equal(idKey(data.DisplayParentId), idKey(nativeSetup.graph.actual.playlistsRoot.Id));
  assert.equal(idKey(data.UserId), idKey(input.userId));
  assert.equal(data.IsRoot, false);
  assert.equal(data.IsHD, false);
  assert.equal(data.IsShortcut, false);
  assert.equal(data.Width, 0);
  assert.equal(data.Height, 0);
  assert.deepEqual(data.RemoteTrailers, []);
  assert.equal(Number.isNaN(Date.parse(data.DateLastSaved)), false);
  assert.match(row.DateLastRefreshed, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{7}$/u);
  assert.match(row.DateLastSaved, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{7}$/u);
  assert.equal(data.DateLastSaved, `${row.DateLastSaved.replace(' ', 'T')}Z`);
  return dynamicId;
}

function verifyPlaylistUserViewFilesystemDelta(before, after, dynamicId) {
  assert.deepEqual(Object.keys(after), Object.keys(before));
  for (const domain of Object.keys(before)) {
    if (domain !== 'metadata') assert.deepEqual(after[domain], before[domain], domain);
  }
  assert.equal(after.metadata.exists, before.metadata.exists);
  const beforeByPath = new Map(before.metadata.entries.map(entry => [entry.path, entry]));
  const afterByPath = new Map(after.metadata.entries.map(entry => [entry.path, entry]));
  assert.deepEqual(after.metadata.entries.filter(entry => beforeByPath.has(entry.path)), before.metadata.entries);
  assert.deepEqual(before.metadata.entries.filter(entry => !afterByPath.has(entry.path)), []);
  assert.deepEqual(after.metadata.entries.filter(entry => !beforeByPath.has(entry.path)), [
    { path: 'views', type: 'directory' },
    { path: `views/${dynamicId}`, type: 'directory' }
  ]);
}

async function loadFixture() {
  const [inputBytes, nativeBytes, sourceContractBytes, bindingBytes, testBytes,
    projectorBytes, recorderBytes, summaryBytes, databaseStagesBytes, filesystemStagesBytes, setupHttpBytes,
    nativeHttpBytes, nativeSetupBytes, provenanceBytes, runtimeManifestBytes] = await Promise.all([
    readFile(inputUrl),
    readFile(nativeUrl),
    readFile(sourceContractUrl),
    readFile(projectionBindingUrl),
    readFile(testUrl),
    readFile(projectorUrl),
    readFile(recorderUrl),
    readFile(summaryUrl),
    readFile(databaseStagesUrl),
    readFile(filesystemStagesUrl),
    readFile(setupHttpUrl),
    readFile(nativeHttpUrl),
    readFile(nativeSetupUrl),
    readFile(provenanceUrl),
    readFile(runtimeManifestUrl),
  ]);
  const input = JSON.parse(inputBytes);
  const native = JSON.parse(nativeBytes);
  const sourceContract = JSON.parse(sourceContractBytes);
  const projectionBindingValue = JSON.parse(bindingBytes);
  return {
    inputBytes,
    nativeBytes,
    sourceContractBytes,
    testBytes,
    projectorBytes,
    recorderBytes,
    input,
    native,
    sourceContract,
    projectionBindingValue,
    summary: JSON.parse(summaryBytes),
    databaseStages: JSON.parse(databaseStagesBytes),
    filesystemStages: JSON.parse(filesystemStagesBytes),
    setupHttp: JSON.parse(setupHttpBytes),
    nativeHttp: JSON.parse(nativeHttpBytes),
    nativeSetup: JSON.parse(nativeSetupBytes),
    provenance: JSON.parse(provenanceBytes),
    runtimeManifest: JSON.parse(runtimeManifestBytes),
  };
}

async function loadTrackedFixture() {
  const [inputBytes, nativeBytes] = await Promise.all([readFile(inputUrl), readFile(nativeUrl)]);
  return {
    inputBytes,
    nativeBytes,
    input: JSON.parse(inputBytes),
    native: JSON.parse(nativeBytes),
  };
}

function projectNative(sourceContract, sourceContractBytes) {
  return {
    schemaVersion: sourceContract.schemaVersion,
    frozenJellyfin: true,
    sourceEvidence,
    sourceEvidenceSha256: sha256(sourceContractBytes),
    fixtureInputSha256: sourceContract.fixtureInputSha256,
    endpoints: sourceContract.endpoints,
    setup: sourceContract.setup,
    cases: sourceContract.cases,
  };
}

test('tracked album fixture is a mechanical projection of the authoritative contract', async () => {
  const fixture = await loadFixture();
  assert.equal(fixture.sourceContract.schemaVersion, 1);
  assert.equal(fixture.sourceContract.kind, 'album-filters-native-contract');
  assert.equal(fixture.sourceContract.mode, 'main');
  assert.equal(fixture.sourceContract.fixtureInputSha256, sha256(fixture.inputBytes));
  assert.equal(fixture.sourceContract.setup?.dynamicIdsExcluded, true);
  assert.deepEqual(fixture.native, projectNative(fixture.sourceContract, fixture.sourceContractBytes));

  assert.equal(fixture.projectionBindingValue.schemaVersion, 1);
  assert.deepEqual(fixture.projectionBindingValue.projectionLogic.spec, projectionSpec);
  assert.equal(fixture.projectionBindingValue.projectionLogic.sha256, sha256(JSON.stringify(projectionSpec)));
  assert.deepEqual(fixture.projectionBindingValue.authoritativeContract, {
    path: sourceEvidence,
    sha256: sha256(fixture.sourceContractBytes),
  });
  assert.deepEqual(fixture.projectionBindingValue.fixtureInput, {
    path: fixtureInput,
    sha256: sha256(fixture.inputBytes),
  });
  assert.deepEqual(fixture.projectionBindingValue.trackedFixture, {
    path: trackedFixture,
    sha256: sha256(fixture.nativeBytes),
  });
  assert.deepEqual(fixture.projectionBindingValue.integrityTest, {
    path: integrityTest,
    sha256: sha256(fixture.testBytes),
  });
  assert.deepEqual(fixture.projectionBindingValue.projector, {
    path: projector,
    sha256: sha256(fixture.projectorBytes),
  });
});

test('album fixture covers every input case and contains only stable response identities', async () => {
  const { input, native } = await loadTrackedFixture();
  const inputByName = new Map(input.cases.map(entry => [entry.name, entry]));
  const itemByKey = new Map(input.items.map(item => [item.key, item]));
  const itemKeyById = new Map(input.items.map(item => [String(item.id).replaceAll('-', '').toLowerCase(), item.key]));
  assert.equal(inputByName.size, input.cases.length);
  assert.equal(new Set(native.cases.map(entry => entry.name)).size, input.cases.length);
  assert.deepEqual(native.cases.map(entry => entry.name), input.cases.map(entry => entry.name));

  const requiredResponseFields = ['contentType', 'items', 'keys', 'orderedKeys', 'problem', 'startIndex', 'status', 'totalRecordCount'];
  const allowedCaseFields = new Set([
    'name', 'query', 'scope', 'parentKey', 'auth', 'endpoints',
    'omitScope', 'omitParentId', 'omitIds', 'recursive', 'omitSortBy', 'assertOrder', 'expectedStatus',
    ...requiredResponseFields,
  ]);
  for (const entry of native.cases) {
    const source = inputByName.get(entry.name);
    assert.ok(source, entry.name);
    assert.equal(entry.query, source.query, entry.name);
    assert.deepEqual(entry.scope, source.scope, entry.name);
    assert.equal(entry.parentKey, source.parentKey ?? null, entry.name);
    assert.equal(entry.auth, source.auth ?? 'user', entry.name);
    assert.deepEqual(entry.endpoints, source.endpoints ?? ['items', 'legacy'], entry.name);
    assert.equal(entry.omitScope, source.omitScope ?? false, entry.name);
    assert.equal(entry.omitParentId, source.omitParentId ?? false, entry.name);
    assert.equal(entry.omitIds, source.omitIds ?? false, entry.name);
    assert.equal(entry.recursive, Object.hasOwn(source, 'recursive') ? source.recursive : true, entry.name);
    assert.equal(entry.omitSortBy, source.omitSortBy ?? false, entry.name);
    assert.equal(entry.assertOrder, source.assertOrder ?? false, entry.name);
    assert.equal(entry.expectedStatus, source.expectedStatus ?? 200, entry.name);
    assert.deepEqual(Object.keys(entry).filter(key => !allowedCaseFields.has(key)), [], entry.name);
    assert.ok(requiredResponseFields.every(field => Object.hasOwn(entry, field)), entry.name);
    assert.equal(Number.isInteger(entry.status), true, entry.name);
    assert.deepEqual(entry.keys, [...entry.orderedKeys].sort(), entry.name);
    assert.deepEqual(entry.orderedKeys, entry.items.map(item => item.key), entry.name);
    if (entry.status < 400) {
      assert.equal(entry.contentType, 'application/json; charset=utf-8', entry.name);
      assert.equal(entry.problem, null, entry.name);
      assert.equal(Number.isInteger(entry.startIndex) && entry.startIndex >= 0, true, entry.name);
      assert.equal(Number.isInteger(entry.totalRecordCount) && entry.totalRecordCount >= 0, true, entry.name);
      assert.ok(entry.totalRecordCount >= entry.items.length, entry.name);
    } else {
      assert.equal(entry.status, entry.expectedStatus, entry.name);
      assert.equal(entry.contentType, 'text/plain', entry.name);
      assert.deepEqual(entry.problem, { rawBody: 'Error processing request.' }, entry.name);
      assert.equal(entry.startIndex, null, entry.name);
      assert.equal(entry.totalRecordCount, null, entry.name);
      assert.deepEqual(entry.keys, [], entry.name);
      assert.deepEqual(entry.items, [], entry.name);
    }

    for (const item of entry.items) {
      assert.deepEqual(Object.keys(item).sort(), ['key', 'name', 'parentKey', 'type'], `${entry.name}:${item.key}`);
      const seeded = itemByKey.get(item.key);
      assert.ok(seeded, `${entry.name}:${item.key}`);
      assert.equal(typeof item.name, 'string', `${entry.name}:${item.key}:name`);
      assert.ok(item.name.length > 0, `${entry.name}:${item.key}:name`);
      assert.equal(typeof item.type, 'string', `${entry.name}:${item.key}:type`);
      assert.ok(item.type.length > 0, `${entry.name}:${item.key}:type`);
      const parentId = seeded.parentId == null ? null : String(seeded.parentId).replaceAll('-', '').toLowerCase();
      const expectedParentKey = parentId == null || /^0+$/u.test(parentId)
        ? null
        : itemKeyById.get(parentId);
      assert.equal(item.parentKey, expectedParentKey, `${entry.name}:${item.key}:parentKey`);
    }
  }
  const byName = new Map(native.cases.map(entry => [entry.name, entry]));
  const full = byName.get('collection-view-memory-no-order');
  const page = byName.get('collection-view-memory-no-order-page');
  const crossRootPage = byName.get('collection-view-memory-no-order-cross-root-page');
  assert.deepEqual(full.orderedKeys, ['whitespaceAlbum', 'duplicateHighIdAlbum', 'alphaAlbum',
    'betaAlbum', 'cleanNameAlbum', 'crossTopAlternateAlbum', 'literalPipeAlbum', 'ownedExtraAlbum',
    'alternatePrimaryAlbum', 'bomEmptyAlbum', 'duplicateLowIdAlbum', 'ownerEligibleAlbum',
    'secondA', 'secondB', 'secondC']);
  assert.deepEqual(page.orderedKeys, full.orderedKeys.slice(1, 4));
  assert.deepEqual(crossRootPage.orderedKeys, full.orderedKeys.slice(11, 15));
  assert.deepEqual(full.items.map(item => item.parentKey), [
    ...Array(12).fill('physicalRoot'), ...Array(3).fill('physicalSecondary')]);
  for (const entry of [full, page, crossRootPage]) {
    assert.equal(entry.parentKey, 'collectionView');
    assert.equal(entry.omitIds, true);
    assert.equal(entry.omitSortBy, true);
    assert.equal(entry.recursive, false);
    assert.equal(entry.totalRecordCount, 15);
  }
  assert.deepEqual(crossRootPage.items.map(item => item.parentKey),
    ['physicalRoot', 'physicalSecondary', 'physicalSecondary', 'physicalSecondary']);
});

test('authoritative album evidence is complete, bounds the native UserView side effect, stops cleanly, and is tied to frozen inputs', async () => {
  const {
    input, sourceContract, recorderBytes, summary, databaseStages, filesystemStages, setupHttp, nativeHttp,
    nativeSetup, provenance, runtimeManifest,
  } = await loadFixture();
  const endpointCases = input.cases.reduce((total, entry) => total
    + (entry.endpoints ?? ['items', 'legacy']).length, 0);

  assert.equal(summary.passed, true);
  assert.equal(summary.mode, 'main');
  assert.equal(summary.fixtureItems, input.items.length);
  assert.equal(summary.fixtureCases, input.cases.length);
  assert.equal(summary.contractsRecorded, input.cases.length);
  assert.equal(summary.endpointCases, endpointCases);
  assert.equal(summary.httpRecords, endpointCases + 2);
  assert.equal(summary.databaseUnchangedByReads, false);
  assert.equal(summary.filesystemUnchangedByReads, false);
  assert.equal(summary.nativePlaylistUserViewSideEffectVerified, true);
  assert.equal(summary.databaseStableOutsideExpectedSideEffect, true);
  assert.equal(summary.filesystemStableOutsideExpectedSideEffect, true);
  assert.deepEqual(summary.nativePlaylistUserViewSideEffect, {
    name: 'native-playlists-user-view-first-read-materialization',
    triggerRecord: 'user-root-album-filter-dispatches-repository-query:items',
    stabilityProbeRecord: 'user-root-album-filter-dispatches-repository-query:legacy',
    database: {
      changedTables: ['BaseItems'],
      addedRows: 1,
      addedType: 'MediaBrowser.Controller.Entities.UserView',
    },
    filesystem: {
      changedDomains: ['metadata'],
      addedEntries: ['views', 'views/<dynamic-user-view-id>'],
      addedFiles: 0,
    },
    observation: {
      creationSettleAttempts: summary.nativePlaylistUserViewSideEffect.observation.creationSettleAttempts,
      stableSamples: 3,
      intervalMilliseconds: 250,
      stabilityProbeSettleAttempts: summary.nativePlaylistUserViewSideEffect.observation.stabilityProbeSettleAttempts,
    },
  });
  assert.ok(summary.nativePlaylistUserViewSideEffect.observation.creationSettleAttempts >= 3);
  assert.ok(summary.nativePlaylistUserViewSideEffect.observation.stabilityProbeSettleAttempts >= 3);
  assert.equal(summary.foreignKeyCheckPassedAllStages, true);
  assert.equal(summary.processClean, true);
  assert.equal(summary.error, null);
  assert.ok(sourceContract.cases.every(entry => !Object.hasOwn(entry, 'discoveryOnly')));
  assert.ok(Object.values(nativeSetup.graph.invariants).every(value => value === true));
  assert.deepEqual(nativeSetup.graph.actual.collectionPhysicalFolderIds.map(idKey), [
    idKey(nativeSetup.graph.actual.physicalRoot.Id), idKey(nativeSetup.graph.actual.physicalSecondary.Id)]);

  assert.equal(setupHttp.records.length, summary.setupHttpRecords);
  assert.deepEqual(setupHttp.records.map(record => [record.name, record.response.status]), [
    ['setup-login-admin', 200],
    ['setup-create-virtual-folder', 204],
    ['setup-list-virtual-folders', 200],
    ['setup-reference-authenticated-shutdown', 204],
  ]);

  const databaseStageNames = ['beforeProvision', 'afterProvision', 'afterSeed', 'beforeReads',
    'beforePlaylistUserViewCreate', 'afterPlaylistUserViewCreate', 'afterPlaylistUserViewStabilityProbe',
    'afterReads', 'finalAfterShutdown'];
  for (const name of databaseStageNames) {
    assert.deepEqual(databaseStages[name].foreignKeyCheck, [], name);
  }
  assert.deepEqual(databaseStages.beforePlaylistUserViewCreate, databaseStages.beforeReads);
  assert.deepEqual(filesystemStages.beforePlaylistUserViewCreate, filesystemStages.beforeReads);
  const playlistUserViewId = verifyPlaylistUserViewDatabaseDelta(
    databaseStages.beforePlaylistUserViewCreate,
    databaseStages.afterPlaylistUserViewCreate,
    input,
    nativeSetup);
  verifyPlaylistUserViewFilesystemDelta(
    filesystemStages.beforePlaylistUserViewCreate,
    filesystemStages.afterPlaylistUserViewCreate,
    playlistUserViewId);
  assert.deepEqual(databaseStages.afterPlaylistUserViewStabilityProbe, databaseStages.afterPlaylistUserViewCreate);
  assert.deepEqual(databaseStages.afterReads, databaseStages.afterPlaylistUserViewCreate);
  assert.deepEqual(databaseStages.finalAfterShutdown, databaseStages.afterPlaylistUserViewCreate);
  assert.deepEqual(filesystemStages.afterPlaylistUserViewStabilityProbe, filesystemStages.afterPlaylistUserViewCreate);
  assert.deepEqual(filesystemStages.afterReads, filesystemStages.afterPlaylistUserViewCreate);
  assert.deepEqual(filesystemStages.finalAfterShutdown, filesystemStages.afterPlaylistUserViewCreate);

  assert.equal(summary.process.portInitiallyAvailable, true);
  assert.equal(summary.process.portFinallyAvailable, true);
  assert.equal(Number.isInteger(summary.process.selectedPort), true);
  for (const name of ['setup', 'recording']) {
    const stage = summary.process.stages[name];
    assert.equal(Number.isInteger(stage.pid) && stage.pid > 0, true, name);
    assert.equal(stage.code, 0, name);
    assert.equal(stage.signal, null, name);
    assert.notEqual(stage.timedOut, true, name);
    assert.equal(stage.cleanShutdown, true, name);
    assert.equal(stage.portAvailable, true, name);
    assert.equal(stage.error, null, name);
  }

  assert.equal(nativeHttp.mode, 'main');
  assert.equal(nativeHttp.records.length, summary.httpRecords);
  assert.equal(nativeHttp.records[0].name, 'recording-login-admin');
  assert.equal(nativeHttp.records.at(-1).name, 'reference-authenticated-shutdown');
  assert.equal(nativeHttp.records.slice(1, -1).length, endpointCases);

  assert.equal(runtimeManifest.fileCount, runtimeManifest.entries.length);
  assert.ok(runtimeManifest.fileCount >= 153);
  assert.ok(runtimeManifest.dllCount > 0);
  assert.ok(runtimeManifest.depsJsonCount > 0);
  assert.ok(runtimeManifest.runtimeConfigCount > 0);
  assert.equal(runtimeManifest.entriesSha256, sha256(JSON.stringify(runtimeManifest.entries)));
  assert.equal(provenance.referenceRuntime.entriesSha256, runtimeManifest.entriesSha256);
  assert.equal(provenance.referenceRuntime.fileCount, runtimeManifest.fileCount);
  const runtimeRootUrl = validationFileUrl(`${runtimeManifest.root.replaceAll('\\', '/')}/`, repoRootUrl);
  for (const entry of runtimeManifest.entries) {
    const fileUrl = validationFileUrl(entry.path, runtimeRootUrl);
    const [bytes, info] = await Promise.all([readFile(fileUrl), stat(fileUrl)]);
    assert.equal(info.size, entry.size, entry.path);
    assert.equal(sha256(bytes), entry.sha256, entry.path);
  }

  assert.equal(provenance.recorder.sha256, sha256(recorderBytes));
  const preparedByKind = new Map(provenance.preparedInputs.map(entry => [entry.kind, entry]));
  for (const kind of ['nativeReferencePreparation', 'referencePreparationVerifier', 'referenceBootstrapScript',
    'nativeReferenceBootstrapLog', 'nativeReferenceBaselineManifest', 'nativeReferenceModel']) {
    assert.ok(preparedByKind.has(kind), kind);
  }
  const preparation = JSON.parse(await readFile(validationFileUrl(preparedByKind.get('nativeReferencePreparation').path, repoRootUrl)));
  assert.equal(preparation.initializedFromEmpty, true);
  assert.equal(preparation.process.stopped, true);
  assert.equal(preparation.process.exitCode, 0);
  assert.equal(preparation.identityRemapping.createdThroughNativeApi, true);
  assert.equal(idKey(preparation.identityRemapping.fixtureUserId), idKey(input.userId));
  assert.equal(preparation.initialDatabaseSha256, preparedByKind.get('frozenSourceDatabase').sha256);
  assert.deepEqual(preparation.foreignKeyCheck, []);
  assert.ok(preparation.migrationHistory > 0);
  assert.ok(preparation.observations.some(entry => entry.route === '/Users/New' && entry.status === 200
    && idKey(entry.responseBody.Id) === idKey(preparation.identityRemapping.actualUserId)));
  assert.ok(preparation.observations.some(entry => entry.route === '/Users/AuthenticateByName' && entry.status === 200
    && entry.responseBody.User.Policy.IsAdministrator === true
    && idKey(entry.responseBody.User.Id) === idKey(preparation.identityRemapping.actualUserId)));
  assert.equal(preparation.observations.at(-1).route, '/System/Shutdown');
  assert.equal(preparation.observations.at(-1).status, 204);
  assert.equal(preparedByKind.get('fixtureInput').sha256, sourceContract.fixtureInputSha256);
  assert.equal(preparedByKind.get('recorderSource').sha256, sha256(recorderBytes));
  for (const artifact of provenance.artifacts) {
    assert.equal(sha256(await readFile(validationFileUrl(artifact.path, evidenceRootUrl))), artifact.sha256, artifact.path);
  }
  const hashedInputs = [...provenance.nativeSources,
    ...provenance.preparedInputs.filter(entry => typeof entry.sha256 === 'string')];
  for (const entry of hashedInputs) {
    assert.equal(sha256(await readFile(validationFileUrl(entry.path, repoRootUrl))), entry.sha256, entry.path);
  }
  const preparedNativeSources = provenance.preparedInputs.filter(entry => entry.kind === 'frozenNativeSource')
    .map(({ path, sha256: hash }) => ({ path, sha256: hash }));
  assert.deepEqual(preparedNativeSources, provenance.nativeSources);
  for (const suffix of [
    '/MediaBrowser.Controller/Entities/BaseItem.cs',
    '/MediaBrowser.Controller/Entities/UserView.cs',
    '/MediaBrowser.Controller/Playlists/Playlist.cs',
    '/Jellyfin.Server.Implementations/Item/BaseItemMapper.cs',
    '/Emby.Server.Implementations/Library/UserViewManager.cs',
    '/Emby.Server.Implementations/Playlists/PlaylistsFolder.cs',
    '/Emby.Server.Implementations/Sorting/SortNameComparer.cs',
    '/Emby.Server.Implementations/Sorting/NameComparer.cs',
    '/Jellyfin.Api/Middleware/ExceptionMiddleware.cs',
  ]) {
    assert.ok(provenance.nativeSources.some(entry => entry.path.endsWith(suffix)), suffix);
  }
  assert.ok(provenance.preparedInputs.every(entry => !String(entry.path).endsWith('/native.json')
    && !String(entry.path).endsWith('album-filter-native-fixture.test.js')));
  assert.equal(provenance.result.passed, true);
  assert.equal(provenance.result.databaseUnchangedByReads, false);
  assert.equal(provenance.result.filesystemUnchangedByReads, false);
  assert.equal(provenance.result.nativePlaylistUserViewSideEffectVerified, true);
  assert.equal(provenance.result.databaseStableOutsideExpectedSideEffect, true);
  assert.equal(provenance.result.filesystemStableOutsideExpectedSideEffect, true);
  assert.deepEqual(provenance.result.nativePlaylistUserViewSideEffect, summary.nativePlaylistUserViewSideEffect);
  assert.equal(provenance.result.foreignKeyCheckPassedAllStages, true);

  const guidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;
  const idsIn = value => new Set((JSON.stringify(value).match(guidPattern) ?? [])
    .map(value => value.replaceAll('-', '').toLowerCase()));
  const fixtureIds = new Set(input.items.map(item => String(item.id).replaceAll('-', '').toLowerCase()));
  const dynamicNativeIds = [...idsIn(nativeSetup.graph)].filter(id => !fixtureIds.has(id));
  const contractIds = idsIn(sourceContract);
  assert.ok(dynamicNativeIds.length > 0);
  for (const id of dynamicNativeIds) assert.equal(contractIds.has(id), false, id);
  assert.equal(contractIds.has(playlistUserViewId), false, playlistUserViewId);
  assert.equal(JSON.stringify(sourceContract).toLowerCase().includes(playlistUserViewId), false);
});

test('raw native GET records independently reproduce every stable contract and input-derived route', async () => {
  const { input, sourceContract, nativeHttp, nativeSetup } = await loadFixture();
  const idKey = value => String(value).replaceAll('-', '').toLowerCase();
  const itemByKey = new Map(input.items.map(item => [item.key, item]));
  const resolvedIdByFixtureId = new Map(input.items.map(item => [idKey(item.id), item.id]));
  const keyById = new Map(input.items.map(item => [idKey(item.id), item.key]));
  for (const [key, mapping] of Object.entries(nativeSetup.graph.fixtureKeyMapping)) {
    assert.equal(idKey(mapping.fixtureId), idKey(itemByKey.get(key).id), key);
    resolvedIdByFixtureId.set(idKey(mapping.fixtureId), mapping.actualId);
    keyById.set(idKey(mapping.actualId), key);
  }
  const resolvedId = value => resolvedIdByFixtureId.get(idKey(value)) ?? value;
  const routeFor = (endpoint, source) => {
    const parent = source.parentKey == null ? null : itemByKey.get(source.parentKey);
    assert.ok(source.parentKey == null || parent, source.name);
    const parentId = resolvedId(parent?.id ?? input.rootId);
    const scopeIds = source.scope.map(key => resolvedId(itemByKey.get(key).id)).join(',');
    const recursive = Object.hasOwn(source, 'recursive') ? source.recursive : true;
    const parts = [
      ...(!source.omitParentId && !source.omitScope ? [`ParentId=${encodeURIComponent(parentId)}`] : []),
      ...(recursive === null || source.omitScope ? [] : [`Recursive=${recursive}`]),
      ...(!source.omitIds && !source.omitScope ? [`Ids=${encodeURIComponent(scopeIds)}`] : []),
      ...(!source.omitSortBy ? ['SortBy=SortName'] : []),
      'Fields=ParentId',
      'EnableImages=false',
      'EnableUserData=false',
      source.query,
    ];
    const prefix = endpoint === 'items' ? '/Items' : `/Users/${input.userId}/Items`;
    return `${prefix}?${parts.filter(Boolean).join('&')}`;
  };
  const responseProjection = record => {
    const responseItems = Array.isArray(record.response.bodyJson?.Items) ? record.response.bodyJson.Items : [];
    const orderedKeys = responseItems.map(item => {
      const key = keyById.get(idKey(item.Id));
      assert.ok(key, `${record.name}:${item.Id}`);
      return key;
    });
    return {
      status: record.response.status,
      contentType: record.response.headers['content-type'] ?? null,
      startIndex: record.response.bodyJson?.StartIndex ?? null,
      totalRecordCount: record.response.bodyJson?.TotalRecordCount ?? null,
      keys: [...orderedKeys].sort(),
      orderedKeys,
      items: responseItems.map((item, index) => ({
        key: orderedKeys[index],
        name: item.Name,
        type: item.Type,
        parentKey: item.ParentId == null ? null : (keyById.get(idKey(item.ParentId)) ?? null),
      })),
      problem: record.response.status >= 400
        ? record.response.bodyJson && typeof record.response.bodyJson === 'object'
          ? Object.fromEntries(Object.entries(record.response.bodyJson).filter(([key]) => key !== 'traceId'))
          : { rawBody: record.response.bodyText }
        : null,
    };
  };
  const contractByName = new Map(sourceContract.cases.map(entry => [entry.name, entry]));
  const expectedRecordNames = ['recording-login-admin', ...input.cases.flatMap(source =>
    (source.endpoints ?? ['items', 'legacy']).map(endpoint => `${source.name}:${endpoint}`)),
  'reference-authenticated-shutdown'];
  assert.deepEqual(nativeHttp.records.map(record => record.name), expectedRecordNames);
  const recordByName = new Map(nativeHttp.records.map(record => [record.name, record]));
  for (const source of input.cases) {
    const expected = contractByName.get(source.name);
    assert.ok(expected, source.name);
    const stableResponse = Object.fromEntries(['status', 'contentType', 'startIndex', 'totalRecordCount', 'keys', 'orderedKeys', 'items', 'problem']
      .map(field => [field, expected[field]]));
    for (const endpoint of source.endpoints ?? ['items', 'legacy']) {
      const record = recordByName.get(`${source.name}:${endpoint}`);
      assert.ok(record, `${source.name}:${endpoint}`);
      assert.equal(record.request.method, 'GET', `${source.name}:${endpoint}`);
      assert.equal(record.request.route, routeFor(endpoint, source), `${source.name}:${endpoint}`);
      assert.deepEqual(responseProjection(record), stableResponse, `${source.name}:${endpoint}`);
    }
  }
});
