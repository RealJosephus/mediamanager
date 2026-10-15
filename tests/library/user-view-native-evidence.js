import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveNativeReferencePreparationInput,
  verifyNativeReferencePreparation } from './native-reference-preparation.js';

const stable = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

const runNames = Object.freeze({
  'user-root-visibility': 'native-run-v4',
  'user-view-menu': 'native-run',
  'user-view-query': 'native-run-v4',
});

export function userViewArtifactPaths(scenario) {
  const runName = runNames[scenario];
  assert.ok(runName, `Unknown UserView evidence scenario: ${scenario}`);
  return [
    'record-native.mjs',
    'source-initial.db',
    'source-bootstrap.json',
    'source-bootstrap.log',
    `${runName}/input.json`,
    `${runName}/reference-preparation.json`,
    `${runName}/native-http.json`,
    `${runName}/setup-http.json`,
    `${runName}/stages.json`,
    `${runName}/case-stages.json`,
    `${runName}/summary.json`,
    `${runName}/reference-stdout.log`,
    `${runName}/reference-stderr.log`,
    `${runName}/reference/data/data/jellyfin.db`,
    'oracle-validation.json',
  ];
}

function isWithin(root, filename) {
  const relative = path.relative(root, filename);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

async function evidenceRootState(outputRoot) {
  const root = path.resolve(outputRoot instanceof URL ? fileURLToPath(outputRoot) : outputRoot);
  const [metadata, resolved] = await Promise.all([lstat(root), realpath(root)]);
  assert.equal(metadata.isSymbolicLink(), false, 'UserView evidence root cannot be a symbolic link or junction.');
  assert.equal(metadata.isDirectory(), true, 'UserView evidence root must be a directory.');
  return { root, resolved };
}

async function resolveEvidenceFile(rootState, relative) {
  assert.equal(typeof relative, 'string', 'UserView artifact paths must be strings.');
  assert.equal(relative.includes('\\'), false, `UserView artifact path must use canonical separators: ${relative}`);
  assert.equal(path.posix.normalize(relative), relative, `UserView artifact path must be canonical: ${relative}`);
  assert.equal(path.posix.isAbsolute(relative), false, `UserView artifact path must be relative: ${relative}`);
  const filename = path.resolve(rootState.root, ...relative.split('/'));
  assert.ok(isWithin(rootState.root, filename), `UserView artifact escapes its root: ${relative}`);
  const [metadata, resolved] = await Promise.all([lstat(filename), realpath(filename)]);
  assert.equal(metadata.isSymbolicLink(), false, `UserView artifact cannot be a link: ${relative}`);
  assert.equal(metadata.isFile(), true, `UserView artifact must be a regular file: ${relative}`);
  assert.ok(isWithin(rootState.resolved, resolved), `UserView artifact escapes its real root: ${relative}`);
  return { filename, metadata };
}

export async function assertUserViewArtifactManifest({ outputRoot, scenario, provenance }) {
  const rootState = await evidenceRootState(outputRoot);
  const expectedPaths = userViewArtifactPaths(scenario);
  assert.equal(provenance.scenario, scenario, 'UserView provenance scenario must match its consumer.');
  assert.ok(Array.isArray(provenance.artifacts), 'UserView provenance artifacts must be an array.');
  assert.deepEqual(provenance.artifacts.map(artifact => artifact.path), expectedPaths,
    'UserView evidence must contain exactly the canonical artifact list in order.');
  for (const artifact of provenance.artifacts) {
    assert.deepEqual(Object.keys(artifact).sort(), ['bytes', 'path', 'sha256'], `${artifact.path}: artifact fields`);
    assert.equal(Number.isSafeInteger(artifact.bytes) && artifact.bytes >= 0, true, `${artifact.path}: artifact bytes`);
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/u, `${artifact.path}: artifact sha256`);
    const { filename, metadata } = await resolveEvidenceFile(rootState, artifact.path);
    const bytes = await readFile(filename);
    assert.deepEqual({ bytes: metadata.size, readBytes: bytes.length, sha256: sha256(bytes) },
      { bytes: artifact.bytes, readBytes: artifact.bytes, sha256: artifact.sha256 },
      `artifact size/hash: ${artifact.path}`);
  }
  return provenance;
}

