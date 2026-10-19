import { validationExecutable } from '../../tools/validation/paths.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { link, lstat, mkdir, readFile, realpath, readdir, unlink, writeFile, rm, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import { transferDatabase, databaseDigest } from '../../src/migration/database-transfer.js';
import { createStatePackage, restoreRemoteStatePackage, restoreStatePackage } from '../../src/migration/state-package.js';
import { discoverInstanceState } from '../../src/migration/instance-state.js';
import { assertIsolatedInstanceOutput, cloneStoppedInstance } from '../../src/migration/instance-copy.js';
import { createIsolatedOfflineCopyCaptureSession, createStoppedServiceCaptureSession } from '../../src/migration/capture-session.js';
import { verifyNativeMediaAccess } from '../../src/migration/media-access.js';
import { StorageError, StorageRegistry, VirtualFileSystem, IdentityAccessMap, normalizePath } from '../../src/storage/index.js';
import { AListAdapter } from '../../plugins/alist/adapter.js';
import { WebDavAdapter } from '../../plugins/webdav/adapter.js';
import { createRuntime } from '../../src/runtime.js';
import { defaultLibraryOptions } from '../../src/library/options.js';
import { getNewItemId } from '../../src/core/identity.js';
import { nativeGuid } from '../../src/users/native.js';
import { startActualAList } from '../storage/helpers/actual-alist.js';
import { startActualWebDav } from '../storage/helpers/actual-webdav.js';
import { stopNativeReference } from '../../tools/compat/native-shutdown.js';

const id = '22222222-2222-2222-2222-222222222222';
const negativeId = '92929292-9292-9292-9292-929292929292';
const enabled = process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_DOTNET
  && process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_ALIST_EXECUTABLE && process.env.MEDIAMANAGER_WEBDAV_EXECUTABLE;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? entry.toString() : entry, 2);
const expected = (bytes, range = false) => ({ bytes: String(bytes.length), sha256: sha(bytes), ...(range ? { range: { start: '17', end: '63', sha256: sha(bytes.subarray(17, 64)) } } : {}) });

class IsolatedVersionedFilesystemAdapter {
  #root;
  #closed = false;

  constructor(root) {
    this.#root = path.resolve(root);
    this.capabilities = Object.freeze({ randomRead: false, reliableLength: true, reliableVersion: true, directorySnapshot: false,
      create: true, replace: true, atomicReplace: true, conditionalWrite: true, mkdir: false, delete: false, rename: false, directLease: false, watch: false });
  }

  #check(signal) {
    if (signal?.aborted) throw new StorageError('cancelled', 'Storage operation was cancelled.');
    if (this.#closed) throw new StorageError('closed', 'The isolated filesystem adapter is closed.');
  }

