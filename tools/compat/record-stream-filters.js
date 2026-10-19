import { validationExecutable, validationOutputRoot, validationPath } from '../validation/paths.js';
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
const [outputArgument, portArgument] = process.argv.slice(2);
if (!outputArgument || !portArgument) {
  throw new Error('Usage: node tools/compat/record-stream-filters.js <new-evidence-directory> <loopback-port>');
}

const outputRoot = validationPath(path.resolve(repoRoot, outputArgument));
const allowedRoot = validationOutputRoot();
if (outputRoot === allowedRoot || !outputRoot.startsWith(allowedRoot + path.sep)) {
  throw new Error('The evidence directory must be a new child of the configured validation output root.');
}
if (existsSync(outputRoot)) throw new Error(`Evidence directory already exists: ${outputRoot}`);

const port = Number(portArgument);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('The loopback port must be an integer from 1024 through 65535.');
}

const sourceRoot = validationPath(path.join(repoRoot, '.agent-docs/evidence/core-flow-20260926/reference'));
const sourceDatabase = validationPath(path.join(repoRoot, '.agent-docs/evidence/core-flow-20260926/initial.db'));
const referenceRoot = path.join(outputRoot, 'reference');
const databasePath = path.join(referenceRoot, 'data/data/jellyfin.db');
const fixtureInputPath = validationPath(path.join(repoRoot, 'tests/library/fixtures/stream-filters/input.json'));
const dotnetPath = validationExecutable('dotnet');
const jellyfinDll = validationPath(path.join(repoRoot, '.agent-docs/baselines/jellyfin-current/source/Jellyfin.Server/bin/Release/net10.0/jellyfin.dll'));
const origin = `http://127.0.0.1:${port}`;
const deviceId = 'stream-filter-native-oracle';
const password = 'isolated-core-flow-password';
const apiKeyToken = 'streamfilterapikey000000000000000';
const fixture = JSON.parse(await readFile(fixtureInputPath, 'utf8'));
const itemByKey = new Map(fixture.items.map(item => [item.key, item]));
const keyById = new Map(fixture.items.map(item => [item.id.replaceAll('-', '').toLowerCase(), item.key]));

const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2) + '\n';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const idKey = value => String(value).replaceAll('-', '').toLowerCase();
const upperId = value => String(value).toUpperCase();

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function available(localPort) {
  return await new Promise(resolve => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port: localPort, exclusive: true }, () => server.close(() => resolve(true)));
  });
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