export async function assertUserViewEvidenceProvenance({ evidence, scenario, sourceRecorder, jellyfinDll,
  fixtureUserId }) {
  const outputRoot = new URL('../', evidence);
  const rootState = await evidenceRootState(outputRoot);
  const provenanceFile = await resolveEvidenceFile(rootState, 'provenance.json');
  const provenance = JSON.parse(await readFile(provenanceFile.filename, 'utf8'));
  await assertUserViewArtifactManifest({ outputRoot, scenario, provenance });
  const bundledDatabase = await resolveEvidenceFile(rootState, 'source-initial.db');
  const bundledBootstrap = await resolveEvidenceFile(rootState, 'source-bootstrap.json');
  const bundledBootstrapLog = await resolveEvidenceFile(rootState, 'source-bootstrap.log');
  const runName = runNames[scenario];
  const preparationFile = await resolveEvidenceFile(rootState, `${runName}/reference-preparation.json`);
  const preparation = JSON.parse(await readFile(preparationFile.filename, 'utf8'));
  const bundledPreparationInputs = new Map([
    [preparation.inputs?.[0]?.path, bundledBootstrap.filename],
    [preparation.inputs?.[5]?.path, bundledBootstrapLog.filename],
  ]);
  const referencePreparation = await verifyNativeReferencePreparation({
    preparation,
    profile: 'user-view',
    sourceDatabase: bundledDatabase.filename,
    fixtureUserId,
    resolveInput(profile, historicalPath) {
      return bundledPreparationInputs.get(historicalPath)
        ?? resolveNativeReferencePreparationInput(profile, historicalPath);
    },
  });
  const [recorderBytes, databaseBytes, dllBytes, bootstrapBytes, bootstrapLogBytes] = await Promise.all([
    readFile(sourceRecorder), readFile(bundledDatabase.filename), readFile(jellyfinDll),
    readFile(bundledBootstrap.filename), readFile(bundledBootstrapLog.filename),
  ]);
  const current = {
    recorderSha256: sha256(recorderBytes),
    sourceDatabaseSha256: sha256(databaseBytes),
    dllSha256: sha256(dllBytes),
    dotnetSha256: referencePreparation.executables.dotnet.sha256,
    ffmpegSha256: referencePreparation.executables.ffmpeg.sha256,
    sourceBootstrapSha256: sha256(bootstrapBytes),
    sourceBootstrapLogSha256: sha256(bootstrapLogBytes),
  };
  assert.deepEqual(provenance.sourceInputs.before, current,
    'current recorder/DLL and bundled source database must match pre-run bindings');
  assert.deepEqual(provenance.sourceInputs.after, current,
    'recorded source inputs must have remained unchanged and match the bundled source database');
  assert.ok(Object.values(provenance.checks).every(Boolean), 'copy, launch, and unchanged checks must all pass');
  assert.equal(provenance.copies.recorderSha256, current.recorderSha256);
  assert.deepEqual(provenance.copies.sourceDatabase,
    { path: 'source-initial.db', sha256: current.sourceDatabaseSha256 });
  assert.deepEqual(provenance.copies.sourcePreparation, {
    bootstrap: { path: 'source-bootstrap.json', sha256: referencePreparation.inputs[0].sha256 },
    log: { path: 'source-bootstrap.log', sha256: referencePreparation.inputs[5].sha256 },
  });
  assert.equal(provenance.copies.databaseBeforeSeedSha256, current.sourceDatabaseSha256);
  assert.deepEqual(preparation.copyBindings, provenance.copies,
    'The parsed reference-preparation copy bindings must match root provenance.');
  assert.equal(preparation.sourceDatabaseSha256, current.sourceDatabaseSha256);
  const command = provenance.launch?.command;
  assert.ok(Array.isArray(command), 'UserView provenance must record the actual native launch command.');
  const ffmpegIndex = command.indexOf('--ffmpeg');
  assert.ok(ffmpegIndex > 1 && ffmpegIndex + 1 < command.length, 'UserView launch must include an ffmpeg input.');
  assert.equal(path.normalize(command[0]), path.normalize(referencePreparation.bootstrap.executables[0].path),
    'UserView launch dotnet must be the prepared executable.');
  assert.equal(path.normalize(command[1]), path.normalize(referencePreparation.bootstrap.executables[1].path),
    'UserView launch DLL must be the prepared executable.');
  assert.equal(path.normalize(command[ffmpegIndex + 1]),
    path.normalize(referencePreparation.bootstrap.executables[2].path),
    'UserView launch ffmpeg must be the prepared executable.');
  assert.equal(provenance.launch.dllSha256, referencePreparation.executables.jellyfinDll.sha256,
    'UserView launch DLL digest must match the current prepared executable.');
  assert.equal(provenance.launch.dotnetSha256, referencePreparation.executables.dotnet.sha256,
    'UserView launch dotnet digest must match the current prepared executable.');
  assert.equal(provenance.launch.ffmpegSha256, referencePreparation.executables.ffmpeg.sha256,
    'UserView launch ffmpeg digest must match the current prepared executable.');
  assert.equal(current.dllSha256, referencePreparation.executables.jellyfinDll.sha256);
  return { ...provenance, preparation, referencePreparation };
}

export function candidateCasesFromTrackedInput(fixture) {
  return fixture.cases.map(testCase => ({
    ...testCase,
    expectedStatus: testCase.expectedStatus ?? 200,
  }));
}

function expectedSetupRecords(fixture) {
  const expected = [{
    kind: 'server-configuration',
    values: { EnableGroupingMoviesIntoCollections: false, EnableGroupingShowsIntoCollections: false },
  }];
  for (const testCase of fixture.cases) {
    if (testCase.serverConfiguration) expected.push({
      kind: 'case-server-configuration', name: testCase.name, values: testCase.serverConfiguration,
    });
    if (testCase.configuration) expected.push({
      kind: 'user-configuration', name: testCase.name, values: testCase.configuration,
    });
    if (testCase.policy) expected.push({ kind: 'policy', name: testCase.name, values: testCase.policy });
  }
  return expected;
}

