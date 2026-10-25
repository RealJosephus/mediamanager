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
  throw new Error('Usage: node tools/compat/record-person-filters.js <new-evidence-directory> <loopback-port>');
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

const sourceRoot = validationPath(path.join(repoRoot, '.test-input/evidence/core-flow-20260926/reference'));
const sourceDatabase = validationPath(path.join(repoRoot, '.test-input/evidence/core-flow-20260926/initial.db'));
const referenceRoot = path.join(outputRoot, 'reference');
const databasePath = path.join(referenceRoot, 'data/data/jellyfin.db');
const fixtureInputPath = validationPath(path.join(repoRoot, 'tests/library/fixtures/person-filters/input.json'));
const dotnetPath = validationExecutable('dotnet');
const jellyfinDll = validationPath(path.join(repoRoot, '.test-input/baselines/jellyfin-current/source/Jellyfin.Server/bin/Release/net10.0/jellyfin.dll'));
const origin = `http://127.0.0.1:${port}`;
const deviceId = 'person-filter-native-oracle';
const password = 'isolated-core-flow-password';
const apiKeyToken = 'personfilterapikey00000000000000';
const fixture = JSON.parse(await readFile(fixtureInputPath, 'utf8'));
const itemByKey = new Map(fixture.items.map(item => [item.key, item]));
const keyById = new Map(fixture.items.map(item => [item.id.replaceAll('-', '').toLowerCase(), item.key]));
const personByKey = new Map(fixture.people.map(person => [person.key, person]));

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
      BaseItems: database.prepare(`SELECT "Id", "Name", "CleanName", "SortName", "Type", "ParentId", "TopParentId", "PrimaryVersionId",
        "OwnerId", "PresentationUniqueKey", "Width", "Height", "IsFolder", "IsMovie", "MediaType", "Data"
        FROM "BaseItems" WHERE "Id" LIKE '72000000-%' ORDER BY "Id"`).all().map(row => ({ ...row })),
      AncestorIds: database.prepare(`SELECT "ItemId", "ParentItemId" FROM "AncestorIds"
        WHERE "ItemId" LIKE '72000000-%' ORDER BY "ItemId", "ParentItemId"`).all().map(row => ({ ...row })),
      LinkedChildren: database.prepare(`SELECT "ParentId", "SortOrder", "ChildId", "ChildType" FROM "LinkedChildren"
        WHERE "ParentId" LIKE '72000000-%' ORDER BY "ParentId", "SortOrder"`).all().map(row => ({ ...row })),
      Peoples: database.prepare(`SELECT "Id", "Name", "PersonType" FROM "Peoples"
        WHERE "Id" LIKE '72000000-%' ORDER BY "Id"`).all().map(row => ({ ...row })),
      PeopleBaseItemMap: database.prepare(`SELECT "ItemId", "PeopleId", "Role", "ListOrder", "SortOrder"
        FROM "PeopleBaseItemMap" WHERE "ItemId" LIKE '72000000-%' OR "PeopleId" LIKE '72000000-%'
        ORDER BY "ItemId", "PeopleId", "Role"`).all().map(row => ({ ...row }))
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
      Movie: 'MediaBrowser.Controller.Entities.Movies.Movie',
      Person: 'MediaBrowser.Controller.Entities.Person'
    };
    const fixedDate = '2026-09-27 12:00:00';
    const inputById = new Map(fixture.items.map(item => [idKey(item.id), item]));
    const ancestors = item => {
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
      assert.equal(database.prepare(`SELECT COUNT(*) AS "Count" FROM "BaseItems" WHERE "Id" LIKE '72000000-%'`).get().Count, 0);
      assert.equal(database.prepare(`SELECT COUNT(*) AS "Count" FROM "Peoples" WHERE "Id" LIKE '72000000-%'`).get().Count, 0);
      for (const item of fixture.items) {
        const isFolder = item.type === 'Folder' || item.type === 'BoxSet';
        const isMovie = item.type === 'Movie';
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
          SortName: item.sortName ?? item.name.toLowerCase(),
          Path: isFolder || item.type === 'Person'
            ? `Z:\\PersonFilterOracle\\${item.key}`
            : `Z:\\PersonFilterOracle\\${item.key}.mkv`,
          Width: item.width ?? null,
          Height: item.height ?? null,
          IsFolder: isFolder ? 1 : 0,
          IsMovie: isMovie ? 1 : 0,
          MediaType: isMovie ? 'Video' : 'Unknown',
          UnratedType: isMovie ? 'Movie' : 'Other',
          PresentationUniqueKey: item.presentationUniqueKey ?? `person-filter-oracle-${idKey(item.primaryVersionId ?? item.id)}`,
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
      for (const link of fixture.links) {
        database.prepare(`INSERT INTO "LinkedChildren" ("ParentId", "SortOrder", "ChildId", "ChildType") VALUES (?, ?, ?, ?)`)
          .run(upperId(link.parentId), link.sortOrder, upperId(link.childId), link.childType);
      }
      for (const person of fixture.people) {
        database.prepare(`INSERT INTO "Peoples" ("Id", "Name", "PersonType") VALUES (?, ?, ?)`)
          .run(upperId(person.id), person.name, person.personType);
      }
      for (const [index, link] of fixture.peopleLinks.entries()) {
        const item = itemByKey.get(link.itemKey);
        const person = personByKey.get(link.personKey);
        assert.ok(item && person, `Unknown people link: ${link.itemKey}/${link.personKey}`);
        database.prepare(`INSERT INTO "PeopleBaseItemMap" ("ItemId", "PeopleId", "Role", "ListOrder", "SortOrder")
          VALUES (?, ?, ?, ?, ?)`)
          .run(upperId(item.id), upperId(person.id), link.role ?? '', index, link.sortOrder ?? null);
      }
      database.prepare(`INSERT INTO "ApiKeys" ("DateCreated", "DateLastActivity", "Name", "AccessToken") VALUES (?, ?, ?, ?)`)
        .run(fixedDate, fixedDate, 'Person Filter Native Oracle', apiKeyToken);
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
  return `MediaBrowser Client="PersonFilterNativeOracle", Device="Isolated", DeviceId="${deviceId}", Version="1"${token ? `, Token="${token}"` : ''}`;
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
    ids: items.map(item => item.Id).sort(),
    keys: items.map(item => keyById.get(idKey(item.Id)) ?? `unknown:${item.Id}`).sort(),
    items: items.map(item => ({
      key: keyById.get(idKey(item.Id)) ?? null,
      id: item.Id,
      name: item.Name,
      sortName: item.SortName ?? null,
      type: item.Type,
      width: item.Width ?? null,
      height: item.Height ?? null
    })),
    problem,
    ...(response.status >= 400 ? { errorText: response.bodyText } : {})
  };
}

