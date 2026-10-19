import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validationFileUrl } from '../../tools/validation/paths.js';
import test from 'node:test';
import { recordItemFilterCandidate } from './item-filter-http-scenario.js';
import { loadNativeByNameFilterScenario, seedNativeByNameFilterInput, writeCompleteByNameFilterEvidence } from './native-byname-filter-scenario.js';

const input = JSON.parse(await readFile(new URL('./fixtures/artist-filters/input.json', import.meta.url), 'utf8'));
const native = JSON.parse(await readFile(new URL('./fixtures/artist-filters/native.json', import.meta.url), 'utf8'));
const nativeScenario = await loadNativeByNameFilterScenario('artist');
const expectedHttpCases = native.cases.reduce((total, entry) => total + entry.endpoints.length, 0);
const sideEffects = native.sideEffects ?? [];
const expectedSideHttpCases = sideEffects.reduce((total, sideEffect) => total
  + sideEffect.cases.reduce((caseTotal, entry) => caseTotal + entry.endpoints.length, 0), 0);
const sideSummaryFiles = new Map([
  ['unknown-credit', '.agent-docs/evidence/byname-filter-inputs/artist-filter-restoration-unknown-v1/summary.json'],
  ['bom-credit', '.agent-docs/evidence/byname-filter-inputs/artist-filter-restoration-bom-credit-v1/summary.json'],
  ['request-order', '.agent-docs/evidence/byname-filter-inputs/artist-filter-restoration-request-order-v1/summary.json'],
  ['bom-order', '.agent-docs/evidence/byname-filter-inputs/artist-filter-restoration-bom-order-v1/summary.json'],
]);

function expectedContract(entry) {
  return {
    status: entry.status,
    contentType: entry.contentType,
    totalRecordCount: entry.totalRecordCount,
    keys: entry.keys,
    orderedKeys: entry.orderedKeys,
    orderedIds: entry.orderedIds,
    items: entry.items,
    problem: entry.problem,
  };
}

function requestCase(entry) {
  return {
    name: entry.name,
    query: entry.query,
    scope: entry.scope,
    ...(entry.parentKey == null ? {} : { parentKey: entry.parentKey }),
    ...(entry.omitScope ? { omitScope: true } : {}),
    ...(entry.omitSortBy ? { omitSortBy: true } : {}),
    ...(entry.assertOrder ? { assertOrder: true } : {}),
    auth: entry.auth,
    endpoints: entry.endpoints,
  };
}

function isolatedFixture(cases) {
  const retainedKeys = new Set(['requestOrderByNameBobSelector']);
  for (const entry of cases) for (const key of entry.scope) retainedKeys.add(key);
  const itemById = new Map(input.items.map(item => [item.id.replaceAll('-', '').toLowerCase(), item]));
  retainedKeys.add(itemById.get(input.rootId.replaceAll('-', '').toLowerCase()).key);
  let changed;
  do {
    changed = false;
    for (const item of input.items) {
      if (!retainedKeys.has(item.key)) continue;
      for (const id of [item.parentId, item.topParentId, item.ownerId, item.primaryVersionId]) {
        if (id == null) continue;
        const dependency = itemById.get(id.replaceAll('-', '').toLowerCase());
        if (dependency && !retainedKeys.has(dependency.key)) {
          retainedKeys.add(dependency.key);
          changed = true;
        }
      }
    }
  } while (changed);
  const retainedIds = new Set(input.items
    .filter(item => retainedKeys.has(item.key))
    .map(item => item.id.replaceAll('-', '').toLowerCase()));
  const itemValueLinks = (input.itemValueLinks ?? []).filter(link => retainedKeys.has(link.itemKey));
  const valueKeys = new Set(itemValueLinks.map(link => link.valueKey));
  const peopleLinks = (input.peopleLinks ?? []).filter(link => retainedKeys.has(link.itemKey));
  const personKeys = new Set(peopleLinks.map(link => link.personKey));
  return {
    ...input,
    items: input.items.filter(item => retainedKeys.has(item.key)),
    links: (input.links ?? []).filter(link => retainedIds.has(link.parentId.replaceAll('-', '').toLowerCase())
      && retainedIds.has(link.childId.replaceAll('-', '').toLowerCase())),
    people: (input.people ?? []).filter(person => personKeys.has(person.key)),
    peopleLinks,
    itemValues: (input.itemValues ?? []).filter(value => valueKeys.has(value.key)),
    itemValueLinks,
    mediaStreams: (input.mediaStreams ?? []).filter(stream => stream.itemKey != null
      ? retainedKeys.has(stream.itemKey)
      : retainedIds.has(stream.itemId.replaceAll('-', '').toLowerCase())),
    cases: cases.map(requestCase),
  };
}

