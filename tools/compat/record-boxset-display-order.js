import { validationExecutable, validationOutputRoot, validationPath } from '../validation/paths.js';
// Isolated frozen-Jellyfin oracle for legacy/modern BoxSet children, display ordering and per-user access.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { getNewItemId } from '../../src/core/identity.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [outputArgument, portArgument] = process.argv.slice(2);
if (!outputArgument || !portArgument) throw new Error('Usage: node record-native.mjs <new-evidence-directory> <loopback-port>');
const output = validationPath(path.resolve(repo, outputArgument));
const allowedRoot = validationOutputRoot();
if (output === allowedRoot || !output.startsWith(allowedRoot + path.sep) || existsSync(output)) {
  throw new Error('Evidence must be a new child directory of the configured validation output root.');
}
const port = Number(portArgument);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid loopback port.');
const origin = `http://127.0.0.1:${port}`;
const source = validationPath(path.join(repo, '.test-input/evidence/core-flow-20260926/reference'));
const sourceDatabase = validationPath(path.join(repo, '.test-input/evidence/core-flow-20260926/initial.db'));
const reference = path.join(output, 'reference');
const databasePath = path.join(reference, 'data/data/jellyfin.db');
const fixturePath = validationPath(path.join(repo, 'tests/library/fixtures/boxset-display-order/input.json'));
const dotnet = validationExecutable('dotnet');
const dll = validationPath(path.join(repo, '.test-input/baselines/jellyfin-current/source/Jellyfin.Server/bin/Release/net10.0/jellyfin.dll'));
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const itemByKey = new Map(fixture.items.map(item => [item.key, item]));
const targetKeys = fixture.items.filter(item => item.type !== 'AggregateFolder').map(item => item.key);
const collectionsPath = path.join(reference, 'data/data/collections');
const paths = {
  userRoot: path.join(reference, 'data/root/default'),
  physicalA: path.join(reference, 'library-content/A'),
  physicalB: path.join(reference, 'library-content/B'),
  collections: collectionsPath,
  libraryA: path.join(reference, 'data/root/default/Library A'),
  libraryB: path.join(reference, 'data/root/default/Library B'),
  collectionLibrary: path.join(reference, 'data/root/default/Collection Library'),
};
const dataRoot = path.join(reference, 'data/data');
const itemPath = item => {
  if (paths[item.pathKind]) return paths[item.pathKind];
  if (item.pathKind === 'noPath') return null;
  if (item.pathKind === 'dataExact') return dataRoot;
  if (item.pathKind === 'dataTrailing') return dataRoot + path.sep;
  if (item.pathKind === 'dataEscape') return dataRoot + path.sep + '..' + path.sep + item.key;
  if (item.pathKind === 'dataUpper') return dataRoot.toUpperCase() + path.sep + item.key;
  if (item.pathKind === 'dataSibling') return dataRoot + '-sibling' + path.sep + item.key;
  if (item.pathKind === 'boxset') return path.join(collectionsPath, item.key);
  if (item.pathKind === 'child') {
    const parent = fixture.items.find(row => row.id === item.parentId);
    return path.join(itemPath(parent) ?? paths.physicalA, item.key + (item.type === 'Movie' ? '.mkv' : ''));
  }
  return path.join(paths.physicalA, item.key);
};
const itemData = item => {
  const data = { ...(item.data ?? {}) };
  if (item.type === 'CollectionFolder') data.PhysicalLocationsList = data.PhysicalFolderIds.map(id => itemPath(fixture.items.find(child => child.id === id)));
  return data;
};
const password = 'isolated-core-flow-password';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2) + '\n';
const stable = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const upperId = value => String(value).toUpperCase();

async function available() {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

async function walk(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    else files.push(target);
  }
  return files;
}

async function filesystemSnapshot() {
  const domains = { userViews: paths.userRoot, metadata: path.join(reference, 'data/metadata'),
    libraries: path.join(reference, 'library-content'), collections: collectionsPath };
  const result = {};
  for (const [name, directory] of Object.entries(domains)) {
    const entries = [];
    async function visit(current) {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const target = path.join(current, entry.name);
        const relative = path.relative(directory, target).replaceAll('\\', '/');
        if (entry.isDirectory()) { entries.push({ path: relative, type: 'directory' }); await visit(target); }
        else entries.push({ path: relative, type: 'file', sha256: sha256(await readFile(target)) });
      }
    }
    if (existsSync(directory)) await visit(directory);
    result[name] = { exists: existsSync(directory), entries: entries.sort((a, b) => a.path.localeCompare(b.path)) };
  }
  return result;
}

