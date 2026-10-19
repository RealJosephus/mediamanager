import { validationExecutable, validationOutputRoot, validationPath } from '../validation/paths.js';
import { currentNativeReference } from './current-native-reference.js';
import { createPrivateFilterOutput } from './filter-reference-output.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export async function recordStudioFilters(outputArgument, portArgument, modeArgument = 'main') {
const modes = new Set(['main', 'discover']);
if (!outputArgument || !portArgument || !modes.has(modeArgument)) {
  throw new Error('Usage: node tools/compat/record-studio-filters.js <new-evidence-directory> <preferred-loopback-port> [main|discover]');
}

const publicOutputRoot = validationPath(path.resolve(repoRoot, outputArgument));
const allowedRoot = validationOutputRoot();
if (publicOutputRoot === allowedRoot || !publicOutputRoot.startsWith(allowedRoot + path.sep)) {
  throw new Error('The evidence directory must be a new child of the configured validation output root.');
}
if (existsSync(publicOutputRoot)) throw new Error(`Evidence directory already exists: ${publicOutputRoot}`);

const preferredPort = Number(portArgument);
if (!Number.isInteger(preferredPort) || preferredPort < 1024 || preferredPort > 65535) {
  throw new Error('The preferred loopback port must be an integer from 1024 through 65535.');
}

const privateOutput = await createPrivateFilterOutput(publicOutputRoot);
const outputRoot = privateOutput.root;
let failure;
try {
const fixtureInputPath = fileURLToPath(new URL('../../tests/library/fixtures/current-byname-filters/studio-input.json', import.meta.url));
const fixture = JSON.parse(await readFile(fixtureInputPath, 'utf8'));
const fixtureUserId = fixture.userId;
const current = await currentNativeReference({ fixtureUserId });
privateOutput.addSecret(current.accessToken);
fixture.userId = current.userId;
const { sourceRoot, sourceDatabase, runtimeRoot, jellyfinDll } = current;
const referenceRoot = path.join(outputRoot, 'reference');
const databasePath = path.join(referenceRoot, 'data/data/jellyfin.db');
const filesystemDomainPaths = {
  userViews: path.join(referenceRoot, 'data/root/default'),
  metadata: path.join(referenceRoot, 'data/metadata'),
  physicalLibrary: path.join(referenceRoot, 'library-content/Studio Filter Physical Root')
};
const physicalAnchorPath = path.join(filesystemDomainPaths.physicalLibrary, 'Native Anchor');
const expectationsPath = fileURLToPath(new URL('../../tests/library/fixtures/current-byname-filters/studio-expected.json', import.meta.url));
const recorderPath = fileURLToPath(import.meta.url);
const dotnetPath = validationExecutable('dotnet', { ...process.env, MEDIAMANAGER_DOTNET: current.dotnet });
const libraryName = 'Studio Filter Library';
const deviceId = 'studio-filter-native-oracle';
const apiKeyToken = 'studiofilterapikey000000000000000';
const expectations = JSON.parse(await readFile(expectationsPath, 'utf8'));
assert.equal(expectations.schemaVersion, 1);
assert.deepEqual(expectations.cases.map(entry => entry.name), fixture.cases.map(entry => entry.name));
const itemByKey = new Map(fixture.items.map(item => [item.key, item]));
const valueByKey = new Map(fixture.itemValues.map(value => [value.key, value]));
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

let sourceTemplates;
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
  await cp(sourceDatabase, databasePath, { force: false, errorOnExist: true });

  await current.prepareClone(referenceRoot, port);
  const templateDatabase = new DatabaseSync(databasePath, { readOnly: true });
  try {
    sourceTemplates = {
      folderTemplate: templateDatabase.prepare('SELECT * FROM "BaseItems" WHERE "Id" = ?').get('11111111-1111-1111-1111-111111111111'),
      movieTemplate: templateDatabase.prepare('SELECT * FROM "BaseItems" WHERE "Id" = ?').get('22222222-2222-2222-2222-222222222222'),
    };
  } finally { templateDatabase.close(); }
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

function assertSeedIdentifiersAbsent() {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(database.prepare(`SELECT COUNT(*) AS "Count" FROM "BaseItems" WHERE "Id" LIKE '75000000-%'`).get().Count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS "Count" FROM "BaseItems" WHERE "Id" = ?')
      .get(upperId('00000000-0000-0000-0000-000000000000')).Count, 0);
    assert.equal(database.prepare(`SELECT COUNT(*) AS "Count" FROM "ItemValues" WHERE "ItemValueId" LIKE '75000000-%'`).get().Count, 0);
    assert.equal(database.prepare(`SELECT COUNT(*) AS "Count" FROM "ApiKeys" WHERE "AccessToken" = ?`).get(apiKeyToken).Count, 0);
  } finally {
    database.close();
  }
}

