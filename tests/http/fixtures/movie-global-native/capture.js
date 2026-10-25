import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeModel } from '../../../../src/database/model.js';
import { isServerIdentity } from '../../../../src/core/server-identity.js';
import { parseLosslessJson } from '../../../../src/core/json.js';
import { verifyNativeBuild } from '../../../../tools/validation/native-build-inputs.js';
import { currentNativeSqliteInputs } from '../../../../tools/validation/current-native-sqlite-inputs.js';
import { describeFile } from '../../../../tools/validation/inventory.js';
import { assertValidationOutputChild, validationExecutable, validationOutputRoot } from '../../../../tools/validation/paths.js';
import { startMovieMediaProxy } from './media-proxy.js';
import { prepareFrozenVideo } from '../../../helpers/frozen-av.js';

export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const json = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? JSON.rawJSON(entry.toString()) : entry, 2) + '\n';
const inputFile = new URL('./input.json', import.meta.url);
const sourcePaths = [
  'Emby.Server.Implementations/Library/LibraryManager.cs', 'Emby.Server.Implementations/Collections/CollectionManager.cs',
  'Emby.Server.Implementations/Library/ExternalDataManager.cs', 'Emby.Server.Implementations/Library/PathManager.cs',
  'Emby.Server.Implementations/Library/KeyframeManager.cs', 'Emby.Server.Implementations/Chapters/ChapterManager.cs',
  'Jellyfin.Server.Implementations/Item/KeyframeRepository.cs',
  'Jellyfin.Server.Implementations/Item/ChapterRepository.cs',
  'Jellyfin.Server.Implementations/MediaSegments/MediaSegmentManager.cs',
  'Jellyfin.Server.Implementations/Trickplay/TrickplayManager.cs',
  'MediaBrowser.Controller/MediaEncoding/EncodingHelper.cs',
  'MediaBrowser.Controller/IO/LocalMediaProxy.cs', 'Emby.Server.Implementations/Library/MediaSourceManager.cs',
  'Emby.Server.Implementations/Library/Validators/CollectionPostScanTask.cs',
  'Emby.Server.Implementations/Library/Validators/GenresValidator.cs', 'Emby.Server.Implementations/Library/Validators/StudiosValidator.cs',
  'Emby.Server.Implementations/Library/Validators/CollectionPosterVerifyPostScanTask.cs',
  'Emby.Server.Implementations/Data/CleanDatabaseScheduledTask.cs',
  'MediaBrowser.Controller/Entities/Folder.cs', 'MediaBrowser.Controller/Entities/BaseItem.cs',
  'MediaBrowser.Controller/Entities/AggregateFolder.cs', 'MediaBrowser.Controller/Entities/UserRootFolder.cs',
  'MediaBrowser.Controller/Entities/CollectionFolder.cs', 'MediaBrowser.Controller/Entities/Movies/Movie.cs',
  'MediaBrowser.Controller/Entities/Movies/BoxSet.cs', 'MediaBrowser.Controller/LibraryTaskScheduler/LimitedConcurrencyLibraryScheduler.cs',
  'MediaBrowser.Providers/Manager/ProviderManager.cs', 'MediaBrowser.Providers/Manager/MetadataService.cs',
  'MediaBrowser.Providers/Movies/MovieMetadataService.cs', 'MediaBrowser.Providers/BoxSets/BoxSetMetadataService.cs',
  'MediaBrowser.Providers/MediaInfo/ProbeProvider.cs', 'MediaBrowser.Providers/MediaInfo/FFProbeVideoInfo.cs',
  'MediaBrowser.MediaEncoding/Encoder/MediaEncoder.cs',
  'MediaBrowser.XbmcMetadata/Providers/BaseNfoProvider.cs', 'MediaBrowser.XbmcMetadata/Providers/MovieNfoProvider.cs',
  'MediaBrowser.XbmcMetadata/Parsers/BaseNfoParser.cs', 'MediaBrowser.Model/Entities/MediaStream.cs',
  'MediaBrowser.XbmcMetadata/Savers/BaseNfoSaver.cs', 'MediaBrowser.XbmcMetadata/Savers/MovieNfoSaver.cs',
  'MediaBrowser.LocalMetadata/Providers/BoxSetXmlProvider.cs', 'MediaBrowser.LocalMetadata/Savers/BoxSetXmlSaver.cs',
  'MediaBrowser.LocalMetadata/Parsers/BaseItemXmlParser.cs', 'MediaBrowser.LocalMetadata/Savers/BaseXmlSaver.cs',
  'MediaBrowser.Controller/Extensions/XmlReaderExtensions.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemMapper.cs', 'Jellyfin.Server.Implementations/Item/BaseItemRepository.cs',
  'Jellyfin.Server.Implementations/Item/ItemPersistenceService.cs', 'Jellyfin.Server.Implementations/Item/LinkedChildrenService.cs',
  'Jellyfin.Server.Implementations/Item/MediaStreamRepository.cs', 'Jellyfin.Server.Implementations/Item/MediaAttachmentRepository.cs',
  'Jellyfin.Server.Implementations/Item/ChapterRepository.cs',
];

