// Scenario-driven frozen-Jellyfin HTTP recorder for item-filter compatibility fixtures.
// The same source is copied into every evidence root as record-native.mjs so the
// consumer-visible recorder hash binds the seed, request matrix, and capture logic.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rmdir, stat, symlink, unlink,
  writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(process.cwd());
const validationModule = await import(pathToFileURL(path.join(repoRoot, 'tools/validation/paths.js')));
const preparationModule = await import(pathToFileURL(path.join(repoRoot, 'tools/compat/filter-reference-inputs.mjs')));
const { assertValidationOutputChild, validationExecutable, validationOutputRoot, validationPath } = validationModule;
const { captureFilterReferencePreparation } = preparationModule;
const idKey = value => String(value).replaceAll('-', '').toLowerCase();
const upperId = value => String(value).toUpperCase();
const sha256Bytes = bytes => createHash('sha256').update(bytes).digest('hex');

const OFFICIAL_RATING_CASES = [
  { name: 'pg13', query: 'OfficialRatings=PG-13' },
  { name: 'r', query: 'OfficialRatings=R' },
  { name: 'pg13-or-r-pipe', query: 'OfficialRatings=PG-13%7CR' },
  { name: 'pg13-or-r-comma', query: 'OfficialRatings=PG-13,R' },
  { name: 'case-insensitive', query: 'OfficialRatings=pg-13' },
  { name: 'unknown', query: 'OfficialRatings=Unclassified' },
  { name: 'empty-omitted', query: 'OfficialRatings=' },
  { name: 'whitespace', query: 'OfficialRatings=%20' },
  { name: 'repeated-values', query: 'OfficialRatings=PG-13&OfficialRatings=R' },
  { name: 'repeated-empty', query: 'OfficialRatings=&OfficialRatings=' },
  { name: 'rating-then-empty', query: 'OfficialRatings=PG-13&OfficialRatings=' },
  { name: 'empty-then-rating', query: 'OfficialRatings=&OfficialRatings=R' },
  { name: 'pg13-only-scope', query: 'OfficialRatings=PG-13', scope: ['pg13'] },
  { name: 'r-only-scope', query: 'OfficialRatings=R', scope: ['r'] },
  { name: 'unrated-only-scope', query: 'OfficialRatings=', scope: ['empty'] },
  { name: 'physical-descendant-boundary', query: 'OfficialRatings=PG-13', scope: ['physicalRoot', 'pg13', 'empty'] },
  { name: 'aggregate-descendant-boundary', query: 'OfficialRatings=R', scope: ['aggregateRoot', 'physicalRoot', 'r'] },
];

const OFFICIAL_RATING_RANGE_CASES = [
  { name: 'minimum-pg13', query: 'MinOfficialRating=PG-13' },
  { name: 'minimum-tv14', query: 'MinOfficialRating=TV-14' },
  { name: 'minimum-tv14d', query: 'MinOfficialRating=TV-14-D' },
  { name: 'minimum-r', query: 'MinOfficialRating=R' },
  { name: 'maximum-pg13', query: 'MaxOfficialRating=PG-13' },
  { name: 'maximum-tv14', query: 'MaxOfficialRating=TV-14' },
  { name: 'maximum-tv14d', query: 'MaxOfficialRating=TV-14-D' },
  { name: 'maximum-r', query: 'MaxOfficialRating=R' },
  { name: 'bounded-tv14', query: 'MinOfficialRating=TV-14&MaxOfficialRating=TV-14' },
  { name: 'has-rating-true', query: 'HasParentalRating=true' },
  { name: 'has-rating-false', query: 'HasParentalRating=false' },
  { name: 'has-false-with-maximum', query: 'HasParentalRating=false&MaxOfficialRating=PG-13' },
  { name: 'invalid-minimum', query: 'MinOfficialRating=INVALID' },
  { name: 'invalid-maximum', query: 'MaxOfficialRating=INVALID' },
  { name: 'empty-minimum', query: 'MinOfficialRating=' },
  { name: 'repeated-minimum-first', query: 'MinOfficialRating=TV-14-D&MinOfficialRating=R' },
  { name: 'numeric-minimum', query: 'MinOfficialRating=14' },
  { name: 'numeric-maximum', query: 'MaxOfficialRating=14' },
  { name: 'block-unrated-has-false', query: 'HasParentalRating=false', blockUnrated: ['Movie'] },
  { name: 'block-unrated-maximum', query: 'MaxOfficialRating=TV-14', blockUnrated: ['Movie'] },
];

const TAG_CASES = [
  { name: 'alpha', query: 'Tags=Alpha' },
  { name: 'beta', query: 'Tags=Beta' },
  { name: 'shared', query: 'Tags=Shared' },
  { name: 'accented', query: 'Tags=Caf%C3%A9' },
  { name: 'clean-accent', query: 'Tags=Cafe' },
  { name: 'case-insensitive', query: 'Tags=alpha' },
  { name: 'column-only', query: 'Tags=ColumnOnly' },
  { name: 'stored-column-value', query: 'Tags=StoredA' },
  { name: 'pipe-values', query: 'Tags=Alpha%7CBeta' },
  { name: 'comma-value', query: 'Tags=Alpha,Beta' },
  { name: 'unknown', query: 'Tags=Missing' },
  { name: 'empty-omitted', query: 'Tags=' },
  { name: 'repeated-values', query: 'Tags=Alpha&Tags=Beta' },
  { name: 'repeated-empty', query: 'Tags=&Tags=' },
  { name: 'value-then-empty', query: 'Tags=Alpha&Tags=' },
  { name: 'empty-then-value', query: 'Tags=&Tags=Alpha' },
  { name: 'whitespace', query: 'Tags=%20' },
];

const RATING_PERMISSION_CASES = [
  { label: 'unrestricted', maxRating: null, blockUnrated: [] },
  { label: 'maximum-nine', maxRating: 9, blockUnrated: [] },
  { label: 'maximum-ten', maxRating: 10, blockUnrated: [] },
  { label: 'maximum-ten-block-unrated', maxRating: 10, blockUnrated: ['Movie'] },
].flatMap(policy => ['alpha', 'beta', 'gamma'].map(detailKey => ({
  name: `${policy.label}-${detailKey}`,
  query: 'IncludeItemTypes=Movie',
  detailKey,
  maxRating: policy.maxRating,
  blockUnrated: policy.blockUnrated,
  detailExpectedStatus: policy.label === 'unrestricted' ? 200 : 404,
  endpoints: ['items', 'legacy', 'detail'],
})));

const TAG_PERMISSION_CASES = [
  { label: 'unrestricted', allowedTags: [], blockedTags: [] },
  { label: 'allow-family', allowedTags: ['Family'], blockedTags: [] },
  { label: 'allow-missing', allowedTags: ['Missing'], blockedTags: [] },
  { label: 'block-blocked', allowedTags: [], blockedTags: ['blocked'] },
].flatMap(policy => ['alpha', 'beta', 'gamma', 'nested'].map(detailKey => ({
  name: `${policy.label}-${detailKey}`,
  query: 'IncludeItemTypes=Movie',
  detailKey,
  allowedTags: policy.allowedTags,
  blockedTags: policy.blockedTags,
  detailExpectedStatus: policy.label === 'allow-missing'
    || (policy.label === 'block-blocked' && detailKey !== 'alpha') ? 404 : 200,
  endpoints: ['items', 'legacy', 'detail'],
})));

