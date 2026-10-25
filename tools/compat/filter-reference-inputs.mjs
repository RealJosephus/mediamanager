import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const idKey = value => String(value).replaceAll('-', '').toLowerCase();

export async function captureFilterReferencePreparation({ sourceRoot, sourceDatabase, repoRoot, fixtureUserId }) {
  const reportPath = path.join(sourceRoot, 'bootstrap.json');
  const reportBytes = await readFile(reportPath), report = JSON.parse(reportBytes);
  assert.equal(report.initializedFromEmpty, true, 'An actual native empty-instance initialization is required.');
  assert.equal(report.process.stopped, true);
  assert.equal(report.process.exitCode, 0);
  assert.equal(report.process.signalCode, null);
  assert.equal(report.outputResolvedInsideWorkspaceTemporary, true);
  assert.equal(report.baseline.sourceCopyVerifiedBeforeAndAfter, true);
  assert.equal(report.baseline.runtimeUnchanged, true);
  assert.equal(report.executablesUnchanged, true);
  assert.ok(report.baseline.runtimeEntriesSha256);
  for (const verified of [report.baseline.verifiedBefore, report.baseline.verifiedAfter]) {
    assert.equal(verified.contentUnchanged, true);
    assert.equal(verified.statusUnchanged, true);
    assert.equal(verified.fileDiscoveryUnchanged, true);
    assert.equal(verified.verifiedFiles, report.baseline.files);
    assert.equal(verified.head, report.baseline.head);
    assert.equal(verified.contentDigest, report.baseline.contentDigest);
  }
  assert.equal(report.identityRemapping.createdThroughNativeApi, true);
  assert.equal(idKey(report.identityRemapping.fixtureUserId), idKey(fixtureUserId));
  assert.deepEqual(report.foreignKeyCheck, []);
  assert.ok(report.migrationHistory > 0);
  assert.ok(report.observations.some(entry => entry.route === '/Users/New' && entry.status === 200
    && idKey(entry.responseBody.Id) === idKey(report.identityRemapping.actualUserId)));
  assert.ok(report.observations.some(entry => entry.route === '/Users/AuthenticateByName' && entry.status === 200
    && idKey(entry.responseBody.User.Id) === idKey(report.identityRemapping.actualUserId)
    && entry.responseBody.User.Policy.IsAdministrator === true));
  assert.equal(report.observations.at(-1).route, '/System/Shutdown');
  assert.equal(report.observations.at(-1).status, 204);
  assert.equal(path.resolve(sourceDatabase), path.resolve(report.initialDatabase));
  const sourceDatabaseSha256 = digest(await readFile(sourceDatabase));
  assert.equal(sourceDatabaseSha256, report.initialDatabaseSha256, 'The stopped native source database changed after preparation.');
  const inputs = [];
  async function bind(kind, filename, expected) {
    const sha256 = digest(await readFile(filename));
    if (expected) assert.equal(sha256, expected, `Reference preparation input changed: ${filename}`);
    inputs.push({ kind, path: path.relative(repoRoot, filename).replaceAll('\\', '/'), sha256 });
  }
  await bind('nativeReferencePreparation', reportPath, digest(reportBytes));
  await bind('referencePreparationVerifier', fileURLToPath(import.meta.url));
  await bind('referenceBootstrapScript', report.bootstrapScript.path, report.bootstrapScript.sha256);
  assert.equal(report.verificationTools.length, 2);
  for (const entry of report.verificationTools) await bind('referencePreparationVerificationTool', entry.path, entry.sha256);
  await bind('nativeReferenceBootstrapLog', path.join(sourceRoot, 'bootstrap.log'));
  await bind('nativeReferenceBaselineManifest', report.baseline.manifestPath, report.baseline.manifestSha256);
  await bind('nativeReferenceModel', path.join(repoRoot, 'src/database/native-model.json'), report.nativeModelSha256);
  for (const entry of report.executables) await bind('nativeReferencePreparationExecutable', entry.path, entry.sha256);
  return { initializedFromEmpty: true, createdThroughNativeApi: true, stopped: true,
    sourceDatabaseSha256, identityRemapping: report.identityRemapping, inputs };
}