function assertResponseShape(response, expectedStatus, label) {
  assert.equal(response.status, expectedStatus, `${label}: status comes from tracked input, not the capture`);
  assert.equal(typeof response.bodyText, 'string', `${label}: body must have been read completely`);
  if (expectedStatus === 200) {
    assert.equal(response.contentType, 'application/json; charset=utf-8', `${label}: list content type`);
    assert.ok(response.bodyJson && typeof response.bodyJson === 'object' && !Array.isArray(response.bodyJson),
      `${label}: list body must be an object`);
    assert.deepEqual(Object.keys(response.bodyJson).sort(), ['Items', 'StartIndex', 'TotalRecordCount'].sort(),
      `${label}: complete list envelope`);
    assert.ok(Array.isArray(response.bodyJson.Items), `${label}: Items must be an array`);
    assert.ok(Number.isInteger(response.bodyJson.StartIndex) && response.bodyJson.StartIndex >= 0,
      `${label}: StartIndex must be a non-negative integer`);
    assert.ok(Number.isInteger(response.bodyJson.TotalRecordCount) && response.bodyJson.TotalRecordCount >= 0,
      `${label}: TotalRecordCount must be a non-negative integer`);
    assert.deepEqual(JSON.parse(response.bodyText), response.bodyJson, `${label}: parsed and raw bodies must agree`);
    return;
  }
  if (expectedStatus === 401) {
    assert.equal(response.contentType, 'application/json; charset=utf-8', `${label}: authorization content type`);
    assert.equal(typeof response.bodyJson, 'string', `${label}: authorization body must be a JSON string`);
    assert.ok(response.bodyJson.length > 0, `${label}: authorization body must not be empty`);
    assert.equal(JSON.parse(response.bodyText), response.bodyJson, `${label}: parsed and raw bodies must agree`);
    return;
  }
  assert.ok(expectedStatus === 400 || expectedStatus === 500, `${label}: unsupported tracked status`);
  assert.equal(response.contentType, 'text/plain', `${label}: request-error content type`);
  assert.equal(Object.hasOwn(response, 'bodyJson'), false, `${label}: request-error body is not JSON`);
  assert.equal(response.bodyText, 'Error processing request.', `${label}: native request-error body`);
}

export function assertUserViewNativeEvidence({ fixture, http, setup, stages, caseStages, menuLifecycle }) {
  const expected = fixture.cases.flatMap(testCase => (testCase.endpoints ?? ['items', 'legacy'])
    .map(endpoint => ({ testCase, endpoint })));
  assert.equal(http.records.length, expected.length, 'complete HTTP case matrix');
  for (const [index, { testCase, endpoint }] of expected.entries()) {
    const record = http.records[index], label = `${testCase.name}:${endpoint}`;
    assert.ok(record, `${label}: missing response`);
    assert.deepEqual([record.name, record.endpoint, record.query, record.scope],
      [testCase.name, endpoint, testCase.query, testCase.scope], `${label}: case identity and order`);
    assertResponseShape(record.response, testCase.expectedStatus ?? 200, label);
  }

  const expectedSetup = expectedSetupRecords(fixture);
  assert.equal(setup.records.length, expectedSetup.length, 'complete setup/control sequence');
  for (const [index, expectedRecord] of expectedSetup.entries()) {
    const record = setup.records[index];
    assert.deepEqual([record.kind, record.name, record.values, record.status],
      [expectedRecord.kind, expectedRecord.name, expectedRecord.values, 204], `setup/control[${index}]`);
  }

  assert.equal(caseStages.length, expected.length, 'complete endpoint stage matrix');
  for (const [index, { testCase, endpoint }] of expected.entries()) {
    assert.deepEqual([caseStages[index].name, caseStages[index].endpoint], [testCase.name, endpoint],
      `case stage identity[${index}]`);
  }
  if (menuLifecycle) {
    assert.ok(stages.before && stages.afterReads && stages.afterShutdown, 'complete menu lifecycle stages');
    assert.deepEqual(caseStages[0].before, stages.before, 'first endpoint starts at the initial stage');
    assert.deepEqual(caseStages.at(-1).after, stages.afterReads, 'last endpoint reaches afterReads');
    assert.deepEqual(stages.afterReads, stages.afterShutdown, 'shutdown does not mutate menu state');
    for (const [index, state] of caseStages.flatMap(stage => [stage.before, stage.after]).entries()) {
      assert.ok(state?.database && state?.filesystem, `menu lifecycle snapshot shape[${index}]`);
      assert.deepEqual(state.database.foreignKeyCheck, [], `menu lifecycle foreign keys[${index}]`);
    }
  } else {
    assert.deepEqual(stages.before, stages.afterReads, 'read-only scenario does not mutate state');
    assert.deepEqual(stages.before, stages.afterShutdown, 'shutdown does not mutate state');
    assert.ok(caseStages.every(stage => stable(Object.keys(stage).sort()) === stable(['endpoint', 'name'])),
      'read-only endpoint controls contain identity only');
  }
}