/** Both independent native processes and PG start from this one new preparation
 * output. Its destructive clearing is confined to its private copy and is never
 * represented as a native/candidate business operation. */
export async function captureMovieGlobal({ signal } = {}) {
  signal?.throwIfAborted();
  const root = path.join(validationOutputRoot(), 'movie-global-native-' + randomUUID());
  assertValidationOutputChild(root); await mkdir(root, { recursive: true });
  const report = { schemaVersion: 1, captures: [], releaseAcceptance: false,
    historicalEvidenceReplaced: false, preparationIsBusinessOperation: false };
  let supplied, build, bound, proxy, failure, closing;
  const save = () => writeFile(path.join(root, 'capture.json'), json(report));
  const finish = () => closing ??= (async () => {
    try {
      await proxy?.close();
      if (proxy) { assert.equal(proxy.report.closed, true); assert.deepEqual(proxy.report.errors, []); }
    } catch (error) { failure ??= error; report.proxyCleanupFailure = { name: error.name, message: error.message, stack: error.stack }; }
    try {
      if (supplied) {
        const after = await currentNativeSqliteInputs();
        assert.deepEqual(after.inputs, supplied.inputs, 'The provisioned stopped source and current SQLite must remain unchanged.');
      }
      if (build) assert.equal((await verifyNativeBuild()).identitySha256, build.identitySha256);
      for (const file of bound ? [bound.database, bound.media] : []) {
        const after = await describeFile(file.filename); assert.equal(after.sha256, file.sha256); assert.equal(after.bytes, file.bytes);
      }
      report.protectedInputsUnchanged = true;
    } catch (error) { failure ??= error; report.protectedInputsUnchanged = false; }
    if (failure) report.failure = { name: failure.name, message: failure.message, stack: failure.stack };
    report.captureComplete = report.captures.length === 2 && !failure;
    await save(); if (failure) throw failure;
  })();
  try {
    supplied = await currentNativeSqliteInputs(); build = await verifyNativeBuild();
    report.parent = { input: supplied.receipt.input, source: supplied.receipt.source,
      initialization: supplied.receipt.initialization, buildIdentitySha256: build.identitySha256 };
    const bytes = await readFile(inputFile), specification = JSON.parse(bytes);
    report.specification = await describeFile(fileURLToPath(inputFile));
    assert.equal(isServerIdentity(specification.serverId), true, 'The neutral fixture server identity must satisfy the native GUID contract.');
    assert.deepEqual(specification.tables, [...nativeModel.tables.map(table => table.name), '__EFMigrationsHistory', '__EFMigrationsLock'].sort());
    const sourceManifest = JSON.parse(await readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json'), 'utf8'));
    const sourceByPath = new Map(sourceManifest.files.map(entry => [entry.path, entry]));
    report.sourceBindings = [];
    for (const relative of sourcePaths) {
      const actual = await describeFile(path.join(build.root, 'source', relative));
      assert.ok(sourceByPath.has(relative), relative); assert.equal(actual.sha256, sourceByPath.get(relative).sha256, relative);
      report.sourceBindings.push({ sourcePath: relative, ...actual });
    }
    const preparation = path.join(root, 'prepared'); await mkdir(preparation);
    const databaseFile = path.join(preparation, 'initial-native.db'); await copyFile(supplied.filename, databaseFile);
    assert.equal(sha(await readFile(databaseFile)), supplied.receipt.input.sha256);
    const prepare = report.preparation = { kind: 'private-empty-domain-copy', candidateCommit: process.env.GITHUB_SHA,
      producer: await describeFile(fileURLToPath(import.meta.url)), parentSha256: supplied.receipt.input.sha256,
      startedAt: new Date().toISOString(), operations: [], rowsBefore: {}, rowsAfter: {} };
    const database = new DatabaseSync(databaseFile, { enableForeignKeyConstraints: false });
    const snapshot = () => Object.fromEntries(['__EFMigrationsHistory', '__EFMigrationsLock', 'sqlite_sequence']
      .map(table => [table, database.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()]));
    const ddl = () => database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
    try {
      const historyBefore = snapshot(); prepare.systemBefore = historyBefore;
      prepare.schemaBefore = ddl();
      prepare.journalModeBefore = database.prepare('PRAGMA journal_mode').get().journal_mode;
      for (const table of nativeModel.tables) prepare.rowsBefore[table.name] = database.prepare(`SELECT count(*) AS n FROM "${table.name}"`).get().n;
      database.exec('PRAGMA foreign_keys=OFF'); prepare.operations.push('PRAGMA foreign_keys=OFF');
      database.exec('BEGIN IMMEDIATE'); prepare.operations.push('BEGIN IMMEDIATE');
      try {
        for (const table of nativeModel.tables) {
          const statement = `DELETE FROM "${table.name}"`; database.exec(statement); prepare.operations.push(statement);
        }
        database.exec('COMMIT'); prepare.operations.push('COMMIT'); prepare.committed = true;
      } catch (error) { database.exec('ROLLBACK'); prepare.operations.push('ROLLBACK'); throw error; }
      prepare.systemAfter = snapshot(); assert.deepEqual(prepare.systemAfter, historyBefore);
      prepare.schemaAfter = ddl(); assert.deepEqual(prepare.schemaAfter, prepare.schemaBefore);
      prepare.foreignKeyViolations = database.prepare('PRAGMA foreign_key_check').all(); assert.deepEqual(prepare.foreignKeyViolations, []);
      for (const table of nativeModel.tables) {
        const count = database.prepare(`SELECT count(*) AS n FROM "${table.name}"`).get().n;
        prepare.rowsAfter[table.name] = count; assert.equal(count, 0);
      }
      // Checkpoint only the new preparation copy. Preserve its actual journal
      // mode; every business executor will open its own byte-identical clone.
      database.exec('PRAGMA wal_checkpoint(TRUNCATE)'); prepare.operations.push('PRAGMA wal_checkpoint(TRUNCATE)');
      prepare.journalModeAfter = database.prepare('PRAGMA journal_mode').get().journal_mode;
      assert.equal(prepare.journalModeAfter, prepare.journalModeBefore);
    } finally { database.close(); }
    prepare.endedAt = new Date().toISOString(); prepare.frozen = await describeFile(databaseFile);
    assert.equal((await describeFile(supplied.filename)).sha256, supplied.receipt.input.sha256);
    const ffmpeg = validationExecutable('ffmpeg'), ffprobe = validationExecutable('ffprobe');
    report.executables = await Promise.all([ffmpeg, ffprobe].map(describeFile));
    const copied = await prepareFrozenVideo(preparation, { name: 'source', signal });
    signal?.throwIfAborted();
    const mediaFile = copied.filename;
    report.mediaPreparation = { kind: 'original-video-packet-copy', evidence: copied.evidence, probe: copied.probe,
      encodingExecuted: false };
    bound = { specification, specificationSha256: sha(bytes), clockWindowStart: prepare.startedAt, database: prepare.frozen,
      media: await describeFile(mediaFile), ffmpeg, ffprobe };
    const boundFile = path.join(preparation, 'input.json'), boundBytes = Buffer.from(json(bound));
    await writeFile(boundFile, boundBytes, { flag: 'wx' });
    report.boundInput = await describeFile(boundFile);
    for (const filename of [databaseFile, mediaFile, boundFile]) await chmod(filename, 0o444);
    proxy = await startMovieMediaProxy({ root, specification, media: bound.media });
    report.mediaProxy = proxy.report;
    const observations = [];
    for (const label of ['first', 'repeat']) {
      signal?.throwIfAborted();
      const output = path.join(root, 'native-' + label);
      // recordOracle uses synchronous subprocesses. The real oracle belongs in
      // an owned worker so the designated HTTP media bridge remains responsive.
      const receipt = await new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./oracle-worker.js', import.meta.url), { trackUnmanagedFds: true,
          workerData: { project: 'tests/http/fixtures/movie-global-native/Oracle.csproj', output,
            args: [boundFile, '{output}/case', '{output}/native.json'], environment: { ...process.env, MEDIAMANAGER_FFMPEG: ffmpeg } } });
        let message, workerError;
        worker.once('message', value => { message = value; });
        worker.once('error', error => { workerError = error; });
        worker.once('exit', code => {
          if (workerError) return reject(workerError);
          if (code !== 0) return reject(new Error('Movie oracle worker exited with code ' + code));
          if (message?.error) return reject(Object.assign(new Error(message.error.message), message.error));
          if (!message?.record) return reject(new Error('Movie oracle worker exited without an execution receipt.'));
          resolve(message.record);
        });
      });
      const nativeFile = path.join(output, 'native.json'), native = parseLosslessJson(await readFile(nativeFile, 'utf8'));
      report.captures.push({ label, receipt, output: await describeFile(nativeFile) });
      observations.push(native); await save();
      assert.equal(native.inputSha256, sha(boundBytes)); assert.equal(native.protectedInputsUnchanged, true);
      assert.equal(native.initialCloneSha256, bound.database.sha256);
      assert.equal(native.failure, null); assert.equal(native.schemaCreated, false);
      assert.equal(native.nativeModules.some(entry => /^(?:lib)?e_sqlite3\.(?:dll|so|dylib)$/iu.test(entry.ModuleName)), true,
        'The actual supplied platform SQLite native module must be loaded.');
      for (const entry of native.nativeModules) {
        assert.equal(entry.importName, 'e_sqlite3'); assert.equal(entry.resolvedBy, 'SetDllImportResolver');
        assert.ok(entry.resolverRequests > 0); assert.ok(BigInt(entry.handle) !== 0n); assert.ok(BigInt(entry.export) !== 0n);
        assert.equal(entry.resolvedNames.length, entry.resolverRequests);
        assert.equal(entry.resolvedNames.every(value => value === entry.importName), true);
      }
      assert.equal(native.assemblies.find(entry => entry.FullName.startsWith('jellyfin,')).sha256, receipt.jellyfinDll.sha256);
      for (const entry of [...native.assemblies, ...native.nativeModules]) {
        const actual = await describeFile(entry.filename); assert.equal(actual.sha256, entry.sha256); assert.equal(actual.bytes, Number(entry.bytes));
      }
      const requests = proxy.report.requests.filter(entry => entry.filename?.startsWith(path.join(output, 'case') + path.sep));
      assert.ok(requests.length > 0, 'The designated native media proxy must serve actual business media copies.');
      assert.equal(requests.every(entry => [200, 206].includes(entry.status) && entry.fileSha256 === bound.media.sha256), true);
    }
    return { root, bound, first: observations[0], repeat: observations[1], report, finish };
  } catch (error) { failure = error; await finish(); throw error; }
}
