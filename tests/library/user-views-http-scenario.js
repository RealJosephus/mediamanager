import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { dependencyOrder, quoteIdentifier, tableDefinition } from '../../src/database/model.js';
import { nativeGuid } from '../../src/users/native.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { expandStatePath } from './fixture-state-path.js';

const tables = { baseItems: 'BaseItems', ancestorIds: 'AncestorIds', linkedChildren: 'LinkedChildren',
  itemValues: 'ItemValues', itemValueLinks: 'ItemValuesMap', userData: 'UserData', images: 'BaseItemImageInfos',
  providers: 'BaseItemProviders', lockedFields: 'BaseItemMetadataFields', peoples: 'Peoples',
  peopleLinks: 'PeopleBaseItemMap', mediaStreams: 'MediaStreamInfos', chapters: 'Chapters' };
const domains = { userViews: 'data/root/default', metadata: 'data/metadata', libraries: 'library-content', collections: 'data/data/collections' };
const json = value => JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? entry.toString() : entry);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const stable = rows => rows.sort((a, b) => json(a).localeCompare(json(b), 'en'));
async function tree(root) {
  const entries = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name), relative = path.relative(root, filename).replaceAll('\\', '/');
      if (entry.isSymbolicLink()) throw new Error('Fixture directory contains a symbolic link.');
      if (entry.isDirectory()) { entries.push({ path: relative, type: 'directory' }); await visit(filename); }
      else entries.push({ path: relative, type: 'file', size: (await stat(filename)).size, sha256: sha256(await readFile(filename)) });
    }
  }
  try { await visit(root); return { exists: true, entries: entries.sort((a, b) => a.path.localeCompare(b.path, 'en')) }; }
  catch (error) { if (error.code === 'ENOENT') return { exists: false, entries: [] }; throw error; }
}
const filesystem = async root => Object.fromEntries(await Promise.all(Object.entries(domains).map(async ([key, folder]) => [key, await tree(path.join(root, folder))])));
const snapshot = async (db, root) => {
  const foreignKeyCheck = (await db.client.query(
    "SELECT conname FROM pg_constraint WHERE connamespace = current_schema()::regnamespace AND contype = 'f' AND NOT convalidated")).rows;
  const rows = {};
  // A PostgreSQL connection serializes its wire protocol; avoid concurrent
  // client.query calls on that same connection while taking a snapshot.
  for (const [key, table] of Object.entries(tables)) rows[key] = stable(await db.rows(table));
  return { database: { ...rows, foreignKeyCheck }, filesystem: await filesystem(root) };
};
const available = port => new Promise(resolve => { const server = createServer(); server.once('error', () => resolve(false)); server.listen(port, '127.0.0.1', () => server.close(() => resolve(true))); });