function seedDatabase() {
  const database = new DatabaseSync(databasePath);
  try {
    const { folderTemplate, movieTemplate } = sourceTemplates;
    const aggregate = database.prepare(`SELECT "Id" FROM "BaseItems"
      WHERE "Type" = 'MediaBrowser.Controller.Entities.AggregateFolder' LIMIT 1`).get();
    assert.ok(folderTemplate && movieTemplate && aggregate, 'The current controlled media templates are required.');
    const typeNames = {
      Folder: 'MediaBrowser.Controller.Entities.Folder',
      Studio: 'MediaBrowser.Controller.Entities.Studio',
      Movie: 'MediaBrowser.Controller.Entities.Movies.Movie',
      MusicGenre: 'MediaBrowser.Controller.Entities.Audio.MusicGenre'
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
        const isFolder = item.isFolder ?? item.type === 'Folder';
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
          Path: `Z:\\StudioFilterOracle\\${item.key}${isFolder ? '' : '.mkv'}`,
          ProductionYear: item.productionYear ?? null,
          ExtraType: item.extraType ?? null,
          IsFolder: isFolder ? 1 : 0,
          IsMovie: isMovie ? 1 : 0,
          MediaType: item.mediaType ?? (isMovie ? 'Video' : 'Unknown'),
          UnratedType: isMovie ? 'Movie' : 'Other',
          PresentationUniqueKey: item.presentationUniqueKey ?? `studio-filter-oracle-${idKey(item.primaryVersionId ?? item.id)}`,
          Studios: item.studiosText ?? null,
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
      for (const value of fixture.itemValues) {
        database.prepare(`INSERT INTO "ItemValues" ("ItemValueId", "Type", "Value", "CleanValue") VALUES (?, ?, ?, ?)`)
          .run(upperId(value.id), value.type === 'Studio' ? 3 : value.type, value.value, value.cleanValue);
      }
      for (const link of fixture.itemValueLinks) {
        database.prepare(`INSERT INTO "ItemValuesMap" ("ItemId", "ItemValueId") VALUES (?, ?)`)
          .run(upperId(resolvedId(itemByKey.get(link.itemKey).id)), upperId(valueByKey.get(link.valueKey).id));
      }
      database.prepare(`INSERT INTO "ApiKeys" ("DateCreated", "DateLastActivity", "Name", "AccessToken") VALUES (?, ?, ?, ?)`).run(
        fixedDate, fixedDate, 'Studio Filter Native Oracle', apiKeyToken);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  } finally {
    database.close();
  }
}

function authorization(token) {
  return `MediaBrowser Client="StudioFilterNativeOracle", Device="Isolated", DeviceId="${deviceId}", Version="1"${token ? `, Token="${token}"` : ''}`;
}

const processArguments = [
  jellyfinDll,
  '--datadir', path.join(referenceRoot, 'data'),
  '--configdir', path.join(referenceRoot, 'config'),
  '--cachedir', path.join(referenceRoot, 'cache'),
  '--logdir', path.join(referenceRoot, 'log'),
  '--nowebclient', '--ffmpeg', current.ffmpeg
];

function startReference(label) {
  return current.start({ referenceRoot, outputRoot, label, origin });
}

async function waitForReady(instance) { await instance.ready(); }

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
  return await instance.stop(async () => (await request(records,
    `${instance.label}-authenticated-shutdown`, '/System/Shutdown', { method: 'POST', token })).status,
  () => available(port));
}