const catalog = {
  classification: {
    evidenceName: 'classification-filters-native-v1',
    runDirectory: 'native-run',
    fixture: 'tests/library/fixtures/classification-filters/input.json',
    fields: 'SortName',
    recordScope: 'scope',
    defaultScope: 'non-root',
    expectedRecords: 48,
  },
  'extra-placeholder': {
    evidenceName: 'extra-placeholder-filters-native-v1',
    runDirectory: 'native-run',
    fixture: 'tests/library/fixtures/extra-placeholder-filters/input.json',
    fields: 'SortName',
    recordScope: 'scope',
    defaultScope: 'non-root',
    expectedRecords: 36,
  },
  'image-type': {
    evidenceName: 'image-type-filters-native-v1',
    runDirectory: 'native-run',
    fixture: 'tests/library/fixtures/image-type-filters/input.json',
    fields: 'SortName',
    recordScope: 'scope',
    defaultScope: 'all',
    expectedRecords: 40,
  },
  'navigation-date': {
    evidenceName: 'navigation-date-filters-native-v1',
    runDirectory: 'native-run',
    fixture: 'tests/library/fixtures/navigation-date-filters/input.json',
    fields: 'SortName',
    recordScope: 'scope',
    defaultScope: 'non-root',
    expectedRecords: 40,
    recordExpectedStatus: true,
  },
  'official-ratings': {
    evidenceName: 'official-ratings-native-v1',
    runDirectory: 'native-run',
    fixture: 'tests/library/fixtures/official-rating-filters/input.json',
    fields: 'SortName',
    recordScope: 'scopeIds',
    defaultScope: 'movies',
    cases: OFFICIAL_RATING_CASES,
    expectedRecords: 34,
  },
  'official-rating-range': {
    evidenceName: 'official-rating-range-native-v1',
    runDirectory: 'native-run',
    fixture: 'tests/library/fixtures/official-rating-range/input.json',
    fields: 'SortName',
    recordScope: 'blockUnrated',
    defaultScope: 'movies',
    cases: OFFICIAL_RATING_RANGE_CASES,
    expectedRecords: 40,
  },
  tags: {
    evidenceName: 'tags-filter-native-v1',
    runDirectory: 'native-run-v2',
    fixture: 'tests/library/fixtures/tag-filters/input.json',
    fields: 'Tags',
    recordScope: null,
    defaultScope: 'movies',
    cases: TAG_CASES,
    expectedRecords: 34,
  },
  'rating-permissions': {
    evidenceName: 'rating-permissions-native-v1',
    runDirectory: 'native-run',
    fixture: 'tests/library/fixtures/rating-permissions/input.json',
    fields: 'SortName',
    recordScope: 'ratingPolicy',
    defaultScope: 'movies',
    cases: RATING_PERMISSION_CASES,
    expectedRecords: 36,
  },
  'tag-permissions': {
    evidenceName: 'tag-permissions-native-v1',
    runDirectory: 'native-run-v3',
    fixture: 'tests/library/fixtures/tag-permissions/input.json',
    fields: 'SortName,Tags',
    recordScope: 'tagPolicy',
    defaultScope: 'movies',
    cases: TAG_PERMISSION_CASES,
    expectedRecords: 48,
  },
};

const [scenarioName, outputArgument, portArgument] = process.argv.slice(2);
const descriptor = catalog[scenarioName];
if (!descriptor || !outputArgument || !portArgument) {
  throw new Error(`Usage: node tools/compat/record-item-filter-native.mjs <${Object.keys(catalog).join('|')}> <new-evidence-root> <preferred-loopback-port>`);
}
const allowedOutputRoot = validationOutputRoot();
const evidenceRoot = assertValidationOutputChild(path.resolve(repoRoot, outputArgument));
if (existsSync(evidenceRoot)) throw new Error('Evidence root must be a new child directory of MEDIAMANAGER_VALIDATION_OUTPUT_ROOT.');
if (path.basename(evidenceRoot) !== descriptor.evidenceName) {
  throw new Error(`Scenario ${scenarioName} must be recorded into a root named ${descriptor.evidenceName}.`);
}
const preferredPort = Number(portArgument);
if (!Number.isInteger(preferredPort) || preferredPort < 1024 || preferredPort > 65535) {
  throw new Error('The preferred loopback port must be an integer from 1024 through 65535.');
}

const nativeRun = path.join(evidenceRoot, descriptor.runDirectory);
const referenceRoot = path.join(nativeRun, 'reference');
const databasePath = path.join(referenceRoot, 'data/data/jellyfin.db');
const sourceRoot = validationPath(path.join(repoRoot, '.agent-docs/evidence/core-flow-20260926/reference'));
const sourceDatabase = validationPath(path.join(repoRoot, '.agent-docs/evidence/core-flow-20260926/initial.db'));
const jellyfinDll = process.env.MEDIAMANAGER_JELLYFIN_DLL
  ? path.resolve(repoRoot, process.env.MEDIAMANAGER_JELLYFIN_DLL)
  : validationPath(path.join(repoRoot, '.agent-docs/baselines/jellyfin-current/source/Jellyfin.Server/bin/Release/net10.0/jellyfin.dll'));
const dotnet = validationExecutable('dotnet');
const ffmpeg = validationExecutable('ffmpeg');
assert.ok(path.isAbsolute(ffmpeg), 'An explicit resolved FFmpeg input is required.');
assert.match(path.basename(ffmpeg), /^ffmpeg(?:\.exe)?$/iu);
const ffprobe = path.join(path.dirname(ffmpeg), path.basename(ffmpeg).replace(/^ffmpeg/iu, 'ffprobe'));
const recorderPath = fileURLToPath(import.meta.url);
const recordedSourcePath = path.join(evidenceRoot, 'record-native.mjs');
const fixturePath = validationPath(path.join(repoRoot, descriptor.fixture));
const fixtureBytes = await readFile(fixturePath);
const fixture = JSON.parse(fixtureBytes);
const itemByKey = new Map(fixture.items.map(item => [item.key, item]));
const itemById = new Map(fixture.items.map(item => [idKey(item.id), item]));
const valueByKey = new Map((fixture.itemValues ?? []).map(value => [value.key, value]));
const defaultScope = descriptor.defaultScope === 'all'
  ? fixture.items.map(item => item.key)
  : descriptor.defaultScope === 'movies'
    ? fixture.items.filter(item => item.type === 'Movie').map(item => item.key)
    : fixture.items.filter(item => idKey(item.id) !== idKey(fixture.rootId)).map(item => item.key);
const scenarioCases = (descriptor.cases ?? fixture.cases).map(testCase => ({
  ...testCase,
  scope: testCase.scope ?? defaultScope,
  endpoints: testCase.endpoints ?? ['items', 'legacy'],
  blockUnrated: testCase.blockUnrated ?? [],
}));
assert.equal(scenarioCases.reduce((count, testCase) => count + testCase.endpoints.length, 0), descriptor.expectedRecords);
for (const testCase of scenarioCases) {
  assert.ok(testCase.name && typeof testCase.query === 'string');
  for (const key of testCase.scope) assert.ok(itemByKey.has(key), `${testCase.name}: unknown scope key ${key}`);
}

const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2) + '\n';
const stable = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const sha256File = async filename => sha256Bytes(await readFile(filename));
const quote = name => `"${String(name).replaceAll('"', '""')}"`;