/** Replay complete native media observations with freshly created synthetic accounts. */
export async function recordUserViewsCandidate({ dialect, fixture, contract, connectionString }) {
  assert.ok(['postgres'].includes(dialect));
  const root = await mkdtemp(path.join(tmpdir(), 'mm-user-views-'));
  const referenceRoot = contract.manifest.referenceRoot, schema = 'user_views_' + randomUUID().replaceAll('-', '').slice(0, 16);
  const nativeStages = contract.native, configuration = contract.configuration, actors = structuredClone(contract.actors);
  let database, runtime, result, port, failure;
  let before;
  const records = [], caseStages = [], setup = [];
  const errors = [], cleanup = { runtimeClosed: false, databaseClosed: false, portReleased: false,
    postgresSchemasRemoved: dialect === 'postgres' ? false : null, programDataDirectoryRemoved: false };
  try {
    for (const [domain, folder] of Object.entries(domains)) {
      const target = path.join(root, folder);
      const before = nativeStages.before.filesystem[domain];
      if (before.exists) await mkdir(target, { recursive: true });
      for (const entry of before.entries) {
        const targetPath = path.resolve(target, entry.path), relative = path.relative(target, targetPath);
        assert.ok(relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
        if (entry.type === 'directory') await mkdir(targetPath, { recursive: true });
        else throw new Error('The offline native fixture contains no file payloads.');
      }
    }
    database = await PostgresDatabase.open({ connectionString, schema, create: true });
    for (const row of nativeStages.before.database.baseItems) await database.insert('BaseItems', { ...row, ParentId: null, OwnerId: null });
    for (const row of nativeStages.before.database.baseItems) await database.update('BaseItems', { Id: row.Id }, { ParentId: row.ParentId, OwnerId: row.OwnerId });
    const byTable = Object.fromEntries(Object.entries(tables).map(([key, name]) => [name, key]));
    for (const table of dependencyOrder().filter(table => table.name !== 'BaseItems' && byTable[table.name])) {
      for (const row of nativeStages.before.database[byTable[table.name]]) await database.insert(table.name, row);
    }
    const rewrite = value => typeof value === 'string' ? expandStatePath(value, referenceRoot, root)
      : Array.isArray(value) ? value.map(rewrite)
        : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rewrite(child)])) : value;
    for (const row of await database.rows('BaseItems')) {
      let Path = rewrite(row.Path);
      for (const macro of ['%AppDataPath%', '%MetadataPath%']) Path = expandStatePath(Path, macro, macro);
      const Data = row.Data == null ? null : JSON.stringify(rewrite(JSON.parse(row.Data)));
      if (Path !== row.Path || Data !== row.Data) await database.update('BaseItems', { Id: row.Id }, { Path, Data });
    }
    runtime = await createTestRuntime({ database, configuration: { ...configuration, IsStartupWizardCompleted: true, UICulture: 'en-US',
      EnableFolderView: false, EnableGroupingMoviesIntoCollections: false, EnableGroupingShowsIntoCollections: false },
      serverId: 'user-views-' + dialect, serverName: 'User Views Candidate', programDataPath: path.join(root, 'data'),
      onError: error => errors.push({ name: error.name, message: error.message, status: error.status ?? null, stack: error.stack }) });
    for (const actor of Object.values(actors)) {
      const created = await runtime.users.createUser({ Name: actor.name, Password: 'user views synthetic password' });
      const oldId = nativeGuid(created.Id), newId = nativeGuid(actor.userId);
      await runtime.store.transaction(async db => {
        const source = (await db.rows('Users', { where: { Id: oldId } }))[0];
        await db.update('Users', { Id: oldId }, { Username: source.Username + '-relocating', NormalizedUsername: source.NormalizedUsername + '-RELOCATING' });
        await db.insert('Users', { ...source, Id: newId });
        for (const name of ['Permissions', 'Preferences']) for (const row of await db.rows(name, { where: { UserId: oldId } })) {
          const where = Object.fromEntries(tableDefinition(name).primaryKey.map(key => [key, row[key]]));
          await db.update(name, where, { UserId: newId });
        }
        await db.delete('Users', { Id: oldId });
      });
      const user = await runtime.users.getUser(newId);
      await runtime.users.updatePolicy(newId, { ...user.Policy, IsAdministrator: true });
    }
    // The native core-flow database also has an administrator outside this
    // two-actor matrix. Preserve that invariant with a synthetic account.
    const administrator = await runtime.users.createUser({ Name: 'UserViewsFixtureAdministrator', Password: 'user views synthetic password' });
    const administratorUser = await runtime.users.getUser(administrator.Id);
    await runtime.users.updatePolicy(administrator.Id, { ...administratorUser.Policy, IsAdministrator: true });
    const closeStore = runtime.store.close.bind(runtime.store);
    runtime.store.close = async () => { if (result) result.afterShutdown = await snapshot(database, root); return closeStore(); };
    port = runtime.networkHost.listeners.find(entry => entry.scheme === 'http' && entry.bound).port;
    const origin = 'http://127.0.0.1:' + port;
    const request = async (route, { method = 'GET', token, body } = {}) => {
      const response = await fetch(origin + route, { method, signal: AbortSignal.timeout(20000),
        headers: { Accept: 'application/json', Authorization: `MediaBrowser Client="UserViewsOracle", Device="Isolated", DeviceId="user-views-candidate-${dialect}", Version="1"${token ? `, Token="${token}"` : ''}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const bodyText = await response.text(); let bodyJson;
      try { bodyJson = JSON.parse(bodyText); } catch { /* Retain exact non-JSON errors. */ }
      return { status: response.status, contentType: response.headers.get('content-type'), bodyText, ...(bodyJson === undefined ? {} : { bodyJson }) };
    };
    for (const actor of Object.values(actors)) {
      const login = await request('/Users/AuthenticateByName', { method: 'POST', body: { Username: actor.name, Pw: 'user views synthetic password' } });
      assert.equal(login.status, 200, login.bodyText); assert.equal(login.bodyJson.User.Id.replaceAll('-', ''), actor.userId.replaceAll('-', ''));
      actor.token = login.bodyJson.AccessToken; actor.login = login.bodyJson;
    }
    const keyCreated = await request('/Auth/Keys?app=UserViewsCandidate', { method: 'POST', token: actors.primary.token });
    assert.equal(keyCreated.status, 204, keyCreated.bodyText);
    const keys = await request('/Auth/Keys', { token: actors.primary.token }); assert.equal(keys.status, 200);
    const apiKey = keys.bodyJson.Items.find(key => key.AppName === 'UserViewsCandidate')?.AccessToken; assert.ok(apiKey);
    before = await snapshot(database, root);
    for (const testCase of fixture.cases) {
      const actor = actors[testCase.actor ?? 'primary'];
      if (testCase.serverConfiguration) {
        Object.assign(runtime.configuration, testCase.serverConfiguration); runtime.localization.serverCulture = testCase.serverConfiguration.UICulture;
        setup.push({ name: testCase.name, kind: 'equivalent-runtime-configuration', values: testCase.serverConfiguration });
      }
      for (const [suffix, values] of [['Configuration', testCase.configuration], ['Policy', testCase.policy]]) {
        if (!values) continue;
        const response = await request(`/Users/${actor.userId}/${suffix}`, { method: 'POST', token: apiKey, body: { ...actor.login.User[suffix], ...values } });
        assert.equal(response.status, 204, testCase.name + ': ' + response.bodyText); setup.push({ name: testCase.name, kind: suffix, status: response.status, values });
      }
      const policy = await request(`/Users/${actor.userId}`, { token: apiKey }); assert.equal(policy.status, 200);
      assert.equal(policy.bodyJson.Policy.IsAdministrator, testCase.policy.IsAdministrator);
      for (const endpoint of ['views', 'legacy']) {
        const route = endpoint === 'views' ? `/UserViews?userId=${actor.userId}&${testCase.query}` : `/Users/${actor.userId}/Views?${testCase.query}`;
        const stageBefore = await snapshot(database, root);
        records.push({ name: testCase.name, query: testCase.query, actor: testCase.actor ?? 'primary', endpoint, route, response: await request(route, { token: actor.token }) });
        caseStages.push({ name: testCase.name, endpoint, before: stageBefore, after: await snapshot(database, root) });
      }
    }
    await runtime.library.userViews.drain();
    result = { dialect, root, referenceRoot, before, records, caseStages, afterReads: await snapshot(database, root), runtimeErrors: errors, setup, cleanup };
  } catch (error) {
    failure = error;
    result ??= { dialect, root, referenceRoot, before, records, caseStages, runtimeErrors: errors, setup, cleanup };
  }
  finally {
    try { if (runtime) await runtime.close(); else await database?.close(); cleanup.runtimeClosed = runtime ? runtime.networkHost.listeners.every(entry => !entry.server.listening) : true; } catch (error) { failure ??= error; }
    if (database) try { await database.rows('BaseItems', { limit: 1 }); } catch (error) {
      if (error.message === 'database is not open' || error.message === 'Client was closed and is not queryable') cleanup.databaseClosed = true;
      else failure ??= error;
    }
    if (port !== undefined) cleanup.portReleased = await available(port);
    if (dialect === 'postgres') {
      const client = new pg.Client({ connectionString });
      try { await client.connect(); for (const name of [schema, schema + '__mm']) await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(name)} CASCADE`);
        cleanup.postgresSchemasRemoved = (await client.query('SELECT schema_name FROM information_schema.schemata WHERE schema_name = ANY($1::text[])', [[schema, schema + '__mm']])).rows.length === 0;
      } catch (error) { failure ??= error; } finally { await client.end(); }
    }
    try {
      const absolute = path.resolve(root), relative = path.relative(path.resolve(tmpdir()), absolute);
      assert.ok(relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) && path.basename(absolute).startsWith('mm-user-views-'));
      await rm(absolute, { recursive: true, force: false }); cleanup.programDataDirectoryRemoved = await stat(absolute).then(() => false, error => error.code === 'ENOENT');
    } catch (error) { failure ??= error; }
  }
  if (failure) { failure.candidateEvidence = result; throw failure; }
  return result;
}