function resolveNativeGraph(virtualFolders) {
  assert.ok(Array.isArray(virtualFolders), 'GET /Library/VirtualFolders must return an array.');
  const virtualFolder = virtualFolders.find(entry => entry.Name === libraryName);
  assert.ok(virtualFolder, `The native ${libraryName} virtual folder must be discoverable.`);
  assert.ok(virtualFolder.ItemId, 'The native virtual folder must expose ItemId.');
  assert.ok(Array.isArray(virtualFolder.Locations)
    && virtualFolder.Locations.some(location => normalizePath(location) === normalizePath(filesystemDomainPaths.physicalLibrary)),
  'The native virtual folder must expose the requested physical location.');

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
    assert.equal(collectionData.PhysicalFolderIds.length, 1,
      'The native collection must map exactly one physical folder for a positive root oracle.');
    const physical = byId.get(idKey(collectionData.PhysicalFolderIds[0]));
    assert.ok(physical, 'CollectionFolder PhysicalFolderIds must resolve to a persisted BaseItems row.');
    assert.equal(physical.Type, 'MediaBrowser.Controller.Entities.Folder');
    assert.equal(normalizePath(physical.Path), normalizePath(filesystemDomainPaths.physicalLibrary));
    const userRoot = byId.get(idKey(collection.ParentId));
    assert.ok(userRoot, 'CollectionFolder ParentId must resolve to a persisted UserRootFolder.');
    assert.equal(userRoot.Type, 'MediaBrowser.Controller.Entities.UserRootFolder');
    const aggregate = rows.find(row => row.Type === 'MediaBrowser.Controller.Entities.AggregateFolder');
    assert.ok(aggregate, 'The native AggregateFolder must remain persisted.');
    assert.equal(idKey(physical.ParentId), idKey(aggregate.Id), 'Physical folder must be an AggregateFolder child.');
    assert.equal(idKey(collection.ParentId), idKey(userRoot.Id), 'CollectionFolder must be a UserRootFolder child.');

    const graph = {
      aggregateRoot: aggregate,
      userRoot,
      collectionView: collection,
      physicalRoot: physical,
      virtualFolder: {
        name: virtualFolder.Name,
        itemId: virtualFolder.ItemId,
        locations: virtualFolder.Locations,
        collectionType: virtualFolder.CollectionType ?? null
      },
      collectionPhysicalFolderIds: collectionData.PhysicalFolderIds
    };
    for (const key of ['aggregateRoot', 'userRoot', 'collectionView', 'physicalRoot']) {
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
    testCase.query.replaceAll(fixtureUserId, fixture.userId)
  ];
  const prefix = endpoint === 'items' ? '/Items' : `/Users/${fixture.userId}/Items`;
  return `${prefix}?${parts.filter(Boolean).join('&')}`;
}

const sourcePaths = [
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.TranslateQuery.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.QueryBuilding.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.Querying.cs',
  'src/Jellyfin.Database/Jellyfin.Database.Implementations/JellyfinQueryHelperExtensions.cs',
  'Jellyfin.Api/Controllers/ItemsController.cs',
  'Jellyfin.Api/Middleware/ExceptionMiddleware.cs',
  'Jellyfin.Api/Controllers/LibraryStructureController.cs',
  'Jellyfin.Api/Helpers/RequestHelpers.cs',
  'Jellyfin.Api/ModelBinders/CommaDelimitedCollectionModelBinder.cs',
  'Jellyfin.Api/ModelBinders/PipeDelimitedCollectionModelBinder.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemMapper.cs',
  'src/Jellyfin.Database/Jellyfin.Database.Implementations/Entities/ItemValueType.cs',
  'MediaBrowser.Controller/Entities/InternalItemsQuery.cs',
  'MediaBrowser.Controller/Entities/BaseItem.cs',
  'MediaBrowser.Controller/Entities/Folder.cs',
  'MediaBrowser.Controller/Entities/UserRootFolder.cs',
  'MediaBrowser.Controller/Entities/CollectionFolder.cs',
  'MediaBrowser.Controller/Entities/UserViewBuilder.cs',
  'MediaBrowser.Controller/Entities/Studio.cs',
  'MediaBrowser.Controller/Entities/Audio/MusicGenre.cs',
  'Emby.Server.Implementations/Library/LibraryManager.cs',
  'src/Jellyfin.Extensions/StringExtensions.cs'
];

