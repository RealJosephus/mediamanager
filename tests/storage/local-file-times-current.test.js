import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { StorageFileSystem } from '../../src/storage/files.js';
import { nativeDateFromUnixNanoseconds, wireDate } from '../../src/users/native.js';
import { dateTicks } from '../../src/library/records.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { captureLocalFileTimes, diagnosticJson, hash } from './fixtures/local-file-times-current/capture.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const profileUrl = new URL('./fixtures/local-file-times-current/input.json', import.meta.url);
const profileBytes = await fs.readFile(profileUrl), profile = JSON.parse(profileBytes);
const date = ns => wireDate(nativeDateFromUnixNanoseconds(ns));
const statValues = value => ({ size: value.size, mode: value.mode, birthtimeNs: value.birthtimeNs,
  mtimeNs: value.mtimeNs, ctimeNs: value.ctimeNs, atimeNs: value.atimeNs,
  birthtimeMs: value.birthtimeMs, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs,
  birthtime: value.birthtime, mtime: value.mtime, ctime: value.ctime, atime: value.atime,
  isFile: value.isFile(), isDirectory: value.isDirectory(), isSymbolicLink: value.isSymbolicLink() });

test('same local files retain Native public creation and modification dates through actual storage metadata', {
  skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 300000,
}, async t => {
  const output = path.join(validationOutputRoot(), 'local-file-times-current-' + randomUUID()), root = path.join(output, 'files');
  await fs.mkdir(root, { recursive: true });
  const report = { schemaVersion: 1, scope: profile.scope, profileSha256: hash(profileBytes),
    runtime: null, sourceBindings: null, sourceEvidenceComplete: false, sourceDiagnostics: [], observations: [], differences: [], cleanup: {}, failures: [],
    samplerCompleted: false, componentAcceptance: false, phaseAcceptance: false, releaseAcceptance: false,
    boundary: 'Compare published local creation/modified dates with ManagedFileSystem.GetCreationTimeUtc(FileSystemInfo). Directory metadata-wrapper defaults are retained separately and do not redefine raw local dates. Extra BCL source retrieval is reported separately in sourceEvidenceComplete and sourceDiagnostics.' };
  const registry = new StorageRegistry(); let adapter;
  try {
    registry.registerType('local-file-times', configuration => LocalAdapter.open(configuration));
    adapter = await registry.createInstance('same-files', 'local-file-times', { root, writable: true });
    const vfs = new VirtualFileSystem(registry); vfs.mount({ path: '/same-files', instanceId: 'same-files', capabilities: { create: true, replace: true, delete: true } });
    const identities = new IdentityAccessMap(); identities.addPrefix({ identityRoot: root, accessRoot: '/same-files',
      style: process.platform === 'win32' ? 'windows' : 'posix', caseSensitive: process.platform !== 'win32',
      returnAccess: 'Only the same isolated regular time-sampling files are exposed.' });
    const fileSystem = new StorageFileSystem({ vfs, identityMap: identities }), fileBytes = Buffer.from(profile.fileBytesBase64, 'base64');
    const samples = [];
    for (const sample of profile.cases) {
      const filename = path.join(root, sample.name + (sample.kind === 'file' ? '.bin' : ''));
      if (sample.kind === 'file') await fs.writeFile(filename, fileBytes, { flag: 'wx' }); else await fs.mkdir(filename);
      const timestamp = sample.mtime === 'current' ? new Date() : new Date(sample.mtime);
      const beforeTimeOperation = statValues(await fs.lstat(filename, { bigint: true }));
      await fs.utimes(filename, timestamp, timestamp);
      const afterTimeOperation = statValues(await fs.lstat(filename, { bigint: true }));
      if (sample.changeMode) {
        const originalMode = Number(afterTimeOperation.mode & 0o777n);
        await fs.chmod(filename, originalMode ^ 0o100); await fs.chmod(filename, originalMode);
      }
      const raw = statValues(await fs.lstat(filename, { bigint: true }));
      const entry = await adapter.stat('/' + path.basename(filename)), virtual = await vfs.stat('/same-files/' + path.basename(filename));
      const facade = await fileSystem.stat(filename, { bigint: true }), facadeNumber = await fileSystem.stat(filename);
      const bytes = sample.kind === 'file' ? await fs.readFile(filename) : null;
      report.observations.push({ sample, filename, actualRequestedMtime: timestamp.toISOString(),
        raw: { beforeTimeOperation, afterTimeOperation, beforeNative: raw },
        localEntry: entry, virtualEntry: virtual, facade: statValues(facade), facadeNumber: statValues(facadeNumber),
        localPublishedDates: { creation: entry.created, modified: entry.modified,
          facadeCreation: date(facade.birthtimeNs), facadeModified: date(facade.mtimeNs) },
        bytesBefore: bytes === null ? null : { length: bytes.length, sha256: hash(bytes) } });
      if (bytes !== null) assert.deepEqual(bytes, fileBytes);
      samples.push({ name: sample.name, kind: sample.kind, filename });
    }
    const captured = await captureLocalFileTimes({ output, input: { schemaVersion: 1, root, samples }, profile, signal: t.signal });
    report.runtime = captured.native.runtime; report.sourceBindings = captured; report.samplerCompleted = true;
    report.sourceDiagnostics = captured.sourceFailures; report.sourceEvidenceComplete = captured.sourceEvidenceComplete;
    for (const observation of report.observations) {
      const native = captured.native.samples.find(value => value.name === observation.sample.name); assert.ok(native, observation.sample.name);
      assert.equal(native.filename, observation.filename); observation.native = native;
      const rawAfter = statValues(await fs.lstat(observation.filename, { bigint: true })); observation.raw.afterNative = rawAfter;
      const afterBytes = observation.sample.kind === 'file' ? await fs.readFile(observation.filename) : null;
      observation.bytesAfter = afterBytes === null ? null : { length: afterBytes.length, sha256: hash(afterBytes) };
      assert.equal(rawAfter.isSymbolicLink, false); assert.equal(native.publicInfo.Exists, true);
      assert.deepEqual(observation.bytesBefore, observation.bytesAfter); assert.deepEqual(native.bytesBefore, native.bytesAfter);
      assert.deepEqual(observation.bytesBefore, native.bytesBefore);
      // Reading can update atime; it must not change the creation/modify/status
      // values whose same-files comparison is about to be consumed.
      for (const field of ['birthtimeNs', 'mtimeNs', 'ctimeNs']) assert.equal(rawAfter[field], observation.raw.beforeNative[field]);
      const expected = { creation: native.managedPublicInfo.creation.utc, modified: native.managedPublicInfo.modified.utc };
      const compare = (consumer, actual, wanted) => {
        if (dateTicks(actual) !== dateTicks(wanted)) report.differences.push({ name: observation.sample.name, consumer, actual, expected: wanted });
      };
      compare('LocalAdapter.created', observation.localEntry.created, expected.creation);
      compare('VFS.created', observation.virtualEntry.created, expected.creation);
      compare('StorageFileSystem creation', observation.localPublishedDates.facadeCreation, expected.creation);
      compare('LocalAdapter.modified', observation.localEntry.modified, expected.modified);
      compare('StorageFileSystem modified', observation.localPublishedDates.facadeModified, expected.modified);
      // Other stat representations remain diagnostic. Date consumers above
      // publish the nanosecond fields at the protocol's 100 ns precision.
      observation.expectedPublicDates = expected;
    }
    report.componentAcceptance = report.differences.length === 0 && report.failures.length === 0;
  } catch (error) { report.failures.push(error); }
  finally {
    try { await registry.close(); report.cleanup.storageClosed = true; }
    catch (error) { report.failures.push(error); report.cleanup.storageClosed = false; }
    try {
      for (const observation of report.observations) {
        const bytes = observation.sample.kind === 'file' ? await fs.readFile(observation.filename) : null;
        assert.deepEqual(bytes === null ? null : { length: bytes.length, sha256: hash(bytes) }, observation.bytesBefore);
      }
      report.cleanup.originalFileBytesIntact = true;
    } catch (error) { report.failures.push(error); report.cleanup.originalFileBytesIntact = false; }
    if (report.failures.length) report.componentAcceptance = false;
    const filename = path.join(output, 'report.json');
    try { await fs.writeFile(filename, JSON.stringify(report, diagnosticJson, 2) + '\n', { flag: 'wx' }); }
    catch (error) { report.failures.push(error); report.componentAcceptance = false; }
    t.diagnostic(JSON.stringify({ report: filename, samplerCompleted: report.samplerCompleted, componentAcceptance: report.componentAcceptance,
      sourceEvidenceComplete: report.sourceEvidenceComplete }));
  }
  if (report.failures.length) throw new AggregateError(report.failures, 'Same-files timestamp sampling and cleanup failed.', { cause: report.failures[0] });
  assert.equal(report.samplerCompleted, true);
  assert.deepEqual(report.differences, [], 'Actual public local dates must match the executing Native reader; raw stat diagnostics remain unmodified.');
});