function targetSnapshot() {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      BaseItems: database.prepare(`SELECT "Id", "Name", "Type", "ParentId", "TopParentId", "PrimaryVersionId",
        "OwnerId", "PresentationUniqueKey", "IsFolder", "IsMovie", "MediaType", "Data"
        FROM "BaseItems" WHERE "Id" LIKE '71000000-%' ORDER BY "Id"`).all().map(row => ({ ...row })),
      AncestorIds: database.prepare(`SELECT "ItemId", "ParentItemId" FROM "AncestorIds"
        WHERE "ItemId" LIKE '71000000-%' ORDER BY "ItemId", "ParentItemId"`).all().map(row => ({ ...row })),
      LinkedChildren: database.prepare(`SELECT "ParentId", "SortOrder", "ChildId", "ChildType" FROM "LinkedChildren"
        WHERE "ParentId" LIKE '71000000-%' ORDER BY "ParentId", "SortOrder"`).all().map(row => ({ ...row })),
      MediaStreamInfos: database.prepare(`SELECT "ItemId", "StreamIndex", "StreamType", "Language", "IsExternal"
        FROM "MediaStreamInfos" WHERE "ItemId" LIKE '71000000-%' ORDER BY "ItemId", "StreamIndex"`).all().map(row => ({ ...row }))
    };
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
    assert.ok(folderTemplate && movieTemplate && aggregate, 'The frozen core-flow templates are required.');
    const typeNames = {
      Folder: 'MediaBrowser.Controller.Entities.Folder',
      BoxSet: 'MediaBrowser.Controller.Entities.Movies.BoxSet',
      Movie: 'MediaBrowser.Controller.Entities.Movies.Movie'
    };
    const streamTypes = { Audio: 0, Subtitle: 2 };
    const fixedDate = '2026-09-28 00:00:00';
    const inputById = new Map(fixture.items.map(item => [idKey(item.id), item]));
    const ancestors = item => {
      if (Array.isArray(item.ancestorIds)) return item.ancestorIds.map(upperId);
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
      assert.equal(database.prepare(`SELECT COUNT(*) AS "Count" FROM "BaseItems" WHERE "Id" LIKE '71000000-%'`).get().Count, 0);
      for (const item of fixture.items) {
        const isFolder = item.type !== 'Movie';
        const row = {
          ...(isFolder ? folderTemplate : movieTemplate),
          Id: upperId(item.id),
          Type: typeNames[item.type],
          ParentId: upperId(item.parentId ?? aggregate.Id),
          TopParentId: upperId(fixture.rootId),
          PrimaryVersionId: item.primaryVersionId ? upperId(item.primaryVersionId) : null,
          OwnerId: item.ownerId ? upperId(item.ownerId) : null,
          Name: item.name,
          CleanName: item.name.toLowerCase(),
          SortName: item.name.toLowerCase(),
          Path: isFolder ? `Z:\\StreamOracle\\${item.key}` : `Z:\\StreamOracle\\${item.key}.mkv`,
          Width: isFolder ? null : 1920,
          Height: isFolder ? null : 1080,
          IsFolder: isFolder ? 1 : 0,
          IsMovie: isFolder ? 0 : 1,
          MediaType: isFolder ? 'Unknown' : 'Video',
          UnratedType: isFolder ? 'Other' : 'Movie',
          PresentationUniqueKey: item.presentationUniqueKey ?? `stream-oracle-${idKey(item.primaryVersionId ?? item.id)}`,
          DateCreated: fixedDate,
          DateModified: fixedDate,
          DateLastSaved: fixedDate,
          Data: isFolder ? '{}' : JSON.stringify({
            VideoType: 'VideoFile',
            IsHD: true,
            IsShortcut: false,
            Width: 1920,
            Height: 1080,
            RemoteTrailers: []
          })
        };
        const columns = Object.keys(row);
        database.prepare(`INSERT INTO "BaseItems" (${columns.map(name => `"${name}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
          .run(...columns.map(name => row[name]));
        for (const parentId of ancestors(item)) {
          database.prepare('INSERT INTO "AncestorIds" ("ItemId", "ParentItemId") VALUES (?, ?)').run(row.Id, parentId);
        }
        for (const [index, stream] of (item.streams ?? []).entries()) {
          assert.ok(Object.hasOwn(streamTypes, stream.type), `Unknown stream type: ${stream.type}`);
          database.prepare(`INSERT INTO "MediaStreamInfos"
            ("ItemId", "StreamIndex", "IsDefault", "IsExternal", "IsForced", "StreamType", "Language", "IsOriginal")
            VALUES (?, ?, 0, 0, 0, ?, ?, 0)`)
            .run(row.Id, index, streamTypes[stream.type], stream.language ?? null);
        }
      }
      for (const link of fixture.links) {
        database.prepare(`INSERT INTO "LinkedChildren" ("ParentId", "SortOrder", "ChildId", "ChildType") VALUES (?, ?, ?, ?)`)
          .run(upperId(link.parentId), link.sortOrder, upperId(link.childId), link.childType);
      }
      database.prepare(`INSERT INTO "ApiKeys" ("DateCreated", "DateLastActivity", "Name", "AccessToken") VALUES (?, ?, ?, ?)`)
        .run(fixedDate, fixedDate, 'Stream Filter Native Oracle', apiKeyToken);
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
  return `MediaBrowser Client="StreamFilterNativeOracle", Device="Isolated", DeviceId="${deviceId}", Version="1"${token ? `, Token="${token}"` : ''}`;
}

function responseContract(response) {
  const items = Array.isArray(response.bodyJson?.Items) ? response.bodyJson.Items : [];
  const problem = response.status >= 400 && response.bodyJson && typeof response.bodyJson === 'object'
    ? Object.fromEntries(Object.entries(response.bodyJson).filter(([key]) => key !== 'traceId'))
    : null;
  return {
    status: response.status,
    contentType: response.headers['content-type'] ?? null,
    totalRecordCount: response.bodyJson?.TotalRecordCount ?? null,
    keys: items.map(item => keyById.get(idKey(item.Id)) ?? `unknown:${item.Id}`).sort(),
    items: items.map(item => ({
      key: keyById.get(idKey(item.Id)) ?? null,
      id: item.Id,
      name: item.Name,
      type: item.Type
    })),
    problem
  };
}

const same = contract => ({ items: contract, legacy: contract });
const split = (items, legacy) => ({ items, legacy });
const invalid = attemptedValue => same({
  status: 400,
  problem: {
    type: 'https://tools.ietf.org/html/rfc9110#section-15.5.1',
    title: 'One or more validation errors occurred.',
    status: 400,
    errors: { hasSubtitles: [`The value '${attemptedValue}' is not valid.`] }
  }
});
const expected = {
  'has-subtitles-true': same({ keys: ['subEng'] }),
  'has-subtitles-false': same({ keys: ['audioEng', 'none'] }),
  'has-subtitles-empty': same({ keys: ['none', 'subEng'] }),
  'has-subtitles-whitespace': same({ keys: ['none', 'subEng'] }),
  'has-subtitles-case-insensitive': same({ keys: ['subEng'] }),
  'has-subtitles-invalid': invalid('1'),
  'has-subtitles-repeated-first-true': same({ keys: ['subEng'] }),
  'has-subtitles-repeated-first-empty': same({ keys: ['none', 'subEng'] }),
  'has-subtitles-repeated-first-invalid': invalid('1,true'),
  'controller-combination-true-prefers-language': split({ keys: ['subFre'] }, { keys: ['subEng', 'subFre'] }),
  'controller-combination-false-prefers-absence': same({ keys: ['audioEng', 'none'] }),
  'controller-combination-empty-applies-language': split({ keys: ['subFre'] }, { keys: ['none', 'subEng', 'subFre'] }),
  'subtitle-single': split({ keys: ['subEng'] }, { keys: ['none', 'subEng', 'subFre'] }),
  'subtitle-single-comma': split({ keys: ['subEng', 'subFre'] }, { keys: ['none', 'subEng', 'subFre', 'subSpa'] }),
  'subtitle-repeated-does-not-resplit': split({ keys: ['subSpa'] }, { keys: ['subEng', 'subFre', 'subSpa'] }),
  'subtitle-repeated-simple': split({ keys: ['subEng', 'subFre'] }, { keys: ['subEng', 'subFre', 'subSpa'] }),
  'subtitle-whitespace-trimmed': split({ keys: ['subEng'] }, { keys: ['subEng', 'subFre'] }),
  'subtitle-empty-single-no-filter': same({ keys: ['none', 'subEng'] }),
  'subtitle-repeated-empty-is-value': split({ keys: ['subEng', 'subUndEmpty'] }, { keys: ['none', 'subEng', 'subUndEmpty', 'subUndNull'] }),
  'subtitle-language-case-sensitive': split({ keys: ['subUpperEng'] }, { keys: ['subEng', 'subUpperEng'] }),
  'subtitle-und-null-or-empty': split({ keys: ['subUndEmpty', 'subUndNull'] }, { keys: ['none', 'subEng', 'subUndEmpty', 'subUndNull'] }),
  'subtitle-und-and-eng': split({ keys: ['subEng', 'subUndEmpty', 'subUndNull'] }, { keys: ['none', 'subEng', 'subUndEmpty', 'subUndNull'] }),
  'subtitle-key-case-insensitive': split({ keys: ['subEng'] }, { keys: ['subEng', 'subFre'] }),
  'audio-single': split({ keys: ['audioEng'] }, { keys: ['audioEng', 'audioFre', 'none'] }),
  'audio-single-comma': split({ keys: ['audioEng', 'audioFre'] }, { keys: ['audioEng', 'audioFre', 'none'] }),
  'audio-repeated-does-not-resplit': split({ keys: ['audioUndNull'] }, { keys: ['audioEng', 'audioFre', 'audioUndNull'] }),
  'audio-repeated-simple': split({ keys: ['audioEng', 'audioFre'] }, { keys: ['audioEng', 'audioFre', 'none'] }),
  'audio-whitespace-trimmed': split({ keys: ['audioEng'] }, { keys: ['audioEng', 'audioFre'] }),
  'audio-empty-single-no-filter': same({ keys: ['audioEng', 'none'] }),
  'audio-repeated-empty-is-value': split({ keys: ['audioEng', 'audioUndEmpty'] }, { keys: ['audioEng', 'audioUndEmpty', 'audioUndNull', 'none'] }),
  'audio-language-case-sensitive': split({ keys: [] }, { keys: ['audioEng', 'audioFre'] }),
  'audio-und-null-or-empty': split({ keys: ['audioUndEmpty', 'audioUndNull'] }, { keys: ['audioEng', 'audioUndEmpty', 'audioUndNull', 'none'] }),
  'audio-und-and-eng': split({ keys: ['audioEng', 'audioUndEmpty', 'audioUndNull'] }, { keys: ['audioEng', 'audioUndEmpty', 'audioUndNull', 'none'] }),
  'subtitle-audio-intersection': split({ keys: ['subEngAudioFre'] }, { keys: ['audioFre', 'none', 'subEng', 'subEngAudioFre'] }),
  'alternate-has-subtitles': same({ keys: ['versionPrimary'] }),
  'alternate-subtitle-language': same({ keys: ['versionPrimary'] }),
  'alternate-audio-language': same({ keys: ['versionPrimary'] }),
  'alternate-language-mismatch': split({ keys: [] }, { keys: ['versionPrimary'] }),
  'owned-has-subtitles-included': same({ keys: ['ownerStreams'] }),
  'owned-subtitle-language-included-modern': split({ keys: ['ownerStreams'] }, { keys: [] }),
  'owned-audio-language-included-modern': split({ keys: ['ownerStreams'] }, { keys: [] }),
  'owned-empty-filter-hidden': same({ keys: [] }),
  'ancestor-closure-has-subtitles': same({ keys: ['ancestorTop'] }),
  'ancestor-closure-subtitle-language': same({ keys: ['ancestorTop'] }),
  'ancestor-closure-audio-language': same({ keys: ['ancestorTop'] }),
  'ancestor-closure-has-no-subtitles': same({ keys: [] }),
  'empty-folder-has-no-subtitles': same({ keys: ['noSubFolder'] }),
  'recursive-linked-folders-has-subtitles': same({ keys: ['linkedBox3'] }),
  'recursive-linked-folders-subtitle-language': same({ keys: ['linkedBox3'] }),
  'recursive-linked-folders-audio-language': same({ keys: ['linkedBox3'] }),
  'recursive-linked-folders-negative': same({ keys: [] }),
  'local-alternate-link-type-excluded': same({ keys: [] }),
  'linked-alternate-link-type-excluded': split({ keys: [] }, { keys: ['altRemoteContainer'] }),
  'linked-parent-ancestor': same({ keys: ['seamLinkedAncestor'] }),
  'linked-parent-root-seam': same({ keys: ['seamTop'] }),
  'linked-parent-root-seam-subtitle-language': same({ keys: ['seamTop'] }),
  'linked-parent-root-seam-audio-language': same({ keys: ['seamTop'] }),
  'user-presentation-grouping': same({ keys: ['groupFirst', 'groupThird'] }),
  'user-grouping-before-count-and-pagination': same({ keys: ['groupThird'], totalRecordCount: 2 }),
  'api-key-does-not-group': same({ keys: ['groupFirst', 'groupSecond', 'groupThird'] }),
  'api-key-language-does-not-group': same({ keys: ['groupFirst', 'groupSecond', 'groupThird'] }),
  'api-key-route-user-semantics': split(
    { keys: ['groupFirst', 'groupSecond', 'groupThird'] },
    { keys: ['groupFirst', 'groupThird'] }),
  'api-key-subtitle-language-legacy-ignored': split(
    { keys: ['groupFirst', 'groupSecond'] },
    { keys: ['groupFirst', 'none'] }),
  'api-key-audio-language-legacy-ignored': split(
    { keys: ['audioEng'] },
    { keys: ['audioEng', 'audioFre', 'none'] })
};
const discoveryOnly = new Set();

await assert.rejects(stat(outputRoot), error => error?.code === 'ENOENT');
const portInitiallyAvailable = await available(port);
assert.equal(portInitiallyAvailable, true, `Port ${port} is already in use.`);
await prepareReference();
const databaseStages = { beforeSeed: targetSnapshot() };
assert.deepEqual(databaseStages.beforeSeed, { BaseItems: [], AncestorIds: [], LinkedChildren: [], MediaStreamInfos: [] });
seedDatabase();
databaseStages.afterSeed = targetSnapshot();

const stdoutPath = path.join(outputRoot, 'reference-stdout.log');
const stderrPath = path.join(outputRoot, 'reference-stderr.log');
const stdoutDescriptor = openSync(stdoutPath, 'wx');
const stderrDescriptor = openSync(stderrPath, 'wx');
const argumentsList = [
  jellyfinDll,
  '--datadir', path.join(referenceRoot, 'data'),
  '--configdir', path.join(referenceRoot, 'config'),
  '--cachedir', path.join(referenceRoot, 'cache'),
  '--logdir', path.join(referenceRoot, 'log'),
  '--nowebclient'
];
const child = spawn(dotnetPath, argumentsList, {
  cwd: repoRoot,
  windowsHide: true,
  stdio: ['ignore', stdoutDescriptor, stderrDescriptor]
});
const completion = new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve({ code, signal }));
});