function sideFixture(sideEffect) {
  const cases = sideEffect.cases.map(requestCase);
  if (sideEffect.mode === 'probe-request-order' || sideEffect.mode === 'probe-bom-order') {
    return isolatedFixture(cases);
  }
  if (sideEffect.mode === 'probe-unknown-credit' || sideEffect.mode === 'probe-bom-credit') {
    return { ...input, cases };
  }
  throw new Error(`Unknown artist side-effect mode: ${sideEffect.mode}.`);
}

function assertCases(actual, expectedCases, sourceCases, dialect, label) {
  const expectedByCaseName = new Map(expectedCases.map(entry => [entry.name, entry]));
  const sourceByCaseName = new Map(sourceCases.map(entry => [entry.name, entry]));
  const httpCases = expectedCases.reduce((total, entry) => total + entry.endpoints.length, 0);
  assert.equal(actual.cases.length, expectedCases.length, label);
  assert.equal(actual.httpCases, httpCases, label);
  for (const actualCase of actual.cases) {
    const expected = expectedByCaseName.get(actualCase.name);
    const source = sourceByCaseName.get(actualCase.name);
    assert.ok(expected, actualCase.name);
    assert.ok(source, actualCase.name);
    assert.equal(actualCase.query, expected.query, actualCase.name);
    assert.deepEqual(actualCase.scope, expected.scope, actualCase.name);
    assert.equal(actualCase.parentKey, expected.parentKey, actualCase.name);
    assert.equal(actualCase.auth, expected.auth, actualCase.name);
    assert.equal(actualCase.omitScope, source.omitScope ? true : undefined, actualCase.name);
    assert.equal(actualCase.omitSortBy, source.omitSortBy ? true : undefined, actualCase.name);
    assert.equal(actualCase.assertOrder, source.assertOrder ? true : undefined, actualCase.name);
    assert.deepEqual(actualCase.endpoints.map(entry => entry.endpoint), expected.endpoints, actualCase.name);
    for (const endpoint of actualCase.endpoints) {
      assert.deepEqual(endpoint.contract, expectedContract(expected),
        `${dialect}:${label}:${actualCase.name}:${endpoint.endpoint}`);
    }
  }
}

function assertReadOnlyCleanup(actual, dialect, label) {
  assert.deepEqual(actual.afterReads, actual.beforeReads,
    `${dialect}:${label}: GET changed isolated item/reference table state`);
  assert.deepEqual(actual.runtimeErrors, [], label);
  assert.deepEqual(actual.cleanup, {
    runtimeClosed: true,
    databaseClosed: true,
    portReleased: true,
    postgresSchemasRemoved: dialect === 'postgres' ? true : null,
    programDataDirectoryRemoved: true,
  }, label);
}

