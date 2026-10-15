import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { nativeQueryReference, resolveNativeQueryInput, verifyNativeQuerySourceBindings } from './native-query-inputs.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const idKey = value => String(value).replaceAll('-', '').toLowerCase();
const changedReferences = Object.freeze([
  { table: 'ActivityLogs', column: 'UserId', count: 4 },
  { table: 'Devices', column: 'UserId', count: 1 },
  { table: 'Permissions', column: 'UserId', count: 24 },
  { table: 'Preferences', column: 'UserId', count: 13 },
  { table: 'Users', column: 'Id', count: 1 },
]);
const remappingScope = 'Stopped isolated database: only Guid-column references to the API-created synthetic admin are remapped; native password hashing and permission records are retained.';
function assertProfile(name) {
  assert.ok(['user-view', 'item-filter'].includes(name), 'Unknown native query reference profile: ' + name);
}

export function nativeReferencePreparationInputs(profileName) {
  assertProfile(profileName);
  return nativeQueryReference.preparationInputs;
}

export function resolveNativeReferencePreparationInput(profileName, filename) {
  assertProfile(profileName);
  return resolveNativeQueryInput(filename);
}

async function readRegularFile(filename, label) {
  const absolute = path.resolve(filename instanceof URL ? fileURLToPath(filename) : filename);
  const [metadata, resolved] = await Promise.all([lstat(absolute), realpath(absolute)]);
  assert.equal(metadata.isSymbolicLink(), false, `${label}: current input cannot be a link`);
  assert.equal(metadata.isFile(), true, `${label}: current input must be a regular file`);
  assert.equal(resolved, absolute, `${label}: current input cannot resolve through a link`);
  const bytes = await readFile(absolute);
  assert.equal(metadata.size, bytes.length, `${label}: current input stat/read size`);
  return { filename: absolute, bytes, size: bytes.length, sha256: sha256(bytes) };
}

function assertIdentityRemapping(remapping, fixtureUserId, label) {
  assert.deepEqual(Object.keys(remapping ?? {}).sort(),
    ['actualUserId', 'changedReferences', 'createdThroughNativeApi', 'fixtureUserId', 'scope'],
    `${label}: identity-remapping fields`);
  assert.equal(remapping.createdThroughNativeApi, true, `${label}: native user creation`);
  assert.match(remapping.actualUserId, /^[0-9a-f]{32}$/u, `${label}: actual native user ID`);
  assert.equal(idKey(remapping.fixtureUserId), idKey(fixtureUserId), `${label}: fixture user binding`);
  assert.deepEqual(remapping.changedReferences, changedReferences, `${label}: remapped reference set`);
  assert.equal(remapping.scope, remappingScope, `${label}: remapping scope`);
}

function assertBootstrapReport(report, { preparation, fixtureUserId, baselineManifest }, label) {
  assert.equal(report.initializedFromEmpty, true, `${label}: empty-instance initialization`);
  assert.deepEqual(Object.keys(report.process ?? {}).sort(), ['exitCode', 'pid', 'signalCode', 'stopped'],
    `${label}: process fields`);
  assert.ok(Number.isInteger(report.process.pid) && report.process.pid > 0, `${label}: process pid`);
  assert.deepEqual({ exitCode: report.process.exitCode, signalCode: report.process.signalCode,
    stopped: report.process.stopped }, { exitCode: 0, signalCode: null, stopped: true }, `${label}: stopped process`);
  assert.equal(report.outputResolvedInsideWorkspaceTemporary, true, `${label}: isolated output`);
  assert.equal(report.executablesUnchanged, true, `${label}: executable stability`);
  assert.deepEqual(report.foreignKeyCheck, [], `${label}: foreign keys`);
  assert.ok(Number.isInteger(report.migrationHistory) && report.migrationHistory > 0, `${label}: migrations`);
  assert.equal(report.initialDatabaseSha256, preparation.sourceDatabaseSha256, `${label}: source database digest`);
  assertIdentityRemapping(report.identityRemapping, fixtureUserId, `${label}:bootstrap`);
  assert.deepEqual(report.identityRemapping, preparation.identityRemapping, `${label}: preparation remapping binding`);

  const baseline = report.baseline;
  assert.ok(typeof baseline?.head === 'string' && baseline.head.length > 0, `${label}: baseline head`);
  assert.match(baseline.contentDigest, /^[0-9a-f]{64}$/u, `${label}: baseline content digest`);
  assert.ok(Number.isInteger(baseline.files) && baseline.files > 0, `${label}: baseline file count`);
  assert.equal(baseline.sourceCopyVerifiedBeforeAndAfter, true, `${label}: source-copy verification`);
  assert.equal(baseline.runtimeUnchanged, true, `${label}: runtime stability`);
  assert.match(baseline.runtimeEntriesSha256, /^[0-9a-f]{64}$/u, `${label}: runtime manifest digest`);
  for (const [stage, verified] of [['before', baseline.verifiedBefore], ['after', baseline.verifiedAfter]]) {
    assert.deepEqual({ contentUnchanged: verified?.contentUnchanged, statusUnchanged: verified?.statusUnchanged,
      fileDiscoveryUnchanged: verified?.fileDiscoveryUnchanged, verifiedFiles: verified?.verifiedFiles,
      head: verified?.head, contentDigest: verified?.contentDigest },
    { contentUnchanged: true, statusUnchanged: true, fileDiscoveryUnchanged: true,
      verifiedFiles: baseline.files, head: baseline.head, contentDigest: baseline.contentDigest },
    `${label}: baseline verified ${stage}`);
  }
  assert.equal(baseline.manifestSha256, baselineManifest.sha256, `${label}: baseline manifest digest binding`);
  assert.equal(baselineManifest.document.head, baseline.head, `${label}: current baseline head`);
  assert.equal(baselineManifest.document.contentDigest, baseline.contentDigest, `${label}: current baseline digest`);
  assert.equal(baselineManifest.document.files.length, baseline.files, `${label}: current baseline file count`);

  assert.ok(Array.isArray(report.observations), `${label}: observations`);
  assert.ok(report.observations.some(entry => entry.route === '/Users/New' && entry.status === 200
    && idKey(entry.responseBody?.Id) === idKey(report.identityRemapping.actualUserId)), `${label}: native user observation`);
  assert.ok(report.observations.some(entry => entry.route === '/Users/AuthenticateByName' && entry.status === 200
    && idKey(entry.responseBody?.User?.Id) === idKey(report.identityRemapping.actualUserId)
    && entry.responseBody?.User?.Policy?.IsAdministrator === true), `${label}: native authentication observation`);
  assert.deepEqual({ route: report.observations.at(-1)?.route, status: report.observations.at(-1)?.status },
    { route: '/System/Shutdown', status: 204 }, `${label}: shutdown observation`);
}