const expected = {
  'person-exact-name': ['aliceActor'],
  'person-query-key-case-insensitive': ['aliceActor'],
  'person-value-case-sensitive': ['lowercaseAlice'],
  'person-unicode-and-space': ['unicodeCredit'],
  'person-empty-no-filter': ['aliceActor', 'noCredit'],
  'person-whitespace-no-filter': ['aliceActor', 'noCredit'],
  'person-repeated-first-value': ['aliceActor', 'aliceBob'],
  'person-repeated-first-empty': ['aliceActor', 'noCredit'],
  'person-id-name-bridge': ['aliceActor', 'aliceDirector'],
  'person-id-is-not-people-id': [],
  'person-id-non-person-same-name-bridge': ['aliceActor', 'aliceDirector'],
  'person-id-missing-selector-matches-nothing': [],
  'person-ids-single-comma-or': ['aliceActor', 'bobDirector'],
  'person-ids-invalid-only-drops-filter': ['aliceActor', 'noCredit'],
  'person-ids-single-invalid-and-valid': ['aliceActor'],
  'person-ids-repeated-values': ['aliceActor', 'bobDirector'],
  'person-ids-repeated-occurrence-with-comma': ['bobDirector'],
  'person-ids-empty-drops-filter': ['aliceActor', 'noCredit'],
  'person-ids-whitespace-drops-filter': ['aliceActor', 'noCredit'],
  'person-ids-query-key-case-insensitive': ['aliceActor'],
  'person-ids-p-format': ['aliceActor'],
  'person-ids-p-format-invalid-neighbor-drops-filter': ['aliceActor', 'noCredit'],
  'person-ids-x-format': ['aliceActor', 'bobDirector'],
  'person-ids-x-format-repeated-occurrence': ['aliceActor', 'bobDirector'],
  'person-ids-x-format-invalid-neighbor-drops-filter': ['aliceActor', 'noCredit'],
  'person-types-alone-no-sql-predicate': ['aliceActor', 'noCredit'],
  'person-with-actor-type': ['aliceActor', 'aliceBob'],
  'person-with-director-type': ['aliceDirector'],
  'person-type-value-case-sensitive': [],
  'person-with-arbitrary-numeric-type': ['numericType'],
  'person-types-single-comma-union': ['aliceActor', 'aliceDirector'],
  'person-types-repeated-values': ['aliceActor', 'aliceDirector'],
  'person-types-repeated-comma-is-literal': ['aliceWriter', 'compositeType'],
  'person-types-empty-does-not-restrict': ['aliceActor', 'aliceDirector'],
  'person-types-whitespace-restricts-empty-string': [],
  'person-types-query-key-case-insensitive': ['aliceActor'],
  'person-ids-with-type': ['aliceDirector'],
  'person-and-person-id-use-independent-and': ['aliceBob'],
  'person-and-person-id-types-apply-to-both': [],
  'person-filter-does-not-propagate-to-ancestors': ['ancestorChild'],
  'person-filter-does-not-propagate-to-linked-parent': ['linkedChild'],
  'person-filter-does-not-expand-alternate-to-primary': [],
  'person-filter-does-not-include-owned-item': [],
  'user-person-presentation-grouping': ['groupFirst'],
  'user-group-count-before-page': ['aliceActor'],
  'api-key-person-does-not-group-modern': ['groupFirst', 'groupSecond'],
  'api-key-person-modern-with-user-id': ['groupFirst'],
  'api-key-person-legacy-route': ['groupFirst'],
  'person-sortname-repository-full': ['sortA2', 'sortTail', 'sortThe2', 'sortEmile', 'sortChinese', 'sortMath2'],
  'person-sortname-repository-page': ['sortTail', 'sortThe2', 'sortEmile'],
  'person-sortname-memory-full': ['sortA2', 'sortTail', 'sortThe2', 'sortEmile', 'sortChinese', 'sortMath2'],
  'person-sortname-memory-page': ['sortTail', 'sortThe2', 'sortEmile'],
  'person-sortname-repository-descending': ['sortMath2', 'sortChinese', 'sortEmile', 'sortThe2', 'sortTail', 'sortA2'],
  'person-sortname-memory-descending': ['sortMath2', 'sortChinese', 'sortEmile', 'sortThe2', 'sortTail', 'sortA2'],
  'person-sortname-repository-name': ['sortTail', 'sortA2', 'sortThe2', 'sortEmile', 'sortChinese', 'sortMath2'],
  'person-sortname-memory-name': ['sortTail', 'sortA2', 'sortThe2', 'sortEmile', 'sortChinese', 'sortMath2'],
  'person-sortname-repository-no-order': ['sortThe2', 'sortA2', 'sortEmile', 'sortChinese', 'sortMath2', 'sortTail'],
  'person-sortname-repository-no-order-page': ['sortThe2', 'sortEmile', 'sortTail'],
  'person-sortname-memory-no-order': ['sortA2', 'sortTail', 'sortThe2', 'sortEmile', 'sortChinese', 'sortMath2'],
  'person-sortname-memory-no-order-page': ['sortTail', 'sortThe2', 'sortEmile']
};
const expectedStatus = {
  'person-sortname-repository-excess-directions': 400,
  'person-sortname-memory-excess-directions': 400
};
const expectedProblems = {
  'person-sortname-repository-excess-directions': null,
  'person-sortname-memory-excess-directions': null
};
const expectedTotalCounts = {
  'user-group-count-before-page': 2,
  'person-sortname-repository-page': 6,
  'person-sortname-memory-page': 6,
  'person-sortname-repository-no-order-page': 6,
  'person-sortname-memory-no-order-page': 6
};
const expectedPersonSortOrder = {
  'person-sortname-repository-full': ['sortA2', 'sortTail', 'sortThe2', 'sortEmile', 'sortChinese', 'sortMath2'],
  'person-sortname-repository-page': ['sortTail', 'sortThe2', 'sortEmile'],
  'person-sortname-memory-full': ['sortA2', 'sortTail', 'sortThe2', 'sortEmile', 'sortChinese', 'sortMath2'],
  'person-sortname-memory-page': ['sortTail', 'sortThe2', 'sortEmile'],
  'person-sortname-repository-descending': ['sortMath2', 'sortChinese', 'sortEmile', 'sortThe2', 'sortTail', 'sortA2'],
  'person-sortname-memory-descending': ['sortMath2', 'sortChinese', 'sortEmile', 'sortThe2', 'sortTail', 'sortA2'],
  'person-sortname-repository-name': ['sortTail', 'sortA2', 'sortThe2', 'sortEmile', 'sortChinese', 'sortMath2'],
  'person-sortname-memory-name': ['sortTail', 'sortA2', 'sortThe2', 'sortEmile', 'sortChinese', 'sortMath2'],
  'person-sortname-repository-no-order': ['sortThe2', 'sortA2', 'sortEmile', 'sortChinese', 'sortMath2', 'sortTail'],
  'person-sortname-repository-no-order-page': ['sortThe2', 'sortEmile', 'sortTail'],
  'person-sortname-memory-no-order': ['sortA2', 'sortTail', 'sortThe2', 'sortEmile', 'sortChinese', 'sortMath2'],
  'person-sortname-memory-no-order-page': ['sortTail', 'sortThe2', 'sortEmile']
};
const discoveryOnly = new Set();

