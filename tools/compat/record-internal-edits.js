import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { currentNativeReference } from './current-native-reference.js';
import { createPrivateFilterOutput, filterEvidenceJson } from './filter-reference-output.js';
import { editHttpInputBytes, editHttpNativeTypes, internalEditHttpInput } from './internal-edit-http-input.js';
import { assertValidationOutputChild } from '../validation/paths.js';

export const editHttpTables = ['BaseItems', 'AncestorIds', 'LinkedChildren', 'ItemValues', 'ItemValuesMap', 'UserData',
  'MediaStreamInfos', 'Peoples', 'PeopleBaseItemMap', 'BaseItemImageInfos', 'BaseItemProviders', 'BaseItemMetadataFields'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => filterEvidenceJson(value);
const available = port => new Promise(resolve => { const server = createServer(); server.once('error', () => resolve(false));
  server.listen(port, '127.0.0.1', () => server.close(() => resolve(true))); });
const sqlitePath = root => path.join(root, 'data/data/jellyfin.db');

export async function editFilesystemSnapshot(roots) {
  const result = {};
  for (const [name, root] of Object.entries(roots)) {
    const entries = [];
    async function visit(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
        assert.equal(entry.isSymbolicLink(), false);
        const filename = path.join(directory, entry.name), relative = path.relative(root, filename).replaceAll('\\', '/');
        if (entry.isDirectory()) { entries.push({ path: relative, kind: 'directory' }); await visit(filename); }
        else {
          assert.ok(entry.isFile()); const bytes = await readFile(filename);
          entries.push({ path: relative, kind: 'file', size: bytes.length, sha256: digest(bytes),
            ...(/\.(?:xml|nfo)$/iu.test(entry.name) ? { text: bytes.toString('utf8') } : {}) });
        }
      }
    }
    await visit(root);
    result[name] = entries.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  }
  return result;
}

async function nativeSnapshot(referenceRoot, input) {
  const database = new SqliteDatabase(sqlitePath(referenceRoot), { readOnly: true, requireMigrationHistory: true });
  try { return { database: Object.fromEntries(editHttpTables.map(table => [table, database.rows(table)])),
    filesystem: await editFilesystemSnapshot(input.filesystemRoots) }; }
  finally { database.close(); }
}

