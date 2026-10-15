import { validationExecutable, validationOutputRoot, validationPath } from '../validation/paths.js';
import { captureFilterReferencePreparation } from './filter-reference-inputs.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [outputArgument, portArgument, modeArgument = 'main'] = process.argv.slice(2);
const modes = new Set(['main', 'discover']);
if (!outputArgument || !portArgument || !modes.has(modeArgument)) {
  throw new Error('Usage: node tools/compat/record-album-filters.js <new-evidence-directory> <preferred-loopback-port> [main|discover]');
}

const outputRoot = validationPath(path.resolve(repoRoot, outputArgument));
const allowedRoot = validationOutputRoot();
if (outputRoot === allowedRoot || !outputRoot.startsWith(allowedRoot + path.sep)) {
  throw new Error('The evidence directory must be a new child of the configured validation output root.');
}
if (existsSync(outputRoot)) throw new Error(`Evidence directory already exists: ${outputRoot}`);

const preferredPort = Number(portArgument);
if (!Number.isInteger(preferredPort) || preferredPort < 1024 || preferredPort > 65535) {
  throw new Error('The preferred loopback port must be an integer from 1024 through 65535.');
}

const sourceRoot = validationPath(path.join(repoRoot, '.agent-docs/evidence/core-flow-20260926/reference'));
const sourceDatabase = validationPath(path.join(repoRoot, '.agent-docs/evidence/core-flow-20260926/initial.db'));
const referenceRoot = path.join(outputRoot, 'reference');
const databasePath = path.join(referenceRoot, 'data/data/jellyfin.db');
const filesystemDomainPaths = {
  userViews: path.join(referenceRoot, 'data/root/default'),
  metadata: path.join(referenceRoot, 'data/metadata'),
  physicalLibrary: path.join(referenceRoot, 'library-content/Album Filter Physical Root'),
  physicalLibrarySecondary: path.join(referenceRoot, 'library-content/Album Filter Secondary Root')
};
const physicalAnchorPath = path.join(filesystemDomainPaths.physicalLibrary, 'Native Anchor');
const secondaryAnchorPath = path.join(filesystemDomainPaths.physicalLibrarySecondary, 'Native Anchor');
const fixtureInputPath = validationPath(path.join(repoRoot, 'tests/library/fixtures/album-filters/input.json'));
const recorderPath = fileURLToPath(import.meta.url);
const dotnetPath = validationExecutable('dotnet');
const frozenSourceRoot = validationPath(path.join(repoRoot, '.agent-docs/baselines/jellyfin-current/source'));
const runtimeRoot = path.join(frozenSourceRoot, 'Jellyfin.Server/bin/Release/net10.0');
const jellyfinDll = path.join(runtimeRoot, 'jellyfin.dll');
const libraryName = 'Album Filter Library';
const deviceId = 'album-filter-native-oracle';
const password = 'isolated-core-flow-password';
const apiKeyToken = 'albumfilterapikey000000000000000';
const fixture = JSON.parse(await readFile(fixtureInputPath, 'utf8'));
const itemByKey = new Map(fixture.items.map(item => [item.key, item]));
const keyById = new Map(fixture.items.map(item => [String(item.id).replaceAll('-', '').toLowerCase(), item.key]));
const resolvedIdByFixtureId = new Map(fixture.items.map(item => [String(item.id).replaceAll('-', '').toLowerCase(), item.id]));

const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2) + '\n';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const idKey = value => String(value).replaceAll('-', '').toLowerCase();
const upperId = value => String(value).toUpperCase();
const resolvedId = value => resolvedIdByFixtureId.get(idKey(value)) ?? value;
const normalizePath = value => path.resolve(String(value)).replaceAll('\\', '/').toLowerCase();

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

const sha256Text = value => createHash('sha256').update(value).digest('hex');

async function walk(directory) {
  const files = [];
  if (!existsSync(directory)) return files;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(file));
    else files.push(file);
  }
  return files;
}

async function fileManifest(directory) {
  const entries = [];
  for (const file of (await walk(directory)).sort((left, right) => left.localeCompare(right))) {
    const info = await stat(file);
    entries.push({
      path: path.relative(directory, file).replaceAll('\\', '/'),
      size: info.size,
      sha256: await sha256(file)
    });
  }
  return {
    schemaVersion: 1,
    root: path.relative(repoRoot, directory).replaceAll('\\', '/'),
    fileCount: entries.length,
    dllCount: entries.filter(entry => entry.path.toLowerCase().endsWith('.dll')).length,
    depsJsonCount: entries.filter(entry => entry.path.toLowerCase().endsWith('.deps.json')).length,
    runtimeConfigCount: entries.filter(entry => entry.path.toLowerCase().endsWith('.runtimeconfig.json')).length,
    entriesSha256: sha256Text(JSON.stringify(entries)),
    entries
  };
}

async function treeSnapshot(directory) {
  if (!existsSync(directory)) return { exists: false, entries: [] };
  const entries = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      const relative = path.relative(directory, target).replaceAll('\\', '/');
      if (entry.isDirectory()) {
        entries.push({ path: relative, type: 'directory' });
        await visit(target);
      } else {
        const info = await stat(target);
        entries.push({ path: relative, type: 'file', size: info.size, sha256: await sha256(target) });
      }
    }
  }
  await visit(directory);
  return { exists: true, entries: entries.sort((left, right) => left.path.localeCompare(right.path)) };
}

async function filesystemDomainSnapshot() {
  return Object.fromEntries(await Promise.all(Object.entries(filesystemDomainPaths)
    .map(async ([name, directory]) => [name, await treeSnapshot(directory)])));
}

async function available(localPort) {
  return await new Promise(resolve => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port: localPort, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

async function choosePort(start) {
  for (let candidate = start; candidate <= Math.min(65535, start + 100); candidate++) {
    if (await available(candidate)) return candidate;
  }
  throw new Error(`No free loopback port was found from ${start} through ${Math.min(65535, start + 100)}.`);
}

const preferredPortInitiallyAvailable = await available(preferredPort);
const port = preferredPortInitiallyAvailable ? preferredPort : await choosePort(preferredPort + 1);
const portInitiallyAvailable = await available(port);
assert.equal(portInitiallyAvailable, true, `Selected port ${port} is already in use.`);
const origin = `http://127.0.0.1:${port}`;

async function prepareReference() {
  await mkdir(outputRoot);
  await cp(sourceRoot, referenceRoot, {
    recursive: true,
    filter(source) {
      const relative = path.relative(sourceRoot, source).replaceAll('\\', '/');
      if (relative.startsWith('log/')) return false;
      return !/^data\/data\/jellyfin\.db(?:-wal|-shm)?$/u.test(relative);
    }
  });
  await mkdir(path.join(referenceRoot, 'log'), { recursive: true });
  await mkdir(filesystemDomainPaths.physicalLibrary, { recursive: true });
  await mkdir(physicalAnchorPath, { recursive: true });
  await mkdir(filesystemDomainPaths.physicalLibrarySecondary, { recursive: true });
  await mkdir(secondaryAnchorPath, { recursive: true });
  await cp(sourceDatabase, databasePath, { force: false, errorOnExist: true });

  const sourceForms = [sourceRoot, sourceRoot.replaceAll('\\', '/'), sourceRoot.replaceAll('\\', '\\\\')];
  for (const file of await walk(referenceRoot)) {
    if (!/\.(?:json|xml)$/u.test(file)) continue;
    let text = await readFile(file, 'utf8');
    for (const source of sourceForms) text = text.replaceAll(source, referenceRoot);
    if (path.basename(file).toLowerCase() === 'network.xml') {
      text = text.replace(/<(InternalHttpPort|PublicHttpPort)>\d+<\/\1>/gu, (_match, name) => `<${name}>${port}</${name}>`);
      text = text.replace(/<AutoDiscovery>true<\/AutoDiscovery>/gu, '<AutoDiscovery>false</AutoDiscovery>');
    }
    await writeFile(file, text, { flag: 'w' });
  }
}

const quoteSqlIdentifier = value => `"${String(value).replaceAll('"', '""')}"`;

function databaseSnapshot() {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tableNames = database.prepare(`SELECT "name" FROM "sqlite_master"
      WHERE "type" = 'table' ORDER BY "name"`).all().map(row => row.name);
    const tables = {};
    const rowCounts = {};
    for (const table of tableNames) {
      const columns = database.prepare(`PRAGMA table_info(${quoteSqlIdentifier(table)})`).all();
      const primaryKeys = columns.filter(column => column.pk > 0)
        .sort((left, right) => left.pk - right.pk).map(column => column.name);
      const orderColumns = primaryKeys.length > 0 ? primaryKeys : columns.map(column => column.name);
      const orderBy = orderColumns.length > 0 ? ` ORDER BY ${orderColumns.map(quoteSqlIdentifier).join(', ')}` : '';
      tables[table] = database.prepare(`SELECT * FROM ${quoteSqlIdentifier(table)}${orderBy}`).all()
        .map(row => ({ ...row }));
      rowCounts[table] = tables[table].length;
    }
    return {
      scope: { rowSelection: 'all rows', tables: tableNames },
      rowCounts,
      tables,
      foreignKeyCheck: database.prepare('PRAGMA foreign_key_check').all().map(row => ({ ...row }))
    };
  } finally {
    database.close();
  }
}

async function waitForSnapshotQuiescence({
  ready = () => true, stableSamples = 3, intervalMilliseconds = 250, maxAttempts = 40
} = {}) {
  let previousDatabase;
  let previousFilesystem;
  let consecutiveStableSamples = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await delay(intervalMilliseconds);
    const database = databaseSnapshot();
    const filesystem = await filesystemDomainSnapshot();
    if (ready(database, filesystem)
      && previousDatabase !== undefined
      && JSON.stringify(database) === JSON.stringify(previousDatabase)
      && JSON.stringify(filesystem) === JSON.stringify(previousFilesystem)) {
      consecutiveStableSamples++;
    } else if (ready(database, filesystem)) {
      consecutiveStableSamples = 1;
    } else {
      consecutiveStableSamples = 0;
    }
    previousDatabase = database;
    previousFilesystem = filesystem;
    if (consecutiveStableSamples >= stableSamples) {
      return { database, filesystem, attempts: attempt, stableSamples, intervalMilliseconds };
    }
  }
  throw new Error(`Native state did not become quiescent after ${maxAttempts * intervalMilliseconds}ms.`);
}