const records = [];
const contracts = [];
let accessToken;
let scenarioError;
let cleanShutdown = false;
let processResult;

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
    request: { method, route, headers: { ...headers, Authorization: authorization('<token>') }, body: body ?? null },
    response: result
  });
  return result;
}

async function waitForReady() {
  let consecutiveSuccesses = 0;
  for (let attempt = 0; attempt < 90; attempt++) {
    if (child.exitCode !== null) throw new Error(`Reference exited before readiness with code ${child.exitCode}.`);
    try {
      const response = await fetch(`${origin}/System/Info/Public`, { signal: AbortSignal.timeout(1_000) });
      consecutiveSuccesses = response.ok ? consecutiveSuccesses + 1 : 0;
      if (consecutiveSuccesses >= 3) return;
    } catch { consecutiveSuccesses = 0; }
    await delay(500);
  }
  throw new Error('Reference did not become ready within 45 seconds.');
}

function routeFor(endpoint, testCase) {
  const scopeIds = testCase.scope.map(key => {
    const item = itemByKey.get(key);
    assert.ok(item, `Unknown fixture scope key: ${key}`);
    return item.id;
  }).join(',');
  const parentId = testCase.parentKey ? itemByKey.get(testCase.parentKey)?.id : fixture.rootId;
  assert.ok(parentId, `${testCase.name}: unknown parentKey ${testCase.parentKey}`);
  const common = `ParentId=${encodeURIComponent(parentId)}&Recursive=true&Ids=${encodeURIComponent(scopeIds)}`
    + '&SortBy=SortName&Fields=MediaStreams&EnableImages=false&EnableUserData=false';
  const prefix = endpoint === 'items' ? '/Items' : `/Users/${fixture.userId}/Items`;
  return `${prefix}?${common}&${testCase.query}`;
}