// Capture oracle inputs before launching the current native process.
const capturedInputs = {
  referencePreparation: current.preparation,
  fixtureInputSha256: await sha256(fixtureInputPath),
  expectationsSha256: await sha256(expectationsPath),
  recorderSha256: await sha256(recorderPath),
  sourceDatabaseSha256: await sha256(sourceDatabase),
  runtimeManifest: await fileManifest(runtimeRoot),
  sourceConfigManifest: await treeSnapshot(path.join(sourceRoot, 'config')),
  nativeSources: await current.sourceBindings(sourcePaths)
};
capturedInputs.sourceConfigManifest.entriesSha256 = sha256Text(JSON.stringify(capturedInputs.sourceConfigManifest.entries));
assert.ok(capturedInputs.runtimeManifest.fileCount > 0, 'The complete current Release runtime must be manifested.');
assert.ok(capturedInputs.runtimeManifest.dllCount > 0, 'The current runtime manifest must contain DLLs.');
assert.ok(capturedInputs.runtimeManifest.depsJsonCount > 0, 'The current runtime manifest must contain deps.json.');
assert.ok(capturedInputs.runtimeManifest.runtimeConfigCount > 0, 'The current runtime manifest must contain runtimeconfig.json.');

await assert.rejects(stat(outputRoot), error => error?.code === 'ENOENT');
await prepareReference();
capturedInputs.preparedConfigManifest = await treeSnapshot(path.join(referenceRoot, 'config'));
capturedInputs.preparedConfigManifest.entriesSha256 = sha256Text(JSON.stringify(capturedInputs.preparedConfigManifest.entries));
await writeFile(path.join(outputRoot, 'reference-runtime-manifest.json'), json(capturedInputs.runtimeManifest), { flag: 'wx' });
await writeFile(path.join(outputRoot, 'source-config-manifest.json'), json(capturedInputs.sourceConfigManifest), { flag: 'wx' });
await writeFile(path.join(outputRoot, 'prepared-config-manifest.json'), json(capturedInputs.preparedConfigManifest), { flag: 'wx' });
await writeFile(path.join(outputRoot, 'current-profile.json'), json(current.preparation), { flag: 'wx' });

const setupRecords = [];
const records = [];
const contracts = [];
const databaseStages = { beforeProvision: databaseSnapshot() };
const filesystemStages = { beforeProvision: await filesystemDomainSnapshot() };
const processStages = {};
let nativeGraph;
let scenarioError;
let setupInstance;
let setupToken;
let recordingInstance;
let accessToken;

assert.deepEqual(databaseStages.beforeProvision.foreignKeyCheck, []);