function playlistUserViewRefreshCompleted(before, current) {
  const beforeIds = new Set(before.tables.BaseItems.map(row => idKey(row.Id)));
  const addedRows = current.tables.BaseItems.filter(row => !beforeIds.has(idKey(row.Id)));
  if (addedRows.length !== 1 || addedRows[0].Type !== 'MediaBrowser.Controller.Entities.UserView') return false;
  const row = addedRows[0];
  if (typeof row.DateLastRefreshed !== 'string' || typeof row.DateLastSaved !== 'string') return false;
  let data;
  try {
    data = JSON.parse(row.Data);
  } catch {
    return false;
  }
  return typeof data.DateLastSaved === 'string'
    && data.DateLastSaved === `${row.DateLastSaved.replace(' ', 'T')}Z`
    && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{7}$/u.test(row.DateLastRefreshed)
    && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{7}$/u.test(row.DateLastSaved);
}

function verifyPlaylistUserViewDatabaseDelta(before, after) {
  assert.deepEqual(after.scope, before.scope, 'The expected UserView creation must not change database snapshot scope.');
  assert.deepEqual(after.foreignKeyCheck, [], 'The database must remain foreign-key clean after UserView creation.');
  assert.deepEqual(before.foreignKeyCheck, []);
  assert.deepEqual(Object.keys(after.tables), Object.keys(before.tables));
  for (const table of Object.keys(before.tables)) {
    if (table !== 'BaseItems') {
      assert.deepEqual(after.tables[table], before.tables[table],
        `The expected UserView creation must not mutate ${table}.`);
      assert.equal(after.rowCounts[table], before.rowCounts[table], table);
    }
  }

  const beforeRows = before.tables.BaseItems;
  const afterRows = after.tables.BaseItems;
  const beforeIds = new Set(beforeRows.map(row => idKey(row.Id)));
  const addedRows = afterRows.filter(row => !beforeIds.has(idKey(row.Id)));
  const addedIds = new Set(addedRows.map(row => idKey(row.Id)));
  assert.equal(addedRows.length, 1, 'The native read may create exactly one BaseItems row.');
  assert.deepEqual(afterRows.filter(row => !addedIds.has(idKey(row.Id))), beforeRows,
    'All pre-existing BaseItems rows must remain byte-for-byte stable.');
  assert.equal(after.rowCounts.BaseItems, before.rowCounts.BaseItems + 1);

  const row = addedRows[0];
  const dynamicId = idKey(row.Id);
  assert.match(dynamicId, /^[0-9a-f]{32}$/u);
  assert.equal(row.Type, 'MediaBrowser.Controller.Entities.UserView');
  assert.equal(row.Name, 'Playlists');
  assert.equal(row.CleanName, 'playlists');
  assert.equal(row.SortName, 'playlists');
  assert.equal(row.ParentId, null);
  assert.equal(row.TopParentId, null);
  assert.equal(row.IsFolder, 1);
  assert.equal(row.MediaType, 'Unknown');
  assert.equal(row.Path, `%MetadataPath%\\views\\${dynamicId}`);
  assert.equal(row.PresentationUniqueKey, dynamicId);
  const data = JSON.parse(row.Data);
  assert.deepEqual(Object.keys(data).sort(), [
    'DateLastSaved', 'DisplayParentId', 'Height', 'IsHD', 'IsRoot', 'IsShortcut', 'RemoteTrailers', 'UserId',
    'ViewType', 'Width'
  ].sort());
  assert.equal(data.ViewType, 'playlists');
  assert.equal(idKey(data.DisplayParentId), idKey(nativeGraph.playlistsRoot.Id));
  assert.equal(idKey(data.UserId), idKey(fixture.userId));
  assert.equal(data.IsRoot, false);
  assert.equal(data.IsHD, false);
  assert.equal(data.IsShortcut, false);
  assert.equal(data.Width, 0);
  assert.equal(data.Height, 0);
  assert.deepEqual(data.RemoteTrailers, []);
  assert.equal(Number.isNaN(Date.parse(data.DateLastSaved)), false);
  assert.match(row.DateLastRefreshed, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{7}$/u);
  assert.match(row.DateLastSaved, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{7}$/u);
  assert.equal(data.DateLastSaved, `${row.DateLastSaved.replace(' ', 'T')}Z`);
  return { dynamicId, row };
}

function verifyPlaylistUserViewFilesystemDelta(before, after, dynamicId) {
  assert.deepEqual(Object.keys(after), Object.keys(before));
  for (const domain of Object.keys(before)) {
    if (domain !== 'metadata') {
      assert.deepEqual(after[domain], before[domain],
        `The expected UserView creation must not mutate the ${domain} filesystem domain.`);
    }
  }
  assert.equal(before.metadata.exists, after.metadata.exists);
  const beforeByPath = new Map(before.metadata.entries.map(entry => [entry.path, entry]));
  const afterByPath = new Map(after.metadata.entries.map(entry => [entry.path, entry]));
  const added = after.metadata.entries.filter(entry => !beforeByPath.has(entry.path));
  const removed = before.metadata.entries.filter(entry => !afterByPath.has(entry.path));
  const preservedAfter = after.metadata.entries.filter(entry => beforeByPath.has(entry.path));
  assert.deepEqual(preservedAfter, before.metadata.entries, 'Existing metadata entries must remain byte-for-byte stable.');
  assert.deepEqual(removed, [], 'The native read must not remove metadata entries.');
  assert.deepEqual(added, [
    { path: 'views', type: 'directory' },
    { path: `views/${dynamicId}`, type: 'directory' }
  ], 'The native read may create only the UserView metadata directories.');
}

function assertSeedIdentifiersAbsent() {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(database.prepare(`SELECT COUNT(*) AS "Count" FROM "BaseItems" WHERE "Id" LIKE '74000000-%'`).get().Count, 0);
    assert.equal(database.prepare(`SELECT COUNT(*) AS "Count" FROM "ApiKeys" WHERE "AccessToken" = ?`).get(apiKeyToken).Count, 0);
  } finally {
    database.close();
  }
}