try {
  await waitForReady();
  const login = await request('login-admin', '/Users/AuthenticateByName', {
    method: 'POST',
    token: undefined,
    body: { Username: 'CoreFlowAdmin', Pw: password }
  });
  assert.equal(login.status, 200, 'The frozen admin login should succeed.');
  accessToken = login.bodyJson.AccessToken;
  assert.equal(idKey(login.bodyJson.User.Id), idKey(fixture.userId));
  databaseStages.beforeReads = targetSnapshot();
  assert.deepEqual(databaseStages.beforeReads, databaseStages.afterSeed);

  for (const testCase of fixture.cases) {
    const endpoints = testCase.endpoints ?? ['items', 'legacy'];
    const endpointContracts = [];
    for (const endpoint of endpoints) {
      const token = testCase.auth === 'apiKey' ? apiKeyToken : accessToken;
      const response = await request(`${testCase.name}:${endpoint}`, routeFor(endpoint, testCase), { token });
      const contract = responseContract(response);
      endpointContracts.push({ endpoint, ...contract });
      if (!discoveryOnly.has(testCase.name)) {
        const pinned = expected[testCase.name]?.[endpoint];
        assert.ok(pinned, `${testCase.name}:${endpoint}: missing pinned expectation.`);
        assert.equal(contract.status, pinned.status ?? 200, `${testCase.name}:${endpoint}: unexpected HTTP status.`);
        if (contract.status === 200) {
          assert.deepEqual(contract.keys, [...pinned.keys].sort(), `${testCase.name}:${endpoint}: unexpected item membership.`);
          assert.equal(contract.totalRecordCount, pinned.totalRecordCount ?? pinned.keys.length,
            `${testCase.name}:${endpoint}: unexpected total count.`);
        } else {
          assert.deepEqual(contract.problem, pinned.problem, `${testCase.name}:${endpoint}: unexpected validation body.`);
        }
      }
    }
    contracts.push({
      name: testCase.name,
      query: testCase.query,
      scope: testCase.scope,
      ...(testCase.parentKey ? { parentKey: testCase.parentKey } : {}),
      auth: testCase.auth ?? 'user',
      endpoints,
      discoveryOnly: discoveryOnly.has(testCase.name),
      contracts: endpointContracts
    });
  }

  databaseStages.afterReads = targetSnapshot();
  assert.deepEqual(databaseStages.afterReads, databaseStages.beforeReads);
} catch (error) {
  scenarioError = error;
} finally {
  if (child.exitCode === null && accessToken) {
    try {
      const shutdown = await request('authenticated-shutdown', '/System/Shutdown', { method: 'POST' });
      cleanShutdown = shutdown.status === 204;
    } catch (error) {
      scenarioError ??= error;
    }
  }
  if (child.exitCode === null) {
    processResult = await Promise.race([completion, delay(20_000).then(() => null)]);
    if (processResult === null) {
      child.kill();
      processResult = await completion;
    }
  } else {
    processResult = await completion;
  }
  closeSync(stdoutDescriptor);
  closeSync(stderrDescriptor);
}