try {
  setupInstance = startReference('setup-reference');
  await waitForReady(setupInstance);
  const login = await request(setupRecords, 'setup-login-admin', '/Users/Me', {
    token: current.accessToken
  });
  assert.equal(login.status, 200, 'The current initialized admin session should succeed during setup.');
  setupToken = current.accessToken;
  assert.equal(idKey(login.bodyJson.Id), idKey(fixture.userId));
  const addRoute = `/Library/VirtualFolders?name=${encodeURIComponent(libraryName)}`
    + `&collectionType=movies&paths=${encodeURIComponent(filesystemDomainPaths.physicalLibrary)}&refreshLibrary=false`;
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
    const login = await request(records, 'recording-login-admin', '/Users/Me', {
      token: current.accessToken
    });
    assert.equal(login.status, 200, 'The current initialized admin session should succeed for recording.');
    accessToken = current.accessToken;
    assert.equal(idKey(login.bodyJson.Id), idKey(fixture.userId));
    await delay(500);
    databaseStages.beforeReads = databaseSnapshot();
    filesystemStages.beforeReads = await filesystemDomainSnapshot();
    assert.deepEqual(databaseStages.beforeReads.foreignKeyCheck, []);

    for (const testCase of fixture.cases) {
      const endpoints = testCase.endpoints ?? ['items', 'legacy'];
      const endpointContracts = [];
      for (const endpoint of endpoints) {
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
      }
      const primary = endpointContracts[0].contract;
      for (const entry of endpointContracts.slice(1)) {
        assert.deepEqual(entry.contract, primary, `${testCase.name}: ${endpoints.join(' and ')} diverged.`);
      }
      if (modeArgument === 'main') {
        const pinned = expectations.cases[contracts.length];
        assert.equal(pinned.name, testCase.name);
        for (const field of ['status', 'contentType', 'keys', 'orderedKeys', 'totalRecordCount', 'startIndex', 'problem']) {
          assert.deepEqual(primary[field], pinned[field], `${testCase.name}: native ${field} changed from discovery.`);
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
const databaseUnchangedDuringRequests = stageEquals(databaseStages.beforeReads, databaseStages.afterReads);
const databaseUnchangedAfterShutdown = stageEquals(databaseStages.afterReads, databaseStages.finalAfterShutdown);
const filesystemUnchangedDuringRequests = stageEquals(filesystemStages.beforeReads, filesystemStages.afterReads);
const filesystemUnchangedAfterShutdown = stageEquals(filesystemStages.afterReads, filesystemStages.finalAfterShutdown);
const foreignKeyCheckPassedAllStages = Object.values(databaseStages)
  .every(stage => Array.isArray(stage?.foreignKeyCheck) && stage.foreignKeyCheck.length === 0);
const processClean = processStages.setup?.cleanShutdown === true
  && processStages.setup?.code === 0
  && processStages.setup?.portAvailable === true
  && processStages.setup?.pidGone === true
  && processStages.recording?.cleanShutdown === true
  && processStages.recording?.code === 0
  && processStages.recording?.portAvailable === true
  && processStages.recording?.pidGone === true;
let mutationMatches = false;
if (databaseStages.beforeReads && databaseStages.afterReads && filesystemStages.beforeReads && filesystemStages.afterReads) {
  try {
    const before = databaseStages.beforeReads.tables;
    const after = databaseStages.afterReads.tables;
    const originalIds = new Set(before.BaseItems.map(item => idKey(item.Id)));
    const addedRows = after.BaseItems.filter(item => !originalIds.has(idKey(item.Id)));
    const stableRows = addedRows.map(item => ({
      name: item.Name,
      cleanName: item.CleanName,
      pathSuffix: String(item.Path).replaceAll('\\', '/').split('/').slice(1).join('/')
    })).sort((left, right) => left.name.localeCompare(right.name, 'en'));
    const expectedRows = [...expectations.mutations.baseItemsAdded]
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    assert.deepEqual(stableRows, expectedRows, 'Studio creation rows changed from discovery.');
    assert.equal(after.BaseItems.length, before.BaseItems.length + expectedRows.length);
    for (const table of Object.keys(before).filter(name => name !== 'BaseItems')) {
      assert.deepEqual(after[table], before[table], `${table} changed during Studio filter reads.`);
    }
    for (const domain of Object.keys(filesystemStages.beforeReads)) {
      const initial = filesystemStages.beforeReads[domain].entries;
      const final = filesystemStages.afterReads[domain].entries;
      const initialPaths = new Set(initial.map(entry => entry.path));
      const added = final.filter(entry => !initialPaths.has(entry.path));
      assert.deepEqual(final.filter(entry => initialPaths.has(entry.path)), initial,
        `${domain} existing files changed during Studio filter reads.`);
      assert.deepEqual(added.map(entry => entry.path).sort(),
        domain === 'metadata' ? [...expectations.mutations.directoriesAdded].sort() : [],
        `${domain} added paths changed from discovery.`);
      assert.ok(added.every(entry => entry.type === 'directory'), `${domain} added a non-directory entry.`);
    }
    mutationMatches = true;
  } catch (error) {
    scenarioError ??= error;
  }
}
const summary = {
  passed: scenarioError == null && processClean && portFinallyAvailable
    && foreignKeyCheckPassedAllStages && mutationMatches
    && databaseUnchangedAfterShutdown && filesystemUnchangedAfterShutdown,
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
  databaseUnchangedDuringRequests,
  databaseUnchangedAfterShutdown,
  filesystemUnchangedDuringRequests,
  filesystemUnchangedAfterShutdown,
  observedDatabaseMutation: !databaseUnchangedByReads,
  observedFilesystemMutation: !filesystemUnchangedByReads,
  mutationMatches,
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
    collectionHasExactlyOnePhysicalFolderId: nativeGraph.collectionPhysicalFolderIds.length === 1,
    physicalParentIsAggregate: idKey(nativeGraph.physicalRoot.ParentId) === idKey(nativeGraph.aggregateRoot.Id),
    physicalPathMatchesRequestedLocation: normalizePath(nativeGraph.physicalRoot.Path) === normalizePath(filesystemDomainPaths.physicalLibrary)
  },
  actual: {
    aggregateRoot: nativeGraph.aggregateRoot,
    userRoot: nativeGraph.userRoot,
    collectionView: nativeGraph.collectionView,
    physicalRoot: nativeGraph.physicalRoot,
    virtualFolder: nativeGraph.virtualFolder,
    collectionPhysicalFolderIds: nativeGraph.collectionPhysicalFolderIds
  },
  fixtureKeyMapping: Object.fromEntries(['aggregateRoot', 'userRoot', 'collectionView', 'physicalRoot'].map(key => [
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
  kind: 'studio-filters-native-contract',
  mode: modeArgument,
  fixtureInputSha256: capturedInputs.fixtureInputSha256,
  endpoints: ['/Items', '/Users/{userId}/Items'],
  setup: { libraryName, dynamicIdsExcluded: true },
  cases: contracts
}), { flag: 'wx' });
await writeFile(path.join(outputRoot, 'summary.json'), json(summary), { flag: 'wx' });

const artifactNames = [
  'current-profile.json',
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
await current.finish();
const gitHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
const dotnetInfo = spawnSync(dotnetPath, ['--info'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
await writeFile(path.join(outputRoot, 'provenance.json'), json({
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  gitHead: gitHead.status === 0 ? gitHead.stdout.trim() : null,
  scenario: 'Current designated Jellyfin HTTP Studios/StudioIds oracle across delimiter binders, invalid and empty GUIDs, selector type and name/clean-name resolution, repository versus memory filtering, predicate short-circuiting, AND/OR composition, and user-token versus API-key routes.',
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
    sourceInputsWereNotRunInPlace: true,
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
    { kind: 'currentSourceDatabase', path: path.relative(repoRoot, sourceDatabase).replaceAll('\\', '/'), sha256: capturedInputs.sourceDatabaseSha256 },
    { kind: 'fixtureInput', path: path.relative(repoRoot, fixtureInputPath).replaceAll('\\', '/'), sha256: capturedInputs.fixtureInputSha256 },
    { kind: 'pinnedExpectations', path: path.relative(repoRoot, expectationsPath).replaceAll('\\', '/'), sha256: capturedInputs.expectationsSha256 },
    { kind: 'recorderSource', path: path.relative(repoRoot, recorderPath).replaceAll('\\', '/'), sha256: capturedInputs.recorderSha256 },
    {
      kind: 'currentReleaseRuntimeTree', path: capturedInputs.runtimeManifest.root,
      fileCount: capturedInputs.runtimeManifest.fileCount, entriesSha256: capturedInputs.runtimeManifest.entriesSha256
    },
    ...capturedInputs.nativeSources.map(source => ({ kind: 'currentNativeSource', ...source }))
  ],
  result: {
    passed: summary.passed,
    process: summary.process,
    databaseUnchangedByReads,
    filesystemUnchangedByReads,
    databaseUnchangedDuringRequests,
    databaseUnchangedAfterShutdown,
    filesystemUnchangedDuringRequests,
    filesystemUnchangedAfterShutdown,
    observedDatabaseMutation: !databaseUnchangedByReads,
    observedFilesystemMutation: !filesystemUnchangedByReads,
    mutationMatches,
    foreignKeyCheckPassedAllStages
  },
  artifacts
}), { flag: 'wx' });

console.log(json({ outputRoot: publicOutputRoot, passed: summary.passed, contractsRecorded: summary.contractsRecorded }).trim());
if (scenarioError) throw scenarioError;
if (!summary.passed) throw new Error(`The isolated current reference did not complete cleanly: ${JSON.stringify(summary.process)}`);

return { outputRoot: publicOutputRoot, summary };
} catch (error) { failure = error; }
finally { await privateOutput.publishAndClose(); }
throw privateOutput.publicError(failure);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await recordStudioFilters(...process.argv.slice(2));
}