  #filename(value) {
    const normalized = normalizePath(value);
    const filename = path.resolve(this.#root, ...normalized.slice(1).split('/'));
    const relative = path.relative(this.#root, filename);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new StorageError('invalid-path', 'Path escapes the isolated filesystem root.');
    return filename;
  }

  async #snapshot(value, signal) {
    this.#check(signal);
    const filename = this.#filename(value);
    let metadata;
    try { metadata = await lstat(filename); } catch (error) { if (error.code === 'ENOENT') throw new StorageError('not-found', 'The isolated filesystem object does not exist.'); throw error; }
    if (metadata.isSymbolicLink()) throw new StorageError('invalid-response', 'Symbolic links are not valid isolated sidecar objects.');
    if (metadata.isDirectory()) return { filename, metadata, bytes: null, version: `directory:${metadata.mtimeMs}` };
    if (!metadata.isFile()) throw new StorageError('invalid-response', 'The isolated filesystem object is not a regular file.');
    const [root, resolved] = await Promise.all([realpath(this.#root), realpath(filename)]);
    const relative = path.relative(root, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new StorageError('invalid-path', 'The isolated sidecar resolves outside its root.');
    const bytes = await readFile(filename); this.#check(signal);
    return { filename, metadata, bytes, version: `sha256:${sha(bytes)}` };
  }

  async stat(value, options = {}) {
    const snapshot = await this.#snapshot(value, options.signal);
    return { name: path.basename(snapshot.filename), kind: snapshot.bytes ? 'file' : 'directory', size: snapshot.bytes ? BigInt(snapshot.bytes.length) : null,
      modified: snapshot.metadata.mtime, created: snapshot.metadata.birthtime, version: snapshot.version };
  }

  async openRead(value, options = {}) {
    if (options.range) throw new StorageError('not-supported', 'The isolated sidecar adapter does not expose ranged reads.');
    const snapshot = await this.#snapshot(value, options.signal);
    if (!snapshot.bytes) throw new StorageError('is-directory', 'The isolated filesystem object is a directory.');
    if (options.ifMatch && options.ifMatch !== snapshot.version) throw new StorageError('version-changed', 'The isolated sidecar version changed.');
    let closed = false;
    async function* stream() { if (!closed && snapshot.bytes.length) yield snapshot.bytes; }
    return { stream: stream(), totalSize: BigInt(snapshot.bytes.length), contentLength: BigInt(snapshot.bytes.length), range: null,
      rangeHonored: false, version: snapshot.version, close: async () => { closed = true; } };
  }

  async write(value, data, options = {}) {
    this.#check(options.signal);
    if (options.overwrite !== false || options.ifMatch) throw new StorageError('not-supported', 'The isolated restore fixture only permits atomic creation of absent files.');
    const filename = this.#filename(value);
    const parent = path.dirname(filename);
    const [root, resolvedParent] = await Promise.all([realpath(this.#root), realpath(parent)]);
    const relative = path.relative(root, resolvedParent);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new StorageError('invalid-path', 'The isolated restore target resolves outside its root.');
    const chunks = []; let length = 0;
    for await (const chunk of data instanceof Uint8Array ? [data] : data) { this.#check(options.signal); chunks.push(Buffer.from(chunk)); length += chunk.length; }
    if (options.size != null && BigInt(length) !== BigInt(options.size)) throw new StorageError('invalid-response', 'The isolated restore length differs from its declaration.');
    const temporary = path.join(parent, `.${path.basename(filename)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, Buffer.concat(chunks), { flag: 'wx' });
      try { await link(temporary, filename); } catch (error) { if (error.code === 'EEXIST') throw new StorageError('already-exists', 'The isolated restore target already exists.'); throw error; }
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    return { size: BigInt(length), atomic: true };
  }

  async listPage(value, options = {}) {
    const snapshot = await this.#snapshot(value, options.signal);
    if (snapshot.bytes) throw new StorageError('not-directory', 'The isolated filesystem object is not a directory.');
    const entries = [];
    for (const entry of await readdir(snapshot.filename, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isFile() && !entry.isDirectory()) throw new StorageError('invalid-response', 'Unsupported isolated filesystem entry.');
      entries.push(await this.stat(`${normalizePath(value)}/${entry.name}`, options));
    }
    return { entries, complete: true, nextCursor: null, consistency: 'weak', snapshot: null, deletionSafe: false };
  }

  async health(options = {}) { this.#check(options.signal); return { state: 'available' }; }
  async close() { this.#closed = true; }
}

async function refreshNative(baseUrl, token, itemId) {
  const response = await fetch(`${baseUrl}/Items/${itemId}/Refresh?metadataRefreshMode=FullRefresh&imageRefreshMode=None&replaceAllMetadata=false`, {
    method: 'POST', headers: { Authorization: `MediaBrowser Token="${token}"` }, signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 204, await response.text());
  return response.status;
}

async function waitNativeItem(baseUrl, token, itemId, predicate) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const response = await fetch(`${baseUrl}/Items?Ids=${itemId}&Fields=Path,Overview,ProviderIds&Recursive=true`, {
      headers: { Authorization: `MediaBrowser Token="${token}"` }, signal: AbortSignal.timeout(2000),
    });
    if (response.status !== 200) assert.fail(`Native item query returned ${response.status}: ${await response.text()}`);
    const item = (await response.json()).Items?.[0];
    if (item && predicate(item)) return item;
    await delay(100);
  }
  throw new Error('Timed out waiting for native Jellyfin metadata refresh');
}

async function startNative(root, port, token, { evidenceDirectory, evidenceName = 'native-process' } = {}) {
  root = path.resolve(root);
  if (typeof evidenceDirectory !== 'string' || !evidenceDirectory) throw new TypeError('A native evidence directory outside the instance is required');
  evidenceDirectory = path.resolve(evidenceDirectory);
  const evidenceRelative = path.relative(root, evidenceDirectory);
  if (evidenceRelative === '' || (!path.isAbsolute(evidenceRelative) && evidenceRelative !== '..' && !evidenceRelative.startsWith(`..${path.sep}`))) {
    throw new Error('Native process evidence must be written outside the instance root');
  }
  if (!/^[A-Za-z0-9_-]+$/u.test(evidenceName)) throw new TypeError('Invalid native process evidence name');
  const dll = path.resolve(process.env.MEDIAMANAGER_JELLYFIN_DLL);
  const args = [dll, '--nowebclient', '--datadir', path.join(root, 'data'), '--configdir', path.join(root, 'config'), '--cachedir', path.join(root, 'cache'), '--logdir', path.join(root, 'log'), '--ffmpeg', validationExecutable('ffmpeg')];
  const child = spawn(process.env.MEDIAMANAGER_DOTNET, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = []; child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => output.push(chunk));
  let error; child.on('error', failure => error = failure);
  const baseUrl = `http://127.0.0.1:${port}`;
  let stopped, receipt;
  const stop = () => stopped ??= stopNativeReference(child, async () => {
    const response = await fetch(baseUrl + '/System/Shutdown', { method: 'POST', headers: { Authorization: `MediaBrowser Token="${token}"` }, signal: AbortSignal.timeout(3000) });
    await response.body?.cancel();
    return response.status;
  }, async outcome => {
    await writeFile(path.join(evidenceDirectory, `${evidenceName}.log`), Buffer.concat(output).toString().replaceAll(token, '[isolated token redacted]'));
    await writeFile(path.join(evidenceDirectory, `${evidenceName}.json`), json({ executable: process.env.MEDIAMANAGER_DOTNET, args, port, ...outcome }));
  }).then(outcome => receipt = Object.freeze(structuredClone(outcome)));
  const assertStopped = async () => {
    if (!stopped) throw new Error('Native Jellyfin has not completed its owned shutdown');
    const observed = await stopped;
    if (observed !== receipt || child.exitCode !== receipt.exitCode || child.signalCode !== receipt.signalCode
      || receipt.exitCode !== 0 || receipt.signalCode !== null || receipt.stopped !== true) {
      throw new Error('Native Jellyfin no longer matches its clean shutdown receipt');
    }
    return structuredClone(receipt);
  };
  try {
    for (let attempt = 0; attempt < 600; attempt++) {
      if (error) throw error;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Isolated Jellyfin exited before readiness: ${child.exitCode ?? child.signalCode}`);
      }
      try {
        const ready = await fetch(baseUrl + '/System/Info', { headers: { Authorization: `MediaBrowser Token="${token}"` }, signal: AbortSignal.timeout(500) });
        await ready.body?.cancel();
        if (ready.ok && Buffer.concat(output).includes(Buffer.from('Main: Startup complete'))) return { baseUrl, stop, assertStopped, instanceRoot: root };
      } catch {}
      await delay(100);
    }
    throw new Error('Isolated Jellyfin did not become ready');
  } catch (failure) { await stop(); throw failure; }
}

test('PostgreSQL runtime over WebDAV and AList returns SQLite exchange state to actual Jellyfin with media, text subtitles and versioned NFO roundtrip', { skip: !enabled }, async t => {
  const sourceRoot = path.resolve(process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE);
  const sourceInstanceState = await discoverInstanceState({ instanceRoot: sourceRoot });
  const evidence = process.env.MEDIAMANAGER_MEDIA_ACCESS_EVIDENCE && path.resolve(process.env.MEDIAMANAGER_MEDIA_ACCESS_EVIDENCE);
  const requestedDirectory = evidence ?? path.join(os.tmpdir(), `mediamanager-media-return-${randomUUID()}`);
  const directory = await assertIsolatedInstanceOutput({ instanceState: sourceInstanceState, output: requestedDirectory });
  await mkdir(directory, { recursive: false });
  let actual, actualWebDav;
  t.after(async () => {
    const errors = [];
    try { await actualWebDav?.stop(); } catch (error) { errors.push(error); }
    try { await actual?.stop(); } catch (error) { errors.push(error); }
    if (!evidence) {
      try { assert.equal(path.dirname(directory), os.tmpdir()); await rm(directory, { recursive: true }); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Actual storage services did not all clean up');
  });
  // Hold our own immutable stopped control for both long protocol branches.
  // Other tests can legitimately open the shared readonly SQLite input and
  // change temporary journal/directory generations without changing its bytes.
  // Keep cloneStoppedInstance's freshness checks, not a refreshed shared seal.
  const stoppedControl = path.join(directory, 'stopped-control');
  await cloneStoppedInstance({ instanceState: sourceInstanceState, destination: stoppedControl });
  const stoppedControlState = await discoverInstanceState({ instanceRoot: stoppedControl });
  actual = await startActualAList({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, port: 5244, evidenceDirectory: path.join(directory, 'alist-process') });
  const readable = path.join(actual.media, 'returned-media');
  const missing = path.join(actual.root, 'missing-enumeration');
  const candidateMedia = path.join(actual.media, 'candidate-media');
  await mkdir(readable); await mkdir(candidateMedia);
  actualWebDav = await startActualWebDav({ sourceRoot: actual.media, basePath: '/return-webdav',
    evidenceDirectory: path.join(directory, 'webdav-process') });
  for (const [mount, root] of [['/Candidate', candidateMedia], ['/' + readable.replaceAll('\\', '/'), readable]]) {
    await actual.api('admin/storage/create', { mount_path: mount, driver: 'Local', cache_expiration: 0, enable_sign: false, addition: JSON.stringify({ root_folder_path: root, show_hidden: true, thumbnail: false, mkdir_perm: '777' }) });
  }
  const ffmpeg = spawnSync(validationExecutable('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=size=32x32:rate=10:duration=0.2', '-metadata', 'title=Current candidate embedded title', '-c:v', 'ffv1', path.join(candidateMedia, 'feature.mkv')], { windowsHide: true });
  assert.equal(ffmpeg.status, 0, ffmpeg.stderr?.toString());
  const media = await readFile(path.join(candidateMedia, 'feature.mkv'));
  const assSubtitle = Buffer.from('[Script Info]\nScriptType: v4.00+\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:00.10,Default,,0,0,0,,Current candidate ASS 中文\n');
  const srtSubtitle = Buffer.from('1\n00:00:00,000 --> 00:00:00,100\nCurrent candidate subtitle 中文\n');
  const ssaSubtitle = Buffer.from('[Script Info]\nScriptType: v4.00\n[V4 Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, TertiaryColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, AlphaLevel, Encoding\nStyle: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,1,2,0,2,10,10,10,0,1\n[Events]\nFormat: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: Marked=0,0:00:00.00,0:00:00.10,Default,,0,0,0,,Current candidate SSA 中文\n');
  const vttSubtitle = Buffer.from('WEBVTT\n\n00:00:00.000 --> 00:00:00.100\nCurrent candidate WebVTT 中文\n');
  const candidateNfo = Buffer.from('<?xml version="1.0" encoding="utf-8"?>\r\n<movie>\r\n  <title>Candidate NFO title 中文</title>\r\n  <plot>Candidate NFO overview &amp; exact bytes.</plot>\r\n  <uniqueid type="tmdb" default="true">919191</uniqueid>\r\n</movie>\r\n');
  const nativeChangedNfo = Buffer.from('<?xml version="1.0" encoding="utf-8"?>\n<movie>\n  <title>Native changed NFO title 中文</title>\n  <plot>Native changed overview &amp; reverse migration.</plot>\n  <uniqueid type="tmdb" default="true">929292</uniqueid>\n</movie>\n');
  await writeFile(path.join(candidateMedia, 'feature.de.ass'), assSubtitle);
  await writeFile(path.join(candidateMedia, 'feature.en.forced.srt'), srtSubtitle);
  await writeFile(path.join(candidateMedia, 'feature.ja.ssa'), ssaSubtitle);
  await writeFile(path.join(candidateMedia, 'feature.fr.vtt'), vttSubtitle);
  const reports = [];
  for (const [index, storageProtocol] of ['webdav', 'alist'].entries()) await t.test(storageProtocol, async () => {
    await rm(path.join(candidateMedia, 'movie.nfo'), { force: true });
    await rm(path.join(readable, 'movie.nfo'), { force: true });
    const root = path.join(directory, storageProtocol); await mkdir(root);
    const working = path.join(root, 'current');
    await cloneStoppedInstance({ instanceState: stoppedControlState, destination: working });
    const sqlitePath = path.join(working, 'data/data/jellyfin.db');
    let sqlite = new SqliteDatabase(sqlitePath, { requireMigrationHistory: true });
    t.after(() => {
      const ownedSqlite = sqlite; sqlite = null;
      try { ownedSqlite?.close(); } catch { /* Branch cleanup already reported failures for an owned connection. */ }
    });
    const movie = sqlite.rows('BaseItems', { where: { Id: id } })[0]; assert.ok(movie);
    // A physical media folder and a UserRoot CollectionFolder are distinct
    // native entities. Their persisted path membership selects library options.
    const programDataPath = path.join(working, 'data');
    const userRootDirectory = path.join(programDataPath, 'root/default'); await mkdir(userRootDirectory, { recursive: true });
    const libraryDirectory = path.join(programDataPath, 'data/root/default/Return'); await mkdir(libraryDirectory, { recursive: true });
    await writeFile(path.join(libraryDirectory, 'options.xml'), `<LibraryOptions><Enabled>true</Enabled><EnableEmbeddedTitles>true</EnableEmbeddedTitles><EnableRealtimeMonitor>false</EnableRealtimeMonitor><PathInfos><MediaPathInfo><Path>${readable}</Path></MediaPathInfo></PathInfos><TypeOptions><TypeOptions><Type>Movie</Type><MetadataFetchers/><ImageFetchers/></TypeOptions></TypeOptions></LibraryOptions>`);
    const userRootId = nativeGuid(getNewItemId(userRootDirectory, 'MediaBrowser.Controller.Entities.UserRootFolder', { programDataPath }));
    const collectionId = nativeGuid(getNewItemId(libraryDirectory, 'MediaBrowser.Controller.Entities.CollectionFolder', { programDataPath }));
    const folder = sqlite.rows('BaseItems', { where: { Id: movie.ParentId } })[0]; assert.ok(folder);
    sqlite.update('BaseItems', { Id: folder.Id }, { Path: readable });
    sqlite.upsert('BaseItems', { ...folder, Id: userRootId, Type: 'MediaBrowser.Controller.Entities.UserRootFolder', Name: 'Media Folders',
      Path: userRootDirectory, ParentId: null, TopParentId: null, Data: '{"IsRoot":true}' });
    sqlite.upsert('BaseItems', { ...folder, Id: collectionId, Type: 'MediaBrowser.Controller.Entities.CollectionFolder', Name: 'Return',
      Path: '%AppDataPath%\\root\\default\\Return', ParentId: userRootId, TopParentId: null,
      Data: JSON.stringify({ CollectionType: 'movies', PhysicalFolderIds: [folder.Id], PhysicalLocationsList: [readable] }) });
    const stateId = sourceInstanceState.identity.serverId;
    const administratorIds = new Set(sqlite.rows('Permissions', { where: { Kind: 0, Value: true } })
      .map(permission => permission.UserId.toLowerCase()));
    const token = sqlite.rows('Devices').find(device => device.AccessToken
      && typeof device.UserId === 'string' && administratorIds.has(device.UserId.toLowerCase()))?.AccessToken;
    assert.ok(token, 'The stopped native instance must contain an authenticated administrator device.');
    for (const table of ['MediaStreamInfos', 'AttachmentStreamInfos', 'Chapters', 'BaseItemImageInfos', 'BaseItemMetadataFields', 'BaseItemProviders', 'PeopleBaseItemMap', 'ItemValuesMap']) {
      const rows = sqlite.rows(table, { where: { ItemId: id } });
      for (const row of rows) {
        sqlite.delete(table, Object.fromEntries(tableDefinition(table).primaryKey.map(key => [key, row[key]])));
      }
    }
    sqlite.update('BaseItems', { Id: id }, { Path: path.join(readable, 'feature.mkv'), Name: 'Before candidate refresh', IsLocked: false, IsInMixedFolder: false,
      RunTimeTicks: null, TotalBitrate: null, Data: '{"VideoType":"VideoFile"}', DateLastRefreshed: '0001-01-01 00:00:00', DateModified: '2000-01-01 00:00:00' });
    sqlite.insert('BaseItems', { ...movie, Id: negativeId, Path: path.join(missing, 'feature.mkv'), Name: 'Missing directory', IsLocked: true,
      IsInMixedFolder: false, Data: '{"VideoType":"VideoFile"}', RunTimeTicks: null, TotalBitrate: null });
    const returned = path.join(root, 'restored');
    const aggregate = sqlite.rows('BaseItems').find(item => item.Type === 'MediaBrowser.Controller.Entities.AggregateFolder');
    if (aggregate) sqlite.update('BaseItems', { Id: aggregate.Id }, { Path: path.join(working, 'data/root') });
    const port = 18365 + index;
    const config = path.join(working, 'config/network.xml');
    await writeFile(config, (await readFile(config, 'utf8')).replace(/<(InternalHttpPort|PublicHttpPort)>\d+<\/\1>/gu, (_, tag) => `<${tag}>${port}</${tag}>`));
    const writableSqlite = sqlite; sqlite = null;
    writableSqlite.close();
    sqlite = new SqliteDatabase(sqlitePath, { readOnly: true, requireMigrationHistory: true });
    const originInstanceState = await discoverInstanceState({ instanceRoot: working });
    assert.equal(originInstanceState.identity.serverId, stateId);
    const instanceBinding = { serverId: stateId, originIdentityDigest: originInstanceState.identity.digest };
    const sourcePortableMountContract = {
      mounts: [
        { mountId: 'return-media', identityRoot: readable, accessRoot: '/media', pathStyle: 'windows',
          caseSensitive: false, returnPolicy: 'required' },
        { mountId: 'missing-return-media', identityRoot: missing, accessRoot: '/missing-media', pathStyle: 'windows',
          caseSensitive: false, returnPolicy: 'required' },
      ]
    };
    const targetPortableMountContract = sourcePortableMountContract;
    // Keep both native round-trip schemas within the production 40-byte identifier contract.
    const schemaNonce = randomUUID().replaceAll('-', '').slice(0, 24);
    const schema = `media_return_${schemaNonce}`;
    let database, runtime, native, readback, nativeDatabase, reverseReadback, reimportDatabase, reimportRuntime, registry;
    let databaseOwner = 'none', reimportDatabaseOwner = 'none';
    let mainSchemaOwned = false, reimportSchemaOwned = false;
    let operationError;
    const cleanupErrors = [];
    const runtimeErrors = [];
    const reimportSchema = `media_reimport_${schemaNonce}`;
    const candidateStorageRoot = storageProtocol === 'webdav' ? '/candidate-media' : '/Candidate';
    const returnedStorageRoot = storageProtocol === 'webdav' ? '/returned-media' : '/' + readable.replaceAll('\\', '/');
    const candidateNfoVirtual = '/sidecar-state/candidate-media/movie.nfo';
    const returnedNfoVirtual = '/sidecar-state/returned-media/movie.nfo';
    try {
      registry = new StorageRegistry();
      registry.registerType('alist', config => new AListAdapter(config, { resolveCredential: async () => actual.token }));
      registry.registerType('webdav', config => new WebDavAdapter(config, { resolveCredential: async () => actualWebDav.authorization }));
      registry.registerType('isolated-versioned-filesystem', config => new IsolatedVersionedFilesystemAdapter(config.root));
      await registry.createInstance('return-media', storageProtocol, storageProtocol === 'webdav'
        ? { baseUrl: actualWebDav.baseUrl, credentialRef: 'isolated' }
        : { baseUrl: actual.baseUrl, credentialRef: 'isolated', capabilities: { create: true, replace: true } });
      await registry.createInstance('sidecar-state', 'isolated-versioned-filesystem', { root: actual.media });
      const vfs = new VirtualFileSystem(registry); vfs.mount({ path: '/media', instanceId: 'return-media', root: candidateStorageRoot, capabilities: {} });
      vfs.mount({ path: '/sidecar-state', instanceId: 'sidecar-state', root: '/', capabilities: {
        create: true, replace: true, conditionalWrite: true, atomicReplace: true
      } });
      const identityMap = new IdentityAccessMap();
      identityMap.addPrefix({ identityRoot: readable, accessRoot: '/media', style: 'windows', returnAccess: 'Native physical directory and actual local media proxy mount' });
      identityMap.bind(negativeId, '/media/feature.mkv');
      database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
      databaseOwner = 'branch'; mainSchemaOwned = true;
      await transferDatabase(sqlite, database, { instanceBinding, portableMountContract: sourcePortableMountContract });
      const libraryOptions = Object.fromEntries((await database.rows('BaseItems')).filter(item => item.Type.endsWith('.CollectionFolder')).map(item => [item.Id.replaceAll('-', '').toLowerCase(), { ...defaultLibraryOptions(), EnableEmbeddedTitles: true, TypeOptions: [{ Type: 'Movie', MetadataFetchers: [], ImageFetchers: [] }] }]));
      runtime = await createRuntime({ database, vfs, identityMap, serverId: stateId, programDataPath: path.join(working, 'data'),
        configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true, DummyChapterDuration: 0 }, libraryOptions,
        onError: error => runtimeErrors.push(error?.stack ?? error?.message ?? String(error)) });
      databaseOwner = 'runtime';
      const context = await runtime.metadata.loadContext(id);
      assert.deepEqual(context.collectionFolders.map(item => item.Id), [collectionId]); assert.equal(context.libraryOptions.EnableEmbeddedTitles, true);
      await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
      const candidateBase = `http://127.0.0.1:${runtime.server.address().port}`;
      const refresh = await fetch(`${candidateBase}/Items/${id}/Refresh?metadataRefreshMode=FullRefresh&imageRefreshMode=None&replaceAllMetadata=true`, { method: 'POST', headers: { Authorization: `MediaBrowser Token="${token}"` } });
      assert.equal(refresh.status, 204, await refresh.text()); await runtime.metadata.drain();
      const changed = (await database.rows('BaseItems', { where: { Id: id } }))[0];
      assert.equal(changed.Name, 'Current candidate embedded title', json({ storageProtocol, runtimeErrors }));
      assert.equal(changed.RunTimeTicks, 2000000n); assert.equal(changed.IsInMixedFolder, false);
      await writeFile(path.join(candidateMedia, 'movie.nfo'), candidateNfo);
      const streams = await database.rows('MediaStreamInfos', { where: { ItemId: id } });
      const externalAss = streams.find(stream => stream.StreamType === 2 && stream.IsExternal && /\.ass$/i.test(stream.Path ?? ''));
      const externalSrt = streams.find(stream => stream.StreamType === 2 && stream.IsExternal && /\.srt$/i.test(stream.Path ?? ''));
      const externalSsa = streams.find(stream => stream.StreamType === 2 && stream.IsExternal && /\.ssa$/i.test(stream.Path ?? ''));
      const externalVtt = streams.find(stream => stream.StreamType === 2 && stream.IsExternal && /\.vtt$/i.test(stream.Path ?? ''));
      assert.ok(externalAss); assert.ok(externalSrt); assert.ok(externalSsa); assert.ok(externalVtt);
      // The negative item carries the same metadata but deliberately has no native filesystem directory.
      for (const stream of streams) await database.insert('MediaStreamInfos', { ...stream, ItemId: negativeId, Path: stream.Path?.replace(readable, missing) ?? null });
      await database.update('BaseItems', { Id: negativeId }, { RunTimeTicks: changed.RunTimeTicks, TotalBitrate: changed.TotalBitrate, Width: changed.Width, Height: changed.Height,
        Data: changed.Data.replaceAll(readable.replaceAll('\\', '\\\\'), missing.replaceAll('\\', '\\\\')) });
      const entry = (itemId, identityRoot, nfoBytes) => ({ itemId, identityPath: path.join(identityRoot, 'feature.mkv'), identityRoot,
        enumeration: { kind: 'native-filesystem', root: identityRoot }, read: { kind: 'native-local-media-proxy' }, expected: expected(media, true),
        sidecars: [
          { kind: 'subtitle', identityPath: path.join(identityRoot, 'feature.de.ass'), streamIndex: externalAss.StreamIndex, read: { kind: 'native-subtitle-original' }, expected: expected(assSubtitle) },
          { kind: 'subtitle', identityPath: path.join(identityRoot, 'feature.en.forced.srt'), streamIndex: externalSrt.StreamIndex, read: { kind: 'native-subtitle-original' }, expected: expected(srtSubtitle) },
          { kind: 'subtitle', identityPath: path.join(identityRoot, 'feature.ja.ssa'), streamIndex: externalSsa.StreamIndex, read: { kind: 'native-subtitle-original' }, expected: expected(ssaSubtitle) },
          { kind: 'subtitle', identityPath: path.join(identityRoot, 'feature.fr.vtt'), streamIndex: externalVtt.StreamIndex, read: { kind: 'native-subtitle-original' }, expected: expected(vttSubtitle) },
          ...(nfoBytes ? [{ kind: 'nfo', identityPath: path.join(identityRoot, 'movie.nfo'), read: { kind: 'native-filesystem-sidecar' },
            stateAssetId: 'movie-nfo', expected: expected(nfoBytes) }] : []),
        ] });
      const plan = { scope: 'explicit-items', items: [entry(id, readable, candidateNfo), entry(negativeId, missing)] };
      const stoppedRuntime = runtime, runtimeClose = stoppedRuntime.close();
      try { await runtimeClose; }
      finally {
        runtime = null;
        if (databaseOwner === 'runtime') {
          database = null; databaseOwner = 'closed';
        }
      }
      database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema });
      databaseOwner = 'branch';
      const instanceState = await discoverInstanceState({ instanceRoot: working });
      assert.equal(instanceState.identity.serverId, stateId);
      assert.deepEqual(await database.readInstanceBinding(), instanceBinding);
      const captureSession = createIsolatedOfflineCopyCaptureSession({
        instanceState,
        ownerId: `native-media-access-${storageProtocol}`,
        assertHeld: async () => {
          assert.equal(stoppedRuntime.close(), runtimeClose);
          await runtimeClose;
          assert.equal(stoppedRuntime.server.listening, false);
          assert.equal(sqlite.database.isTransaction, false);
          assert.equal(database.inTransaction, false);
        },
      });
      const captured = await createStatePackage({ database, destination: path.join(root, 'package'), instanceState, captureSession,
        baseline: 'Frozen current Jellyfin including local modifications', mediaAccess: plan,
        targetPortableMountContract,
        remoteState: { vfs, assets: [{ assetId: 'movie-nfo', virtualPath: candidateNfoVirtual, restorePath: 'movie.nfo', kind: 'nfo' }] } });
      const before = await databaseDigest(database);
      assert.ok(captured.database.pathProjection.rewrittenPaths > 0);
      assert.notDeepEqual(captured.database.tables, before,
        'instance-state virtualization must change the portable database digest without adding a media mount');
      assert.deepEqual(captured.database.portableMountContract.mounts.map(mount => mount.mountId),
        ['missing-return-media', 'return-media'], 'portable mount contracts use canonical mountId order');
      const restored = await restoreStatePackage(path.join(root, 'package'), returned); assert.equal(restored.mediaAccessVerified, false);
      const returnedInstanceState = await discoverInstanceState({ instanceRoot: returned });
      assert.equal(returnedInstanceState.identity.serverId, stateId);
      const initialRemoteRestore = await restoreRemoteStatePackage(path.join(root, 'package'), { vfs, targets: { 'movie-nfo': returnedNfoVirtual } });
      assert.equal(initialRemoteRestore.complete, true); assert.deepEqual(await readFile(path.join(readable, 'movie.nfo')), candidateNfo);
      await writeFile(path.join(root, 'initial-nfo-restore.json'), json(initialRemoteRestore));
      readback = new SqliteDatabase(path.join(returned, 'data/data/jellyfin.db'), { readOnly: true });
      assert.deepEqual(await databaseDigest(readback), captured.database.tables);
      // Provision an independent synthetic return drive, without including media bytes in the state package.
      await writeFile(path.join(readable, 'feature.mkv'), media);
      await writeFile(path.join(readable, 'feature.de.ass'), assSubtitle);
      await writeFile(path.join(readable, 'feature.en.forced.srt'), srtSubtitle);
      await writeFile(path.join(readable, 'feature.ja.ssa'), ssaSubtitle);
      await writeFile(path.join(readable, 'feature.fr.vtt'), vttSubtitle);
      await actual.api('admin/setting/save', [{ key: 'sign_all', value: String(storageProtocol === 'webdav'), type: 'bool', group: 4, flag: 1 }]);
      native = await startNative(returned, port, token, { evidenceDirectory: root });
      const detailsResponse = await fetch(`${native.baseUrl}/Items?Ids=${id}&Fields=Path&Recursive=true`, { headers: { Authorization: `MediaBrowser Token="${token}"` } });
      assert.equal(detailsResponse.status, 200);
      const details = await detailsResponse.json();
      await writeFile(path.join(root, 'native-item.json'), json(details));
      assert.equal(details.Items[0].Name, changed.Name); assert.equal(details.Items[0].Path, changed.Path); assert.equal(BigInt(details.Items[0].RunTimeTicks), changed.RunTimeTicks);
      if (storageProtocol === 'webdav') {
        const signed = await verifyNativeMediaAccess({ ...plan, items: [plan.items[0]] }, { database: readback, baseUrl: native.baseUrl, accessToken: token });
        await writeFile(path.join(root, 'native-signed-access.json'), json(signed).replaceAll(token, '[isolated token redacted]'));
        // LocalMediaProxy deliberately emits a stable, unsigned /d URL. AList's
        // sign_all policy must therefore block byte and subtitle reads without
        // changing Jellyfin's independent native directory enumeration.
        assert.equal(signed.items[0].enumeration[0].verified, true);
        assert.equal(signed.items[0].playbackInfo.verified, true);
        assert.equal(signed.items[0].original.verified, false);
        assert.equal(signed.items[0].range.verified, false);
        assert.equal(signed.items[0].sidecars.filter(sidecar => sidecar.kind === 'subtitle').every(sidecar => !sidecar.verified), true);
        await actual.api('admin/setting/save', [{ key: 'sign_all', value: 'false', type: 'bool', group: 4, flag: 1 }]);
        await writeFile(path.join(directory, 'isolated-alist-access.json'), json({ address: '127.0.0.1', port: 5244,
          unsignedProxyRejectedBySignAll: true, signAllResetForRemainingChecks: true, allMediaSynthetic: true }));
      }
      const nativeNfoRefreshStatus = await refreshNative(native.baseUrl, token, id);
      const nativeNfoItem = await waitNativeItem(native.baseUrl, token, id, item => item.Overview === 'Candidate NFO overview & exact bytes.'
        && item.ProviderIds?.Tmdb === '919191');
      assert.equal(nativeNfoItem.Name, 'Current candidate embedded title');
      await writeFile(path.join(root, 'native-nfo-item.json'), json(nativeNfoItem));
      assert.deepEqual(await readFile(path.join(readable, 'movie.nfo')), candidateNfo);
      const report = await verifyNativeMediaAccess(plan, { database: readback, baseUrl: native.baseUrl, accessToken: token });
      await writeFile(path.join(root, 'native-media-access.json'), json(report).replaceAll(token, '[isolated token redacted]'));
      assert.equal(report.items[0].verified, true, json(report.items[0]));
      assert.equal(report.items[0].sidecars.find(sidecar => sidecar.kind === 'nfo')?.verified, true);
      assert.equal(report.items[1].verified, false); assert.equal(report.items[1].original.verified, false); assert.equal(report.items[1].range.verified, false);
      assert.equal(report.items[1].sidecars.every(sidecar => !sidecar.verified), true);
      assert.equal(report.items[1].enumeration[0].verified, false); assert.equal(report.declaredItemsVerified, false); assert.equal(report.completeLibraryVerified, false);

      readback.close(); readback = null;
      await native.stop(); native = null;
      const changedRefreshDatabase = new SqliteDatabase(path.join(returned, 'data/data/jellyfin.db'), { requireMigrationHistory: true });
      try {
        changedRefreshDatabase.update('BaseItems', { Id: id }, { Overview: null });
        for (const provider of changedRefreshDatabase.rows('BaseItemProviders', { where: { ItemId: id } }).filter(provider => provider.ProviderId === 'Tmdb')) {
          changedRefreshDatabase.delete('BaseItemProviders', { ItemId: provider.ItemId, ProviderId: provider.ProviderId });
        }
      } finally {
        changedRefreshDatabase.close();
      }
      await writeFile(path.join(readable, 'movie.nfo'), nativeChangedNfo);
      const future = new Date(Date.now() + 120000); await utimes(path.join(readable, 'movie.nfo'), future, future);
      native = await startNative(returned, port, token, { evidenceDirectory: root, evidenceName: 'native-changed-process' });
      const nativeChangedRefreshStatus = await refreshNative(native.baseUrl, token, id);
      const nativeChangedItem = await waitNativeItem(native.baseUrl, token, id, item => item.Overview === 'Native changed overview & reverse migration.'
        && item.ProviderIds?.Tmdb === '929292');
      assert.equal(nativeChangedItem.Name, 'Current candidate embedded title');
      await writeFile(path.join(root, 'native-changed-nfo-item.json'), json(nativeChangedItem));
      assert.deepEqual(await readFile(path.join(readable, 'movie.nfo')), nativeChangedNfo);
      const stoppedNative = native;
      const nativeStopReceipt = await stoppedNative.stop(); native = null;

      nativeDatabase = new SqliteDatabase(path.join(returned, 'data/data/jellyfin.db'), { readOnly: true, requireMigrationHistory: true });
      const nativeStored = (await nativeDatabase.rows('BaseItems', { where: { Id: id } }))[0];
      const nativeProviders = Object.fromEntries((await nativeDatabase.rows('BaseItemProviders', { where: { ItemId: id } })).map(row => [row.ProviderId, row.ProviderValue]));
      assert.equal(nativeStored.Name, nativeChangedItem.Name); assert.equal(nativeStored.Overview, nativeChangedItem.Overview); assert.equal(nativeProviders.Tmdb, '929292');
      const reversePlan = { scope: 'explicit-items', items: [entry(id, readable, nativeChangedNfo), entry(negativeId, missing)] };
      const reversePackage = path.join(root, 'reverse-package');
      const nativeInstanceState = await discoverInstanceState({ instanceRoot: returned });
      assert.equal(nativeInstanceState.identity.serverId, stateId);
      assert.equal(stoppedNative.instanceRoot, path.resolve(returned));
      const nativeCaptureSession = createStoppedServiceCaptureSession({
        instanceState: nativeInstanceState,
        receipt: nativeStopReceipt,
        assertStopped: () => stoppedNative.assertStopped(),
      });
      const reverseCaptured = await createStatePackage({ database: nativeDatabase, destination: reversePackage, instanceState: nativeInstanceState,
        captureSession: nativeCaptureSession, baseline: 'Frozen current Jellyfin including local modifications', mediaAccess: reversePlan,
        remoteState: { vfs, assets: [{ assetId: 'movie-nfo', virtualPath: returnedNfoVirtual, restorePath: 'movie.nfo', kind: 'nfo' }] } });
      nativeDatabase.close(); nativeDatabase = null;
      const reverseReturned = path.join(root, 'reverse-restored');
      await restoreStatePackage(reversePackage, reverseReturned);
      const reverseReturnedInstanceState = await discoverInstanceState({ instanceRoot: reverseReturned });
      assert.equal(reverseReturnedInstanceState.identity.serverId, stateId);
      reverseReadback = new SqliteDatabase(path.join(reverseReturned, 'data/data/jellyfin.db'), { readOnly: true });
      assert.deepEqual(await databaseDigest(reverseReadback), reverseCaptured.database.tables); reverseReadback.close(); reverseReadback = null;
      await rm(path.join(readable, 'movie.nfo'));
      const reverseRemoteRestore = await restoreRemoteStatePackage(reversePackage, { vfs, targets: { 'movie-nfo': returnedNfoVirtual } });
      assert.equal(reverseRemoteRestore.complete, true); assert.deepEqual(await readFile(path.join(readable, 'movie.nfo')), nativeChangedNfo);
      await writeFile(path.join(root, 'reverse-nfo-restore.json'), json(reverseRemoteRestore));

      const reverseFixtureDatabase = new SqliteDatabase(path.join(reverseReturned, 'data/data/jellyfin.db'), { requireMigrationHistory: true });
      try {
        reverseFixtureDatabase.update('BaseItems', { Id: id }, { Overview: null, IsLocked: false });
        for (const provider of reverseFixtureDatabase.rows('BaseItemProviders', { where: { ItemId: id } }).filter(provider => provider.ProviderId === 'Tmdb')) {
          reverseFixtureDatabase.delete('BaseItemProviders', { ItemId: provider.ItemId, ProviderId: provider.ProviderId });
        }
      } finally {
        reverseFixtureDatabase.close();
      }
      native = await startNative(reverseReturned, port, token, { evidenceDirectory: root, evidenceName: 'reverse-native-process' });
      const reverseNativeRefreshStatus = await refreshNative(native.baseUrl, token, id);
      const reverseNativeItem = await waitNativeItem(native.baseUrl, token, id, item => item.Overview === 'Native changed overview & reverse migration.'
        && item.ProviderIds?.Tmdb === '929292');
      assert.equal(reverseNativeItem.Name, 'Current candidate embedded title');
      await writeFile(path.join(root, 'reverse-native-nfo-item.json'), json(reverseNativeItem));
      reverseReadback = new SqliteDatabase(path.join(reverseReturned, 'data/data/jellyfin.db'), { readOnly: true });
      const reverseReport = await verifyNativeMediaAccess(reversePlan, { database: reverseReadback, baseUrl: native.baseUrl, accessToken: token });
      await writeFile(path.join(root, 'reverse-native-media-access.json'), json(reverseReport).replaceAll(token, '[isolated token redacted]'));
      assert.equal(reverseReport.items[0].verified, true, json(reverseReport.items[0])); assert.equal(reverseReport.completeLibraryVerified, false);
      reverseReadback.close(); reverseReadback = null;
      await native.stop(); native = null;
      // Complete the reverse sidecar path by importing the state actually used
      // by Jellyfin, then reading and refreshing its changed NFO through the
      // same independent protocol selected for this database branch.
      reverseReadback = new SqliteDatabase(path.join(reverseReturned, 'data/data/jellyfin.db'), { readOnly: true, requireMigrationHistory: true });
      const reimportInstanceState = await discoverInstanceState({ instanceRoot: reverseReturned });
      assert.equal(reimportInstanceState.identity.serverId, stateId);
      reimportDatabase = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema: reimportSchema, create: true });
      reimportDatabaseOwner = 'branch'; reimportSchemaOwned = true;
      const reimportSourceDigest = await databaseDigest(reverseReadback);
      await transferDatabase(reverseReadback, reimportDatabase, { instanceBinding: {
        serverId: reimportInstanceState.identity.serverId,
        originIdentityDigest: reimportInstanceState.identity.digest,
      }, portableMountContract: {
        mounts: [
          { mountId: 'return-media', identityRoot: readable, accessRoot: '/reimport-media', pathStyle: 'windows',
            caseSensitive: false, returnPolicy: 'required' },
          { mountId: 'missing-return-media', identityRoot: missing, accessRoot: '/reimport-missing-media', pathStyle: 'windows',
            caseSensitive: false, returnPolicy: 'required' },
        ]
      } });
      assert.deepEqual(await databaseDigest(reimportDatabase), reimportSourceDigest);
      reverseReadback.close(); reverseReadback = null;
      const reimportedItem = (await reimportDatabase.rows('BaseItems', { where: { Id: id } }))[0];
      assert.equal(reimportedItem.Name, reverseNativeItem.Name);
      assert.equal(reimportedItem.Overview, reverseNativeItem.Overview);
      assert.equal((await reimportDatabase.rows('BaseItemProviders', { where: { ItemId: id, ProviderId: 'Tmdb' } }))[0].ProviderValue, '929292');
      const reimportVfs = new VirtualFileSystem(registry);
      reimportVfs.mount({ path: '/reimport-media', instanceId: 'return-media', root: returnedStorageRoot, capabilities: {} });
      const reimportIdentityMap = new IdentityAccessMap();
      reimportIdentityMap.addPrefix({ identityRoot: readable, accessRoot: '/reimport-media', style: 'windows', returnAccess: 'Verified native directory and network proxy mount' });
      await reimportDatabase.update('BaseItems', { Id: id }, { Overview: null, IsLocked: false });
      await reimportDatabase.delete('BaseItemProviders', { ItemId: id, ProviderId: 'Tmdb' });
      reimportRuntime = await createRuntime({ database: reimportDatabase, vfs: reimportVfs, identityMap: reimportIdentityMap,
        serverId: stateId, programDataPath: path.join(reverseReturned, 'data'), configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true, DummyChapterDuration: 0 }, libraryOptions });
      reimportDatabaseOwner = 'runtime';
      await new Promise(resolve => reimportRuntime.server.listen(0, '127.0.0.1', resolve));
      const reimportBase = `http://127.0.0.1:${reimportRuntime.server.address().port}`;
      const reimportRefresh = await fetch(`${reimportBase}/Items/${id}/Refresh?metadataRefreshMode=FullRefresh&imageRefreshMode=None&replaceAllMetadata=false`, {
        method: 'POST', headers: { Authorization: `MediaBrowser Token="${token}"` }, signal: AbortSignal.timeout(5000),
      });
      assert.equal(reimportRefresh.status, 204, await reimportRefresh.text());
      await reimportRuntime.metadata.drain();
      const refreshedReimport = (await reimportDatabase.rows('BaseItems', { where: { Id: id } }))[0];
      assert.equal(refreshedReimport.Name, 'Current candidate embedded title');
      assert.equal(refreshedReimport.Overview, 'Native changed overview & reverse migration.');
      assert.equal((await reimportDatabase.rows('BaseItemProviders', { where: { ItemId: id, ProviderId: 'Tmdb' } }))[0].ProviderValue, '929292');
      assert.equal(refreshedReimport.RunTimeTicks, 2000000n);
      assert.deepEqual(await readFile(path.join(readable, 'movie.nfo')), nativeChangedNfo);
      const reimportMedia = await reimportVfs.openRead('/reimport-media/feature.mkv');
      try { const chunks = []; for await (const chunk of reimportMedia.stream) chunks.push(Buffer.from(chunk)); assert.deepEqual(Buffer.concat(chunks), media); }
      finally { await reimportMedia.close(); }
      await writeFile(path.join(root, 'reverse-node-reimport.json'), json({ backend: 'postgres', databaseDigestEqual: true,
        id: refreshedReimport.Id, identityPath: refreshedReimport.Path, name: refreshedReimport.Name, overview: refreshedReimport.Overview,
        tmdb: '929292', runtimeTicks: refreshedReimport.RunTimeTicks, refreshStatus: reimportRefresh.status,
        nativeChangedNfoSha256: sha(nativeChangedNfo), mediaSha256: sha(media), storageProtocol,
        actualProtocolReadVerified: true, nativeReturnAccessProtocol: 'AList LocalMediaProxy over the same isolated media root',
        completeLibraryVerified: false }));
      const ownedReimportRuntime = reimportRuntime;
      try { await ownedReimportRuntime.close(); }
      finally {
        reimportRuntime = null;
        if (reimportDatabaseOwner === 'runtime') {
          reimportDatabase = null; reimportDatabaseOwner = 'closed';
        }
      }
      reports.push({ runtimeDatabase: 'postgres', storageProtocol, databaseDigestEqual: true, candidateRefreshHttpStatus: refresh.status, name: changed.Name, runtimeTicks: changed.RunTimeTicks,
        subtitleFormatsVerified: report.items[0].sidecars.filter(sidecar => sidecar.kind === 'subtitle').map(sidecar => sidecar.format), positiveVerified: report.items[0].verified,
        nativeCurrentItemFieldsVerified: true, nativeNfoRefreshStatus, nativeNfoFieldsVerified: true, nativeNfoBytesVerified: true,
        nativeNfoTitleValue: nativeNfoItem.Name, embeddedTitleRetained: true,
        nativeChangedRefreshStatus, nativeChangedNfoFieldsVerified: true, reverseRemoteRestoreVerified: true, reverseNativeRefreshStatus,
        reverseNativeFieldsVerified: true, reverseNativeAccessVerified: reverseReport.items[0].verified,
        reverseNodeImportVerified: true, reverseNodeNfoRefreshStatus: reimportRefresh.status, reverseNodeNfoBytesVerified: true,
        negativeDirectoryVerified: report.items[1].enumeration[0].verified, negativeHttpReadVerified: report.items[1].original.verified, completeLibraryVerified: false });
    } catch (error) {
      operationError = error;
    } finally {
      const attempt = async action => { try { await action(); } catch (error) { cleanupErrors.push(error); } };
      await attempt(async () => readback?.close());
      await attempt(async () => reverseReadback?.close());
      await attempt(async () => nativeDatabase?.close());
      await attempt(async () => native?.stop());
      if (reimportRuntime) {
        await attempt(async () => {
          const ownedRuntime = reimportRuntime;
          try { await ownedRuntime.close(); }
          finally {
            reimportRuntime = null;
            if (reimportDatabaseOwner === 'runtime') {
              reimportDatabase = null; reimportDatabaseOwner = 'closed';
            }
          }
        });
      }
      if (reimportDatabaseOwner === 'branch' && reimportDatabase) {
        await attempt(async () => {
          const ownedDatabase = reimportDatabase;
          try { await ownedDatabase.close(); }
          finally { reimportDatabase = null; reimportDatabaseOwner = 'closed'; }
        });
      }
      if (runtime) {
        await attempt(async () => {
          const ownedRuntime = runtime;
          try { await ownedRuntime.close(); }
          finally {
            runtime = null;
            if (databaseOwner === 'runtime') { database = null; databaseOwner = 'closed'; }
          }
        });
      }
      await attempt(async () => registry?.close());
      if (databaseOwner === 'branch' && database) {
        await attempt(async () => {
          const ownedDatabase = database;
          try { await ownedDatabase.close(); }
          finally { database = null; databaseOwner = 'closed'; }
        });
      }
      if (sqlite) {
        await attempt(async () => {
          const ownedSqlite = sqlite; sqlite = null;
          await ownedSqlite.close();
        });
      }
      if (mainSchemaOwned || reimportSchemaOwned) {
        let admin;
        let connected = false;
        await attempt(async () => {
          const { default: pg } = await import('pg');
          admin = new pg.Client({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES });
          await admin.connect(); connected = true;
        });
        if (connected) {
          const ownedSchemas = [
            ...(mainSchemaOwned ? [schema, `${schema}__mm`] : []),
            ...(reimportSchemaOwned ? [reimportSchema, `${reimportSchema}__mm`] : []),
          ];
          for (const name of ownedSchemas) {
            await attempt(async () => admin.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`));
          }
          await attempt(async () => admin.end());
        }
      }
    }
    if (operationError && cleanupErrors.length) {
      throw new AggregateError([operationError, ...cleanupErrors], `Native ${storageProtocol} branch failed and did not clean up every resource`);
    }
    if (operationError) throw operationError;
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, `Native ${storageProtocol} branch did not clean up every resource`);
  });
  await writeFile(path.join(directory, 'report.json'), json({ reports, mediaBytesIncludedInStatePackage: false,
    nativeFullLibraryScannerRun: false, actualAList: true, actualWebDav: true,
    runtimeDatabase: 'PostgreSQL only; SQLite is used only for Jellyfin import/export exchange',
    protocolSwitch: 'The WebDAV branch uses WebDAV in the PostgreSQL runtime and AList LocalMediaProxy after return to Jellyfin',
    referenceDataOpened: false }));
});