async function prepareReference() {
  await mkdir(output);
  await writeFile(path.join(output, 'input.json'), await readFile(fixturePath), { flag: 'wx' });
  await cp(source, reference, { recursive: true, filter(file) {
    const relative = path.relative(source, file).replaceAll('\\', '/');
    return !relative.startsWith('log/') && !/^data\/data\/jellyfin\.db(?:-wal|-shm)?$/u.test(relative);
  } });
  await mkdir(path.join(reference, 'log'), { recursive: true });
  await cp(sourceDatabase, databasePath, { force: false, errorOnExist: true });
  const sourceForms = [source, source.replaceAll('\\', '/'), source.replaceAll('\\', '\\\\')];
  for (const file of await walk(reference)) {
    if (!/\.(?:json|xml)$/u.test(file)) continue;
    let content = await readFile(file, 'utf8');
    for (const oldPath of sourceForms) content = content.replaceAll(oldPath, reference);
    if (path.basename(file).toLowerCase() === 'network.xml') {
      content = content.replace(/<(InternalHttpPort|PublicHttpPort)>\d+<\/\1>/gu, (_, name) => `<${name}>${port}</${name}>`);
      content = content.replace(/<AutoDiscovery>true<\/AutoDiscovery>/gu, '<AutoDiscovery>false</AutoDiscovery>');
    }
    await writeFile(file, content);
  }
  for (const directory of Object.values(paths)) await mkdir(directory, { recursive: true });
  assert.equal(getNewItemId(paths.userRoot, 'MediaBrowser.Controller.Entities.UserRootFolder', {
    programDataPath: path.join(reference, 'data'),
  }), itemByKey.get('userRoot').id.replaceAll('-', ''));
  seedDatabase();
}