async function assertNativeMutation(actual, dialect, sideEffect) {
  const sourceDirectory = sideEffect.sourceEvidence.slice(0, sideEffect.sourceEvidence.lastIndexOf('/'));
  const summaryFile = sideSummaryFiles.get(sideEffect.key);
  assert.equal(summaryFile?.slice(0, summaryFile.lastIndexOf('/')), sourceDirectory, sideEffect.key);
  const summary = JSON.parse(await readFile(validationFileUrl(`../../${summaryFile}`, import.meta.url), 'utf8'));
  assert.equal(summary.passed, true, sideEffect.key);
  assert.equal(summary.observedDatabaseMutation, true, sideEffect.key);
  assert.equal(summary.observedFilesystemMutation, true, sideEffect.key);
  const idKey = value => String(value).replaceAll('-', '').toLowerCase();
  const existing = new Set(actual.beforeReads.BaseItems.map(row => idKey(row.Id)));
  const created = actual.afterReads.BaseItems.filter(row => !existing.has(idKey(row.Id)));
  const nativeCreated = summary.probeObservations.createdArtists;
  const withoutVolatileDates = row => Object.fromEntries(Object.entries(row)
    .filter(([key]) => key !== 'DateCreated' && key !== 'DateModified')
    .map(([key, value]) => [key, typeof value === 'boolean' ? Number(value) : value]));
  assert.deepEqual(created.map(withoutVolatileDates), nativeCreated.map(withoutVolatileDates),
    `${dialect}:${sideEffect.key}: persisted MusicArtist row differs from native`);
  assert.ok(created.every(row => Number.isFinite(Date.parse(row.DateCreated.replace(' ', 'T') + 'Z'))
    && Number.isFinite(Date.parse(row.DateModified.replace(' ', 'T') + 'Z'))), sideEffect.key);
  for (const table of Object.keys(actual.beforeReads).filter(name => name !== 'BaseItems')) {
    assert.deepEqual(actual.afterReads[table], actual.beforeReads[table], `${dialect}:${sideEffect.key}:${table}`);
  }
  assert.deepEqual(actual.filesystemBeforeReads, [], sideEffect.key);
  const expectedFilesystem = [
    { path: 'artists', type: 'directory' },
    ...summary.probeObservations.newArtistDirectoryEntries.map(entry => ({
      path: `artists/${entry.path}`, type: entry.type,
    })),
  ].sort((left, right) => left.path.localeCompare(right.path, 'en'));
  assert.deepEqual(actual.filesystemAfterReads, expectedFilesystem, sideEffect.key);
  assert.deepEqual(actual.filesystemAfterShutdown, expectedFilesystem, sideEffect.key);
  assert.deepEqual(actual.runtimeErrors, [], sideEffect.key);
  assert.deepEqual(actual.cleanup, {
    runtimeClosed: true,
    databaseClosed: true,
    portReleased: true,
    postgresSchemasRemoved: dialect === 'postgres' ? true : null,
    programDataDirectoryRemoved: true,
  }, sideEffect.key);
}

for (const dialect of ['postgres']) {
  test(`${dialect}: ${native.cases.length} artist-reference cases / ${expectedHttpCases} Items requests match frozen Jellyfin`, {
    skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES,
  }, async () => {
    const actual = await recordItemFilterCandidate({
      dialect,
      fixture: input,
      connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
      scenarioName: 'artist-filter',
      fields: 'ProductionYear',
      captureResponseBodies: true,
      prepareScenario: context => seedNativeByNameFilterInput(context, nativeScenario),
      captureOrder: true,
      captureItems: true,
    });
    await writeCompleteByNameFilterEvidence(actual, nativeScenario, { scenarioName: 'artist-filter' });
    assertCases(actual, native.cases, input.cases, dialect, 'main');
    assertReadOnlyCleanup(actual, dialect, 'main');
  });

  test(`${dialect}: ${sideEffects.length} artist selector side probes / ${expectedSideHttpCases} Items requests match frozen Jellyfin responses and GET mutations`, {
    skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES,
  }, async () => {
    assert.deepEqual(sideEffects.map(sideEffect => sideEffect.key),
      ['unknown-credit', 'bom-credit', 'request-order', 'bom-order']);
    for (const [index, sideEffect] of sideEffects.entries()) {
      const fixture = sideFixture(sideEffect);
      const sideScenario = await loadNativeByNameFilterScenario('artist', sideEffect.key);
      const actual = await recordItemFilterCandidate({
        dialect,
        fixture,
        connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
        // PostgreSQL identifiers are capped by the shared scenario harness at
        // 40 ASCII characters once its uniqueness suffix is appended.
        scenarioName: `artist-side-${index + 1}`,
        fields: 'ProductionYear',
        captureResponseBodies: true,
        prepareScenario: context => seedNativeByNameFilterInput(context, sideScenario),
        captureOrder: true,
        captureItems: true,
        trackFilesystem: true,
      });
      await writeCompleteByNameFilterEvidence(actual, sideScenario, { scenarioName: `artist-side-${index + 1}` });
      assertCases(actual, sideEffect.cases, fixture.cases, dialect, sideEffect.key);
      await assertNativeMutation(actual, dialect, sideEffect);
    }
  });
}