await assert.rejects(stat(outputRoot), error => error?.code === 'ENOENT');
const portInitiallyAvailable = await available(port);
assert.equal(portInitiallyAvailable, true, `Port ${port} is already in use.`);
await prepareReference();
const databaseStages = { beforeSeed: targetSnapshot() };
assert.deepEqual(databaseStages.beforeSeed, {
  BaseItems: [], AncestorIds: [], LinkedChildren: [], Peoples: [], PeopleBaseItemMap: []
});
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
  assert.ok(parentId, `Unknown fixture parent key: ${testCase.parentKey}`);
  const recursive = Object.hasOwn(testCase, 'recursive') ? testCase.recursive : true;
  const common = `ParentId=${encodeURIComponent(parentId)}&Recursive=${recursive ? 'true' : 'false'}`
    + (testCase.omitIds ? '' : `&Ids=${encodeURIComponent(scopeIds)}`)
    + (testCase.omitSortBy ? '' : `&SortBy=${encodeURIComponent(testCase.sortBy ?? 'SortName')}`)
    + `&Fields=${encodeURIComponent(testCase.fields ?? 'Width,Height')}&EnableImages=false&EnableUserData=false`;
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
      endpointContracts.push({ endpoint, contract: responseContract(response) });
    }
    const primaryContract = endpointContracts[0].contract;
    for (const entry of endpointContracts.slice(1)) {
      assert.deepEqual(entry.contract, primaryContract, `${testCase.name}: ${endpoints.join(' and ')} diverged.`);
    }
    if (discoveryOnly.has(testCase.name)) {
      // Probe once before pinning the previously unrecorded ASP.NET model-binding edge.
    } else if (Object.hasOwn(expectedStatus, testCase.name)) {
      assert.equal(primaryContract.status, expectedStatus[testCase.name], `${testCase.name}: unexpected HTTP status.`);
      assert.equal(primaryContract.contentType, 'text/plain', `${testCase.name}: unexpected content type.`);
      assert.equal(primaryContract.totalRecordCount, null, `${testCase.name}: an error must not expose a result count.`);
      assert.deepEqual(primaryContract.ids, [], `${testCase.name}: an error must not expose result ids.`);
      assert.deepEqual(primaryContract.keys, [], `${testCase.name}: an error must not expose result keys.`);
      assert.deepEqual(primaryContract.problem, expectedProblems[testCase.name], `${testCase.name}: unexpected validation problem.`);
      assert.equal(primaryContract.errorText, 'Error processing request.', `${testCase.name}: unexpected error body.`);
    } else {
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
      if (expectedPersonSortOrder[testCase.name]) {
        const orderedKeys = expectedPersonSortOrder[testCase.name];
        assert.deepEqual(primaryContract.items.map(item => item.key), orderedKeys,
          `${testCase.name}: unexpected Person order.`);
        assert.deepEqual(primaryContract.items.map(item => item.sortName),
          orderedKeys.map(key => itemByKey.get(key).sortName),
          `${testCase.name}: unexpected Person SortName projection.`);
      }
    }
    contracts.push({
      name: testCase.name,
      query: testCase.query,
      scope: testCase.scope,
      auth: testCase.auth ?? 'user',
      endpoints,
      discoveryOnly: discoveryOnly.has(testCase.name),
      ...primaryContract
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
const portFinallyAvailable = await available(port);
const summary = {
  passed: scenarioError == null && cleanShutdown && processResult?.code === 0 && portFinallyAvailable,
  origin,
  fixtureCases: fixture.cases.length,
  httpRecords: records.length,
  endpointCases: contracts.reduce((total, entry) => total + entry.endpoints.length, 0),
  discoveryOnlyCases: [...discoveryOnly],
  databaseUnchangedByReads: databaseStages.beforeReads !== undefined
    && JSON.stringify(databaseStages.beforeReads) === JSON.stringify(databaseStages.afterReads),
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
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.QueryBuilding.cs',
  'Jellyfin.Server.Implementations/Item/BaseItemRepository.Querying.cs',
  'Jellyfin.Api/Controllers/ItemsController.cs',
  'Jellyfin.Api/Helpers/RequestHelpers.cs',
  'Jellyfin.Api/ModelBinders/CommaDelimitedCollectionModelBinder.cs',
  'Jellyfin.Server.Implementations/Security/AuthorizationContext.cs',
  'MediaBrowser.Controller/Entities/InternalItemsQuery.cs',
  'src/Jellyfin.Database/Jellyfin.Database.Implementations/Entities/People.cs',
  'src/Jellyfin.Database/Jellyfin.Database.Implementations/Entities/PeopleBaseItemMap.cs',
  'src/Jellyfin.Database/Jellyfin.Database.Implementations/ModelConfiguration/PeopleConfiguration.cs',
  'src/Jellyfin.Database/Jellyfin.Database.Implementations/ModelConfiguration/PeopleBaseItemMapConfiguration.cs'
];
const nativeSources = [];
for (const relative of sourcePaths) {
  const file = validationPath(path.join(repoRoot, '.test-input/baselines/jellyfin-current/source', relative));
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
  scenario: 'Frozen Jellyfin HTTP Person/PersonIds/PersonTypes oracle across public Items routes, users/API keys, name bridging, relation topology, grouping, paging, and model-binding edges.',
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