function seedDatabase() {
  const database = new DatabaseSync(databasePath);
  const templateDatabase = new DatabaseSync(sourceDatabase, { readOnly: true });
  try {
    const folderTemplate = templateDatabase.prepare('SELECT * FROM "BaseItems" WHERE "Id" = ?').get('11111111-1111-1111-1111-111111111111');
    const movieTemplate = templateDatabase.prepare('SELECT * FROM "BaseItems" WHERE "Id" = ?').get('22222222-2222-2222-2222-222222222222');
    const aggregate = database.prepare(`SELECT "Id" FROM "BaseItems"
      WHERE "Type" = 'MediaBrowser.Controller.Entities.AggregateFolder' LIMIT 1`).get();
    assert.ok(folderTemplate && movieTemplate && aggregate, 'The frozen core-flow templates are required.');
    const typeNames = {
      Folder: 'MediaBrowser.Controller.Entities.Folder',
      Movie: 'MediaBrowser.Controller.Entities.Movies.Movie',
      MusicAlbum: 'MediaBrowser.Controller.Entities.Audio.MusicAlbum',
      Playlist: 'MediaBrowser.Controller.Playlists.Playlist'
    };
    const fixedDate = '2026-09-28 02:00:00';
    const seedItems = fixture.items.filter(item => !item.nativeExisting && !item.nativeManaged);
    const inputById = new Map(fixture.items.map(item => [idKey(item.id), item]));
    const ancestors = item => {
      const values = [];
      if (Array.isArray(item.ancestorIds)) values.push(...item.ancestorIds);
      else if (!(Object.hasOwn(item, 'parentId') && item.parentId === null)) {
        let parentId = item.parentId;
        while (parentId) {
          values.push(parentId);
          parentId = inputById.get(idKey(parentId))?.parentId;
        }
        values.push(aggregate.Id);
      }
      return [...new Set(values.map(value => upperId(resolvedId(value))))];
    };

    database.exec('BEGIN IMMEDIATE');
    try {
      for (const item of seedItems) {
        const isFolder = item.isFolder ?? ['Folder', 'MusicAlbum', 'Playlist'].includes(item.type);
        const isMovie = item.type === 'Movie';
        const row = {
          ...(isFolder ? folderTemplate : movieTemplate),
          Id: upperId(resolvedId(item.id)),
          Type: typeNames[item.type],
          ParentId: Object.hasOwn(item, 'parentId') && item.parentId === null
            ? null : upperId(resolvedId(item.parentId ?? aggregate.Id)),
          TopParentId: Object.hasOwn(item, 'topParentId') && item.topParentId === null
            ? null : upperId(resolvedId(item.topParentId ?? fixture.rootId)),
          PrimaryVersionId: item.primaryVersionId ? upperId(resolvedId(item.primaryVersionId)) : null,
          OwnerId: item.ownerId ? upperId(resolvedId(item.ownerId)) : null,
          Name: item.name,
          CleanName: item.cleanName ?? item.name.toLowerCase(),
          SortName: item.sortName ?? (item.cleanName ?? item.name.toLowerCase()),
          Path: item.pathKind === 'sharedPlaylist'
            ? path.join(referenceRoot, 'data', 'data', 'playlists', item.key)
            : `Z:\\AlbumFilterOracle\\${item.key}${isFolder ? '' : '.mkv'}`,
          ProductionYear: item.productionYear ?? null,
          ExtraType: item.extraType ?? null,
          IsFolder: isFolder ? 1 : 0,
          IsMovie: isMovie ? 1 : 0,
          MediaType: item.mediaType ?? (isMovie ? 'Video' : 'Unknown'),
          UnratedType: isMovie ? 'Movie' : item.type === 'MusicAlbum' ? 'Music' : 'Other',
          PresentationUniqueKey: item.presentationUniqueKey ?? `album-filter-oracle-${idKey(item.primaryVersionId ?? item.id)}`,
          Width: item.width ?? 0,
          Height: item.height ?? 0,
          DateCreated: fixedDate,
          DateModified: fixedDate,
          DateLastSaved: fixedDate,
          Data: item.dataText ?? JSON.stringify(item.data ?? (isMovie
            ? { VideoType: 'VideoFile', IsHD: (item.width ?? 0) >= 1200, IsShortcut: false, RemoteTrailers: [] }
            : {}))
        };
        const columns = Object.keys(row);
        database.prepare(`INSERT INTO "BaseItems" (${columns.map(quoteSqlIdentifier).join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
          .run(...columns.map(name => row[name]));
        for (const parentId of ancestors(item)) {
          database.prepare('INSERT INTO "AncestorIds" ("ItemId", "ParentItemId") VALUES (?, ?)').run(row.Id, parentId);
        }
      }

      for (const link of fixture.links) {
        database.prepare(`INSERT INTO "LinkedChildren" ("ParentId", "SortOrder", "ChildId", "ChildType") VALUES (?, ?, ?, ?)`)
          .run(upperId(resolvedId(link.parentId)), link.sortOrder, upperId(resolvedId(link.childId)), link.childType);
      }
      database.prepare(`INSERT INTO "ApiKeys" ("DateCreated", "DateLastActivity", "Name", "AccessToken") VALUES (?, ?, ?, ?)`).run(
        fixedDate, fixedDate, 'Album Filter Native Oracle', apiKeyToken);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  } finally {
    templateDatabase.close();
    database.close();
  }
}

function authorization(token) {
  return `MediaBrowser Client="AlbumFilterNativeOracle", Device="Isolated", DeviceId="${deviceId}", Version="1"${token ? `, Token="${token}"` : ''}`;
}

const processArguments = [
  jellyfinDll,
  '--datadir', path.join(referenceRoot, 'data'),
  '--configdir', path.join(referenceRoot, 'config'),
  '--cachedir', path.join(referenceRoot, 'cache'),
  '--logdir', path.join(referenceRoot, 'log'),
  '--nowebclient'
];

function startReference(label) {
  const stdoutPath = path.join(outputRoot, `${label}-stdout.log`);
  const stderrPath = path.join(outputRoot, `${label}-stderr.log`);
  const stdoutDescriptor = openSync(stdoutPath, 'wx');
  const stderrDescriptor = openSync(stderrPath, 'wx');
  const child = spawn(dotnetPath, processArguments, {
    cwd: repoRoot,
    windowsHide: true,
    stdio: ['ignore', stdoutDescriptor, stderrDescriptor]
  });
  let spawnError;
  const completion = new Promise(resolve => {
    child.once('error', error => {
      spawnError = error;
      resolve({ code: null, signal: null, error: { name: error.name, message: error.message } });
    });
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { label, child, completion, get spawnError() { return spawnError; }, stdoutDescriptor, stderrDescriptor };
}

async function waitForReady(instance) {
  let consecutiveSuccesses = 0;
  for (let attempt = 0; attempt < 90; attempt++) {
    if (instance.spawnError) throw instance.spawnError;
    if (instance.child.exitCode !== null) {
      throw new Error(`${instance.label} reference exited before readiness with code ${instance.child.exitCode}.`);
    }
    try {
      const response = await fetch(`${origin}/System/Info/Public`, { signal: AbortSignal.timeout(1_000) });
      consecutiveSuccesses = response.ok ? consecutiveSuccesses + 1 : 0;
      if (consecutiveSuccesses >= 3) return;
    } catch {
      consecutiveSuccesses = 0;
    }
    await delay(500);
  }
  throw new Error(`${instance.label} reference did not become ready within 45 seconds.`);
}

async function request(records, name, route, { method = 'GET', token, body } = {}) {
  const headers = { Accept: 'application/json', Authorization: authorization(token) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(origin + route, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000)
  });
  const bodyText = await response.text();
  let bodyJson;
  try {
    bodyJson = bodyText === '' ? null : JSON.parse(bodyText);
  } catch {
    bodyJson = undefined;
  }
  const result = {
    status: response.status,
    headers: Object.fromEntries([...response.headers.entries()].sort(([left], [right]) => left.localeCompare(right))),
    bodyText,
    ...(bodyJson === undefined ? {} : { bodyJson })
  };
  records.push({
    name,
    request: {
      method,
      route,
      headers: { ...headers, Authorization: authorization(token ? '<token>' : undefined) },
      body: body ?? null
    },
    response: result
  });
  return result;
}

async function stopReference(instance, token, records) {
  const lifecycle = [];
  let cleanShutdown = false;
  let stopError;
  let result;
  if (instance.child.exitCode === null && token) {
    try {
      const shutdown = await request(records, `${instance.label}-authenticated-shutdown`, '/System/Shutdown', {
        method: 'POST', token
      });
      cleanShutdown = shutdown.status === 204;
    } catch (error) {
      stopError = error;
    }
  }
  if (instance.child.exitCode === null) {
    result = await Promise.race([instance.completion, delay(20_000).then(() => null)]);
    lifecycle.push({ action: 'wait-after-shutdown', timeoutMilliseconds: 20_000, completed: result !== null });
    if (result === null) {
      const accepted = instance.child.kill();
      lifecycle.push({ action: 'child-kill', accepted });
      result = await Promise.race([instance.completion, delay(10_000).then(() => null)]);
      lifecycle.push({ action: 'wait-after-child-kill', timeoutMilliseconds: 10_000, completed: result !== null });
    }
    if (result === null && instance.child.pid) {
      const forced = spawnSync('taskkill', ['/PID', String(instance.child.pid), '/T', '/F'], {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000
      });
      lifecycle.push({
        action: 'taskkill-exact-process-tree',
        pid: instance.child.pid,
        exitCode: forced.status,
        signal: forced.signal,
        stdout: forced.stdout,
        stderr: forced.stderr,
        error: forced.error ? { name: forced.error.name, message: forced.error.message } : null
      });
      result = await Promise.race([instance.completion, delay(10_000).then(() => null)]);
      lifecycle.push({ action: 'wait-after-taskkill', timeoutMilliseconds: 10_000, completed: result !== null });
    }
  } else {
    result = await instance.completion;
  }
  result ??= { code: null, signal: null, timedOut: true };
  for (const descriptor of [instance.stdoutDescriptor, instance.stderrDescriptor]) {
    try {
      closeSync(descriptor);
    } catch (error) {
      stopError ??= error;
    }
  }
  return {
    pid: instance.child.pid,
    ...result,
    cleanShutdown,
    lifecycle,
    portAvailable: await available(port),
    error: stopError ? { name: stopError.name, message: stopError.message } : null
  };
}

function resolveNativeGraph(virtualFolders) {
  assert.ok(Array.isArray(virtualFolders), 'GET /Library/VirtualFolders must return an array.');
  const virtualFolder = virtualFolders.find(entry => entry.Name === libraryName);
  assert.ok(virtualFolder, `The native ${libraryName} virtual folder must be discoverable.`);
  assert.ok(virtualFolder.ItemId, 'The native virtual folder must expose ItemId.');
  assert.ok(Array.isArray(virtualFolder.Locations)
    && [filesystemDomainPaths.physicalLibrarySecondary, filesystemDomainPaths.physicalLibrary]
      .every(requested => virtualFolder.Locations.some(location => normalizePath(location) === normalizePath(requested))),
  'The native virtual folder must expose both requested physical locations.');

  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database.prepare('SELECT "Id", "Type", "Name", "ParentId", "TopParentId", "Path", "Data" FROM "BaseItems"').all();
    const byId = new Map(rows.map(row => [idKey(row.Id), row]));
    const collection = byId.get(idKey(virtualFolder.ItemId));
    assert.ok(collection, `Virtual folder ItemId ${virtualFolder.ItemId} must exist in BaseItems.`);
    assert.equal(collection.Type, 'MediaBrowser.Controller.Entities.CollectionFolder');
    assert.equal(collection.Name, libraryName);
    const collectionData = JSON.parse(collection.Data ?? '{}');
    assert.ok(Array.isArray(collectionData.PhysicalFolderIds), 'CollectionFolder Data must expose PhysicalFolderIds.');
    assert.equal(collectionData.PhysicalFolderIds.length, 2,
      'The native collection must map both physical folders for this ordering oracle.');
    const physicalFolders = collectionData.PhysicalFolderIds.map(id => byId.get(idKey(id)));
    assert.ok(physicalFolders.every(Boolean), 'Each PhysicalFolderId must resolve to a persisted BaseItems row.');
    assert.ok(physicalFolders.every(row => row.Type === 'MediaBrowser.Controller.Entities.Folder'));
    const physical = physicalFolders.find(row => normalizePath(row.Path) === normalizePath(filesystemDomainPaths.physicalLibrary));
    const physicalSecondary = physicalFolders.find(row => normalizePath(row.Path) === normalizePath(filesystemDomainPaths.physicalLibrarySecondary));
    assert.ok(physical && physicalSecondary, 'Both requested physical folders must be present.');
    assert.deepEqual(physicalFolders.map(row => idKey(row.Id)), [physical, physicalSecondary].map(row => idKey(row.Id)),
      'PhysicalFolderIds must match the observed persisted path order.');
    assert.equal(normalizePath(physical.Path), normalizePath(filesystemDomainPaths.physicalLibrary));
    const userRoot = byId.get(idKey(collection.ParentId));
    assert.ok(userRoot, 'CollectionFolder ParentId must resolve to a persisted UserRootFolder.');
    assert.equal(userRoot.Type, 'MediaBrowser.Controller.Entities.UserRootFolder');
    const aggregate = rows.find(row => row.Type === 'MediaBrowser.Controller.Entities.AggregateFolder');
    assert.ok(aggregate, 'The native AggregateFolder must remain persisted.');
    const playlists = byId.get(idKey(itemByKey.get('playlistsRoot').id));
    assert.ok(playlists, 'The frozen native PlaylistsFolder must remain persisted.');
    assert.equal(playlists.Type, 'Emby.Server.Implementations.Playlists.PlaylistsFolder');
    assert.equal(idKey(physical.ParentId), idKey(aggregate.Id), 'Physical folder must be an AggregateFolder child.');
    assert.equal(idKey(physicalSecondary.ParentId), idKey(aggregate.Id), 'Secondary physical folder must be an AggregateFolder child.');
    assert.equal(idKey(playlists.ParentId), idKey(aggregate.Id), 'Playlists folder must be an AggregateFolder child.');
    assert.equal(idKey(collection.ParentId), idKey(userRoot.Id), 'CollectionFolder must be a UserRootFolder child.');

    const graph = {
      aggregateRoot: aggregate,
      playlistsRoot: playlists,
      userRoot,
      collectionView: collection,
      physicalRoot: physical,
      physicalSecondary,
      virtualFolder: {
        name: virtualFolder.Name,
        itemId: virtualFolder.ItemId,
        locations: virtualFolder.Locations,
        collectionType: virtualFolder.CollectionType ?? null
      },
      collectionPhysicalFolderIds: collectionData.PhysicalFolderIds
    };
    for (const key of ['aggregateRoot', 'playlistsRoot', 'userRoot', 'collectionView', 'physicalRoot', 'physicalSecondary']) {
      const fixtureItem = itemByKey.get(key);
      const actual = graph[key];
      assert.ok(fixtureItem && actual);
      resolvedIdByFixtureId.set(idKey(fixtureItem.id), actual.Id);
      keyById.set(idKey(actual.Id), key);
    }
    return graph;
  } finally {
    database.close();
  }
}

function responseContract(response) {
  const responseItems = Array.isArray(response.bodyJson?.Items) ? response.bodyJson.Items : [];
  const orderedKeys = responseItems.map(item => {
    const key = keyById.get(idKey(item.Id));
    assert.ok(key, `Native response returned unmapped item id ${item.Id}.`);
    return key;
  });
  return {
    frozen: {
      status: response.status,
      contentType: response.headers['content-type'] ?? null,
      startIndex: response.bodyJson?.StartIndex ?? null,
      totalRecordCount: response.bodyJson?.TotalRecordCount ?? null,
      keys: [...orderedKeys].sort(),
      orderedKeys,
      items: responseItems.map(item => ({
        key: keyById.get(idKey(item.Id)),
        name: item.Name,
        type: item.Type,
        parentKey: item.ParentId ? (keyById.get(idKey(item.ParentId)) ?? null) : null
      })),
      problem: response.status >= 400
        ? response.bodyJson && typeof response.bodyJson === 'object'
          ? Object.fromEntries(Object.entries(response.bodyJson).filter(([key]) => key !== 'traceId'))
          : { rawBody: response.bodyText }
        : null
    }
  };
}

function routeFor(endpoint, testCase) {
  const parentItem = testCase.parentKey ? itemByKey.get(testCase.parentKey) : null;
  if (testCase.parentKey) assert.ok(parentItem, `Unknown fixture parent key: ${testCase.parentKey}`);
  const parentId = resolvedId(parentItem?.id ?? fixture.rootId);
  const scopeIds = (testCase.scope ?? []).map(key => {
    const item = itemByKey.get(key);
    assert.ok(item, `Unknown fixture scope key: ${key}`);
    return resolvedId(item.id);
  }).join(',');
  const recursive = Object.hasOwn(testCase, 'recursive') ? testCase.recursive : true;
  const parts = [
    ...(!testCase.omitParentId && !testCase.omitScope ? [`ParentId=${encodeURIComponent(parentId)}`] : []),
    ...(recursive === null || testCase.omitScope ? [] : [`Recursive=${recursive}`]),
    ...(!testCase.omitIds && !testCase.omitScope ? [`Ids=${encodeURIComponent(scopeIds)}`] : []),
    ...(!testCase.omitSortBy ? ['SortBy=SortName'] : []),
    'Fields=ParentId',
    'EnableImages=false',
    'EnableUserData=false',
    testCase.query
  ];
  const prefix = endpoint === 'items' ? '/Items' : `/Users/${fixture.userId}/Items`;
  return `${prefix}?${parts.filter(Boolean).join('&')}`;
}

// Pinned only after complete discovery runs established these native results.
const expected = {
  'album-ids-match-only-direct-parent': { keys: ['alphaDirectA', 'alphaDirectFolder'], orderedKeys: ['alphaDirectA', 'alphaDirectFolder'], totalRecordCount: 2, startIndex: 0 },
  'album-ids-do-not-require-music-album-parent': { keys: ['nonAlbumChild'], orderedKeys: ['nonAlbumChild'], totalRecordCount: 1, startIndex: 0 },
  'album-ids-single-comma-or': { keys: ['alphaDirectA', 'betaChild'], orderedKeys: ['alphaDirectA', 'betaChild'], totalRecordCount: 2, startIndex: 0 },
  'album-ids-invalid-only-drops-filter': { keys: ['alphaDirectA', 'betaChild'], orderedKeys: ['alphaDirectA', 'betaChild'], totalRecordCount: 2, startIndex: 0 },
  'album-ids-valid-and-invalid-keeps-valid': { keys: ['alphaDirectA'], orderedKeys: ['alphaDirectA'], totalRecordCount: 1, startIndex: 0 },
  'album-ids-repeated-comma-occurrence-is-not-split': { keys: ['betaChild'], orderedKeys: ['betaChild'], totalRecordCount: 1, startIndex: 0 },
  'album-ids-p-format': { keys: ['alphaDirectA'], orderedKeys: ['alphaDirectA'], totalRecordCount: 1, startIndex: 0 },
  'album-ids-n-format': { keys: ['alphaDirectA'], orderedKeys: ['alphaDirectA'], totalRecordCount: 1, startIndex: 0 },
  'album-ids-b-format': { keys: ['alphaDirectA'], orderedKeys: ['alphaDirectA'], totalRecordCount: 1, startIndex: 0 },
  'album-ids-bom-wrapped-guid-is-discarded': { keys: ['alphaDirectA', 'betaChild'], orderedKeys: ['alphaDirectA', 'betaChild'], totalRecordCount: 2, startIndex: 0 },
  'album-ids-single-x-format-is-split-away': { keys: ['alphaDirectA', 'betaChild'], orderedKeys: ['alphaDirectA', 'betaChild'], totalRecordCount: 2, startIndex: 0 },
  'album-ids-repeated-x-format-is-accepted': { keys: ['alphaDirectA', 'betaChild'], orderedKeys: ['alphaDirectA', 'betaChild'], totalRecordCount: 2, startIndex: 0 },
  'album-ids-repeated-x-format-nel-whitespace-is-accepted': { keys: ['alphaDirectA', 'betaChild'], orderedKeys: ['alphaDirectA', 'betaChild'], totalRecordCount: 2, startIndex: 0 },
  'album-ids-repeated-x-format-bom-whitespace-is-rejected': { keys: ['betaChild'], orderedKeys: ['betaChild'], totalRecordCount: 1, startIndex: 0 },
  'albums-name-uses-clean-name': { keys: ['cleanNameChild'], orderedKeys: ['cleanNameChild'], totalRecordCount: 1, startIndex: 0 },
  'albums-duplicate-clean-name-limit-one': { keys: ['duplicateHighChild'], orderedKeys: ['duplicateHighChild'], totalRecordCount: 1, startIndex: 0 },
  'albums-single-pipe-occurrence-splits': { keys: ['alphaDirectA', 'betaChild'], orderedKeys: ['alphaDirectA', 'betaChild'], totalRecordCount: 2, startIndex: 0 },
  'albums-repeated-occurrences-are-values': { keys: ['alphaDirectA', 'betaChild'], orderedKeys: ['alphaDirectA', 'betaChild'], totalRecordCount: 2, startIndex: 0 },
  'albums-repeated-occurrence-keeps-literal-pipe': { keys: ['betaChild', 'literalPipeChild'], orderedKeys: ['betaChild', 'literalPipeChild'], totalRecordCount: 2, startIndex: 0 },
  'albums-empty-preserves-direct-album-ids': { keys: ['alphaDirectA'], orderedKeys: ['alphaDirectA'], totalRecordCount: 1, startIndex: 0 },
  'albums-overwrite-direct-album-ids': { keys: ['betaChild'], orderedKeys: ['betaChild'], totalRecordCount: 1, startIndex: 0 },
  'albums-unknown-overwrites-direct-album-ids-with-empty': { keys: ['alphaDirectA', 'betaChild'], orderedKeys: ['alphaDirectA', 'betaChild'], totalRecordCount: 2, startIndex: 0 },
  'albums-whitespace-selects-global-first-album': { keys: ['whitespaceChild'], orderedKeys: ['whitespaceChild'], totalRecordCount: 1, startIndex: 0 },
  'albums-global-name-resolver-is-not-user-scoped': { keys: ['globalChild'], orderedKeys: ['globalChild'], totalRecordCount: 1, startIndex: 0 },
  'albums-name-resolver-excludes-owned-selector': { keys: ['ownerEligibleChild'], orderedKeys: ['ownerEligibleChild'], totalRecordCount: 1, startIndex: 0 },
  'albums-name-resolver-excludes-hidden-alternate-selector': { keys: ['alternatePrimaryChild'], orderedKeys: ['alternatePrimaryChild'], totalRecordCount: 1, startIndex: 0 },
  'albums-name-resolver-keeps-cross-top-alternate-selector': { keys: ['crossTopAlternateChild'], orderedKeys: ['crossTopAlternateChild'], totalRecordCount: 1, startIndex: 0 },
  'albums-name-resolver-keeps-owned-extra-selector': { keys: ['ownedExtraAlbumChild'], orderedKeys: ['ownedExtraAlbumChild'], totalRecordCount: 1, startIndex: 0 },
  'albums-name-resolver-keeps-parentless-selector': { keys: ['parentlessAlbumChild'], orderedKeys: ['parentlessAlbumChild'], totalRecordCount: 1, startIndex: 0 },
  'albums-bom-name-uses-empty-clean-name-selector': { keys: ['bomEmptyAlbumChild'], orderedKeys: ['bomEmptyAlbumChild'], totalRecordCount: 1, startIndex: 0 },
  'albums-nel-whitespace-selects-global-first-album': { keys: ['whitespaceChild'], orderedKeys: ['whitespaceChild'], totalRecordCount: 1, startIndex: 0 },
  'album-ids-empty-guid-matches-direct-parent': { keys: ['emptyGuidAlbumChild'], orderedKeys: ['emptyGuidAlbumChild'], totalRecordCount: 1, startIndex: 0 },
  'album-filter-default-hides-owned-and-alternate': { keys: ['includePrimary', 'ownedExtra'], orderedKeys: ['includePrimary', 'ownedExtra'], totalRecordCount: 2, startIndex: 0 },
  'album-filter-include-owned-keeps-owned-and-alternate': { keys: ['includeAlternate', 'includePrimary', 'ownedExtra', 'ownedNonExtra'], orderedKeys: ['includeAlternate', 'includePrimary', 'ownedExtra', 'ownedNonExtra'], totalRecordCount: 4, startIndex: 0 },
  'user-album-presentation-grouping': { keys: ['groupFirst'], orderedKeys: ['groupFirst'], totalRecordCount: 1, startIndex: 0 },
  'api-key-album-does-not-group-modern': { keys: ['groupFirst', 'groupSecond'], orderedKeys: ['groupFirst', 'groupSecond'], totalRecordCount: 2, startIndex: 0 },
  'api-key-album-modern-with-user-id': { keys: ['groupFirst'], orderedKeys: ['groupFirst'], totalRecordCount: 1, startIndex: 0 },
  'api-key-album-legacy-route': { keys: ['groupFirst'], orderedKeys: ['groupFirst'], totalRecordCount: 1, startIndex: 0 },
  'user-album-group-count-before-page': { keys: ['groupFirst'], orderedKeys: ['groupFirst'], totalRecordCount: 2, startIndex: 0 },
  'album-filter-explicit-sort-order': { keys: ['alphaDirectA', 'alphaDirectB'], orderedKeys: ['alphaDirectA', 'alphaDirectB'], totalRecordCount: 2, startIndex: 0 },
  'album-filter-no-sort-preserves-request-id-order': { keys: ['alphaDirectA', 'alphaDirectB'], orderedKeys: ['alphaDirectB', 'alphaDirectA'], totalRecordCount: 2, startIndex: 0 },
  'album-filter-total-count-disabled': { keys: ['alphaDirectA'], orderedKeys: ['alphaDirectA'], totalRecordCount: 1, startIndex: 0 },
  'album-filter-count-before-start-and-limit': { keys: ['alphaDirectB'], orderedKeys: ['alphaDirectB'], totalRecordCount: 2, startIndex: 1 },
  'folder-memory-path-ignores-album-filter': { keys: ['memoryNoise'], orderedKeys: ['memoryNoise'], totalRecordCount: 2, startIndex: 1 },
  'folder-recursive-path-applies-album-filter': { keys: ['memoryMatch'], orderedKeys: ['memoryMatch'], totalRecordCount: 1, startIndex: 0 },
  'folder-memory-path-does-not-group-by-presentation-key': { keys: ['memoryGroupFirst', 'memoryGroupSecond'], orderedKeys: ['memoryGroupFirst', 'memoryGroupSecond'], totalRecordCount: 2, startIndex: 0 },
  'folder-memory-path-cannot-revive-prefiltered-owned-and-alternate': { keys: ['memoryHdOwnedExtra', 'memoryHdPrimary'], orderedKeys: ['memoryHdOwnedExtra', 'memoryHdPrimary'], totalRecordCount: 2, startIndex: 0 },
  'folder-memory-sort-name-uses-materialized-item-order': { keys: ['memoryOrderNameFirst', 'memoryOrderPersistedFirst'], orderedKeys: ['memoryOrderNameFirst', 'memoryOrderPersistedFirst'], totalRecordCount: 2, startIndex: 0 },
  'user-root-album-filter-dispatches-repository-query': { keys: ['alphaDirectA', 'alphaDirectB', 'alphaDirectFolder'], orderedKeys: ['alphaDirectA', 'alphaDirectB', 'alphaDirectFolder'], totalRecordCount: 3, startIndex: 0 },
  'user-root-unknown-albums-falls-back-to-library-list': { keys: ['collectionView', 'playlistsRoot'], orderedKeys: ['collectionView', 'playlistsRoot'], totalRecordCount: 2, startIndex: 1 },
  'api-key-aggregate-nonrecursive-ignores-album-filter': { keys: ['physicalRoot', 'physicalSecondary'], orderedKeys: ['physicalRoot', 'physicalSecondary'], totalRecordCount: 2, startIndex: 0 },
  'parent-id-empty-guid-user-is-bad-request': {
    status: 400, contentType: 'text/plain', problem: { rawBody: 'Error processing request.' }
  },
  'parent-id-empty-guid-api-key-is-bad-request': {
    status: 400, contentType: 'text/plain', problem: { rawBody: 'Error processing request.' }
  },
  'playlists-user-forces-recursive-playlist-query': {
    keys: ['playlistDirect', 'playlistNested'], orderedKeys: ['playlistDirect', 'playlistNested'], totalRecordCount: 2, startIndex: 0
  },
  'playlists-api-key-modern-forces-direct-playlist-query': {
    keys: ['playlistDirect'], orderedKeys: ['playlistDirect'], totalRecordCount: 1, startIndex: 0
  },
  'playlists-api-key-legacy-has-user-context': {
    keys: ['playlistDirect', 'playlistNested'], orderedKeys: ['playlistDirect', 'playlistNested'], totalRecordCount: 2, startIndex: 0
  },
  'collection-view-memory-no-order': {
    keys: ['alphaAlbum', 'alternatePrimaryAlbum', 'betaAlbum', 'bomEmptyAlbum', 'cleanNameAlbum',
      'crossTopAlternateAlbum', 'duplicateHighIdAlbum', 'duplicateLowIdAlbum', 'literalPipeAlbum',
      'ownedExtraAlbum', 'ownerEligibleAlbum', 'secondA', 'secondB', 'secondC', 'whitespaceAlbum'],
    orderedKeys: ['whitespaceAlbum', 'duplicateHighIdAlbum', 'alphaAlbum', 'betaAlbum', 'cleanNameAlbum',
      'crossTopAlternateAlbum', 'literalPipeAlbum', 'ownedExtraAlbum', 'alternatePrimaryAlbum',
      'bomEmptyAlbum', 'duplicateLowIdAlbum', 'ownerEligibleAlbum', 'secondA', 'secondB', 'secondC'],
    totalRecordCount: 15, startIndex: 0
  },
  'collection-view-memory-no-order-page': {
    keys: ['alphaAlbum', 'betaAlbum', 'duplicateHighIdAlbum'],
    orderedKeys: ['duplicateHighIdAlbum', 'alphaAlbum', 'betaAlbum'],
    totalRecordCount: 15, startIndex: 1
  },
  'collection-view-memory-no-order-cross-root-page': {
    keys: ['ownerEligibleAlbum', 'secondA', 'secondB', 'secondC'],
    orderedKeys: ['ownerEligibleAlbum', 'secondA', 'secondB', 'secondC'],
    totalRecordCount: 15, startIndex: 11
  }
};

const sourcePaths = [
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.TranslateQuery.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.QueryBuilding.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.Querying.cs',
  'Jellyfin.Api/Controllers/ItemsController.cs',
  'Jellyfin.Api/Middleware/ExceptionMiddleware.cs',
  'Jellyfin.Api/Controllers/LibraryStructureController.cs',
  'Jellyfin.Api/Helpers/RequestHelpers.cs',
  'Jellyfin.Api/ModelBinders/CommaDelimitedCollectionModelBinder.cs',
  'Jellyfin.Api/ModelBinders/PipeDelimitedCollectionModelBinder.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemMapper.cs',
  'MediaBrowser.Controller/Entities/InternalItemsQuery.cs',
  'MediaBrowser.Controller/Entities/BaseItem.cs',
  'MediaBrowser.Controller/Entities/Folder.cs',
  'MediaBrowser.Controller/Entities/UserRootFolder.cs',
  'MediaBrowser.Controller/Entities/CollectionFolder.cs',
  'MediaBrowser.Controller/Entities/UserView.cs',
  'MediaBrowser.Controller/Entities/UserViewBuilder.cs',
  'MediaBrowser.Controller/Playlists/Playlist.cs',
  'Emby.Server.Implementations/Library/LibraryManager.cs',
  'Emby.Server.Implementations/Library/UserViewManager.cs',
  'Emby.Server.Implementations/Playlists/PlaylistsFolder.cs',
  'Emby.Server.Implementations/Sorting/SortNameComparer.cs',
  'Emby.Server.Implementations/Sorting/NameComparer.cs'
];

// Capture oracle inputs before launching the frozen native process.
const capturedInputs = {
  referencePreparation: await captureFilterReferencePreparation({ sourceRoot, sourceDatabase, repoRoot, fixtureUserId: fixture.userId }),
  fixtureInputSha256: await sha256(fixtureInputPath),
  recorderSha256: await sha256(recorderPath),
  sourceDatabaseSha256: await sha256(sourceDatabase),
  runtimeManifest: await fileManifest(runtimeRoot),
  sourceConfigManifest: await treeSnapshot(path.join(sourceRoot, 'config')),
  nativeSources: await Promise.all(sourcePaths.map(async relative => {
    const file = path.join(frozenSourceRoot, relative);
    return { path: path.relative(repoRoot, file).replaceAll('\\', '/'), sha256: await sha256(file) };
  }))
};
capturedInputs.sourceConfigManifest.entriesSha256 = sha256Text(JSON.stringify(capturedInputs.sourceConfigManifest.entries));
assert.ok(capturedInputs.runtimeManifest.fileCount >= 153, 'The complete frozen Release runtime must be manifested.');
assert.ok(capturedInputs.runtimeManifest.dllCount > 0, 'The frozen runtime manifest must contain DLLs.');
assert.ok(capturedInputs.runtimeManifest.depsJsonCount > 0, 'The frozen runtime manifest must contain deps.json.');
assert.ok(capturedInputs.runtimeManifest.runtimeConfigCount > 0, 'The frozen runtime manifest must contain runtimeconfig.json.');

await assert.rejects(stat(outputRoot), error => error?.code === 'ENOENT');
await prepareReference();
capturedInputs.preparedConfigManifest = await treeSnapshot(path.join(referenceRoot, 'config'));
capturedInputs.preparedConfigManifest.entriesSha256 = sha256Text(JSON.stringify(capturedInputs.preparedConfigManifest.entries));
await writeFile(path.join(outputRoot, 'reference-runtime-manifest.json'), json(capturedInputs.runtimeManifest), { flag: 'wx' });
await writeFile(path.join(outputRoot, 'source-config-manifest.json'), json(capturedInputs.sourceConfigManifest), { flag: 'wx' });
await writeFile(path.join(outputRoot, 'prepared-config-manifest.json'), json(capturedInputs.preparedConfigManifest), { flag: 'wx' });

const setupRecords = [];
const records = [];
const contracts = [];
const playlistUserViewTriggerCase = 'user-root-album-filter-dispatches-repository-query';
const databaseStages = { beforeProvision: databaseSnapshot() };
const filesystemStages = { beforeProvision: await filesystemDomainSnapshot() };
const processStages = {};
let nativeGraph;
let playlistUserViewSideEffect;
let scenarioError;
let setupInstance;
let setupToken;
let recordingInstance;
let accessToken;

assert.deepEqual(databaseStages.beforeProvision.foreignKeyCheck, []);

try {
  setupInstance = startReference('setup-reference');
  await waitForReady(setupInstance);
  const login = await request(setupRecords, 'setup-login-admin', '/Users/AuthenticateByName', {
    method: 'POST',
    body: { Username: 'CoreFlowAdmin', Pw: password }
  });
  assert.equal(login.status, 200, 'The frozen admin login should succeed during setup.');
  setupToken = login.bodyJson.AccessToken;
  assert.equal(idKey(login.bodyJson.User.Id), idKey(fixture.userId));
  const addRoute = `/Library/VirtualFolders?name=${encodeURIComponent(libraryName)}`
    + `&collectionType=movies&paths=${encodeURIComponent(filesystemDomainPaths.physicalLibrarySecondary)}`
    + `&paths=${encodeURIComponent(filesystemDomainPaths.physicalLibrary)}&refreshLibrary=false`;
  const add = await request(setupRecords, 'setup-create-virtual-folder', addRoute, {
    method: 'POST',
    token: setupToken,
    body: { LibraryOptions: { Enabled: true } }
  });
  assert.equal(add.status, 204, `Native virtual-folder setup failed: ${add.bodyText}`);
  const list = await request(setupRecords, 'setup-list-virtual-folders', '/Library/VirtualFolders', { token: setupToken });
  assert.equal(list.status, 200, `Native virtual-folder discovery failed: ${list.bodyText}`);
  assert.ok(Array.isArray(list.bodyJson));
  nativeGraph = { setupApiVirtualFolders: list.bodyJson };
} catch (error) {
  scenarioError = error;
} finally {
  if (setupInstance) {
    processStages.setup = await stopReference(setupInstance, setupToken, setupRecords);
    if (!processStages.setup.cleanShutdown || processStages.setup.code !== 0 || !processStages.setup.portAvailable) {
      scenarioError ??= new Error(`Native setup process did not stop cleanly: ${JSON.stringify(processStages.setup)}`);
    }
  }
}

if (!scenarioError) {
  try {
    const setupApiVirtualFolders = nativeGraph.setupApiVirtualFolders;
    nativeGraph = resolveNativeGraph(setupApiVirtualFolders);
    databaseStages.afterProvision = databaseSnapshot();
    filesystemStages.afterProvision = await filesystemDomainSnapshot();
    assert.deepEqual(databaseStages.afterProvision.foreignKeyCheck, []);
    assertSeedIdentifiersAbsent();
    seedDatabase();
    databaseStages.afterSeed = databaseSnapshot();
    filesystemStages.afterSeed = await filesystemDomainSnapshot();
    assert.deepEqual(databaseStages.afterSeed.foreignKeyCheck, []);
    assert.deepEqual(filesystemStages.afterSeed, filesystemStages.afterProvision,
      'Offline database seeding must not mutate the filesystem domain.');
  } catch (error) {
    scenarioError = error;
  }
}

if (!scenarioError) {
  try {
    recordingInstance = startReference('reference');
    await waitForReady(recordingInstance);
    const login = await request(records, 'recording-login-admin', '/Users/AuthenticateByName', {
      method: 'POST',
      body: { Username: 'CoreFlowAdmin', Pw: password }
    });
    assert.equal(login.status, 200, 'The frozen admin login should succeed for recording.');
    accessToken = login.bodyJson.AccessToken;
    assert.equal(idKey(login.bodyJson.User.Id), idKey(fixture.userId));
    await delay(500);
    databaseStages.beforeReads = databaseSnapshot();
    filesystemStages.beforeReads = await filesystemDomainSnapshot();
    assert.deepEqual(databaseStages.beforeReads.foreignKeyCheck, []);

    for (const testCase of fixture.cases) {
      const endpoints = testCase.endpoints ?? ['items', 'legacy'];
      if (testCase.name === playlistUserViewTriggerCase) {
        assert.deepEqual(endpoints, ['items', 'legacy'], 'The UserView side-effect case must expose a stability probe.');
        databaseStages.beforePlaylistUserViewCreate = databaseSnapshot();
        filesystemStages.beforePlaylistUserViewCreate = await filesystemDomainSnapshot();
        assert.deepEqual(databaseStages.beforePlaylistUserViewCreate, databaseStages.beforeReads,
          'All native GET requests before the UserView trigger must be database read-only.');
        assert.deepEqual(filesystemStages.beforePlaylistUserViewCreate, filesystemStages.beforeReads,
          'All native GET requests before the UserView trigger must be filesystem read-only.');
      }
      const endpointContracts = [];
      for (const [endpointIndex, endpoint] of endpoints.entries()) {
        const token = testCase.auth === 'apiKey' ? apiKeyToken : accessToken;
        const response = await request(records, `${testCase.name}:${endpoint}`, routeFor(endpoint, testCase), { token });
        const contract = responseContract(response);
        const expectedStatus = testCase.expectedStatus ?? 200;
        assert.equal(contract.frozen.status, expectedStatus, `${testCase.name}:${endpoint} returned an unexpected status.`);
        assert.equal(contract.frozen.contentType, expectedStatus < 400 ? 'application/json; charset=utf-8' : 'text/plain',
          `${testCase.name}:${endpoint} returned an unexpected content type.`);
        if (expectedStatus < 400) assert.equal(contract.frozen.problem, null, `${testCase.name}:${endpoint} exposed a problem response.`);
        else assert.deepEqual(contract.frozen.problem, { rawBody: 'Error processing request.' },
          `${testCase.name}:${endpoint} returned an unexpected production error body.`);
        endpointContracts.push({ endpoint, contract: contract.frozen });
        if (testCase.name === playlistUserViewTriggerCase && endpointIndex === 0) {
          const settled = await waitForSnapshotQuiescence({
            ready: database => playlistUserViewRefreshCompleted(databaseStages.beforePlaylistUserViewCreate, database)
          });
          databaseStages.afterPlaylistUserViewCreate = settled.database;
          filesystemStages.afterPlaylistUserViewCreate = settled.filesystem;
          const { dynamicId } = verifyPlaylistUserViewDatabaseDelta(
            databaseStages.beforePlaylistUserViewCreate,
            databaseStages.afterPlaylistUserViewCreate);
          verifyPlaylistUserViewFilesystemDelta(
            filesystemStages.beforePlaylistUserViewCreate,
            filesystemStages.afterPlaylistUserViewCreate,
            dynamicId);
          playlistUserViewSideEffect = {
            name: 'native-playlists-user-view-first-read-materialization',
            triggerRecord: `${testCase.name}:${endpoint}`,
            stabilityProbeRecord: `${testCase.name}:${endpoints[1]}`,
            database: {
              changedTables: ['BaseItems'],
              addedRows: 1,
              addedType: 'MediaBrowser.Controller.Entities.UserView'
            },
            filesystem: {
              changedDomains: ['metadata'],
              addedEntries: ['views', 'views/<dynamic-user-view-id>'],
              addedFiles: 0
            },
            observation: {
              creationSettleAttempts: settled.attempts,
              stableSamples: settled.stableSamples,
              intervalMilliseconds: settled.intervalMilliseconds
            }
          };
        } else if (testCase.name === playlistUserViewTriggerCase && endpointIndex === 1) {
          const settled = await waitForSnapshotQuiescence();
          databaseStages.afterPlaylistUserViewStabilityProbe = settled.database;
          filesystemStages.afterPlaylistUserViewStabilityProbe = settled.filesystem;
          assert.deepEqual(databaseStages.afterPlaylistUserViewStabilityProbe,
            databaseStages.afterPlaylistUserViewCreate,
            'The second endpoint must not mutate the materialized Playlists UserView.');
          assert.deepEqual(filesystemStages.afterPlaylistUserViewStabilityProbe,
            filesystemStages.afterPlaylistUserViewCreate,
            'The second endpoint must not mutate the materialized Playlists UserView directories.');
          playlistUserViewSideEffect.observation.stabilityProbeSettleAttempts = settled.attempts;
        }
      }
      const primary = endpointContracts[0].contract;
      for (const entry of endpointContracts.slice(1)) {
        assert.deepEqual(entry.contract, primary, `${testCase.name}: ${endpoints.join(' and ')} diverged.`);
      }
      if (modeArgument === 'main') {
        const pinned = expected[testCase.name];
        assert.ok(pinned, `${testCase.name}: missing pinned native expectation.`);
        assert.equal(primary.status, pinned.status ?? 200, `${testCase.name}: unexpected status.`);
        if (primary.status >= 400) {
          assert.equal(primary.contentType, pinned.contentType, `${testCase.name}: unexpected error content type.`);
          assert.deepEqual(primary.problem, pinned.problem, `${testCase.name}: unexpected error response.`);
          assert.deepEqual(primary.keys, [], `${testCase.name}: an error response exposed items.`);
          assert.equal(primary.startIndex, null, `${testCase.name}: an error response exposed StartIndex.`);
          assert.equal(primary.totalRecordCount, null, `${testCase.name}: an error response exposed TotalRecordCount.`);
        } else {
          assert.deepEqual(primary.keys, [...pinned.keys].sort(), `${testCase.name}: unexpected membership.`);
          assert.equal(primary.totalRecordCount, pinned.totalRecordCount ?? pinned.keys.length,
            `${testCase.name}: unexpected total record count.`);
          assert.equal(primary.startIndex, pinned.startIndex ?? 0, `${testCase.name}: unexpected start index.`);
          if (testCase.assertOrder || pinned.orderedKeys) {
            assert.deepEqual(primary.orderedKeys, pinned.orderedKeys ?? pinned.keys,
              `${testCase.name}: unexpected item order.`);
          }
        }
      }
      contracts.push({
        name: testCase.name,
        query: testCase.query,
        scope: testCase.scope,
        parentKey: testCase.parentKey ?? null,
        auth: testCase.auth ?? 'user',
        endpoints,
        omitScope: testCase.omitScope ?? false,
        omitParentId: testCase.omitParentId ?? false,
        omitIds: testCase.omitIds ?? false,
        recursive: Object.hasOwn(testCase, 'recursive') ? testCase.recursive : true,
        omitSortBy: testCase.omitSortBy ?? false,
        assertOrder: testCase.assertOrder ?? false,
        expectedStatus: testCase.expectedStatus ?? 200,
        ...primary
      });
    }

    databaseStages.afterReads = databaseSnapshot();
    filesystemStages.afterReads = await filesystemDomainSnapshot();
    assert.ok(playlistUserViewSideEffect, 'The native Playlists UserView side effect must be observed and verified.');
    assert.deepEqual(databaseStages.afterReads, databaseStages.afterPlaylistUserViewStabilityProbe,
      'Native filter GET requests after the expected UserView creation must not mutate any SQLite table.');
    assert.deepEqual(filesystemStages.afterReads, filesystemStages.afterPlaylistUserViewStabilityProbe,
      'Native filter GET requests after the expected UserView creation must not mutate the filesystem domain.');
  } catch (error) {
    scenarioError = error;
  } finally {
    if (recordingInstance) {
      processStages.recording = await stopReference(recordingInstance, accessToken, records);
      if (!processStages.recording.cleanShutdown || processStages.recording.code !== 0 || !processStages.recording.portAvailable) {
        scenarioError ??= new Error(`Native recording process did not stop cleanly: ${JSON.stringify(processStages.recording)}`);
      }
    }
  }
}

if (databaseStages.beforeReads) {
  try {
    databaseStages.finalAfterShutdown = databaseSnapshot();
    filesystemStages.finalAfterShutdown = await filesystemDomainSnapshot();
    assert.deepEqual(databaseStages.finalAfterShutdown, databaseStages.afterReads,
      'Native recording shutdown must preserve every SQLite table after the expected side effect.');
    assert.deepEqual(filesystemStages.finalAfterShutdown, filesystemStages.afterReads,
      'Native recording shutdown must preserve the filesystem domain after the expected side effect.');
  } catch (error) {
    scenarioError ??= error;
  }
}

const portFinallyAvailable = await available(port);
const stageEquals = (left, right) => left !== undefined && right !== undefined
  && JSON.stringify(left) === JSON.stringify(right);
const databaseUnchangedByReads = databaseStages.beforeReads !== undefined
  && stageEquals(databaseStages.beforeReads, databaseStages.afterReads)
  && stageEquals(databaseStages.beforeReads, databaseStages.finalAfterShutdown);
const filesystemUnchangedByReads = filesystemStages.beforeReads !== undefined
  && stageEquals(filesystemStages.beforeReads, filesystemStages.afterReads)
  && stageEquals(filesystemStages.beforeReads, filesystemStages.finalAfterShutdown);
const nativePlaylistUserViewSideEffectVerified = playlistUserViewSideEffect !== undefined;
const databaseStableOutsideExpectedSideEffect = stageEquals(databaseStages.beforeReads,
  databaseStages.beforePlaylistUserViewCreate)
  && stageEquals(databaseStages.afterPlaylistUserViewCreate, databaseStages.afterPlaylistUserViewStabilityProbe)
  && stageEquals(databaseStages.afterPlaylistUserViewCreate, databaseStages.afterReads)
  && stageEquals(databaseStages.afterPlaylistUserViewCreate, databaseStages.finalAfterShutdown);
const filesystemStableOutsideExpectedSideEffect = stageEquals(filesystemStages.beforeReads,
  filesystemStages.beforePlaylistUserViewCreate)
  && stageEquals(filesystemStages.afterPlaylistUserViewCreate, filesystemStages.afterPlaylistUserViewStabilityProbe)
  && stageEquals(filesystemStages.afterPlaylistUserViewCreate, filesystemStages.afterReads)
  && stageEquals(filesystemStages.afterPlaylistUserViewCreate, filesystemStages.finalAfterShutdown);
const foreignKeyCheckPassedAllStages = Object.values(databaseStages)
  .every(stage => Array.isArray(stage?.foreignKeyCheck) && stage.foreignKeyCheck.length === 0);
const processClean = processStages.setup?.cleanShutdown === true
  && processStages.setup?.code === 0
  && processStages.setup?.portAvailable === true
  && processStages.recording?.cleanShutdown === true
  && processStages.recording?.code === 0
  && processStages.recording?.portAvailable === true;
const summary = {
  passed: scenarioError == null && processClean && portFinallyAvailable
    && nativePlaylistUserViewSideEffectVerified
    && !databaseUnchangedByReads && !filesystemUnchangedByReads
    && databaseStableOutsideExpectedSideEffect && filesystemStableOutsideExpectedSideEffect
    && foreignKeyCheckPassedAllStages,
  mode: modeArgument,
  origin,
  fixtureItems: fixture.items.length,
  fixtureCases: fixture.cases.length,
  httpRecords: records.length,
  endpointCases: contracts.reduce((total, entry) => total + entry.endpoints.length, 0),
  setupHttpRecords: setupRecords.length,
  contractsRecorded: contracts.length,
  databaseUnchangedByReads,
  filesystemUnchangedByReads,
  nativePlaylistUserViewSideEffectVerified,
  databaseStableOutsideExpectedSideEffect,
  filesystemStableOutsideExpectedSideEffect,
  nativePlaylistUserViewSideEffect: playlistUserViewSideEffect ?? null,
  foreignKeyCheckPassedAllStages,
  processClean,
  process: {
    preferredPort,
    preferredPortInitiallyAvailable,
    selectedPort: port,
    portInitiallyAvailable,
    portFinallyAvailable,
    stages: processStages
  },
  error: scenarioError ? { name: scenarioError.name, message: scenarioError.message, stack: scenarioError.stack } : null
};

const portableNativeGraph = nativeGraph?.collectionView ? {
  invariants: {
    collectionFolderWasCreatedByApi: true,
    collectionParentIsUserRoot: idKey(nativeGraph.collectionView.ParentId) === idKey(nativeGraph.userRoot.Id),
    collectionHasTwoPhysicalFolderIdsInPersistedOrder: nativeGraph.collectionPhysicalFolderIds.length === 2
      && idKey(nativeGraph.collectionPhysicalFolderIds[0]) === idKey(nativeGraph.physicalRoot.Id)
      && idKey(nativeGraph.collectionPhysicalFolderIds[1]) === idKey(nativeGraph.physicalSecondary.Id),
    physicalParentIsAggregate: idKey(nativeGraph.physicalRoot.ParentId) === idKey(nativeGraph.aggregateRoot.Id),
    secondaryPhysicalParentIsAggregate: idKey(nativeGraph.physicalSecondary.ParentId) === idKey(nativeGraph.aggregateRoot.Id),
    playlistsParentIsAggregate: idKey(nativeGraph.playlistsRoot.ParentId) === idKey(nativeGraph.aggregateRoot.Id),
    physicalPathMatchesRequestedLocation: normalizePath(nativeGraph.physicalRoot.Path) === normalizePath(filesystemDomainPaths.physicalLibrary),
    secondaryPhysicalPathMatchesRequestedLocation: normalizePath(nativeGraph.physicalSecondary.Path) === normalizePath(filesystemDomainPaths.physicalLibrarySecondary)
  },
  actual: {
    aggregateRoot: nativeGraph.aggregateRoot,
    playlistsRoot: nativeGraph.playlistsRoot,
    userRoot: nativeGraph.userRoot,
    collectionView: nativeGraph.collectionView,
    physicalRoot: nativeGraph.physicalRoot,
    physicalSecondary: nativeGraph.physicalSecondary,
    virtualFolder: nativeGraph.virtualFolder,
    collectionPhysicalFolderIds: nativeGraph.collectionPhysicalFolderIds
  },
  fixtureKeyMapping: Object.fromEntries(['aggregateRoot', 'playlistsRoot', 'userRoot', 'collectionView', 'physicalRoot', 'physicalSecondary'].map(key => [
    key,
    { fixtureId: itemByKey.get(key).id, actualId: nativeGraph[key].Id }
  ]))
} : null;

await writeFile(path.join(outputRoot, 'setup-http.json'), json({ schemaVersion: 1, origin, records: setupRecords }), { flag: 'wx' });
await writeFile(path.join(outputRoot, 'native-http.json'), json({ schemaVersion: 1, origin, mode: modeArgument, records }), { flag: 'wx' });
await writeFile(path.join(outputRoot, 'native-setup.json'), json({ schemaVersion: 1, libraryName, graph: portableNativeGraph }), { flag: 'wx' });
await writeFile(path.join(outputRoot, 'database-stages.json'), json({ schemaVersion: 1, ...databaseStages }), { flag: 'wx' });
await writeFile(path.join(outputRoot, 'filesystem-stages.json'), json({
  schemaVersion: 1,
  domainPaths: Object.fromEntries(Object.entries(filesystemDomainPaths)
    .map(([name, directory]) => [name, path.relative(repoRoot, directory).replaceAll('\\', '/')])),
  ...filesystemStages
}), { flag: 'wx' });
await writeFile(path.join(outputRoot, 'native-contract.json'), json({
  schemaVersion: 1,
  kind: 'album-filters-native-contract',
  mode: modeArgument,
  fixtureInputSha256: capturedInputs.fixtureInputSha256,
  endpoints: ['/Items', '/Users/{userId}/Items'],
  setup: { libraryName, dynamicIdsExcluded: true },
  cases: contracts
}), { flag: 'wx' });
await writeFile(path.join(outputRoot, 'summary.json'), json(summary), { flag: 'wx' });

const artifactNames = [
  'setup-http.json', 'native-http.json', 'native-setup.json', 'database-stages.json', 'filesystem-stages.json',
  'native-contract.json', 'summary.json', 'reference-runtime-manifest.json', 'source-config-manifest.json',
  'prepared-config-manifest.json', 'setup-reference-stdout.log', 'setup-reference-stderr.log',
  ...(recordingInstance ? ['reference-stdout.log', 'reference-stderr.log'] : [])
];
const artifacts = [];
for (const name of artifactNames) {
  const file = path.join(outputRoot, name);
  if (existsSync(file)) artifacts.push({ path: name, sha256: await sha256(file) });
}
const gitHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
const dotnetInfo = spawnSync(dotnetPath, ['--info'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
await writeFile(path.join(outputRoot, 'provenance.json'), json({
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  gitHead: gitHead.status === 0 ? gitHead.stdout.trim() : null,
  scenario: 'Frozen Jellyfin HTTP Albums/AlbumIds oracle across binders, global name resolution, ownership/alternate eligibility, root dispatch, explicit ParentId errors, PlaylistsFolder user dispatch and its one-time UserView materialization, in-memory versus repository filtering, grouping, counting, paging, and ordering.',
  isolation: {
    sourceInstance: path.relative(repoRoot, sourceRoot).replaceAll('\\', '/'),
    sourceDatabase: path.relative(repoRoot, sourceDatabase).replaceAll('\\', '/'),
    clonedInstance: path.relative(repoRoot, referenceRoot).replaceAll('\\', '/'),
    setupThenCleanRestart: true,
    virtualFolderCreatedThroughNativeApi: true,
    loopbackOnly: true,
    autoDiscovery: false,
    preferredPort,
    preferredPortInitiallyAvailable,
    selectedPort: port,
    portInitiallyAvailable,
    portFinallyAvailable,
    frozenInputsWereNotRunInPlace: true,
    syntheticCredentialsAndTokensOnly: true
  },
  recorderInvocation: [
    process.execPath,
    path.relative(repoRoot, recorderPath).replaceAll('\\', '/'),
    path.relative(repoRoot, outputRoot).replaceAll('\\', '/'),
    String(preferredPort),
    modeArgument
  ],
  referenceCommand: [path.relative(repoRoot, dotnetPath).replaceAll('\\', '/'), ...processArguments.map(value => path.isAbsolute(value)
    ? path.relative(repoRoot, value).replaceAll('\\', '/') : value)],
  runtime: { node: process.version, dotnetInfoExitCode: dotnetInfo.status, dotnetInfo: dotnetInfo.stdout },
  referenceRuntime: {
    root: capturedInputs.runtimeManifest.root,
    fileCount: capturedInputs.runtimeManifest.fileCount,
    dllCount: capturedInputs.runtimeManifest.dllCount,
    depsJsonCount: capturedInputs.runtimeManifest.depsJsonCount,
    runtimeConfigCount: capturedInputs.runtimeManifest.runtimeConfigCount,
    entriesSha256: capturedInputs.runtimeManifest.entriesSha256,
    manifestArtifact: 'reference-runtime-manifest.json'
  },
  nativeSources: capturedInputs.nativeSources,
  recorder: {
    path: path.relative(repoRoot, recorderPath).replaceAll('\\', '/'),
    sha256: capturedInputs.recorderSha256
  },
  preparedInputs: [
    ...capturedInputs.referencePreparation.inputs,
    { kind: 'frozenSourceDatabase', path: path.relative(repoRoot, sourceDatabase).replaceAll('\\', '/'), sha256: capturedInputs.sourceDatabaseSha256 },
    { kind: 'fixtureInput', path: path.relative(repoRoot, fixtureInputPath).replaceAll('\\', '/'), sha256: capturedInputs.fixtureInputSha256 },
    { kind: 'recorderSource', path: path.relative(repoRoot, recorderPath).replaceAll('\\', '/'), sha256: capturedInputs.recorderSha256 },
    {
      kind: 'frozenReleaseRuntimeTree', path: capturedInputs.runtimeManifest.root,
      fileCount: capturedInputs.runtimeManifest.fileCount, entriesSha256: capturedInputs.runtimeManifest.entriesSha256
    },
    ...capturedInputs.nativeSources.map(source => ({ kind: 'frozenNativeSource', ...source }))
  ],
  result: {
    passed: summary.passed,
    process: summary.process,
    databaseUnchangedByReads,
    filesystemUnchangedByReads,
    nativePlaylistUserViewSideEffectVerified,
    databaseStableOutsideExpectedSideEffect,
    filesystemStableOutsideExpectedSideEffect,
    nativePlaylistUserViewSideEffect: playlistUserViewSideEffect ?? null,
    foreignKeyCheckPassedAllStages
  },
  artifacts
}), { flag: 'wx' });

console.log(json({ outputRoot, summary, contract: path.join(outputRoot, 'native-contract.json') }).trim());
if (scenarioError) throw scenarioError;
if (!summary.passed) throw new Error(`The isolated frozen reference did not complete cleanly: ${JSON.stringify(summary.process)}`);