async function seed(referenceRoot, input) {
  const database = new DatabaseSync(sqlitePath(referenceRoot));
  try {
    const template = id => { const query = database.prepare('SELECT * FROM "BaseItems" WHERE "Id"=?'); query.setReadBigInts(true); return query.get(id); };
    const folder = template(input.ids.folder), movie = template(input.ids.movie);
    assert.ok(folder && movie);
    for (const item of input.items) {
      const data = { ...(item.type === 'Movie' ? { VideoType: 'VideoFile' } : {}), ...item.data };
      const row = { ...(item.type === 'Movie' ? movie : folder), Id: item.id, Type: editHttpNativeTypes[item.type],
        Name: item.name, CleanName: item.name.toLowerCase(), SortName: item.name.toLowerCase(),
        ParentId: item.parent, TopParentId: item.topParent, Path: item.path,
        IsFolder: item.type !== 'Movie' ? 1n : 0n, IsMovie: item.type === 'Movie' ? 1n : 0n,
        IsSeries: 0n, IsInMixedFolder: item.type === 'Movie' ? 1n : 0n,
        MediaType: item.type === 'Movie' ? 'Video' : 'Unknown', UnratedType: item.type === 'Movie' ? 'Movie' : 'Other',
        RunTimeTicks: item.type === 'Movie' ? 9007199254740993n : null,
        PresentationUniqueKey: item.id.replaceAll('-', ''), Data: JSON.stringify(data) };
      const columns = Object.keys(row);
      database.prepare(`INSERT INTO "BaseItems" (${columns.map(name => `"${name}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})
        ON CONFLICT("Id") DO UPDATE SET ${columns.filter(name => name !== 'Id').map(name => `"${name}"=excluded."${name}"`).join(',')}`)
        .run(...columns.map(name => row[name]));
      if (item.type === 'Movie') await writeFile(item.path, 'Controlled media bytes; metadata editing does not probe or encode.\n', { flag: 'wx' });
      else await mkdir(item.path, { recursive: true });
      if (item.type === 'Playlist') await writeFile(path.join(item.path, 'playlist.xml'), '<Item><LocalTitle>Original</LocalTitle><Custom>retained</Custom></Item>', { flag: 'wx' });
    }
    await writeFile(path.join(input.mediaPath, 'feature.nfo'), '<movie><title>Original</title><custom key="a">retained</custom></movie>', { flag: 'wx' });
    await writeFile(path.join(input.collectionPath, 'options.xml'), '<LibraryOptions><SaveLocalMetadata>true</SaveLocalMetadata><MetadataSavers><string>Nfo</string></MetadataSavers><EnableRealtimeMonitor>false</EnableRealtimeMonitor><TypeOptions/></LibraryOptions>', { flag: 'wx' });
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { database.close(); }
}

/** Actual native HTTP/SQLite/files, followed by an exact private-state reset
 * and a candidate callback at the same physical instance and media paths. */
export async function recordInternalEdits(destination, compareCandidate, { port = 19000 } = {}) {
  destination = assertValidationOutputChild(path.resolve(destination));
  assert.equal(existsSync(destination), false);
  assert.ok(await available(port));
  const output = await createPrivateFilterOutput(destination), root = output.root;
  let failure;
  try {
    const current = await currentNativeReference(); output.addSecret(current.accessToken);
    const referenceRoot = path.join(root, 'reference'), initialRoot = path.join(root, 'initial');
    const initialMediaRoot = path.join(root, 'initial-media');
    await mkdir(root);
    await cp(current.sourceRoot, referenceRoot, { recursive: true, filter: filename => !path.relative(current.sourceRoot, filename).replaceAll('\\', '/').startsWith('log/') });
    await mkdir(path.join(referenceRoot, 'log'), { recursive: true });
    await current.prepareClone(referenceRoot, port);
    const origin = `http://127.0.0.1:${port}`;
    const request = async (route, { method = 'GET', body } = {}) => {
      const response = await fetch(origin + route, { method, signal: AbortSignal.timeout(30000),
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}),
          Authorization: `MediaBrowser Client="InternalEditOracle", Device="Isolated", DeviceId="internal-edit-oracle", Version="1", Token="${current.accessToken}"` },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, contentType: response.headers.get('content-type'), bodyText: await response.text() };
    };
    const discover = current.start({ referenceRoot, outputRoot: root, label: 'discovery', origin });
    let discovery, discoveryProcess;
    try {
      await discover.ready(); discovery = await request('/Items/Root'); assert.equal(discovery.status, 200, discovery.bodyText);
    } finally { discoveryProcess = await discover.stop(async () => (await request('/System/Shutdown', { method: 'POST' })).status, () => available(port)); }
    assert.ok(discoveryProcess.cleanShutdown && discoveryProcess.code === 0 && discoveryProcess.pidGone && discoveryProcess.portAvailable);
    const discoveredRoot = JSON.parse(discovery.bodyText);
    assert.equal(discoveredRoot.Type, 'UserRootFolder');
    const rootKey = discoveredRoot.Id.replaceAll('-', '').toUpperCase();
    assert.match(rootKey, /^[A-F0-9]{32}$/u);
    const discoveredId = `${rootKey.slice(0, 8)}-${rootKey.slice(8, 12)}-${rootKey.slice(12, 16)}-${rootKey.slice(16, 20)}-${rootKey.slice(20)}`;
    const database = new DatabaseSync(sqlitePath(referenceRoot), { readOnly: true });
    let observed;
    try {
      const find = type => { const row = database.prepare('SELECT * FROM "BaseItems" WHERE "Type"=?').get(editHttpNativeTypes[type]); assert.ok(row); return row.Id; };
      observed = { AggregateFolder: find('AggregateFolder'), UserRootFolder: discoveredId,
        PlaylistsFolder: find('PlaylistsFolder'), userId: current.userId, userRootName: discoveredRoot.Name };
      const userRoot = database.prepare('SELECT "Id","Type","Path" FROM "BaseItems" WHERE lower(replace("Id",\'-\',\'\'))=?').get(rootKey.toLowerCase());
      if (userRoot) { assert.equal(userRoot.Type, editHttpNativeTypes.UserRootFolder); observed.UserRootFolder = userRoot.Id; }
      await writeFile(path.join(root, 'discovery.json'), json({ response: discovery, observed, existingUserRoot: userRoot ?? null,
        materializeDiscoveredRootInStoppedSeed: true, process: discoveryProcess }), { flag: 'wx' });
    } finally { database.close(); }
    const input = internalEditHttpInput(referenceRoot, observed);
    await mkdir(input.mediaPath, { recursive: true });
    await seed(referenceRoot, input);
    await cp(referenceRoot, initialRoot, { recursive: true });
    await cp(input.mediaPath, initialMediaRoot, { recursive: true });
    const records = [], stages = [], interval = { startedAt: new Date().toISOString() };
    const process = current.start({ referenceRoot, outputRoot: root, label: 'reference', origin });
    let before, afterShutdown, executionError, processOutcome;
    try {
      await process.ready(); before = await nativeSnapshot(referenceRoot, input);
      for (const testCase of input.cases) {
        const window = { startedAt: new Date().toISOString() };
        const response = await request(`/Items/${testCase.itemId}`, { method: 'POST', body: testCase.body });
        window.finishedAt = new Date().toISOString();
        records.push({ name: testCase.name, response });
        stages.push({ name: testCase.name, window, ...await nativeSnapshot(referenceRoot, input) });
        assert.equal(response.status, 204, `${testCase.name}: ${response.bodyText}`);
      }
    } catch (error) { executionError = error; }
    finally {
      processOutcome = await process.stop(async () => (await request('/System/Shutdown', { method: 'POST' })).status, () => available(port));
      afterShutdown = await nativeSnapshot(referenceRoot, input); interval.finishedAt = new Date().toISOString();
    }
    await writeFile(path.join(root, 'native-http.json'), json({ discovery, observed, records }), { flag: 'wx' });
    await writeFile(path.join(root, 'native-stages.json'), json({ before, stages, afterShutdown, interval }), { flag: 'wx' });
    const summary = { passed: !executionError && records.length === input.cases.length && processOutcome.cleanShutdown
      && processOutcome.code === 0 && processOutcome.pidGone && processOutcome.portAvailable,
      records: records.length, process: processOutcome, discoveryProcess,
      error: executionError ? { message: executionError.message, stack: executionError.stack } : null };
    await writeFile(path.join(root, 'summary.json'), json(summary), { flag: 'wx' });
    if (executionError) throw executionError;
    assert.ok(summary.passed);
    assert.ok(path.relative(root, referenceRoot) === 'reference' && path.relative(root, initialRoot) === 'initial');
    await rm(referenceRoot, { recursive: true });
    await cp(initialRoot, referenceRoot, { recursive: true });
    assert.equal(path.relative(root, input.mediaPath), 'media');
    assert.equal(path.relative(root, initialMediaRoot), 'initial-media');
    await rm(input.mediaPath, { recursive: true });
    await cp(initialMediaRoot, input.mediaPath, { recursive: true });
    const candidate = await compareCandidate({ current, referenceRoot, input, native: { before, stages, afterShutdown, records } });
    await writeFile(path.join(root, 'candidate.json'), json(candidate), { flag: 'wx' });
    await current.finish();
    await writeFile(path.join(root, 'provenance.json'), json({ preparation: current.preparation,
      recorder: { path: fileURLToPath(import.meta.url), sha256: digest(await readFile(fileURLToPath(import.meta.url))) },
      inputSha256: digest(editHttpInputBytes), sourceBindings: await current.sourceBindings(['Jellyfin.Api/Controllers/ItemUpdateController.cs',
        'MediaBrowser.Controller/Entities/Folder.cs', 'MediaBrowser.Controller/Entities/CollectionFolder.cs',
        'MediaBrowser.Controller/Entities/AggregateFolder.cs', 'MediaBrowser.LocalMetadata/Savers/PlaylistXmlSaver.cs',
        'MediaBrowser.LocalMetadata/Parsers/BaseItemXmlParser.cs', 'MediaBrowser.XbmcMetadata/Parsers/BaseNfoParser.cs',
        'MediaBrowser.XbmcMetadata/Parsers/MovieNfoParser.cs', 'Jellyfin.Server.Implementations/Item/BaseItemMapper.cs']),
      samePhysicalPaths: true, candidateInitialStateReset: true, artifacts: [] }), { flag: 'wx' });
    return { root: destination, input, native: { before, stages, afterShutdown, records }, candidate };
  } catch (error) {
    failure = error;
    if (existsSync(root)) await writeFile(path.join(root, 'error.json'), json({ name: error.name, message: error.message, stack: error.stack }), { flag: 'wx' });
  }
  finally { await output.publishAndClose(); }
  throw output.publicError(failure);
}
