import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyNativeReferencePreparation } from './native-reference-preparation.js';
import { nativeQueryReference, nativeQueryExecutables, nativeItemFilterRecordedOutputRoot } from './native-query-inputs.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sha256File = async filename => sha256(await readFile(filename));

function isWithin(root, filename) {
  const relative = path.relative(root, filename);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

async function evidenceRootState(evidenceRoot) {
  const root = path.resolve(evidenceRoot);
  const [metadata, resolved] = await Promise.all([lstat(root), realpath(root)]);
  assert.equal(metadata.isSymbolicLink(), false, 'Item-filter evidence root cannot be a link.');
  assert.equal(metadata.isDirectory(), true, 'Item-filter evidence root must be a directory.');
  return { root, resolved };
}

async function resolveEvidenceArtifact(rootState, relative) {
  assert.equal(typeof relative, 'string', 'Item-filter artifact paths must be strings.');
  assert.equal(relative.includes('\\'), false, `Item-filter artifact path must use canonical separators: ${relative}`);
  assert.equal(path.posix.normalize(relative), relative, `Item-filter artifact path must be canonical: ${relative}`);
  assert.equal(path.posix.isAbsolute(relative), false, `Item-filter artifact path must be relative: ${relative}`);
  const filename = path.resolve(rootState.root, ...relative.split('/'));
  assert.ok(isWithin(rootState.root, filename), `Item-filter artifact escapes its root: ${relative}`);
  const [metadata, resolved] = await Promise.all([lstat(filename), realpath(filename)]);
  assert.equal(metadata.isSymbolicLink(), false, `Item-filter artifact cannot be a link: ${relative}`);
  assert.equal(metadata.isFile(), true, `Item-filter artifact must be a regular file: ${relative}`);
  assert.ok(isWithin(rootState.resolved, resolved), `Item-filter artifact escapes its real root: ${relative}`);
  return { filename, metadata };
}

export async function assertNativeItemFilterArtifactManifest({ evidenceRoot, artifacts, expectedPaths }) {
  const rootState = await evidenceRootState(evidenceRoot);
  assert.ok(Array.isArray(artifacts), 'Item-filter artifacts must be an array.');
  assert.deepEqual(artifacts.map(item => item.path), expectedPaths,
    'Item-filter artifacts must be the exact canonical list in recording order.');
  for (const artifact of artifacts) {
    assert.deepEqual(Object.keys(artifact).sort(), ['path', 'sha256', 'size'], `${artifact.path}: artifact fields`);
    assert.equal(Number.isSafeInteger(artifact.size) && artifact.size >= 0, true, `${artifact.path}: size`);
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/u, artifact.path);
    const { filename, metadata } = await resolveEvidenceArtifact(rootState, artifact.path);
    const bytes = await readFile(filename);
    assert.equal(metadata.size, artifact.size, `${artifact.path}: stat size`);
    assert.equal(bytes.length, artifact.size, `${artifact.path}: read size`);
    assert.equal(sha256(bytes), artifact.sha256, `${artifact.path}: sha256`);
  }
}

function assertResponseContracts(nativeHttp) {
  for (const record of nativeHttp.records) {
    const { response } = record;
    assert.equal(response.status, record.expectedStatus, `${record.name}:${record.endpoint}:expectedStatus`);
    assert.ok(response.contentType?.startsWith('application/json'), `${record.name}:${record.endpoint}:contentType`);
    assert.ok(response.bodyJson && typeof response.bodyJson === 'object' && !Array.isArray(response.bodyJson),
      `${record.name}:${record.endpoint}:body`);
    if (response.status === 200 && record.endpoint !== 'detail') {
      assert.ok(Array.isArray(response.bodyJson.Items), `${record.name}:${record.endpoint}:Items`);
      assert.ok(Number.isInteger(response.bodyJson.TotalRecordCount), `${record.name}:${record.endpoint}:TotalRecordCount`);
      assert.ok(Number.isInteger(response.bodyJson.StartIndex), `${record.name}:${record.endpoint}:StartIndex`);
      const countDisabled = new URL(record.route, 'http://127.0.0.1').searchParams
        .get('EnableTotalRecordCount')?.toLowerCase() === 'false';
      if (countDisabled) {
        assert.equal(response.bodyJson.TotalRecordCount, response.bodyJson.Items.length,
          `${record.name}:${record.endpoint}:disabledCount`);
      } else {
        assert.ok(response.bodyJson.Items.length <= response.bodyJson.TotalRecordCount
          && response.bodyJson.StartIndex + response.bodyJson.Items.length <= response.bodyJson.TotalRecordCount,
        `${record.name}:${record.endpoint}:counts`);
      }
      for (const item of response.bodyJson.Items) {
        assert.ok(typeof item.Id === 'string' && typeof item.Name === 'string' && typeof item.Type === 'string',
          `${record.name}:${record.endpoint}:item`);
      }
    } else if (response.status === 200) {
      assert.ok(typeof response.bodyJson.Id === 'string' && typeof response.bodyJson.Name === 'string'
        && typeof response.bodyJson.Type === 'string', `${record.name}:${record.endpoint}:detail`);
    } else {
      assert.equal(response.bodyJson.status, response.status, `${record.name}:${record.endpoint}:problemStatus`);
      assert.ok(typeof response.bodyJson.title === 'string' && response.bodyJson.title.length > 0,
        `${record.name}:${record.endpoint}:problemTitle`);
      assert.ok(typeof response.bodyJson.type === 'string' && response.bodyJson.type.length > 0,
        `${record.name}:${record.endpoint}:problemType`);
    }
  }
}

