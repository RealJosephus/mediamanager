import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { after } from 'node:test';
import { acquireTestResource } from '../helpers/test-resource-lease.js';
import { recordItemFilterCandidate } from './item-filter-http-scenario.js';
import { seedNativeFilterInput } from './native-filter-input.js';
import { assertCompleteFilterHttpResponses, writeCompleteFilterHttpEvidence } from './full-filter-wire.js';
import { writeCurrentFilterCandidateEvidence } from './current-filter-http.js';
import { readNativeStaticSourcePermissionEvidence } from './native-static-source-evidence.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/rating-permissions/input.json', import.meta.url)));
export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const resourceLease = await acquireTestResource('native-filter-http-ports');
const { binding, nativeHttp, inputs, nativeServerId } = await readNativeStaticSourcePermissionEvidence();

test('postgres: eight static video source permission combinations match complete native detail responses', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async () => {
  const actual = await recordItemFilterCandidate({
    dialect: 'postgres', connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
    scenarioName: 'static-source-permissions',
    fixture: { ...fixture, cases: binding.cases.map(entry => ({ ...entry,
      policy: { ...entry.transcodingPolicy, IsAdministrator: true,
        AllowedTags: [], BlockedTags: [], BlockUnratedItems: [],
        MaxParentalRating: null, MaxParentalSubRating: null },
    })) },
    fields: 'SortName', captureResponseBodies: true, trackUserData: true,
    trackFilesystem: true, captureFilesystemDomains: true,
    prepareScenario: context => seedNativeFilterInput(context, 'rating-permissions', inputs),
  });
  assertCompleteFilterHttpResponses(actual, nativeHttp, { scenarioName: 'static-source-permissions', nativeServerId });
  await writeCompleteFilterHttpEvidence(actual, nativeHttp, { scenarioName: 'static-source-permissions', nativeServerId });
  assert.equal(actual.httpCases, 8);
  assert.equal(actual.cases.length, 8);
  for (const [index, entry] of actual.cases.entries()) {
    assert.deepEqual(entry.endpoints.map(endpoint => endpoint.endpoint), ['detail']);
    for (const [field, requested] of Object.entries(entry.policy)) {
      if (requested === null) assert.equal(Object.hasOwn(entry.policyReadback, field), false, entry.name + ':' + field);
      else assert.deepEqual(entry.policyReadback[field], requested, entry.name + ':' + field);
    }
    const response = entry.endpoints[0].response;
    assert.equal(response.status, 200);
    assert.equal(response.body.MediaSources.length, 1);
    const source = response.body.MediaSources[0];
    assert.equal(source.SupportsTranscoding, Boolean(index & 1));
    assert.equal(source.SupportsDirectStream, Boolean(index & 4));
    assert.equal(source.SupportsDirectPlay, true);
  }
  assert.deepEqual(actual.afterReads, actual.beforeReads);
  assert.deepEqual(actual.userDataAfterReads, actual.userDataBeforeReads);
  assert.deepEqual(actual.filesystemAfterReads, actual.filesystemBeforeReads);
  assert.deepEqual(actual.filesystemAfterShutdown, actual.filesystemAfterReads);
  assert.deepEqual(actual.filesystemDomainsAfterReads, actual.filesystemDomainsBeforeReads);
  assert.deepEqual(actual.filesystemDomainsAfterShutdown, actual.filesystemDomainsAfterReads);
  assert.deepEqual(actual.runtimeErrors, []);
  assert.deepEqual(actual.handledExpectedRuntimeErrors, []);
  assert.deepEqual(actual.cleanup, { runtimeClosed: true, databaseClosed: true,
    portReleased: true, postgresSchemasRemoved: true, programDataDirectoryRemoved: true });
  await writeCurrentFilterCandidateEvidence('static-source-permissions', actual, { scenarioName: 'static-source-permissions' });
});

// Release after all test hooks, streams, processes and resource postconditions.
after(async () => { await resourceLease?.release(); });