async function available(port) {
  return await new Promise(resolve => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

async function choosePort(start) {
  for (let port = start; port <= Math.min(65535, start + 100); port++) if (await available(port)) return port;
  throw new Error(`No free loopback port from ${start} through ${Math.min(65535, start + 100)}.`);
}

async function containmentNegativeControl() {
  await mkdir(allowedOutputRoot, { recursive: true });
  const controlRoot = await mkdtemp(path.join(allowedOutputRoot, '.item-filter-containment-'));
  const outsideRoot = await mkdtemp(path.join(path.dirname(allowedOutputRoot), '.item-filter-outside-'));
  const escape = path.join(controlRoot, 'escape');
  const linkType = process.platform === 'win32' ? 'junction' : 'directory-symlink';
  try {
    await symlink(outsideRoot, escape, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(assertValidationOutputChild(path.join(controlRoot, 'ordinary', 'capture')),
      path.join(controlRoot, 'ordinary', 'capture'));
    assert.throws(() => assertValidationOutputChild(path.join(escape, 'capture')), /cannot escape/u);
    return { existingAncestorChecked: true, linkType, linkEscapeRejected: true };
  } finally {
    if (existsSync(escape)) await unlink(escape);
    await rmdir(controlRoot);
    await rmdir(outsideRoot);
  }
}

async function walk(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(filename));
    else files.push(filename);
  }
  return files;
}

async function artifactEntries(names) {
  const entries = [];
  for (const name of names) {
    const filename = path.join(evidenceRoot, name);
    const info = await stat(filename);
    entries.push({ path: name.replaceAll('\\', '/'), size: info.size, sha256: await sha256File(filename) });
  }
  return entries;
}

async function verifyArtifactEntries(entries) {
  for (const entry of entries) {
    const filename = path.join(evidenceRoot, entry.path);
    const info = await stat(filename);
    assert.equal(info.size, entry.size, `${entry.path}: artifact size changed.`);
    assert.equal(await sha256File(filename), entry.sha256, `${entry.path}: artifact hash changed.`);
  }
  return true;
}

async function artifactTamperNegativeControl(entries) {
  await verifyArtifactEntries(entries);
  const tampered = entries.map((entry, index) => index === 0 ? { ...entry, sha256: '0'.repeat(64) } : entry);
  await assert.rejects(() => verifyArtifactEntries(tampered), /artifact hash changed/u);
  return { pristineManifestAccepted: true, tamperedManifestRejected: true };
}

async function prepareReference(port) {
  await mkdir(nativeRun, { recursive: true });
  await cp(recorderPath, recordedSourcePath, { errorOnExist: true, force: false });
  await cp(sourceRoot, referenceRoot, {
    recursive: true,
    filter(source) {
      const relative = path.relative(sourceRoot, source).replaceAll('\\', '/');
      if (relative.startsWith('log/')) return false;
      return !/^data\/data\/jellyfin\.db(?:-wal|-shm)?$/u.test(relative);
    },
  });
  await mkdir(path.join(referenceRoot, 'log'), { recursive: true });
  await cp(sourceDatabase, databasePath, { errorOnExist: true, force: false });
  const sourceForms = [sourceRoot, sourceRoot.replaceAll('\\', '/'), sourceRoot.replaceAll('\\', '\\\\')];
  for (const filename of await walk(referenceRoot)) {
    if (!/\.(?:json|xml)$/u.test(filename)) continue;
    let content = await readFile(filename, 'utf8');
    for (const source of sourceForms) content = content.replaceAll(source, referenceRoot);
    if (path.basename(filename).toLowerCase() === 'network.xml') {
      content = content.replace(/<(InternalHttpPort|PublicHttpPort)>\d+<\/\1>/gu,
        (_match, name) => `<${name}>${port}</${name}>`);
      content = content.replace(/<AutoDiscovery>true<\/AutoDiscovery>/gu, '<AutoDiscovery>false</AutoDiscovery>');
    }
    await writeFile(filename, content);
  }
}

function ancestorsFor(item) {
  if (Array.isArray(item.ancestorIds)) return [...new Set(item.ancestorIds.map(upperId))];
  const ancestors = [];
  let parentId = item.parentId;
  while (parentId) {
    ancestors.push(upperId(parentId));
    parentId = itemById.get(idKey(parentId))?.parentId ?? null;
  }
  return [...new Set(ancestors)];
}

function seedDatabase() {
  const database = new DatabaseSync(databasePath);
  try {
    const folderTemplate = database.prepare('SELECT * FROM "BaseItems" WHERE "Id" = ?')
      .get('11111111-1111-1111-1111-111111111111');
    const movieTemplate = database.prepare('SELECT * FROM "BaseItems" WHERE "Id" = ?')
      .get('22222222-2222-2222-2222-222222222222');
    const aggregate = database.prepare(`SELECT * FROM "BaseItems"
      WHERE "Type" = 'MediaBrowser.Controller.Entities.AggregateFolder' LIMIT 1`).get();
    assert.ok(folderTemplate && movieTemplate && aggregate, 'Frozen folder, movie, and aggregate templates are required.');
    const nativeTypes = {
      Folder: 'MediaBrowser.Controller.Entities.Folder',
      Movie: 'MediaBrowser.Controller.Entities.Movies.Movie',
      BoxSet: 'MediaBrowser.Controller.Entities.Movies.BoxSet',
    };
    const folderTypes = new Set(['Folder', 'BoxSet']);
    const fixedDate = '2026-09-29 12:00:00';
    const targetIds = fixture.items.filter(item => item.type !== 'AggregateFolder').map(item => upperId(item.id));
    const valueIds = (fixture.itemValues ?? []).map(value => upperId(value.id));
    const placeholders = values => values.map(() => '?').join(',');
    database.exec('BEGIN IMMEDIATE');
    try {
      if (targetIds.length) {
        database.prepare(`DELETE FROM "AncestorIds" WHERE "ItemId" IN (${placeholders(targetIds)})`).run(...targetIds);
        database.prepare(`DELETE FROM "LinkedChildren" WHERE "ParentId" IN (${placeholders(targetIds)}) OR "ChildId" IN (${placeholders(targetIds)})`)
          .run(...targetIds, ...targetIds);
        database.prepare(`DELETE FROM "BaseItemImageInfos" WHERE "ItemId" IN (${placeholders(targetIds)})`).run(...targetIds);
        database.prepare(`DELETE FROM "ItemValuesMap" WHERE "ItemId" IN (${placeholders(targetIds)})`).run(...targetIds);
      }
      if (valueIds.length) {
        database.prepare(`DELETE FROM "ItemValuesMap" WHERE "ItemValueId" IN (${placeholders(valueIds)})`).run(...valueIds);
        database.prepare(`DELETE FROM "ItemValues" WHERE "ItemValueId" IN (${placeholders(valueIds)})`).run(...valueIds);
      }
      for (const item of fixture.items) {
        if (item.type === 'AggregateFolder') {
          assert.equal(idKey(item.id), idKey(aggregate.Id), 'Fixture aggregate must bind the native aggregate folder.');
          continue;
        }
        const isFolder = folderTypes.has(item.type);
        const isMovie = item.type === 'Movie';
        const defaultData = isMovie
          ? { VideoType: 'VideoFile', IsHD: false, IsShortcut: false, RemoteTrailers: [] }
          : {};
        const row = {
          ...(isFolder ? folderTemplate : movieTemplate),
          Id: upperId(item.id),
          Type: nativeTypes[item.type],
          ParentId: item.parentId == null ? null : upperId(item.parentId),
          TopParentId: item.topParentId == null ? null : upperId(item.topParentId),
          Name: item.name,
          CleanName: item.cleanName ?? item.name.toLowerCase(),
          SortName: item.sortName ?? item.cleanName ?? item.name.toLowerCase(),
          Path: `Z:\\ItemFilterOracle\\${scenarioName}\\${item.key}${isFolder ? '' : '.mkv'}`,
          IsFolder: isFolder ? 1 : 0,
          IsMovie: isMovie ? 1 : 0,
          IsSeries: 0,
          IsVirtualItem: item.isVirtualItem ? 1 : 0,
          MediaType: item.mediaType ?? (isMovie ? 'Video' : 'Unknown'),
          UnratedType: isMovie ? 'Movie' : 'Other',
          PrimaryVersionId: item.primaryVersionId == null ? null : upperId(item.primaryVersionId),
          OwnerId: item.ownerId == null ? null : upperId(item.ownerId),
          ExtraType: item.extraType ?? null,
          PresentationUniqueKey: item.presentationUniqueKey ?? `item-filter-${scenarioName}-${idKey(item.id)}`,
          ProductionYear: item.productionYear ?? null,
          CustomRating: item.customRating ?? null,
          OfficialRating: Object.hasOwn(item, 'officialRating') ? item.officialRating : null,
          InheritedParentalRatingValue: item.inheritedParentalRatingValue ?? null,
          InheritedParentalRatingSubValue: item.inheritedParentalRatingSubValue ?? null,
          Tags: Object.hasOwn(item, 'tagsText') ? item.tagsText : null,
          Genres: null,
          Studios: null,
          ProductionLocations: null,
          DateCreated: fixedDate,
          DateModified: fixedDate,
          DateLastSaved: item.dateLastSaved ?? fixedDate,
          Data: item.dataText ?? JSON.stringify(item.data ?? defaultData),
        };
        const columns = Object.keys(row);
        const updates = columns.filter(column => column !== 'Id')
          .map(column => `${quote(column)}=excluded.${quote(column)}`).join(',');
        database.prepare(`INSERT INTO "BaseItems" (${columns.map(quote).join(',')})
          VALUES (${columns.map(() => '?').join(',')}) ON CONFLICT("Id") DO UPDATE SET ${updates}`)
          .run(...columns.map(column => row[column]));
        for (const ancestorId of ancestorsFor(item)) {
          database.prepare('INSERT INTO "AncestorIds" ("ItemId", "ParentItemId") VALUES (?, ?)')
            .run(row.Id, ancestorId);
        }
      }
      for (const link of fixture.links ?? []) {
        database.prepare('INSERT INTO "LinkedChildren" ("ParentId", "SortOrder", "ChildId", "ChildType") VALUES (?, ?, ?, ?)')
          .run(upperId(link.parentId), link.sortOrder, upperId(link.childId), link.childType);
      }
      const itemValueTypes = { Genre: 2, Studio: 3, Tags: 4 };
      for (const value of fixture.itemValues ?? []) {
        database.prepare('INSERT INTO "ItemValues" ("ItemValueId", "Type", "Value", "CleanValue") VALUES (?, ?, ?, ?)')
          .run(upperId(value.id), itemValueTypes[value.type] ?? value.type, value.value,
            value.cleanValue ?? value.value.toLowerCase());
      }
      for (const link of fixture.itemValueLinks ?? []) {
        database.prepare('INSERT INTO "ItemValuesMap" ("ItemId", "ItemValueId") VALUES (?, ?)')
          .run(upperId(itemByKey.get(link.itemKey).id), upperId(valueByKey.get(link.valueKey).id));
      }
      for (const image of fixture.images ?? []) {
        database.prepare(`INSERT INTO "BaseItemImageInfos"
          ("Id", "Blurhash", "DateModified", "Height", "ImageType", "ItemId", "Path", "Width")
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(upperId(image.id), null, fixedDate, 1, image.imageType,
          upperId(itemByKey.get(image.itemKey).id), `Z:\\ItemFilterOracle\\${scenarioName}\\${image.id}.jpg`, 1);
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database.close();
  }
}

function normalizeSqlValue(value) {
  if (Buffer.isBuffer(value)) return { type: 'blob', base64: value.toString('base64') };
  if (typeof value === 'bigint') return { type: 'bigint', value: value.toString() };
  return value;
}

function canonicalRows(rows) {
  return rows.map(row => Object.fromEntries(Object.entries(row)
    .map(([key, value]) => [key, normalizeSqlValue(value)])))
    .sort((left, right) => stable(left).localeCompare(stable(right), 'en'));
}

function databaseSnapshot() {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  database.exec('PRAGMA busy_timeout=5000');
  try {
    const targetIds = fixture.items.map(item => upperId(item.id));
    const valueIds = (fixture.itemValues ?? []).map(value => upperId(value.id));
    const placeholders = values => values.map(() => '?').join(',');
    const selected = (sql, parameters) => database.prepare(sql).all(...parameters);
    const tableDefinitions = database.prepare(`SELECT "name", "sql" FROM "sqlite_master"
      WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%' ORDER BY "name"`).all();
    const tableSummaries = tableDefinitions.map(definition => {
      const rows = canonicalRows(database.prepare(`SELECT * FROM ${quote(definition.name)}`).all());
      const columns = database.prepare(`PRAGMA table_info(${quote(definition.name)})`).all();
      const foreignKeys = database.prepare(`PRAGMA foreign_key_list(${quote(definition.name)})`).all();
      const indexes = database.prepare(`PRAGMA index_list(${quote(definition.name)})`).all()
        .map(index => ({ ...index,
          columns: database.prepare(`PRAGMA index_info(${quote(index.name)})`).all() }));
      return {
        name: definition.name,
        sqlSha256: sha256Bytes(Buffer.from(definition.sql ?? '')),
        columnsSha256: sha256Bytes(Buffer.from(stable(columns))),
        foreignKeysSha256: sha256Bytes(Buffer.from(stable(foreignKeys))),
        indexesSha256: sha256Bytes(Buffer.from(stable(indexes))),
        rowCount: rows.length,
        rowsSha256: sha256Bytes(Buffer.from(stable(rows))),
      };
    });
    const hasSequence = database.prepare(`SELECT COUNT(*) AS "count" FROM "sqlite_master"
      WHERE "type" = 'table' AND "name" = 'sqlite_sequence'`).get().count > 0;
    const sequences = hasSequence ? canonicalRows(database.prepare('SELECT * FROM "sqlite_sequence"').all()) : [];
    const pragmas = {
      applicationId: database.prepare('PRAGMA application_id').get().application_id,
      autoVacuum: database.prepare('PRAGMA auto_vacuum').get().auto_vacuum,
      encoding: database.prepare('PRAGMA encoding').get().encoding,
      foreignKeys: database.prepare('PRAGMA foreign_keys').get().foreign_keys,
      journalMode: database.prepare('PRAGMA journal_mode').get().journal_mode,
      pageSize: database.prepare('PRAGMA page_size').get().page_size,
      schemaVersion: database.prepare('PRAGMA schema_version').get().schema_version,
      userVersion: database.prepare('PRAGMA user_version').get().user_version,
    };
    const foreignKeyCheck = canonicalRows(database.prepare('PRAGMA foreign_key_check').all());
    const integrityCheck = canonicalRows(database.prepare('PRAGMA integrity_check').all());
    const complete = { tableSummaries, sequences,
      sequencesSha256: sha256Bytes(Buffer.from(stable(sequences))), pragmas, foreignKeyCheck, integrityCheck };
    complete.sha256 = sha256Bytes(Buffer.from(stable(complete)));
    return {
      baseItems: selected(`SELECT "Id", "OwnerId", "PrimaryVersionId", "ExtraType", "CustomRating", "OfficialRating",
        "InheritedParentalRatingValue", "InheritedParentalRatingSubValue", "PresentationUniqueKey", "Tags", "DateLastSaved"
        FROM "BaseItems" WHERE "Id" IN (${placeholders(targetIds)}) ORDER BY "Id"`, targetIds),
      ancestorIds: selected(`SELECT "ItemId", "ParentItemId" FROM "AncestorIds"
        WHERE "ItemId" IN (${placeholders(targetIds)}) ORDER BY "ItemId", "ParentItemId"`, targetIds),
      linkedChildren: selected(`SELECT "ParentId", "SortOrder", "ChildId", "ChildType" FROM "LinkedChildren"
        WHERE "ParentId" IN (${placeholders(targetIds)}) OR "ChildId" IN (${placeholders(targetIds)})
        ORDER BY "ParentId", "SortOrder", "ChildId"`, [...targetIds, ...targetIds]),
      itemValues: valueIds.length ? selected(`SELECT "ItemValueId", "Type", "Value", "CleanValue" FROM "ItemValues"
        WHERE "ItemValueId" IN (${placeholders(valueIds)}) ORDER BY "ItemValueId"`, valueIds) : [],
      itemValuesMap: valueIds.length ? selected(`SELECT "ItemId", "ItemValueId" FROM "ItemValuesMap"
        WHERE "ItemValueId" IN (${placeholders(valueIds)}) ORDER BY "ItemId", "ItemValueId"`, valueIds) : [],
      imageInfos: selected(`SELECT "Id", "ItemId", "ImageType", "Path", "Width", "Height" FROM "BaseItemImageInfos"
        WHERE "ItemId" IN (${placeholders(targetIds)}) ORDER BY "Id"`, targetIds),
      foreignKeyCheck,
      complete,
    };
  } finally {
    database.close();
  }
}

function selectedDatabaseSnapshot() {
  const { complete: _complete, ...selected } = databaseSnapshot();
  return selected;
}

function completeDatabaseSnapshot() {
  return databaseSnapshot().complete;
}

function serializeDatabase() {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try { return Buffer.from(database.serialize()); }
  finally { database.close(); }
}

async function restoreSerializedDatabase(bytes) {
  for (const suffix of ['-wal', '-shm']) {
    const filename = databasePath + suffix;
    if (existsSync(filename)) await unlink(filename);
  }
  await writeFile(databasePath, bytes);
  assert.equal(databaseIsUnlocked(), true, 'Restored native database is still locked.');
}

function authorization(token) {
  return `MediaBrowser Client="CompatibilityValidation", Device="IsolatedItemFilterReference", DeviceId="item-filter-native-${scenarioName}", Version="1.0"${token ? `, Token="${token}"` : ''}`;
}

async function request(origin, route, { method = 'GET', token, body } = {}) {
  const response = await fetch(origin + route, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: authorization(token),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const bodyText = await response.text();
  let bodyJson;
  try { bodyJson = bodyText === '' ? null : JSON.parse(bodyText); } catch { /* Preserve the raw body. */ }
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    bodyText,
    ...(bodyJson === undefined ? {} : { bodyJson }),
  };
}

function expectedStatusFor(testCase, endpoint) {
  return endpoint === 'detail' ? testCase.detailExpectedStatus : testCase.expectedStatus ?? 200;
}

function validateResponseContract(response, { endpoint, expectedStatus, label, route = '' }) {
  assert.equal(response.status, expectedStatus,
    `${label} returned ${response.status}, expected ${expectedStatus}: ${response.bodyText.slice(0, 1000)}`);
  assert.ok(response.contentType?.startsWith('application/json'), `${label} did not return JSON.`);
  assert.ok(response.bodyJson && typeof response.bodyJson === 'object' && !Array.isArray(response.bodyJson),
    `${label} did not return a JSON object.`);
  if (response.status === 200 && endpoint !== 'detail') {
    const body = response.bodyJson;
    assert.ok(Array.isArray(body.Items), `${label} did not return an Items array.`);
    assert.ok(Number.isInteger(body.TotalRecordCount) && body.TotalRecordCount >= 0,
      `${label} returned an invalid TotalRecordCount.`);
    assert.ok(Number.isInteger(body.StartIndex) && body.StartIndex >= 0,
      `${label} returned an invalid StartIndex.`);
    const countDisabled = new URL(route || '/', 'http://127.0.0.1').searchParams
      .get('EnableTotalRecordCount')?.toLowerCase() === 'false';
    if (countDisabled) {
      assert.equal(body.TotalRecordCount, body.Items.length,
        `${label} returned an inconsistent disabled-count result.`);
    } else {
      assert.ok(body.Items.length <= body.TotalRecordCount
        && body.StartIndex <= body.TotalRecordCount
        && body.StartIndex + body.Items.length <= body.TotalRecordCount,
      `${label} returned inconsistent Items pagination counts.`);
    }
    for (const [index, item] of body.Items.entries()) {
      assert.ok(item && typeof item === 'object' && !Array.isArray(item), `${label}:Items[${index}] is not an object.`);
      assert.ok(typeof item.Id === 'string' && item.Id.length > 0, `${label}:Items[${index}] has no Id.`);
      assert.ok(typeof item.Name === 'string', `${label}:Items[${index}] has no Name.`);
      assert.ok(typeof item.Type === 'string' && item.Type.length > 0, `${label}:Items[${index}] has no Type.`);
    }
  } else if (response.status === 200) {
    assert.ok(typeof response.bodyJson.Id === 'string' && response.bodyJson.Id.length > 0,
      `${label} detail response has no Id.`);
    assert.ok(typeof response.bodyJson.Name === 'string', `${label} detail response has no Name.`);
    assert.ok(typeof response.bodyJson.Type === 'string' && response.bodyJson.Type.length > 0,
      `${label} detail response has no Type.`);
  } else {
    assert.ok(Number.isInteger(response.bodyJson.status), `${label} problem body has no integer status.`);
    assert.equal(response.bodyJson.status, response.status, `${label} problem status does not match HTTP status.`);
    assert.ok(typeof response.bodyJson.title === 'string' && response.bodyJson.title.length > 0,
      `${label} problem body has no title.`);
    assert.ok(typeof response.bodyJson.type === 'string' && response.bodyJson.type.length > 0,
      `${label} problem body has no type.`);
  }
  return true;
}

function responseValidationNegativeControls() {
  const valid = { status: 200, contentType: 'application/json', bodyText: '{}',
    bodyJson: { Items: [], TotalRecordCount: 0, StartIndex: 0 } };
  assert.throws(() => validateResponseContract({ ...valid, status: 500 },
    { endpoint: 'items', expectedStatus: 200, label: 'negative-control-status' }), /expected 200/u);
  assert.throws(() => validateResponseContract({ ...valid, bodyJson: { Items: {}, TotalRecordCount: 0, StartIndex: 0 } },
    { endpoint: 'items', expectedStatus: 200, label: 'negative-control-body' }), /Items array/u);
  assert.throws(() => validateResponseContract({ status: 404, contentType: 'application/json', bodyText: '{}',
    bodyJson: { status: 200, title: 'Not Found', type: 'about:blank' } },
  { endpoint: 'detail', expectedStatus: 404, label: 'negative-control-problem' }), /does not match/u);
  return { badStatusRejected: true, badBodyRejected: true, badProblemBodyRejected: true };
}

function routeFor(endpoint, testCase, userId) {
  if (endpoint === 'detail') return `/Items/${itemByKey.get(testCase.detailKey).id}`;
  const scopeIds = testCase.scope.map(key => itemByKey.get(key).id).join(',');
  const common = [
    `Ids=${encodeURIComponent(scopeIds)}`,
    'SortBy=SortName',
    `Fields=${encodeURIComponent(descriptor.fields)}`,
    'EnableImages=false',
    'EnableUserData=false',
    testCase.query.replaceAll(fixture.userId, userId),
  ];
  return `${endpoint === 'items' ? '/Items' : `/Users/${userId}/Items`}?${common.join('&')}`;
}

function startReference(port) {
  const stdoutPath = path.join(nativeRun, 'reference-stdout.log');
  const stderrPath = path.join(nativeRun, 'reference-stderr.log');
  const stdout = openSync(stdoutPath, 'wx');
  const stderr = openSync(stderrPath, 'wx');
  const child = spawn(dotnet, [jellyfinDll,
    '--datadir', path.join(referenceRoot, 'data'),
    '--configdir', path.join(referenceRoot, 'config'),
    '--cachedir', path.join(referenceRoot, 'cache'),
    '--logdir', path.join(referenceRoot, 'log'),
    '--nowebclient', '--nonetchange', '--ffmpeg', ffmpeg], {
    cwd: repoRoot,
    windowsHide: true,
    stdio: ['ignore', stdout, stderr],
  });
  const completion = new Promise(resolve => {
    child.once('error', error => resolve({ code: null, signal: null, error: { name: error.name, message: error.message } }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return {
    command: [dotnet, jellyfinDll, '--datadir', path.join(referenceRoot, 'data'),
      '--configdir', path.join(referenceRoot, 'config'), '--cachedir', path.join(referenceRoot, 'cache'),
      '--logdir', path.join(referenceRoot, 'log'), '--nowebclient', '--nonetchange', '--ffmpeg', ffmpeg],
    child,
    completion,
    closeDescriptors() { closeSync(stdout); closeSync(stderr); },
    port,
  };
}

async function waitForReady(instance, origin) {
  let startupComplete = false;
  let consecutiveHttpSuccesses = 0;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (instance.child.exitCode !== null || instance.child.signalCode !== null) {
      throw new Error(`Frozen Jellyfin exited before readiness: ${instance.child.exitCode ?? instance.child.signalCode}`);
    }
    try {
      const startupLog = await readFile(path.join(nativeRun, 'reference-stdout.log'), 'utf8');
      startupComplete ||= startupLog.includes('Main: Startup complete');
      const response = await fetch(origin + '/System/Info/Public', { signal: AbortSignal.timeout(1000) });
      consecutiveHttpSuccesses = response.ok ? consecutiveHttpSuccesses + 1 : 0;
      await response.body?.cancel();
      if (startupComplete && consecutiveHttpSuccesses >= 3) return {
        startupComplete, httpReady: true, consecutiveHttpSuccesses, attempts: attempt + 1,
      };
    } catch { consecutiveHttpSuccesses = 0; }
    await delay(500);
  }
  throw new Error(`Frozen Jellyfin did not become ready within the bounded wait (startupComplete=${startupComplete}, consecutiveHttpSuccesses=${consecutiveHttpSuccesses}).`);
}

function processIsGone(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error?.code === 'ESRCH'; }
}

function databaseIsUnlocked() {
  let database;
  try {
    database = new DatabaseSync(databasePath);
    database.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE; ROLLBACK');
    return true;
  } catch {
    return false;
  } finally {
    try { database?.close(); } catch { /* Already closed. */ }
  }
}

async function confirmStopped(instance) {
  let pidGone = false;
  let portAvailable = false;
  let databaseUnlocked = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    pidGone = processIsGone(instance.child.pid);
    portAvailable = await available(instance.port);
    databaseUnlocked = databaseIsUnlocked();
    if (pidGone && portAvailable && databaseUnlocked) {
      return { pidGone, portAvailable, databaseUnlocked, attempts: attempt + 1 };
    }
    await delay(250);
  }
  return { pidGone, portAvailable, databaseUnlocked, attempts: 60 };
}

async function stopReference(instance, token, origin, setupRecords) {
  let shutdownStatus = null;
  let processResult;
  if (token && instance.child.exitCode === null && instance.child.signalCode === null) {
    try {
      const shutdown = await request(origin, '/System/Shutdown', { method: 'POST', token });
      shutdownStatus = shutdown.status;
      setupRecords.push({ kind: 'shutdown', status: shutdown.status });
    } catch { shutdownStatus = null; }
  }
  if (instance.child.exitCode === null && instance.child.signalCode === null) {
    processResult = await Promise.race([instance.completion, delay(20000).then(() => null)]);
    if (!processResult) {
      instance.child.kill();
      processResult = await Promise.race([instance.completion, delay(10000).then(() => null)]);
    }
    if (!processResult && instance.child.pid) {
      spawnSync('taskkill', ['/PID', String(instance.child.pid), '/T', '/F'], {
        cwd: repoRoot, windowsHide: true, encoding: 'utf8', timeout: 10000,
      });
      processResult = await Promise.race([instance.completion, delay(10000).then(() => null)]);
    }
  } else {
    processResult = await instance.completion;
  }
  try { instance.closeDescriptors(); } catch { /* Descriptors already released. */ }
  return { shutdownStatus, processResult: processResult ?? { code: null, signal: null },
    ...await confirmStopped(instance) };
}

const selectedPort = await available(preferredPort) ? preferredPort : await choosePort(preferredPort + 1);
const origin = `http://127.0.0.1:${selectedPort}`;
const negativeControls = {
  containment: await containmentNegativeControl(),
  responseValidation: responseValidationNegativeControls(),
};
const preparation = await captureFilterReferencePreparation({
  sourceRoot,
  sourceDatabase,
  repoRoot,
  fixtureUserId: fixture.userId,
});
async function executionInputs() {
  const result = [];
  for (const [kind, filename] of [['ffmpeg', ffmpeg], ['ffprobe', ffprobe]]) {
    const metadata = await stat(filename);
    assert.equal(metadata.isFile(), true);
    const bytes = await readFile(filename);
    result.push({ kind, filename, bytes: bytes.length, sha256: sha256Bytes(bytes) });
  }
  return result;
}
const nativeLaunch = { command: null, before: await executionInputs(), after: null };
const sourceSummary = {
  initializedFromEmpty: preparation.initializedFromEmpty,
  createdThroughNativeApi: preparation.createdThroughNativeApi,
  sourceStopped: preparation.stopped,
  sourceDatabaseSha256: preparation.sourceDatabaseSha256,
  preparedInputCount: preparation.inputs.length,
  jellyfinDllSha256: await sha256File(jellyfinDll),
  dotnetSha256: await sha256File(dotnet),
};
await prepareReference(selectedPort);
assert.equal(await sha256File(recordedSourcePath), await sha256File(recorderPath));
seedDatabase();
await writeFile(path.join(nativeRun, 'reference-preparation.json'), json(preparation), { flag: 'wx' });

const stages = {};
const records = [];
const setupRecords = [];
const fullDatabaseReadGates = [];
let instance;
let token;
let basePolicy;
let baselineDatabaseBytes;
let fullDatabaseBaseline;
let fullDatabaseAfterRun;
let fullDatabaseAfterShutdown;
let readiness = { startupComplete: false, httpReady: false, consecutiveHttpSuccesses: 0, attempts: 0 };
let lifecycle = { shutdownStatus: null, processResult: { code: null, signal: null },
  pidGone: false, portAvailable: false, databaseUnlocked: false, attempts: 0 };
let outcomeError;
try {
  instance = startReference(selectedPort);
  nativeLaunch.command = instance.command;
  readiness = await waitForReady(instance, origin);
  const login = await request(origin, '/Users/AuthenticateByName', {
    method: 'POST',
    body: { Username: 'CoreFlowAdmin', Pw: process.env.MEDIAMANAGER_NATIVE_REFERENCE_PASSWORD ?? 'isolated-core-flow-password' },
  });
  assert.equal(login.status, 200, `Frozen admin login failed: ${login.bodyText}`);
  token = login.bodyJson.AccessToken;
  const userId = login.bodyJson.User.Id;
  assert.equal(idKey(userId), idKey(fixture.userId));
  basePolicy = login.bodyJson.User.Policy;
  const configRead = await request(origin, '/System/Configuration', { token });
  assert.equal(configRead.status, 200);
  assert.deepEqual(configRead.bodyJson.PluginRepositories, []);
  const taskRead = await request(origin, '/ScheduledTasks', { token });
  assert.equal(taskRead.status, 200);
  assert.ok(taskRead.bodyJson.length >= 20);
  assert.ok(taskRead.bodyJson.every(task => task.State === 'Idle' && task.Triggers?.length === 0));
  const networkRead = await request(origin, '/System/Configuration/network', { token });
  assert.equal(networkRead.status, 200);
  assert.deepEqual(networkRead.bodyJson.LocalNetworkAddresses, ['127.0.0.1']);
  assert.equal(networkRead.bodyJson.AutoDiscovery, false);
  assert.equal(networkRead.bodyJson.EnableUPnP, false);
  assert.equal(networkRead.bodyJson.EnableRemoteAccess, false);
  setupRecords.push({ kind: 'actual-isolation-readback', configuration: configRead,
    tasks: taskRead, network: networkRead });
  stages.before = { database: selectedDatabaseSnapshot() };
  baselineDatabaseBytes = serializeDatabase();
  fullDatabaseBaseline = completeDatabaseSnapshot();
  for (const testCase of scenarioCases) {
    if (['official-rating-range', 'rating-permissions', 'tag-permissions'].includes(scenarioName)) {
      const policy = {
        ...basePolicy,
        ...(scenarioName === 'rating-permissions' ? {
          AllowedTags: [],
          BlockedTags: [],
          MaxParentalRating: testCase.maxRating,
          MaxParentalSubRating: testCase.maxRating == null ? null : 0,
          BlockUnratedItems: testCase.blockUnrated,
        } : scenarioName === 'tag-permissions' ? {
          AllowedTags: testCase.allowedTags,
          BlockedTags: testCase.blockedTags,
        } : {
          MaxParentalRating: null,
          MaxParentalSubRating: null,
          BlockUnratedItems: testCase.blockUnrated,
          AllowedTags: [],
          BlockedTags: [],
        }),
      };
      const update = await request(origin, `/Users/${userId}/Policy`, { method: 'POST', token, body: policy });
      assert.equal(update.status, 204, `${testCase.name}: native policy update failed: ${update.bodyText}`);
      setupRecords.push({ name: testCase.name, kind: 'policy',
        ...(scenarioName === 'rating-permissions' ? { maxRating: testCase.maxRating, blockUnrated: testCase.blockUnrated } : {}),
        ...(scenarioName === 'tag-permissions' ? { allowedTags: testCase.allowedTags, blockedTags: testCase.blockedTags } : {}),
        ...(scenarioName === 'official-rating-range' ? { blockUnrated: testCase.blockUnrated } : {}),
        status: update.status });
    }
    const databaseBeforeCaseReads = completeDatabaseSnapshot();
    for (const endpoint of testCase.endpoints) {
      const route = routeFor(endpoint, testCase, userId);
      const response = await request(origin, route, { token });
      const expectedStatus = expectedStatusFor(testCase, endpoint);
      validateResponseContract(response, { endpoint, expectedStatus, label: `${testCase.name}:${endpoint}`, route });
      const record = {
        name: testCase.name,
        query: testCase.query,
        endpoint,
        route,
        ...(descriptor.recordScope === 'scope' ? { scope: testCase.scope } : {}),
        ...(descriptor.recordScope === 'scopeIds' ? { scopeIds: testCase.scope.map(key => itemByKey.get(key).id) } : {}),
        ...(descriptor.recordScope === 'blockUnrated' ? { blockUnrated: testCase.blockUnrated } : {}),
        ...(descriptor.recordScope === 'ratingPolicy' ? {
          maxRating: testCase.maxRating,
          blockUnrated: testCase.blockUnrated,
          ...(endpoint === 'detail' ? { detailId: itemByKey.get(testCase.detailKey).id } : {}),
        } : {}),
        ...(descriptor.recordScope === 'tagPolicy' ? {
          allowedTags: testCase.allowedTags,
          blockedTags: testCase.blockedTags,
          ...(endpoint === 'detail' ? { detailId: itemByKey.get(testCase.detailKey).id } : {}),
        } : {}),
        expectedStatus,
        response,
      };
      records.push(record);
    }
    const databaseAfterCaseReads = completeDatabaseSnapshot();
    const stableAcrossReads = stable(databaseBeforeCaseReads) === stable(databaseAfterCaseReads);
    fullDatabaseReadGates.push({ name: testCase.name,
      beforeSha256: databaseBeforeCaseReads.sha256,
      afterSha256: databaseAfterCaseReads.sha256,
      userTables: databaseBeforeCaseReads.tableSummaries.length,
      sequenceRows: databaseBeforeCaseReads.sequences.length,
      stable: stableAcrossReads });
    assert.equal(stableAcrossReads, true, `${testCase.name}: native HTTP reads mutated the complete database.`);
  }
  if (['official-rating-range', 'rating-permissions', 'tag-permissions'].includes(scenarioName)) {
    const restore = await request(origin, `/Users/${userId}/Policy`, { method: 'POST', token, body: basePolicy });
    assert.equal(restore.status, 204, `Native policy restore failed: ${restore.bodyText}`);
    setupRecords.push({ kind: 'policy-restore', status: restore.status });
  }
  stages.afterReads = { database: selectedDatabaseSnapshot() };
} catch (error) {
  outcomeError = error;
} finally {
  if (instance) lifecycle = await stopReference(instance, token, origin, setupRecords);
  try { fullDatabaseAfterRun = completeDatabaseSnapshot(); }
  catch (error) { outcomeError ??= error; }
  if (baselineDatabaseBytes && lifecycle.pidGone && lifecycle.portAvailable && lifecycle.databaseUnlocked) {
    try { await restoreSerializedDatabase(baselineDatabaseBytes); }
    catch (error) { outcomeError ??= error; }
  }
  stages.before ??= { database: selectedDatabaseSnapshot() };
  stages.afterReads ??= { database: selectedDatabaseSnapshot() };
  stages.afterShutdown = { database: selectedDatabaseSnapshot() };
  try { fullDatabaseAfterShutdown = completeDatabaseSnapshot(); }
  catch (error) { outcomeError ??= error; }
}

nativeLaunch.after = await executionInputs();
const executionInputsUnchanged = stable(nativeLaunch.before) === stable(nativeLaunch.after);
const recorderSha256 = await sha256File(recordedSourcePath);
const fixtureSha256 = sha256Bytes(fixtureBytes);
const scenarioDefinitionSha256 = sha256Bytes(Buffer.from(stable({
  scenarioName,
  descriptor: Object.fromEntries(Object.entries(descriptor).filter(([key]) => key !== 'cases')),
  cases: scenarioCases,
})));
const completeDatabaseReadStable = fullDatabaseReadGates.length === scenarioCases.length
  && fullDatabaseReadGates.every(gate => gate.stable);
const completeDatabaseRestored = Boolean(fullDatabaseBaseline && fullDatabaseAfterShutdown)
  && stable(fullDatabaseBaseline) === stable(fullDatabaseAfterShutdown);
const completeDatabaseReadStableAndRestored = completeDatabaseReadStable && completeDatabaseRestored;
const selectedDatabaseStable = stable(stages.before.database) === stable(stages.afterReads.database)
  && stable(stages.afterReads.database) === stable(stages.afterShutdown.database);
const foreignKeyCheckPassedAllStages = Object.values(stages)
  .every(stage => stage.database.foreignKeyCheck.length === 0);
const fullDatabaseSnapshots = [fullDatabaseBaseline, fullDatabaseAfterRun, fullDatabaseAfterShutdown].filter(Boolean);
const integrityCheckPassedAllStages = fullDatabaseSnapshots.length === 3
  && fullDatabaseSnapshots.every(snapshot => snapshot.integrityCheck.every(row => Object.values(row).includes('ok'))
    && snapshot.foreignKeyCheck.length === 0);
const sourceUnchanged = await sha256File(sourceDatabase) === sourceSummary.sourceDatabaseSha256;
const invocation = {
  scenario: scenarioName,
  evidenceName: descriptor.evidenceName,
  runDirectory: descriptor.runDirectory,
  outputRoot: path.relative(allowedOutputRoot, evidenceRoot).replaceAll('\\', '/'),
  preferredPort,
  selectedPort,
};
const nativeHttpPath = path.join(nativeRun, 'native-http.json');
const setupHttpPath = path.join(nativeRun, 'setup-http.json');
const stagesPath = path.join(nativeRun, 'stages.json');
const summaryPath = path.join(nativeRun, 'summary.json');
const provenancePath = path.join(nativeRun, 'provenance.json');
await writeFile(nativeHttpPath, json({ schemaVersion: 2, invocation, origin, records }), { flag: 'wx' });
await writeFile(setupHttpPath, json({ schemaVersion: 2, invocation, origin, records: setupRecords }), { flag: 'wx' });
await writeFile(stagesPath, json({ schemaVersion: 2, invocation, ...stages }), { flag: 'wx' });
const preSummaryArtifactNames = [
  'record-native.mjs',
  `${descriptor.runDirectory}/reference-preparation.json`,
  `${descriptor.runDirectory}/native-http.json`,
  `${descriptor.runDirectory}/setup-http.json`,
  `${descriptor.runDirectory}/stages.json`,
  `${descriptor.runDirectory}/reference-stdout.log`,
  `${descriptor.runDirectory}/reference-stderr.log`,
  `${descriptor.runDirectory}/reference/data/data/jellyfin.db`,
];
const boundArtifacts = await artifactEntries(preSummaryArtifactNames);
negativeControls.artifactManifest = await artifactTamperNegativeControl(boundArtifacts);
const negativeControlsPassed = negativeControls.containment.existingAncestorChecked
  && negativeControls.containment.linkEscapeRejected
  && Object.values(negativeControls.responseValidation).every(Boolean)
  && Object.values(negativeControls.artifactManifest).every(Boolean);
const summary = {
  passed: !outcomeError
    && records.length === descriptor.expectedRecords
    && completeDatabaseReadStableAndRestored
    && selectedDatabaseStable
    && foreignKeyCheckPassedAllStages
    && integrityCheckPassedAllStages
    && readiness.startupComplete && readiness.httpReady && readiness.consecutiveHttpSuccesses >= 3
    && lifecycle.shutdownStatus === 204
    && lifecycle.processResult?.code === 0
    && lifecycle.processResult?.signal == null
    && lifecycle.pidGone && lifecycle.portAvailable && lifecycle.databaseUnlocked
    && sourceUnchanged
    && executionInputsUnchanged
    && negativeControlsPassed,
  invocation,
  scenario: scenarioName,
  runDirectory: descriptor.runDirectory,
  cases: scenarioCases.length,
  httpRecords: records.length,
  completeDatabaseReadStableAndRestored,
  completeDatabaseGateSemantics: 'All user tables, sequences, selected PRAGMAs, FK and integrity checks are stable within each HTTP read batch; the exact post-login baseline is restored after shutdown.',
  selectedDatabaseStable,
  fullDatabaseCoverage: {
    userTables: fullDatabaseBaseline?.tableSummaries.length ?? null,
    sequenceRows: fullDatabaseBaseline?.sequences.length ?? null,
    baselineSha256: fullDatabaseBaseline?.sha256 ?? null,
    afterRunSha256: fullDatabaseAfterRun?.sha256 ?? null,
    afterShutdownSha256: fullDatabaseAfterShutdown?.sha256 ?? null,
    readGates: fullDatabaseReadGates,
    readStable: completeDatabaseReadStable,
    restored: completeDatabaseRestored,
  },
  foreignKeyCheckPassedAllStages,
  integrityCheckPassedAllStages,
  readiness,
  cleanShutdown: lifecycle.shutdownStatus === 204,
  processResult: lifecycle.processResult,
  selectedPort,
  portAvailable: lifecycle.portAvailable,
  pidGone: lifecycle.pidGone,
  databaseUnlocked: lifecycle.databaseUnlocked,
  shutdownConfirmationAttempts: lifecycle.attempts,
  recorderSha256,
  fixtureSha256,
  scenarioDefinitionSha256,
  sourceSummary,
  sourceUnchanged,
  nativeLaunch,
  executionInputsUnchanged,
  boundArtifacts,
  negativeControls,
  error: outcomeError ? { name: outcomeError.name, message: outcomeError.message, stack: outcomeError.stack } : null,
};
await writeFile(summaryPath, json(summary), { flag: 'wx' });
const provenanceArtifacts = await artifactEntries([...preSummaryArtifactNames, `${descriptor.runDirectory}/summary.json`]);
await verifyArtifactEntries(provenanceArtifacts);
await writeFile(provenancePath, json({
  schemaVersion: 2,
  createdAt: new Date().toISOString(),
  invocation,
  scenario: scenarioName,
  runDirectory: descriptor.runDirectory,
  sourceSummary,
  sourceUnchanged,
  nativeLaunch,
  executionInputsUnchanged,
  preparedInputs: preparation.inputs,
  fixture: { path: descriptor.fixture, sha256: fixtureSha256 },
  recorder: { path: 'record-native.mjs', sha256: recorderSha256 },
  scenarioDefinitionSha256,
  negativeControls,
  artifacts: provenanceArtifacts,
  limitations: [
    'The source instance is a freshly initialized, isolated native Jellyfin instance with synthetic item templates.',
    'Items and relationships are seeded offline into a stopped copy; all recorded responses come from native Jellyfin HTTP.',
  ],
}), { flag: 'wx' });
const finalArtifacts = await artifactEntries([...preSummaryArtifactNames,
  `${descriptor.runDirectory}/summary.json`, `${descriptor.runDirectory}/provenance.json`]);
await verifyArtifactEntries(finalArtifacts);
await writeFile(path.join(evidenceRoot, 'oracle-validation.json'), json({
  schemaVersion: 2,
  passed: summary.passed,
  invocation,
  recorderSha256,
  fixtureSha256,
  scenarioDefinitionSha256,
  sourceSummary,
  nativeLaunch,
  executionInputsUnchanged,
  negativeControls,
  artifacts: finalArtifacts,
}), { flag: 'wx' });
if (!summary.passed) throw new Error(`Native item-filter recording failed: ${JSON.stringify(summary.error ?? summary)}`);
console.log(JSON.stringify({ evidenceRoot: path.relative(repoRoot, evidenceRoot).replaceAll('\\', '/'),
  runDirectory: descriptor.runDirectory, cases: scenarioCases.length, records: records.length,
  processResult: lifecycle.processResult, portAvailable: lifecycle.portAvailable,
  databaseUnlocked: lifecycle.databaseUnlocked, completeDatabaseReadStableAndRestored,
  recorderSha256, fixtureSha256 }));