export async function verifyNativeItemFilterEvidence(options) {
  const recorderSource = await readFile(path.join(repoRoot, 'tools/compat/record-item-filter-native.mjs'), 'utf8');
  return verifyNativeItemFilterEvidenceContract({ ...options, recorderSource });
}

export async function verifyNativeItemFilterEvidenceContract({ evidence, fixtureUrl, scenario, runDirectory,
  expectedRecords, recorderSource }) {
  assert.equal(typeof recorderSource, 'string');
  const nativeRun = fileURLToPath(evidence);
  const evidenceRoot = path.dirname(nativeRun.replace(/[\\/]$/u, ''));
  const [summary, provenance, oracle, nativeHttp, preparation, fixtureBytes] = await Promise.all([
    readFile(path.join(nativeRun, 'summary.json'), 'utf8').then(JSON.parse),
    readFile(path.join(nativeRun, 'provenance.json'), 'utf8').then(JSON.parse),
    readFile(path.join(evidenceRoot, 'oracle-validation.json'), 'utf8').then(JSON.parse),
    readFile(path.join(nativeRun, 'native-http.json'), 'utf8').then(JSON.parse),
    readFile(path.join(nativeRun, 'reference-preparation.json'), 'utf8').then(JSON.parse),
    readFile(fixtureUrl),
  ]);
  const invocation = summary.invocation;
  assert.equal(invocation.scenario, scenario);
  assert.equal(invocation.evidenceName, path.basename(evidenceRoot));
  assert.equal(invocation.runDirectory, runDirectory);
  const recordedOutputRoot = nativeItemFilterRecordedOutputRoot;
  assert.ok(isWithin(recordedOutputRoot, evidenceRoot));
  assert.equal(invocation.outputRoot, path.relative(recordedOutputRoot, evidenceRoot).replaceAll('\\', '/'));
  assert.ok(Number.isInteger(invocation.preferredPort) && Number.isInteger(invocation.selectedPort));
  assert.equal(summary.selectedPort, invocation.selectedPort);
  assert.equal(summary.passed, true);
  assert.equal(summary.scenario, scenario);
  assert.equal(summary.runDirectory, runDirectory);
  assert.deepEqual(nativeHttp.invocation, invocation);
  assert.deepEqual(provenance.invocation, invocation);
  assert.deepEqual(oracle.invocation, invocation);
  assert.equal(summary.httpRecords, expectedRecords);
  assert.equal(nativeHttp.records.length, expectedRecords);
  assertResponseContracts(nativeHttp);

  assert.equal(summary.completeDatabaseReadStableAndRestored, true);
  assert.equal(summary.fullDatabaseCoverage.readStable, true);
  assert.equal(summary.fullDatabaseCoverage.restored, true);
  assert.equal(summary.fullDatabaseCoverage.baselineSha256, summary.fullDatabaseCoverage.afterShutdownSha256);
  assert.equal(summary.fullDatabaseCoverage.readGates.length, summary.cases);
  assert.ok(summary.fullDatabaseCoverage.readGates.every(gate => gate.stable
    && gate.beforeSha256 === gate.afterSha256));
  assert.equal(summary.foreignKeyCheckPassedAllStages, true);
  assert.equal(summary.integrityCheckPassedAllStages, true);
  assert.equal(summary.cleanShutdown, true);
  assert.deepEqual(summary.processResult, { code: 0, signal: null });
  assert.equal(summary.pidGone, true);
  assert.equal(summary.portAvailable, true);
  assert.equal(summary.databaseUnlocked, true);
  assert.equal(summary.sourceUnchanged, true);
  assert.deepEqual(summary.negativeControls, {
    containment: { existingAncestorChecked: true,
      linkType: process.platform === 'win32' ? 'junction' : 'directory-symlink', linkEscapeRejected: true },
    responseValidation: { badStatusRejected: true, badBodyRejected: true, badProblemBodyRejected: true },
    artifactManifest: { pristineManifestAccepted: true, tamperedManifestRejected: true },
  });
  assert.deepEqual(provenance.negativeControls, summary.negativeControls);
  assert.deepEqual(oracle.negativeControls, summary.negativeControls);

  const sourceDatabase = nativeQueryReference.sourceDatabase.filename;
  const { jellyfinDll, dotnet } = nativeQueryExecutables;
  assert.equal(summary.sourceSummary.sourceDatabaseSha256, await sha256File(sourceDatabase));
  assert.equal(summary.sourceSummary.jellyfinDllSha256, await sha256File(jellyfinDll));
  assert.equal(summary.sourceSummary.dotnetSha256, await sha256File(dotnet));
  assert.equal(summary.sourceSummary.initializedFromEmpty, true);
  assert.equal(summary.sourceSummary.createdThroughNativeApi, true);
  assert.equal(summary.sourceSummary.sourceStopped, true);
  assert.deepEqual(provenance.sourceSummary, summary.sourceSummary);
  assert.deepEqual(oracle.sourceSummary, summary.sourceSummary);
  assert.equal(summary.sourceSummary.preparedInputCount, preparation.inputs.length);
  assert.equal(summary.sourceSummary.sourceDatabaseSha256, preparation.sourceDatabaseSha256);
  assert.deepEqual(provenance.preparedInputs, preparation.inputs);
  const referencePreparation = await verifyNativeReferencePreparation({
    preparation,
    profile: 'item-filter',
    sourceDatabase,
    fixtureUserId: JSON.parse(fixtureBytes).userId,
  });
  assert.equal(summary.sourceSummary.dotnetSha256, referencePreparation.executables.dotnet.sha256,
    'The recorder dotnet identity must match the prepared executable.');
  assert.equal(summary.sourceSummary.jellyfinDllSha256, referencePreparation.executables.jellyfinDll.sha256,
    'The recorder DLL identity must match the prepared executable.');

  const recorderSha256 = await sha256File(path.join(evidenceRoot, 'record-native.mjs'));
  assert.equal(recorderSha256, summary.recorderSha256);
  assert.equal(recorderSha256, sha256(recorderSource));
  assert.equal(summary.fixtureSha256, sha256(fixtureBytes));
  assert.equal(provenance.fixture.sha256, summary.fixtureSha256);
  assert.equal(oracle.fixtureSha256, summary.fixtureSha256);
  assert.equal(provenance.scenarioDefinitionSha256, summary.scenarioDefinitionSha256);
  assert.equal(oracle.scenarioDefinitionSha256, summary.scenarioDefinitionSha256);
  assert.equal(oracle.passed, true);

  const prefix = `${runDirectory}/`;
  const preSummaryPaths = ['record-native.mjs', `${prefix}reference-preparation.json`, `${prefix}native-http.json`,
    `${prefix}setup-http.json`, `${prefix}stages.json`, `${prefix}reference-stdout.log`,
    `${prefix}reference-stderr.log`, `${prefix}reference/data/data/jellyfin.db`];
  const provenancePaths = [...preSummaryPaths, `${prefix}summary.json`];
  const oraclePaths = [...provenancePaths, `${prefix}provenance.json`];
  await assertNativeItemFilterArtifactManifest({ evidenceRoot, artifacts: summary.boundArtifacts,
    expectedPaths: preSummaryPaths });
  await assertNativeItemFilterArtifactManifest({ evidenceRoot, artifacts: provenance.artifacts,
    expectedPaths: provenancePaths });
  await assertNativeItemFilterArtifactManifest({ evidenceRoot, artifacts: oracle.artifacts,
    expectedPaths: oraclePaths });
  return { summary, provenance, oracle, nativeHttp, preparation, referencePreparation };
}