databaseStages.finalAfterShutdown = targetSnapshot();
if (databaseStages.afterReads !== undefined) {
  assert.deepEqual(databaseStages.finalAfterShutdown, databaseStages.afterReads);
}
const portFinallyAvailable = await available(port);
const validationRecords = records.filter(record => record.response.status === 400);
assert.equal(validationRecords.length, 4);
assert.ok(validationRecords.every(record => typeof record.response.bodyJson?.traceId === 'string'
  && record.response.bodyJson.traceId.length > 0));
const summary = {
  passed: scenarioError == null && cleanShutdown && processResult?.code === 0 && portFinallyAvailable,
  origin,
  fixtureCases: fixture.cases.length,
  httpRecords: records.length,
  endpointCases: contracts.reduce((total, entry) => total + entry.endpoints.length, 0),
  discoveryOnlyCases: [...discoveryOnly],
  validationResponses: validationRecords.length,
  rawValidationProblemsIncludeTraceId: true,
  databaseUnchangedByReads: databaseStages.beforeReads !== undefined
    && JSON.stringify(databaseStages.beforeReads) === JSON.stringify(databaseStages.afterReads),
  databaseUnchangedAfterShutdown: databaseStages.afterReads !== undefined
    && JSON.stringify(databaseStages.afterReads) === JSON.stringify(databaseStages.finalAfterShutdown),
  process: { pid: child.pid, ...processResult, cleanShutdown, portInitiallyAvailable, portFinallyAvailable },
  error: scenarioError ? { name: scenarioError.name, message: scenarioError.message, stack: scenarioError.stack } : null
};