function seedDatabase() {
  const database = new DatabaseSync(databasePath);
  try {
    const folderTemplate = database.prepare('SELECT * FROM "BaseItems" WHERE "Id" = ?').get('11111111-1111-1111-1111-111111111111');
    const movieTemplate = database.prepare('SELECT * FROM "BaseItems" WHERE "Id" = ?').get('22222222-2222-2222-2222-222222222222');
    assert.ok(folderTemplate && movieTemplate, 'Frozen folder and movie templates are required.');
    const nativeTypes = {
      Folder: 'MediaBrowser.Controller.Entities.Folder', Movie: 'MediaBrowser.Controller.Entities.Movies.Movie',
      BoxSet: 'MediaBrowser.Controller.Entities.Movies.BoxSet', Series: 'MediaBrowser.Controller.Entities.TV.Series',
      Audio: 'MediaBrowser.Controller.Entities.Audio.Audio',
      CollectionFolder: 'MediaBrowser.Controller.Entities.CollectionFolder',
      UserRootFolder: 'MediaBrowser.Controller.Entities.UserRootFolder',
      UserView: 'MediaBrowser.Controller.Entities.UserView',
    };
    const quote = name => `"${name.replaceAll('"', '""')}"`;
    database.exec('BEGIN IMMEDIATE');
    try {
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM "BaseItems" WHERE "Id" LIKE '80100000-%'`).get().count, 0);
      for (const item of fixture.items) {
        if (item.type === 'AggregateFolder') {
          assert.equal(database.prepare('SELECT "Type" FROM "BaseItems" WHERE "Id" = ?').get(upperId(item.id)).Type,
            'MediaBrowser.Controller.Entities.AggregateFolder');
          continue;
        }
        const isFolder = !['Movie', 'Audio'].includes(item.type);
        const row = {
          ...(isFolder ? folderTemplate : movieTemplate),
          Id: upperId(item.id),
          Type: nativeTypes[item.type],
          ParentId: item.parentId == null ? null : upperId(item.parentId),
          TopParentId: item.topParentId == null ? null : upperId(item.topParentId),
          Name: item.name,
          CleanName: item.sortName,
          SortName: item.sortName,
          Path: itemPath(item),
          IsFolder: isFolder ? 1 : 0,
          IsMovie: item.type === 'Movie' ? 1 : 0,
          IsSeries: item.type === 'Series' ? 1 : 0,
          Overview: item.overview ?? null,
          Tags: item.tagsText ?? null,
          OfficialRating: item.officialRating ?? null,
          CustomRating: item.customRating ?? null,
          InheritedParentalRatingValue: item.inheritedParentalRatingValue ?? null,
          InheritedParentalRatingSubValue: item.inheritedParentalRatingSubValue ?? null,
          MediaType: item.mediaType ?? (item.type === 'Movie' ? 'Video' : item.type === 'Audio' ? 'Audio' : 'Unknown'),
          UnratedType: item.type === 'Movie' ? 'Movie' : 'Other',
          PresentationUniqueKey: item.presentationUniqueKey ?? item.id.replaceAll('-', ''),
          PremiereDate: item.premiereDate ?? null,
          Album: item.album ?? null, RunTimeTicks: item.runTimeTicks == null ? null : Number(item.runTimeTicks),
          CommunityRating: item.communityRating ?? null, CriticRating: item.criticRating ?? null,
          IndexNumber: item.indexNumber ?? null, ParentIndexNumber: item.parentIndexNumber ?? null,
          ProductionYear: item.productionYear ?? null,
          DateCreated: item.dateCreated ?? '2026-09-29 12:00:00',
          DateModified: '2026-09-29 12:00:00',
          DateLastSaved: '2026-09-29 12:00:00',
          Data: JSON.stringify(itemData(item)),
        };
        const columns = Object.keys(row);
        database.prepare(`INSERT INTO "BaseItems" (${columns.map(quote).join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
          .run(...columns.map(name => row[name]));
      }
      for (const item of fixture.items) for (const ancestorId of item.ancestorIds ?? []) {
        database.prepare('INSERT INTO "AncestorIds" ("ItemId", "ParentItemId") VALUES (?, ?)')
          .run(upperId(item.id), upperId(ancestorId));
      }
      for (const link of fixture.links) {
        database.prepare('INSERT INTO "LinkedChildren" ("ParentId", "SortOrder", "ChildId", "ChildType") VALUES (?, ?, ?, ?)')
          .run(upperId(link.parentId), link.sortOrder, upperId(link.childId), link.childType);
      }
      for (const value of fixture.itemValues) {
        database.prepare('INSERT INTO "ItemValues" ("ItemValueId", "Type", "Value", "CleanValue") VALUES (?, ?, ?, ?)')
          .run(upperId(value.id), value.type, value.value, value.cleanValue);
      }
      for (const link of fixture.itemValueLinks) {
        database.prepare('INSERT INTO "ItemValuesMap" ("ItemId", "ItemValueId") VALUES (?, ?)')
          .run(upperId(itemByKey.get(link.itemKey).id), upperId(fixture.itemValues.find(value => value.key === link.valueKey).id));
      }
      for (const data of fixture.userData) {
        const item = itemByKey.get(data.itemKey);
        database.prepare('INSERT INTO "UserData" ("ItemId","UserId","CustomDataKey","IsFavorite","LastPlayedDate","PlayCount","PlaybackPositionTicks","Played") VALUES (?,?,?,?,?,?,?,?)')
          .run(upperId(item.id), upperId(fixture.userId), item.id, data.isFavorite ? 1 : 0, data.lastPlayedDate,
            data.playCount, Number(data.positionTicks), data.played ? 1 : 0);
      }
      database.exec('COMMIT');
    } catch (error) { database.exec('ROLLBACK'); throw error; }
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { database.close(); }
}

function databaseSnapshot() {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      baseItems: database.prepare(`SELECT * FROM "BaseItems" WHERE "Id" LIKE '80100000-%' OR "Id" = ? ORDER BY "Id"`).all(upperId(itemByKey.get('userRoot').id)),
      ancestorIds: database.prepare(`SELECT * FROM "AncestorIds" WHERE "ItemId" LIKE '80100000-%' ORDER BY "ItemId", "ParentItemId"`).all(),
      linkedChildren: database.prepare(`SELECT * FROM "LinkedChildren" WHERE "ParentId" LIKE '80100000-%' ORDER BY "ParentId", "SortOrder"`).all(),
      itemValues: database.prepare(`SELECT * FROM "ItemValues" WHERE "ItemValueId" LIKE '80100000-%' ORDER BY "ItemValueId"`).all(),
      itemValueLinks: database.prepare(`SELECT * FROM "ItemValuesMap" WHERE "ItemId" LIKE '80100000-%' ORDER BY "ItemId", "ItemValueId"`).all(),
      userData: database.prepare("SELECT * FROM UserData WHERE ItemId LIKE '80100000-%' ORDER BY ItemId, UserId, CustomDataKey").all(),
      foreignKeyCheck: database.prepare('PRAGMA foreign_key_check').all(),
    };
  } finally { database.close(); }
}

