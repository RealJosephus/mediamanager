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
export async function recordArtistFilters(outputArgument, portArgument, modeArgument = 'main') {
const modes = new Set(['main', 'discover', 'probe-unknown-credit', 'probe-bom-credit', 'probe-request-order', 'probe-bom-order']);
if (!outputArgument || !portArgument || !modes.has(modeArgument)) {
  throw new Error('Usage: node tools/compat/record-artist-filters.js <new-evidence-directory> <preferred-loopback-port> [main|discover|probe-unknown-credit|probe-bom-credit|probe-request-order|probe-bom-order]');
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
const fixtureInputPath = fileURLToPath(new URL('../../tests/library/fixtures/current-byname-filters/artist-input.json', import.meta.url));
const fixture = JSON.parse(await readFile(fixtureInputPath, 'utf8'));
const fixtureUserId = fixture.userId;
const current = await currentNativeReference({ fixtureUserId });
privateOutput.addSecret(current.accessToken);
fixture.userId = current.userId;
const { sourceRoot, sourceDatabase, runtimeRoot, jellyfinDll } = current;
const referenceRoot = path.join(outputRoot, 'reference');
const databasePath = path.join(referenceRoot, 'data/data/jellyfin.db');
const artistMetadataPath = path.join(referenceRoot, 'data/metadata/artists');
const recorderPath = fileURLToPath(import.meta.url);
const dotnetPath = validationExecutable('dotnet', { ...process.env, MEDIAMANAGER_DOTNET: current.dotnet });
const deviceId = 'artist-filter-native-oracle';
const apiKeyToken = 'artistfilterapikey00000000000000';
const itemByKey = new Map(fixture.items.map(item => [item.key, item]));
const valueByKey = new Map(fixture.itemValues.map(value => [value.key, value]));
const keyById = new Map(fixture.items.map(item => [item.id.replaceAll('-', '').toLowerCase(), item.key]));

const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2) + '\n';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const idKey = value => String(value).replaceAll('-', '').toLowerCase();
const upperId = value => String(value).toUpperCase();

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

const sha256Text = value => createHash('sha256').update(value).digest('hex');

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

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(file));
    else files.push(file);
  }
  return files;
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
  await cp(sourceDatabase, databasePath, { force: false, errorOnExist: true });

  await current.prepareClone(referenceRoot, port);
}

const relationshipTables = ['BaseItems', 'ItemValues', 'ItemValuesMap', 'AncestorIds', 'LinkedChildren', 'ApiKeys'];
const relationshipTableOrder = {
  BaseItems: '"Id"',
  ItemValues: '"ItemValueId"',
  ItemValuesMap: '"ItemId", "ItemValueId"',
  AncestorIds: '"ItemId", "ParentItemId"',
  LinkedChildren: '"ParentId", "SortOrder", "ChildId"',
  ApiKeys: '"Id"'
};

function relationshipSnapshot() {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tables = {};
    const rowCounts = {};
    for (const table of relationshipTables) {
      tables[table] = database.prepare(`SELECT * FROM "${table}" ORDER BY ${relationshipTableOrder[table]}`).all()
        .map(row => ({ ...row }));
      rowCounts[table] = tables[table].length;
    }
    return {
      scope: { rowSelection: 'all rows', tables: relationshipTables },
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
    assert.equal(database.prepare(`SELECT COUNT(*) AS "Count" FROM "BaseItems" WHERE "Id" LIKE '73000000-%'`).get().Count, 0);
    assert.equal(database.prepare(`SELECT COUNT(*) AS "Count" FROM "ItemValues" WHERE "ItemValueId" LIKE '73000000-%'`).get().Count, 0);
    assert.equal(database.prepare(`SELECT COUNT(*) AS "Count" FROM "ApiKeys" WHERE "AccessToken" = ?`).get(apiKeyToken).Count, 0);
  } finally {
    database.close();
  }
}