await writeFile(path.join(outputRoot, 'native-http.json'), json({ schemaVersion: 1, origin, records }), { flag: 'wx' });
await writeFile(path.join(outputRoot, 'database-stages.json'), json(databaseStages), { flag: 'wx' });
await writeFile(path.join(outputRoot, 'native-contract.json'), json({
  schemaVersion: 1,
  frozenJellyfin: true,
  fixtureInputSha256: await sha256(fixtureInputPath),
  endpoints: ['/Items', '/Users/{userId}/Items'],
  cases: contracts
}), { flag: 'wx' });
await writeFile(path.join(outputRoot, 'summary.json'), json(summary), { flag: 'wx' });

const sourcePaths = [
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.TranslateQuery.cs',
  'Jellyfin.Api/Controllers/ItemsController.cs',
  'Jellyfin.Api/ModelBinders/CommaDelimitedCollectionModelBinder.cs',
  'Jellyfin.Server.Implementations/Security/AuthorizationContext.cs',
  'MediaBrowser.Controller/Entities/InternalItemsQuery.cs',
  'src/Jellyfin.Database/Jellyfin.Database.Implementations/DescendantQueryHelper.cs',
  'src/Jellyfin.Database/Jellyfin.Database.Implementations/MatchCriteria/HasMediaStreamType.cs',
  'tests/Jellyfin.Server.Implementations.Tests/Item/BaseItemRepositoryStreamFilterTests.cs'
];
const nativeSources = [];
for (const relative of sourcePaths) {
  const file = validationPath(path.join(repoRoot, '.agent-docs/baselines/jellyfin-current/source', relative));
  nativeSources.push({ path: path.relative(repoRoot, file).replaceAll('\\', '/'), sha256: await sha256(file) });
}
const artifactNames = ['native-http.json', 'database-stages.json', 'native-contract.json', 'summary.json', 'reference-stdout.log', 'reference-stderr.log'];
const artifacts = [];
for (const name of artifactNames) artifacts.push({ path: name, sha256: await sha256(path.join(outputRoot, name)) });
const gitHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
const dotnetInfo = spawnSync(dotnetPath, ['--info'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
await writeFile(path.join(outputRoot, 'provenance.json'), json({
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  gitHead: gitHead.status === 0 ? gitHead.stdout.trim() : null,
  scenario: 'Frozen Jellyfin HTTP HasSubtitles, SubtitleLanguages, and AudioLanguages oracle across both Items routes, model binding, versions, ownership, grouping, ancestors, and recursively linked containers.',
  isolation: {
    sourceInstance: path.relative(repoRoot, sourceRoot).replaceAll('\\', '/'),
    sourceDatabase: path.relative(repoRoot, sourceDatabase).replaceAll('\\', '/'),
    clonedInstance: path.relative(repoRoot, referenceRoot).replaceAll('\\', '/'),
    loopbackOnly: true,
    autoDiscovery: false,
    port,
    portInitiallyAvailable,
    portFinallyAvailable,
    frozenInputsWereNotRunInPlace: true,
    syntheticCredentialsAndTokensOnly: true
  },
  command: [path.relative(repoRoot, dotnetPath).replaceAll('\\', '/'), ...argumentsList.map(value => path.isAbsolute(value)
    ? path.relative(repoRoot, value).replaceAll('\\', '/') : value)],
  runtime: { node: process.version, dotnetInfoExitCode: dotnetInfo.status, dotnetInfo: dotnetInfo.stdout },
  referenceAssemblies: [{ path: path.relative(repoRoot, jellyfinDll).replaceAll('\\', '/'), sha256: await sha256(jellyfinDll) }],
  nativeSources,
  recorder: {
    path: path.relative(repoRoot, fileURLToPath(import.meta.url)).replaceAll('\\', '/'),
    sha256: await sha256(fileURLToPath(import.meta.url))
  },
  preparedInputs: [
    { path: path.relative(repoRoot, sourceDatabase).replaceAll('\\', '/'), sha256: await sha256(sourceDatabase) },
    { path: path.relative(repoRoot, fixtureInputPath).replaceAll('\\', '/'), sha256: await sha256(fixtureInputPath) },
    { path: path.relative(repoRoot, path.join(referenceRoot, 'config/network.xml')).replaceAll('\\', '/'), sha256: await sha256(path.join(referenceRoot, 'config/network.xml')) }
  ],
  result: { passed: summary.passed, process: summary.process, discoveryOnlyCases: summary.discoveryOnlyCases },
  artifacts
}), { flag: 'wx' });

console.log(json({ outputRoot, summary, contract: path.join(outputRoot, 'native-contract.json') }).trim());
if (scenarioError) throw scenarioError;
if (!summary.passed) throw new Error(`The isolated frozen reference did not complete cleanly: ${JSON.stringify(summary.process)}`);