export async function verifyNativeReferencePreparation(options) {
  assertProfile(options.profile);
  await verifyNativeQuerySourceBindings();
  return verifyNativeReferencePreparationContract({ ...options,
    inputPaths: nativeReferencePreparationInputs(options.profile),
    resolveInput: options.resolveInput ?? resolveNativeReferencePreparationInput });
}

export async function verifyNativeReferencePreparationContract({ preparation, profile, sourceDatabase, fixtureUserId,
  inputPaths, resolveInput }) {
  const label = profile + ':reference-preparation';
  const expectedTopLevel = profile === 'user-view'
    ? ['copyBindings', 'createdThroughNativeApi', 'identityRemapping', 'initializedFromEmpty', 'inputs',
      'sourceDatabaseSha256', 'stopped']
    : ['createdThroughNativeApi', 'identityRemapping', 'initializedFromEmpty', 'inputs',
      'sourceDatabaseSha256', 'stopped'];
  assert.deepEqual(Object.keys(preparation ?? {}).sort(), expectedTopLevel.sort(), `${label}: top-level fields`);
  assert.deepEqual({ initializedFromEmpty: preparation.initializedFromEmpty,
    createdThroughNativeApi: preparation.createdThroughNativeApi, stopped: preparation.stopped },
  { initializedFromEmpty: true, createdThroughNativeApi: true, stopped: true }, `${label}: native preparation state`);
  assert.match(preparation.sourceDatabaseSha256, /^[0-9a-f]{64}$/u, `${label}: source database sha256`);
  assertIdentityRemapping(preparation.identityRemapping, fixtureUserId, label);

  assert.equal(inputPaths.length, 11, label + ': complete preparation input list');
  const expectedInputs = inputPaths;
  assert.ok(Array.isArray(preparation.inputs), `${label}: inputs must be an array`);
  assert.deepEqual(preparation.inputs.map(input => [input.kind, input.path]), expectedInputs,
    `${label}: exact input kinds/paths/order`);
  const identities = [];
  for (const [index, input] of preparation.inputs.entries()) {
    assert.deepEqual(Object.keys(input).sort(), ['kind', 'path', 'sha256'], `${label}: input fields[${index}]`);
    assert.match(input.sha256, /^[0-9a-f]{64}$/u, `${label}: input sha256[${index}]`);
    const current = await readRegularFile(resolveInput(profile, expectedInputs[index][1]), `${label}:${input.path}`);
    assert.equal(current.sha256, input.sha256, `${label}: current input sha256: ${input.path}`);
    identities.push({ ...input, currentPath: current.filename, size: current.size });
  }
  const source = await readRegularFile(sourceDatabase, `${label}:source-database`);
  assert.equal(source.sha256, preparation.sourceDatabaseSha256, `${label}: current source database sha256`);

  const bootstrap = JSON.parse(identities[0] && (await readFile(identities[0].currentPath, 'utf8')));
  const baselineIdentity = identities[6];
  const baselineManifest = {
    ...baselineIdentity,
    document: JSON.parse(await readFile(baselineIdentity.currentPath, 'utf8')),
  };
  assertBootstrapReport(bootstrap, { preparation, fixtureUserId, baselineManifest }, label);

  assert.equal(sha256(await readFile(resolveInput(profile, preparation.inputs[2].path))),
    bootstrap.bootstrapScript.sha256, `${label}: bootstrap script report binding`);
  assert.equal(bootstrap.verificationTools.length, 2, `${label}: verification tool count`);
  for (const [index, tool] of bootstrap.verificationTools.entries()) {
    assert.equal(sha256(await readFile(resolveInput(profile, preparation.inputs[index + 3].path))), tool.sha256,
      `${label}: verification tool report binding[${index}]`);
  }
  assert.equal(bootstrap.nativeModelSha256, preparation.inputs[7].sha256, `${label}: native model binding`);
  assert.equal(bootstrap.executables.length, 3, `${label}: executable count`);
  for (const [index, executable] of bootstrap.executables.entries()) {
    assert.equal(executable.sha256, preparation.inputs[index + 8].sha256,
      `${label}: executable report binding[${index}]`);
  }
  return {
    preparation,
    sourceDatabase: source,
    bootstrap,
    inputs: identities,
    executables: {
      dotnet: identities[8],
      jellyfinDll: identities[9],
      ffmpeg: identities[10],
    },
  };
}