function seedDatabase() {
  const database = new DatabaseSync(databasePath);
  try {
    const folderTemplate = database.prepare('SELECT * FROM "BaseItems" WHERE "Id" = ?').get('11111111-1111-1111-1111-111111111111');
    const movieTemplate = database.prepare('SELECT * FROM "BaseItems" WHERE "Id" = ?').get('22222222-2222-2222-2222-222222222222');
    const aggregate = database.prepare(`SELECT "Id" FROM "BaseItems"
      WHERE "Type" = 'MediaBrowser.Controller.Entities.AggregateFolder' LIMIT 1`).get();
    assert.ok(folderTemplate && movieTemplate && aggregate, 'The current controlled media templates are required.');
    const typeNames = {
      Folder: 'MediaBrowser.Controller.Entities.Folder',
      BoxSet: 'MediaBrowser.Controller.Entities.Movies.BoxSet',
      Movie: 'MediaBrowser.Controller.Entities.Movies.Movie',
      MusicArtist: 'MediaBrowser.Controller.Entities.Audio.MusicArtist',
      MusicAlbum: 'MediaBrowser.Controller.Entities.Audio.MusicAlbum'
    };
    const fixedDate = '2026-09-28 02:00:00';
    const isolatedOrderSeedKeys = modeArgument === 'probe-request-order'
      ? new Set(['root', 'requestOrderByNameBobSelector', 'artistAlice', 'artistBob'])
      : modeArgument === 'probe-bom-order'
        ? new Set(['root', 'requestOrderByNameBobSelector', 'bomEmptyCleanOrphanCredit', 'artistBob'])
        : null;
    const seedItems = isolatedOrderSeedKeys
      ? fixture.items.filter(item => isolatedOrderSeedKeys.has(item.key))
      : fixture.items;
    const seedItemKeys = new Set(seedItems.map(item => item.key));
    const seedItemValueLinks = fixture.itemValueLinks.filter(link => seedItemKeys.has(link.itemKey));
    const seedValueKeys = new Set(seedItemValueLinks.map(link => link.valueKey));
    const seedItemValues = fixture.itemValues.filter(value => seedValueKeys.has(value.key));
    const seedItemIds = new Set(seedItems.map(item => idKey(item.id)));
    const seedLinkedChildren = fixture.links.filter(link => seedItemIds.has(idKey(link.parentId)) && seedItemIds.has(idKey(link.childId)));
    const inputById = new Map(seedItems.map(item => [idKey(item.id), item]));
    const ancestors = item => {
      if (Object.hasOwn(item, 'parentId') && item.parentId === null) return [];
      const values = [];
      let parentId = item.parentId;
      while (parentId) {
        values.push(parentId);
        parentId = inputById.get(idKey(parentId))?.parentId;
      }
      values.push(aggregate.Id);
      return [...new Set(values.map(upperId))];
    };

    database.exec('BEGIN IMMEDIATE');
    try {
      for (const item of seedItems) {
        const isFolder = item.isFolder ?? ['Folder', 'BoxSet', 'MusicArtist', 'MusicAlbum'].includes(item.type);
        const isMovie = item.type === 'Movie';
        const row = {
          ...(isFolder ? folderTemplate : movieTemplate),
          Id: upperId(item.id),
          Type: typeNames[item.type],
          ParentId: Object.hasOwn(item, 'parentId') && item.parentId === null
            ? null : upperId(item.parentId ?? aggregate.Id),
          TopParentId: Object.hasOwn(item, 'topParentId') && item.topParentId === null
            ? null : upperId(item.topParentId ?? fixture.rootId),
          PrimaryVersionId: item.primaryVersionId ? upperId(item.primaryVersionId) : null,
          OwnerId: item.ownerId ? upperId(item.ownerId) : null,
          Name: item.name,
          CleanName: item.cleanName ?? item.name.toLowerCase(),
          SortName: item.sortName ?? (item.cleanName ?? item.name.toLowerCase()),
          Path: `Z:\\ArtistFilterOracle\\${item.key}${isFolder ? '' : '.mkv'}`,
          ProductionYear: item.productionYear ?? null,
          ExtraType: item.extraType ?? null,
          IsFolder: isFolder ? 1 : 0,
          IsMovie: isMovie ? 1 : 0,
          MediaType: item.mediaType ?? (isMovie ? 'Video' : 'Unknown'),
          UnratedType: isMovie ? 'Movie' : ['MusicArtist', 'MusicAlbum'].includes(item.type) ? 'Music' : 'Other',
          PresentationUniqueKey: item.presentationUniqueKey ?? `artist-filter-oracle-${idKey(item.primaryVersionId ?? item.id)}`,
          DateCreated: fixedDate,
          DateModified: fixedDate,
          DateLastSaved: fixedDate,
          Data: item.dataText ?? JSON.stringify(item.data ?? {})
        };
        const columns = Object.keys(row);
        database.prepare(`INSERT INTO "BaseItems" (${columns.map(name => `"${name}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
          .run(...columns.map(name => row[name]));
        for (const parentId of ancestors(item)) {
          database.prepare('INSERT INTO "AncestorIds" ("ItemId", "ParentItemId") VALUES (?, ?)').run(row.Id, parentId);
        }
      }

      for (const value of seedItemValues) {
        database.prepare(`INSERT INTO "ItemValues" ("ItemValueId", "Type", "Value", "CleanValue") VALUES (?, ?, ?, ?)`)
          .run(upperId(value.id), value.type, value.value, value.cleanValue);
      }
      for (const link of seedItemValueLinks) {
        const item = itemByKey.get(link.itemKey);
        const value = valueByKey.get(link.valueKey);
        assert.ok(item && value, `Unknown item-value link: ${link.itemKey}/${link.valueKey}`);
        database.prepare('INSERT INTO "ItemValuesMap" ("ItemId", "ItemValueId") VALUES (?, ?)')
          .run(upperId(item.id), upperId(value.id));
      }
      for (const link of seedLinkedChildren) {
        database.prepare(`INSERT INTO "LinkedChildren" ("ParentId", "SortOrder", "ChildId", "ChildType") VALUES (?, ?, ?, ?)`)
          .run(upperId(link.parentId), link.sortOrder, upperId(link.childId), link.childType);
      }
      database.prepare(`INSERT INTO "ApiKeys" ("DateCreated", "DateLastActivity", "Name", "AccessToken") VALUES (?, ?, ?, ?)`)
        .run(fixedDate, fixedDate, 'Artist Filter Native Oracle', apiKeyToken);
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
  return `MediaBrowser Client="ArtistFilterNativeOracle", Device="Isolated", DeviceId="${deviceId}", Version="1"${token ? `, Token="${token}"` : ''}`;
}

function responseContract(response) {
  const items = Array.isArray(response.bodyJson?.Items) ? response.bodyJson.Items : [];
  const orderedIds = items.map(item => idKey(item.Id));
  const orderedKeys = items.map(item => keyById.get(idKey(item.Id)) ?? `unknown:${item.Id}`);
  const problem = response.status >= 400 && response.bodyJson && typeof response.bodyJson === 'object'
    ? Object.fromEntries(Object.entries(response.bodyJson).filter(([key]) => key !== 'traceId'))
    : null;
  const contract = {
    status: response.status,
    contentType: response.headers['content-type'] ?? null,
    totalRecordCount: response.bodyJson?.TotalRecordCount ?? null,
    ids: [...orderedIds].sort(),
    keys: [...orderedKeys].sort(),
    orderedIds,
    orderedKeys,
    items: items.map(item => ({
      key: keyById.get(idKey(item.Id)) ?? null,
      id: item.Id,
      name: item.Name,
      type: item.Type,
      productionYear: item.ProductionYear ?? null
    })),
    problem
  };
  return contract;
}

const expected = {
  'artist-ids-match-artist-and-album-artist': ['artistAlice', 'albumArtistAlice'],
  'album-artist-ids-match-only-album-role': ['albumArtistAlice'],
  'contributing-artist-requires-direct-artist': ['artistAlice'],
  'contributing-allows-unselected-album-artist': ['artistAliceAlbumBob'],
  'contributing-excludes-any-selected-album-artist': [],
  'exclude-artist-ids-cover-both-roles': ['artistBob', 'noCredit'],
  'artist-id-uses-persisted-clean-name': ['oddCredit'],
  'artist-id-missing-selector-matches-nothing': [],
  'exclude-missing-selector-is-no-op': ['artistAlice', 'noCredit'],
  'artist-ids-single-comma-or': ['artistAlice', 'artistBob'],
  'artist-and-album-artist-filters-are-and': ['artistAliceAlbumBob'],
  'artists-name-bridge': ['artistAlice', 'albumArtistAlice'],
  'artists-root-request-dispatches-filtered-repository-query': [],
  'artists-query-key-and-name-case-insensitive': ['artistAlice'],
  'artists-single-pipe-occurrence-splits': ['artistAlice', 'artistBob'],
  'artists-repeated-occurrences-are-values': ['artistAlice', 'artistBob'],
  'artists-repeated-occurrence-keeps-literal-pipe': ['literalPipeCredit', 'artistBob'],
  'artists-empty-preserves-direct-artist-ids': ['artistBob'],
  'artists-overwrite-direct-artist-ids': ['artistAlice'],
  'artists-whitespace-selects-first-library-artist': ['artistAlice'],
  'artists-whitespace-overwrites-direct-artist-ids': ['artistAlice'],
  'artists-repeated-whitespace-and-name-union': ['artistAlice', 'artistBob'],
  'artists-name-bridge-excludes-owned-selector': ['ownerEligibleCredit'],
  'artists-name-bridge-excludes-hidden-alternate-selector': ['alternatePrimaryCredit'],
  'artists-raw-name-keeps-sharp-s-distinct-from-ss': ['unicodeSharpCredit'],
  'artists-raw-name-ascii-ss-does-not-fold-to-sharp-s': ['unicodeSsCredit'],
  'artist-ids-invalid-only-drops-filter': ['artistAlice', 'noCredit'],
  'artist-ids-valid-and-invalid-keeps-valid': ['artistAlice'],
  'artist-ids-repeated-comma-occurrence-is-not-split': ['artistBob'],
  'artist-ids-p-format': ['artistAlice'],
  'artist-ids-n-format': ['artistAlice'],
  'artist-ids-b-format': ['artistAlice'],
  'artist-ids-bom-wrapped-guid-is-discarded': ['artistAlice', 'noCredit'],
  'artist-ids-single-x-format-is-split-away': ['artistAlice', 'noCredit'],
  'artist-ids-repeated-x-format-is-accepted': ['artistAlice', 'artistBob'],
  'artist-ids-repeated-x-format-nel-whitespace-is-accepted': ['artistAlice', 'artistBob'],
  'artist-ids-repeated-x-format-bom-whitespace-is-rejected': ['artistBob'],
  'artist-filter-does-not-propagate-to-ancestors': ['ancestorChild'],
  'artist-filter-does-not-propagate-to-linked-parent': ['linkedChild'],
  'artist-filter-can-match-folder-own-value': ['ownCreditFolder'],
  'artist-filter-does-not-expand-alternate-to-primary': [],
  'artist-filter-excludes-owned-non-extra-but-keeps-extra': ['ownedExtra'],
  'artist-selector-outside-result-scope-still-drives': ['outsideCredit'],
  'user-artist-presentation-grouping': ['groupFirst'],
  'api-key-artist-does-not-group-modern': ['groupFirst', 'groupSecond'],
  'api-key-artist-modern-with-user-id': ['groupFirst'],
  'api-key-artist-legacy-route': ['groupFirst'],
  'user-artist-group-count-before-page': ['artistAlice'],
  'music-album-artist-default-order': ['albumAlpha2025', 'albumBeta2024', 'albumZeta2025']
};
const expectedTotalCounts = { 'user-artist-group-count-before-page': 2 };
const expectedOrders = { 'music-album-artist-default-order': ['albumAlpha2025', 'albumZeta2025', 'albumBeta2024'] };
const discoveryOnly = modeArgument === 'discover' ? new Set(fixture.cases.map(testCase => testCase.name)) : new Set();
const probeCases = {
  'probe-unknown-credit': [{
    name: 'artists-unknown-name-creates-selector-and-matches-orphan-credit',
    query: 'ArtistIds=73000000-0000-0000-0000-000000000002&Artists=NativeMissingArtist',
    scope: ['unknownNameOrphanCredit', 'artistBob', 'noCredit']
  }],
  'probe-bom-credit': [{
    name: 'artists-bom-name-creates-empty-clean-selector-and-matches-orphan-credit',
    query: 'Artists=%EF%BB%BF',
    scope: ['bomEmptyCleanOrphanCredit', 'artistAlice', 'noCredit']
  }],
  'probe-request-order': [{
    name: 'artists-repeated-name-then-whitespace-observes-request-local-created-selector',
    query: 'Artists=Alice&Artists=%20%20',
    scope: ['artistAlice', 'artistBob']
  }],
  'probe-bom-order': [{
    name: 'artists-bom-then-whitespace-observes-created-selector-but-prefers-bob-sort',
    query: 'Artists=%EF%BB%BF&Artists=%20%20',
    scope: ['bomEmptyCleanOrphanCredit', 'artistBob']
  }]
};
const probeExpectation = {
  'probe-unknown-credit': {
    responseKeys: ['unknownNameOrphanCredit'],
    artistName: 'NativeMissingArtist',
    artistCleanName: 'nativemissingartist',
    exactDirectoryEntry: { type: 'directory', path: 'NativeMissingArtist' }
  },
  'probe-bom-credit': {
    responseKeys: ['bomEmptyCleanOrphanCredit'],
    artistName: '\uFEFF',
    artistCleanName: ''
  },
  'probe-request-order': {
    responseKeys: ['artistAlice'],
    artistName: 'Alice',
    artistCleanName: 'alice',
    exactDirectoryEntry: { type: 'directory', path: 'Alice' },
    requireOnlyByNameArtistBeforeRead: true
  },
  'probe-bom-order': {
    responseKeys: ['artistBob', 'bomEmptyCleanOrphanCredit'],
    artistName: '\uFEFF',
    artistCleanName: '',
    exactDirectoryEntry: { type: 'directory', path: '\uFEFF' },
    requireOnlyByNameArtistBeforeRead: true
  }
}[modeArgument];
const runCases = probeCases[modeArgument] ?? fixture.cases;
const isMainRun = modeArgument === 'main' || modeArgument === 'discover';

const sourcePaths = [
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.TranslateQuery.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.QueryBuilding.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.Querying.cs',
  'Jellyfin.Api/Controllers/ItemsController.cs',
  'Jellyfin.Api/Helpers/RequestHelpers.cs',
  'Jellyfin.Api/ModelBinders/CommaDelimitedCollectionModelBinder.cs',
  'Jellyfin.Api/ModelBinders/PipeDelimitedCollectionModelBinder.cs',
  'src/Jellyfin.Database/Jellyfin.Database.Implementations/JellyfinQueryHelperExtensions.cs',
  'src/Jellyfin.Database/Jellyfin.Database.Implementations/Entities/BaseItemEntity.cs',
  'src/Jellyfin.Database/Jellyfin.Database.Implementations/Entities/ItemValue.cs',
  'src/Jellyfin.Database/Jellyfin.Database.Implementations/Entities/ItemValueMap.cs',
  'src/Jellyfin.Database/Jellyfin.Database.Implementations/Entities/ItemValueType.cs',
  'MediaBrowser.Controller/Entities/InternalItemsQuery.cs',
  'MediaBrowser.Controller/Entities/Audio/MusicArtist.cs',
  'Emby.Server.Implementations/Library/LibraryManager.cs',
  'Jellyfin.Server.Implementations/Item/ItemPersistenceService.cs'
];

// Capture every oracle input before the reference process starts. Derived contracts and tests are deliberately absent.
const capturedInputs = {
  referencePreparation: current.preparation,
  fixtureInputSha256: await sha256(fixtureInputPath),
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
assertSeedIdentifiersAbsent();
const databaseStages = { beforeSeed: relationshipSnapshot() };
assert.deepEqual(databaseStages.beforeSeed.foreignKeyCheck, []);
seedDatabase();
databaseStages.afterSeed = relationshipSnapshot();
assert.deepEqual(databaseStages.afterSeed.foreignKeyCheck, []);
const filesystemStages = { afterSeed: await treeSnapshot(artistMetadataPath) };

const instance = current.start({ referenceRoot, outputRoot, label: 'reference', origin });
const { child, arguments: argumentsList } = instance;

const records = [];
const contracts = [];
const probeStages = {};
const probeObservations = {};
let accessToken;
let scenarioError;
let cleanShutdown = false;
let processResult;
const processLifecycle = [];

async function request(name, route, { method = 'GET', token = accessToken, body } = {}) {
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
  try { bodyJson = bodyText === '' ? null : JSON.parse(bodyText); }
  catch { bodyJson = undefined; }
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

async function waitForReady() { await instance.ready(); }

function routeFor(endpoint, testCase) {
  const scopeIds = testCase.omitScope ? null : testCase.scope.map(key => {
    const item = itemByKey.get(key);
    assert.ok(item, `Unknown fixture scope key: ${key}`);
    return item.id;
  }).join(',');
  const parts = [
    ...(!testCase.omitScope ? [
      `ParentId=${encodeURIComponent(fixture.rootId)}`,
      'Recursive=true',
      `Ids=${encodeURIComponent(scopeIds)}`
    ] : []),
    ...(!testCase.omitSortBy ? ['SortBy=SortName'] : []),
    'Fields=ProductionYear',
    'EnableImages=false',
    'EnableUserData=false',
    testCase.query.replaceAll(fixtureUserId, fixture.userId)
  ];
  const prefix = endpoint === 'items' ? '/Items' : `/Users/${fixture.userId}/Items`;
  return `${prefix}?${parts.join('&')}`;
}

try {
  await waitForReady();
  const login = await request('login-admin', '/Users/Me', {
    token: current.accessToken
  });
  assert.equal(login.status, 200, 'The current initialized admin session should succeed.');
  accessToken = current.accessToken;
  assert.equal(idKey(login.bodyJson.Id), idKey(fixture.userId));
  databaseStages.beforeReads = relationshipSnapshot();
  filesystemStages.beforeReads = await treeSnapshot(artistMetadataPath);
  assert.deepEqual(databaseStages.beforeReads, databaseStages.afterSeed);
  if (probeExpectation?.requireOnlyByNameArtistBeforeRead) {
    const preRequestMusicArtists = databaseStages.beforeReads.tables.BaseItems
      .filter(row => row.Type === 'MediaBrowser.Controller.Entities.Audio.MusicArtist');
    assert.equal(preRequestMusicArtists.length, 1);
    assert.equal(preRequestMusicArtists[0].Name, 'Bob');
    assert.equal(preRequestMusicArtists[0].CleanName, 'bob');
    assert.equal(preRequestMusicArtists[0].ParentId, null);
    assert.equal(preRequestMusicArtists[0].TopParentId, null);
    probeObservations.preRequestMusicArtists = preRequestMusicArtists;
  }

  for (const testCase of runCases) {
    const endpoints = testCase.endpoints ?? ['items', 'legacy'];
    const endpointContracts = [];
    for (const endpoint of endpoints) {
      const token = testCase.auth === 'apiKey' ? apiKeyToken : accessToken;
      const response = await request(`${testCase.name}:${endpoint}`, routeFor(endpoint, testCase), { token });
      const contract = responseContract(response);
      endpointContracts.push({ endpoint, contract });
      if (!isMainRun) {
        probeStages[`${testCase.name}:${endpoint}`] = {
          database: relationshipSnapshot(),
          artistDirectory: await treeSnapshot(artistMetadataPath)
        };
      }
    }
    const primaryContract = endpointContracts[0].contract;
    for (const entry of endpointContracts.slice(1)) {
      assert.deepEqual(entry.contract, primaryContract, `${testCase.name}: ${endpoints.join(' and ')} diverged.`);
    }
    if (isMainRun && !discoveryOnly.has(testCase.name)) {
      assert.ok(Object.hasOwn(expected, testCase.name), `${testCase.name}: missing pinned expectation.`);
      assert.equal(primaryContract.status, 200, `${testCase.name}: expected a successful HTTP response.`);
      assert.equal(primaryContract.contentType, 'application/json; charset=utf-8', `${testCase.name}: unexpected content type.`);
      const expectedKeys = [...expected[testCase.name]].sort();
      const expectedIds = expectedKeys.map(key => idKey(itemByKey.get(key).id)).sort();
      assert.deepEqual(primaryContract.keys, expectedKeys, `${testCase.name}: unexpected item membership.`);
      assert.deepEqual(primaryContract.ids, expectedIds, `${testCase.name}: unexpected result ids.`);
      assert.equal(primaryContract.totalRecordCount, expectedTotalCounts[testCase.name] ?? expectedKeys.length,
        `${testCase.name}: unexpected total count.`);
      assert.equal(primaryContract.problem, null, `${testCase.name}: successful response exposed a problem.`);
      if (testCase.assertOrder) {
        assert.deepEqual(primaryContract.orderedKeys, expectedOrders[testCase.name], `${testCase.name}: unexpected response order.`);
        assert.deepEqual(primaryContract.orderedIds, expectedOrders[testCase.name].map(key => idKey(itemByKey.get(key).id)),
          `${testCase.name}: unexpected ordered ids.`);
      }
    } else if (!isMainRun) {
      assert.equal(primaryContract.status, 200, `${testCase.name}: probe should return a successful HTTP response.`);
      assert.equal(primaryContract.problem, null, `${testCase.name}: probe exposed a problem response.`);
      if (probeExpectation) {
        assert.deepEqual(primaryContract.keys, [...probeExpectation.responseKeys].sort());
        assert.deepEqual([...primaryContract.orderedKeys].sort(), [...probeExpectation.responseKeys].sort());
        assert.equal(primaryContract.totalRecordCount, probeExpectation.responseKeys.length);
      }
    }
    contracts.push({
      name: testCase.name,
      query: testCase.query,
      scope: testCase.scope,
      auth: testCase.auth ?? 'user',
      endpoints,
      omitScope: testCase.omitScope ?? false,
      omitSortBy: testCase.omitSortBy ?? false,
      assertOrder: testCase.assertOrder ?? false,
      discoveryOnly: discoveryOnly.has(testCase.name),
      ...primaryContract
    });
  }

  databaseStages.afterReads = relationshipSnapshot();
  filesystemStages.afterReads = await treeSnapshot(artistMetadataPath);
  if (isMainRun) {
    assert.deepEqual(databaseStages.afterReads, databaseStages.beforeReads);
    assert.deepEqual(filesystemStages.afterReads, filesystemStages.beforeReads);
  } else if (probeExpectation) {
    const beforeIds = new Set(databaseStages.beforeReads.tables.BaseItems.map(row => row.Id));
    const newBaseItems = databaseStages.afterReads.tables.BaseItems.filter(row => !beforeIds.has(row.Id));
    const createdArtists = newBaseItems.filter(row => row.Type === 'MediaBrowser.Controller.Entities.Audio.MusicArtist'
      && row.Name === probeExpectation.artistName
      && row.CleanName === probeExpectation.artistCleanName);
    const beforePaths = new Set(filesystemStages.beforeReads.entries.map(entry => `${entry.type}:${entry.path}`));
    const newArtistDirectoryEntries = filesystemStages.afterReads.entries
      .filter(entry => !beforePaths.has(`${entry.type}:${entry.path}`));
    assert.equal(createdArtists.length, 1, 'Unknown Artists lookup must persist exactly one matching MusicArtist row.');
    assert.equal(createdArtists[0].ParentId, null);
    assert.equal(createdArtists[0].TopParentId, null);
    assert.notDeepEqual(filesystemStages.afterReads, filesystemStages.beforeReads,
      'Unknown Artists lookup must create or change its metadata artist directory tree.');
    if (probeExpectation.exactDirectoryEntry) {
      assert.ok(newArtistDirectoryEntries.some(entry => entry.type === probeExpectation.exactDirectoryEntry.type
          && entry.path === probeExpectation.exactDirectoryEntry.path),
      'Unknown Artists lookup must create its expected metadata artist directory.');
    }
    probeObservations.newBaseItems = newBaseItems;
    probeObservations.createdArtists = createdArtists;
    probeObservations.artistDirectoryCreated = !filesystemStages.beforeReads.exists && filesystemStages.afterReads.exists;
    probeObservations.newArtistDirectoryEntries = newArtistDirectoryEntries;
  }
} catch (error) {
  scenarioError = error;
} finally {
  const outcome = await instance.stop(async () => (await request('authenticated-shutdown', '/System/Shutdown',
    { method: 'POST', token: current.accessToken })).status, () => available(port));
  cleanShutdown = outcome.cleanShutdown;
  processResult = { code: outcome.code, signal: outcome.signal };
  processLifecycle.push(...outcome.lifecycle);
  if (outcome.error) scenarioError ??= new Error(outcome.error.message);

}

databaseStages.finalAfterShutdown = relationshipSnapshot();
filesystemStages.finalAfterShutdown = await treeSnapshot(artistMetadataPath);
if (isMainRun) {
  try {
    assert.deepEqual(databaseStages.finalAfterShutdown, databaseStages.beforeReads);
    assert.deepEqual(filesystemStages.finalAfterShutdown, filesystemStages.beforeReads);
  } catch (error) {
    scenarioError ??= error;
  }
} else if (probeExpectation && probeObservations.createdArtists) {
  try {
    for (const artist of probeObservations.createdArtists) {
      assert.ok(databaseStages.finalAfterShutdown.tables.BaseItems.some(row => row.Id === artist.Id));
    }
    assert.deepEqual(filesystemStages.finalAfterShutdown, filesystemStages.afterReads);
  } catch (error) {
    scenarioError ??= error;
  }
}
const portFinallyAvailable = await available(port);
const databaseUnchangedByReads = databaseStages.beforeReads !== undefined
  && JSON.stringify(databaseStages.beforeReads) === JSON.stringify(databaseStages.afterReads)
  && JSON.stringify(databaseStages.beforeReads) === JSON.stringify(databaseStages.finalAfterShutdown);
const filesystemUnchangedByReads = filesystemStages.beforeReads !== undefined
  && JSON.stringify(filesystemStages.beforeReads) === JSON.stringify(filesystemStages.afterReads)
  && JSON.stringify(filesystemStages.beforeReads) === JSON.stringify(filesystemStages.finalAfterShutdown);
const foreignKeyCheckPassedAllStages = [
  ...Object.values(databaseStages),
  ...Object.values(probeStages).map(stage => stage.database)
].every(stage => Array.isArray(stage?.foreignKeyCheck) && stage.foreignKeyCheck.length === 0);
const summary = {
  passed: scenarioError == null && cleanShutdown && processResult?.code === 0 && portFinallyAvailable
    && foreignKeyCheckPassedAllStages
    && (!isMainRun || (databaseUnchangedByReads && filesystemUnchangedByReads)),
  mode: modeArgument,
  origin,
  fixtureCases: isMainRun ? fixture.cases.length : 0,
  probeCases: isMainRun ? 0 : runCases.length,
  httpRecords: records.length,
  endpointCases: contracts.reduce((total, entry) => total + entry.endpoints.length, 0),
  discoveryOnlyCases: [...discoveryOnly],
  databaseUnchangedByReads,
  filesystemUnchangedByReads,
  observedDatabaseMutation: !databaseUnchangedByReads,
  observedFilesystemMutation: !filesystemUnchangedByReads,
  foreignKeyCheckPassedAllStages,
  probeObservations,
  process: {
    pid: child.pid,
    ...processResult,
    cleanShutdown,
    preferredPort,
    preferredPortInitiallyAvailable,
    selectedPort: port,
    portInitiallyAvailable,
    portFinallyAvailable,
    lifecycle: processLifecycle
  },
  error: scenarioError ? { name: scenarioError.name, message: scenarioError.message, stack: scenarioError.stack } : null
};

await writeFile(path.join(outputRoot, 'native-http.json'), json({ schemaVersion: 2, origin, mode: modeArgument, records }), { flag: 'wx' });
await writeFile(path.join(outputRoot, 'database-stages.json'), json({
  schemaVersion: 2,
  snapshotScope: { rowSelection: 'all rows', tables: relationshipTables, includesForeignKeyCheck: true },
  ...databaseStages,
  probeStages
}), { flag: 'wx' });
await writeFile(path.join(outputRoot, 'filesystem-stages.json'), json({ schemaVersion: 2, ...filesystemStages }), { flag: 'wx' });
await writeFile(path.join(outputRoot, 'native-contract.json'), json({
  schemaVersion: 2,
  referenceProfile: 'current-designated-source-byname-http',
  mode: modeArgument,
  fixtureInputSha256: capturedInputs.fixtureInputSha256,
  endpoints: ['/Items', '/Users/{userId}/Items'],
  cases: contracts
}), { flag: 'wx' });
await writeFile(path.join(outputRoot, 'summary.json'), json(summary), { flag: 'wx' });

const artifactNames = [
  'current-profile.json',
  'native-http.json', 'database-stages.json', 'filesystem-stages.json', 'native-contract.json', 'summary.json',
  'reference-runtime-manifest.json', 'source-config-manifest.json', 'prepared-config-manifest.json',
  'reference-stdout.log', 'reference-stderr.log'
];
const artifacts = [];
for (const name of artifactNames) artifacts.push({ path: name, sha256: await sha256(path.join(outputRoot, name)) });
await current.finish();
const gitHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
const dotnetInfo = spawnSync(dotnetPath, ['--info'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
await writeFile(path.join(outputRoot, 'provenance.json'), json({
  schemaVersion: 2,
  recordedAt: new Date().toISOString(),
  gitHead: gitHead.status === 0 ? gitHead.stdout.trim() : null,
  scenario: isMainRun
    ? 'Current designated Jellyfin HTTP Artists/ArtistIds/AlbumArtistIds/ContributingArtistIds/ExcludeArtistIds oracle across public Items routes, users/API keys, binders, name bridging, persisted clean names, relation topology, grouping, paging, and MusicAlbum default ordering.'
    : `Disposable current Jellyfin HTTP ${modeArgument} probe for Artists name lookup side effects.`,
  isolation: {
    sourceInstance: path.relative(repoRoot, sourceRoot).replaceAll('\\', '/'),
    sourceDatabase: path.relative(repoRoot, sourceDatabase).replaceAll('\\', '/'),
    clonedInstance: path.relative(repoRoot, referenceRoot).replaceAll('\\', '/'),
    loopbackOnly: true,
    autoDiscovery: false,
    preferredPort,
    preferredPortInitiallyAvailable,
    selectedPort: port,
    portInitiallyAvailable,
    portFinallyAvailable,
    sourceInputsWereNotRunInPlace: true,
    syntheticCredentialsAndTokensOnly: true,
    disposableSideEffectProbe: !isMainRun
  },
  recorderInvocation: [
    process.execPath,
    path.relative(repoRoot, fileURLToPath(import.meta.url)).replaceAll('\\', '/'),
    path.relative(repoRoot, outputRoot).replaceAll('\\', '/'),
    String(preferredPort),
    modeArgument
  ],
  referenceCommand: [path.relative(repoRoot, dotnetPath).replaceAll('\\', '/'), ...argumentsList.map(value => path.isAbsolute(value)
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
  referenceAssemblies: [{
    path: path.relative(repoRoot, jellyfinDll).replaceAll('\\', '/'),
    sha256: capturedInputs.runtimeManifest.entries.find(entry => entry.path.toLowerCase() === 'jellyfin.dll')?.sha256 ?? null
  }],
  nativeSources: capturedInputs.nativeSources,
  recorder: {
    path: path.relative(repoRoot, recorderPath).replaceAll('\\', '/'),
    sha256: capturedInputs.recorderSha256
  },
  preparedInputs: [
    ...capturedInputs.referencePreparation.inputs,
    {
      kind: 'currentSourceDatabase',
      path: path.relative(repoRoot, sourceDatabase).replaceAll('\\', '/'),
      sha256: capturedInputs.sourceDatabaseSha256
    },
    {
      kind: 'fixtureInput',
      path: path.relative(repoRoot, fixtureInputPath).replaceAll('\\', '/'),
      sha256: capturedInputs.fixtureInputSha256
    },
    {
      kind: 'recorderSource',
      path: path.relative(repoRoot, recorderPath).replaceAll('\\', '/'),
      sha256: capturedInputs.recorderSha256
    },
    {
      kind: 'currentReleaseRuntimeTree',
      path: capturedInputs.runtimeManifest.root,
      fileCount: capturedInputs.runtimeManifest.fileCount,
      entriesSha256: capturedInputs.runtimeManifest.entriesSha256
    },
    {
      kind: 'sourceConfigTree',
      path: path.relative(repoRoot, path.join(sourceRoot, 'config')).replaceAll('\\', '/'),
      entryCount: capturedInputs.sourceConfigManifest.entries.length,
      entriesSha256: capturedInputs.sourceConfigManifest.entriesSha256
    },
    {
      kind: 'preparedCloneConfigTree',
      path: path.relative(repoRoot, path.join(referenceRoot, 'config')).replaceAll('\\', '/'),
      entryCount: capturedInputs.preparedConfigManifest.entries.length,
      entriesSha256: capturedInputs.preparedConfigManifest.entriesSha256
    },
    ...capturedInputs.nativeSources.map(source => ({ kind: 'currentNativeSource', ...source }))
  ],
  result: {
    passed: summary.passed,
    process: summary.process,
    discoveryOnlyCases: summary.discoveryOnlyCases,
    databaseUnchangedByReads,
    filesystemUnchangedByReads,
    foreignKeyCheckPassedAllStages,
    observedDatabaseMutation: summary.observedDatabaseMutation,
    observedFilesystemMutation: summary.observedFilesystemMutation,
    probeObservations
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
  await recordArtistFilters(...process.argv.slice(2));
}