const authorization = token => `MediaBrowser Client="LegacyBoxSetOracle", Device="Isolated", DeviceId="legacy-boxset-oracle", Version="1"${token ? `, Token="${token}"` : ''}`;
async function request(route, { method = 'GET', token, body } = {}) {
  const response = await fetch(origin + route, { method, headers: { Accept: 'application/json', Authorization: authorization(token),
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const bodyText = await response.text();
  let bodyJson;
  try { bodyJson = JSON.parse(bodyText); } catch { /* Not JSON. */ }
  return { status: response.status, contentType: response.headers.get('content-type'), bodyText,
    ...(bodyJson === undefined ? {} : { bodyJson }) };
}

function startReference() {
  const stdout = openSync(path.join(output, 'reference-stdout.log'), 'wx');
  const stderr = openSync(path.join(output, 'reference-stderr.log'), 'wx');
  const child = spawn(dotnet, [dll, '--datadir', path.join(reference, 'data'), '--configdir', path.join(reference, 'config'),
    '--cachedir', path.join(reference, 'cache'), '--logdir', path.join(reference, 'log'), '--nowebclient'], {
    cwd: repo, windowsHide: true, stdio: ['ignore', stdout, stderr],
  });
  const completion = new Promise(resolve => {
    child.once('error', error => resolve({ code: null, signal: null, error: { name: error.name, message: error.message } }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, completion, closeDescriptors() { closeSync(stdout); closeSync(stderr); } };
}

async function waitForReady(instance) {
  for (let attempt = 0; attempt < 90; attempt++) {
    if (instance.child.exitCode !== null) throw new Error(`Frozen reference exited before readiness: ${instance.child.exitCode}`);
    try {
      const startupLog = await readFile(path.join(output, 'reference-stdout.log'), 'utf8');
      if (startupLog.includes('Main: Startup complete')
        && (await fetch(origin + '/System/Info/Public', { signal: AbortSignal.timeout(1000) })).ok) return;
    }
    catch { /* Wait for native bind. */ }
    await delay(500);
  }
  throw new Error('Frozen reference did not become ready.');
}

assert.equal(await available(), true, 'Loopback port is occupied.');
const inputHashes = {
  recorderSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
  fixtureSha256: sha256(await readFile(fixturePath)),
  sourceDatabaseSha256: sha256(await readFile(sourceDatabase)),
  dllSha256: sha256(await readFile(dll)),
};
await prepareReference();
const stages = { before: { database: databaseSnapshot(), filesystem: await filesystemSnapshot() } };
const records = [];
const setupRecords = [];
let instance, token, result, outcomeError;
try {
  instance = startReference();
  await waitForReady(instance);
  const login = await request('/Users/AuthenticateByName', { method: 'POST', body: { Username: 'CoreFlowAdmin', Pw: password } });
  assert.equal(login.status, 200, `Frozen admin login failed: ${login.bodyText}`);
  token = login.bodyJson.AccessToken;
  const userId = login.bodyJson.User.Id;
  assert.equal(userId.replaceAll('-', '').toLowerCase(), fixture.userId.replaceAll('-', '').toLowerCase());
  const createKey = await request('/Auth/Keys?app=LegacyBoxSetOracle', { method: 'POST', token });
  assert.equal(createKey.status, 204);
  const keys = await request('/Auth/Keys', { token });
  assert.equal(keys.status, 200);
  const apiKey = keys.bodyJson.Items.find(item => item.AppName === 'LegacyBoxSetOracle')?.AccessToken;
  assert.ok(apiKey);
  const configuration = await request('/System/Configuration', { token });
  assert.equal(configuration.status, 200);
  const configUpdate = await request('/System/Configuration', { method: 'POST', token, body: {
    ...configuration.bodyJson, EnableGroupingMoviesIntoCollections: false, EnableGroupingShowsIntoCollections: false,
  } });
  assert.equal(configUpdate.status, 204);
  setupRecords.push({ kind: 'configuration', status: configUpdate.status, values: {
    EnableGroupingMoviesIntoCollections: false, EnableGroupingShowsIntoCollections: false,
  } });
  for (const testCase of fixture.cases) {
    if (testCase.policy) {
      const policy = await request(`/Users/${userId}/Policy`, {
        method: 'POST', token, body: { ...login.bodyJson.User.Policy, ...testCase.policy },
      });
      assert.equal(policy.status, 204, `Policy update failed for ${testCase.name}: ${policy.bodyText}`);
      setupRecords.push({ kind: 'policy', name: testCase.name, policy: testCase.policy, status: policy.status });
    }
    for (const endpoint of testCase.endpoints ?? ['items', 'legacy']) {
      const common = [];
      if (!testCase.omitParentId) common.push(`ParentId=${itemByKey.get(testCase.parentKey).id}`);
      if (testCase.recursive !== null) common.push(`Recursive=${testCase.recursive ? 'true' : 'false'}`);
      if (!testCase.omitIds) common.push(`Ids=${testCase.scope.map(key => itemByKey.get(key).id).join(',')}`);
      if (!testCase.omitSortBy) common.push(`SortBy=${testCase.sortBy ?? 'SortName'}`);
      common.push('Fields=SortName', 'EnableImages=false', 'EnableUserData=false', testCase.query);
      const prefix = endpoint === 'items' ? '/Items' : `/Users/${userId}/Items`;
      const route = endpoint === 'detail' ? `/Items/${itemByKey.get(testCase.detailKey).id}` : `${prefix}?${common.join('&')}`;
      records.push({ name: testCase.name, query: testCase.query, scope: testCase.scope, endpoint, route,
        response: await request(route, { token: testCase.auth === 'apiKey' ? apiKey : token }) });
    }
  }
  stages.afterReads = { database: databaseSnapshot(), filesystem: await filesystemSnapshot() };
} catch (error) { outcomeError = error; }
finally {
  if (instance) {
    if (token && instance.child.exitCode === null) {
      try { await request('/System/Shutdown', { method: 'POST', token }); }
      catch (error) { outcomeError ??= error; }
    }
    result = await Promise.race([instance.completion, delay(20000).then(() => null)]);
    if (!result && instance.child.exitCode === null) {
      instance.child.kill();
      result = await Promise.race([instance.completion, delay(10000).then(() => null)]);
    }
    instance.closeDescriptors();
  }
  stages.afterShutdown = { database: databaseSnapshot(), filesystem: await filesystemSnapshot() };
  await writeFile(path.join(output, 'native-http.json'), json({ origin, records }), { flag: 'wx' });
  await writeFile(path.join(output, 'setup-http.json'), json({ origin, records: setupRecords }), { flag: 'wx' });
  await writeFile(path.join(output, 'stages.json'), json({ schemaVersion: 1, targetKeys, ...stages }), { flag: 'wx' });
  const summary = {
    passed: !outcomeError && records.length === fixture.cases.reduce((count, item) => count + (item.endpoints?.length ?? 2), 0)
      && records.every(record => [200, 401, 404].includes(record.response.status))
      && result?.code === 0 && await available()
      && Object.values(stages).every(stage => stage.database.foreignKeyCheck.length === 0)
      && stable(stages.before.database) === stable(stages.afterReads.database)
      && stable(stages.before.database) === stable(stages.afterShutdown.database)
      && stable(stages.before.filesystem) === stable(stages.afterReads.filesystem)
      && stable(stages.before.filesystem) === stable(stages.afterShutdown.filesystem),
    cases: records.length,
    processResult: result,
    portAvailable: await available(),
    ...inputHashes,
    error: outcomeError ? { name: outcomeError.name, message: outcomeError.message, stack: outcomeError.stack } : null,
  };
  await writeFile(path.join(output, 'summary.json'), json(summary), { flag: 'wx' });
  if (!summary.passed) throw new Error(`Legacy BoxSet oracle failed: ${JSON.stringify(summary.error ?? summary.processResult)}`);
  console.log(JSON.stringify({ evidence: path.relative(repo, output), cases: records.length,
    processResult: result, portAvailable: summary.portAvailable }));
}
