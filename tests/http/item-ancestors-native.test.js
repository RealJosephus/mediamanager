import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { transferDatabase } from '../../src/migration/database-transfer.js';
import { discoverInstanceState } from '../../src/migration/instance-state.js';
import { startProductionInstance } from '../../src/main.js';
import { idKey, EMPTY_ID, dateTicks } from '../../src/library/records.js';
import { nativeGuid } from '../../src/users/native.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput, filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
import { assertCompleteNativeFilterHttpRepeat } from '../library/full-filter-wire.js';

const enabled = process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE
  && process.env.MEDIAMANAGER_JELLYFIN_DLL;
const authorization = token => `MediaBrowser Client="Ancestor consumer", Device="Isolated", DeviceId="ancestor-consumer", Version="1"${token ? `, Token="${token}"` : ''}`;
const json = value => JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? String(entry) : entry);
const snapshot = async database => Object.fromEntries(await Promise.all(['BaseItems', 'AncestorIds', 'UserData']
  .map(async table => [table, await database.rows(table)])));
const digest = value => createHash('sha256').update(json(value)).digest('hex');
function comparableAncestors(observation) {
  return { records: observation.records.map(entry => {
    if (!Array.isArray(entry.response.bodyJson)) return entry;
    const bodyJson = entry.response.bodyJson.map(item => {
      if (!Object.hasOwn(item, 'DateCreated')) return item;
      assert.match(item.DateCreated, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/u);
      return { ...item, DateCreated: `ticks:${dateTicks(item.DateCreated)}` };
    });
    return { ...entry, response: { ...entry.response, bodyJson, bodyText: json(bodyJson) } };
  }) };
}
const unusedPort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject).listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(error => error ? reject(error) : resolve(port));
  });
});
const portAvailable = port => new Promise(resolve => {
  const server = createServer();
  server.once('error', () => resolve(false)).listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
});

test('item ancestors match actual native parent translation, visibility, default DTO and userless authentication', {
  skip: !enabled, timeout: 240000,
}, async () => {
  const output = await createPrivateFilterOutput(path.join(validationOutputRoot(), `item-ancestors-${randomUUID()}`));
  output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
  await mkdir(output.root);
  const root = await realpath(output.root), port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const report = { processes: [], cases: [], runtimeErrors: [], cleanup: [] };
  let current, native, database, application, failure;
  const request = async (server, route, { token, method = 'GET', body } = {}) => {
    const response = await fetch(`${server}${route}`, { method, signal: AbortSignal.timeout(30000),
      headers: { Authorization: authorization(token), Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const bodyText = await response.text();
    return { status: response.status, contentType: response.headers.get('content-type'), bodyText,
      bodyJson: bodyText && response.headers.get('content-type')?.includes('json') ? JSON.parse(bodyText) : null };
  };
  const stop = async () => {
    if (!native) return;
    const result = await native.stop(async () => (await request(origin, '/System/Shutdown', {
      token: current.accessToken, method: 'POST' })).status, () => portAvailable(port));
    report.processes.push(result); native = null;
    assert.equal(result.cleanShutdown, true); assert.equal(result.pidGone, true); assert.equal(result.portAvailable, true);
  };
  try {
    current = await currentNativeReference();
    output.addSecret(current.accessToken);
    report.input = current.preparation;
    report.sourceBindings = await current.sourceBindings(['Jellyfin.Api/Controllers/LibraryController.cs',
      'Emby.Server.Implementations/Library/LibraryManager.cs', 'MediaBrowser.Controller/Entities/BaseItem.cs',
      'MediaBrowser.Controller/Entities/Folder.cs', 'MediaBrowser.Controller/Entities/UserRootFolder.cs']);
    const referenceRoot = path.join(root, 'reference');
    await cp(current.sourceRoot, referenceRoot, { recursive: true,
      filter: filename => !path.relative(current.sourceRoot, filename).replaceAll('\\', '/').startsWith('log/') });
    await mkdir(path.join(referenceRoot, 'log'), { recursive: true });
    await current.prepareClone(referenceRoot, port);
    native = current.start({ referenceRoot, outputRoot: root, label: 'discovery', origin });
    await native.ready();
    const rootResponse = await request(origin, '/Items/Root', { token: current.accessToken });
    assert.equal(rootResponse.status, 200);
    report.userRoot = rootResponse.bodyJson;
    assert.equal(typeof report.userRoot.Path, 'string');
    const tokens = { administrator: current.accessToken }, users = {};
    for (const mode of ['regular', 'restricted']) {
      const Name = `Ancestors_${mode}_${randomUUID().slice(0, 8)}`, Password = randomUUID();
      output.addSecret(Password);
      const created = await request(origin, '/Users/New', { token: current.accessToken, method: 'POST', body: { Name, Password } });
      assert.equal(created.status, 200);
      users[mode] = created.bodyJson;
      if (mode === 'restricted') assert.equal((await request(origin, `/Users/${created.bodyJson.Id}/Policy`, {
        token: current.accessToken, method: 'POST', body: { ...created.bodyJson.Policy, BlockedTags: ['restricted'] },
      })).status, 204);
      const login = await request(origin, '/Users/AuthenticateByName', { method: 'POST', body: { Username: Name, Pw: Password } });
      assert.equal(login.status, 200);
      tokens[mode] = login.bodyJson.AccessToken;
      output.addSecret(tokens[mode]);
    }
    assert.equal((await request(origin, '/Auth/Keys?app=AncestorConsumer', { token: current.accessToken, method: 'POST' })).status, 204);
    const keys = await request(origin, '/Auth/Keys', { token: current.accessToken });
    assert.equal(keys.status, 200);
    tokens.userless = keys.bodyJson.Items.find(item => item.AppName === 'AncestorConsumer').AccessToken;
    assert.ok(tokens.userless); output.addSecret(tokens.userless);
    await stop();

    const filename = path.join(referenceRoot, 'data/data/jellyfin.db');
    const mediaRoot = path.join(root, 'media');
    await mkdir(mediaRoot);
    const ids = Object.fromEntries(['physical', 'collection', 'outer', 'inner', 'movie', 'orphan', 'unmapped',
      'unmappedMovie', 'decoy'].map(name => [name, nativeGuid(randomUUID())]));
    const userRootId = nativeGuid(report.userRoot.Id);
    const source = new SqliteDatabase(filename, { requireMigrationHistory: true });
    let beforeNative;
    try {
      const aggregate = source.rows('BaseItems').find(item => item.Type === 'MediaBrowser.Controller.Entities.AggregateFolder');
      assert.ok(aggregate);
      const row = (type, Id, Name, ParentId, Path, data = {}, extra = {}) => postgresTestRow('BaseItems', {
        Id, Name, ParentId, Path, Data: JSON.stringify(data), Type: `MediaBrowser.Controller.Entities.${type}`,
        CleanName: Name.toLowerCase(), SortName: Name.toLowerCase(), TopParentId: ids.physical,
        IsFolder: type !== 'Movies.Movie', MediaType: type === 'Movies.Movie' ? 'Video' : 'Unknown',
        IsMovie: type === 'Movies.Movie', PresentationUniqueKey: idKey(Id),
        DateCreated: '2026-10-01 01:02:03', DateModified: '2026-10-01 01:02:03', ...extra,
      });
      const rows = [
        row('Folder', ids.physical, 'Physical library', aggregate.Id, mediaRoot),
        row('CollectionFolder', ids.collection, 'Visible library', userRootId, path.join(referenceRoot, 'data/root/default/Visible library'),
          { PhysicalLocationsList: [mediaRoot], PhysicalFolderIds: [ids.physical], CollectionType: 'movies' }),
        row('Folder', ids.outer, 'Outer', ids.physical, path.join(mediaRoot, 'Outer')),
        row('Folder', ids.inner, 'Inner', ids.outer, path.join(mediaRoot, 'Outer/Inner')),
        row('Movies.Movie', ids.movie, 'Movie', ids.inner, path.join(mediaRoot, 'Outer/Inner/movie.mp4'), {}, { Tags: 'restricted' }),
        row('Movies.Movie', ids.orphan, 'Parentless movie', null, path.join(mediaRoot, 'orphan.mp4'), {}, { TopParentId: null }),
        row('Folder', ids.unmapped, 'Unmapped physical', aggregate.Id, path.join(mediaRoot, 'Unmapped'), {}, { TopParentId: ids.unmapped }),
        row('Movies.Movie', ids.unmappedMovie, 'Unmapped movie', ids.unmapped, path.join(mediaRoot, 'Unmapped/movie.mp4'), {}, { TopParentId: ids.unmapped }),
        row('Folder', ids.decoy, 'Repository-only ancestor', null, path.join(mediaRoot, 'Decoy'), {}, { TopParentId: null }),
      ];
      if (!source.rows('BaseItems', { where: { Id: userRootId } }).length) rows.unshift(row('UserRootFolder', userRootId,
        report.userRoot.Name, null, report.userRoot.Path, { IsRoot: true }, { TopParentId: null }));
      source.transaction(() => {
        // The provisioned instance includes two path-only controlled seeds.
        // Keep their identities and relations, but bind their paths to this
        // private media namespace before either server observes this graph.
        report.seedRelocations = [];
        for (const [Id, from, relative] of [
          ['11111111-1111-1111-1111-111111111111', 'Z:\\SyntheticMedia', 'Retained seed'],
          ['22222222-2222-2222-2222-222222222222', 'Z:\\SyntheticMedia\\feature.mkv', 'Retained seed/feature.mkv'],
        ]) {
          const [existing] = source.rows('BaseItems', { where: { Id: nativeGuid(Id) } });
          assert.equal(existing.Path, from);
          const to = path.join(mediaRoot, relative);
          source.update('BaseItems', { Id: existing.Id }, { Path: to });
          report.seedRelocations.push({ Id: existing.Id, from, to });
        }
        for (const item of rows) source.insert('BaseItems', item);
        // A repository relation must not replace the entity's ParentId chain.
        for (const ParentItemId of [ids.physical, ids.outer, ids.inner, ids.decoy]) source.insert('AncestorIds', { ItemId: ids.movie, ParentItemId });
      });
      report.graph = { ids, aggregateId: aggregate.Id, userRootId, rows };
      beforeNative = await snapshot(source);
    } finally { source.close(); }

    const cases = [];
    const add = (name, item, mode, expectedStatus = 200, query = '') => cases.push({ name, mode, expectedStatus,
      endpoint: 'ancestors', route: `/Items/${idKey(item)}/Ancestors${query}` });
    for (const mode of ['administrator', 'regular', 'userless']) {
      add(`${mode}-nested`, ids.movie, mode);
      add(`${mode}-parentless`, ids.orphan, mode);
      add(`${mode}-unmapped`, ids.unmappedMovie, mode);
      add(`${mode}-root`, userRootId, mode);
    }
    add('restricted-item', ids.movie, 'restricted', 404);
    add('restricted-visible-folder', ids.inner, 'restricted');
    add('explicit-self', ids.movie, 'regular', 200, `?userId=${users.regular.Id}`);
    add('administrator-selected-user', ids.movie, 'administrator', 200, `?userId=${users.regular.Id}`);
    add('userless-selected-user', ids.movie, 'userless', 200, `?userId=${users.regular.Id}`);
    add('empty-selected-user', ids.movie, 'regular', 200, `?userId=${idKey(EMPTY_ID)}`);
    add('cross-user-forbidden', ids.movie, 'regular', 403, `?userId=${users.restricted.Id}`);
    add('missing-item', randomUUID(), 'regular', 404);
    add('empty-item', EMPTY_ID, 'regular', 400);
    add('anonymous', ids.movie, 'anonymous', 401);
    add('invalid-token', ids.movie, 'invalid', 401);
    report.cases = cases;
    const evaluate = async server => {
      const records = [];
      for (const entry of cases) {
        const response = await request(server, entry.route, { token: entry.mode === 'invalid' ? 'invalid-ancestor-token' : tokens[entry.mode] });
        records.push({ ...entry, response });
      }
      return { records };
    };
    native = current.start({ referenceRoot, outputRoot: root, label: 'reference', origin });
    await native.ready();
    report.native = await evaluate(origin);
    await stop();
    const sqlite = new SqliteDatabase(filename, { readOnly: true, requireMigrationHistory: true });
    let afterNative;
    try {
      afterNative = await snapshot(sqlite);
      assert.deepEqual(afterNative, beforeNative, 'Ancestor reads preserve complete item, ancestor and user-data rows.');
      database = await createPostgresTestDatabase(null, 'item_ancestors');
      const instance = await discoverInstanceState({ instanceRoot: referenceRoot });
      report.transfer = await transferDatabase(sqlite, database, { instanceBinding: {
        serverId: current.preparation.nativeServerId, originIdentityDigest: instance.identity.digest },
      portableMountContract: { mounts: [{ mountId: 'ancestor-media', identityRoot: mediaRoot,
        accessRoot: '/ancestor-media', pathStyle: process.platform === 'win32' ? 'windows' : 'posix',
        caseSensitive: process.platform !== 'win32', returnPolicy: 'required' }] } });
    } finally { sqlite.close(); }
    await database.close();
    const storage = path.join(referenceRoot, 'storage.json');
    await writeFile(storage, JSON.stringify({ instances: [{ id: 'ancestor-media', type: 'local', config: { root: mediaRoot, writable: true } }],
      mounts: [{ path: '/ancestor-media', instanceId: 'ancestor-media', root: '/', capabilities: {
        create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true,
      } }], prefixes: [{ identityRoot: mediaRoot, accessRoot: '/ancestor-media',
        style: process.platform === 'win32' ? 'windows' : 'posix', caseSensitive: process.platform !== 'win32',
        returnAccess: 'Private controlled media remains available for native return.', purpose: 'library' }] }));
    const networkFilename = path.join(referenceRoot, 'config/network.xml'), networkBytes = await readFile(networkFilename);
    report.nodeNetworkInput = { bytes: networkBytes.length, sha256: createHash('sha256').update(networkBytes).digest('hex'),
      base64: networkBytes.toString('base64'), scope: 'The stopped private Native copy retains its current network.xml and reserved port.' };
    application = await startProductionInstance({ environment: { ...process.env, MEDIAMANAGER_INSTANCE: referenceRoot,
      MEDIAMANAGER_POSTGRES: process.env.MEDIAMANAGER_TEST_POSTGRES, MEDIAMANAGER_POSTGRES_SCHEMA: database.schemaName,
      MEDIAMANAGER_STORAGE: storage },
    onError: error => report.runtimeErrors.push({ message: error.message, status: error.status, stack: error.stack }) });
    const beforeNode = await application.store.run(snapshot);
    const listener = application.networkHost.listeners.find(entry => entry.scheme === 'http');
    assert.equal(listener.port, port); assert.deepEqual(await readFile(networkFilename), networkBytes);
    report.node = await evaluate(`http://127.0.0.1:${listener.port}`);
    const afterNode = await application.store.run(snapshot);
    assert.deepEqual(afterNode, beforeNode, 'Ancestor reads preserve complete PostgreSQL rows.');
    report.readOnly = { nativeBefore: digest(beforeNative), nativeAfter: digest(afterNative),
      nodeBefore: digest(beforeNode), nodeAfter: digest(afterNode) };
    for (const entry of report.native.records) assert.equal(entry.response.status, entry.expectedStatus, entry.name);
    report.comparisonProjection = { field: 'Ancestors[].DateCreated', value: 'Exact UTC ticks at 100 ns precision', rawResponsesRetained: true };
    report.comparison = assertCompleteNativeFilterHttpRepeat(comparableAncestors(report.node), comparableAncestors(report.native), {
      leftServerId: current.preparation.nativeServerId, rightServerId: current.preparation.nativeServerId });
    const nested = mode => report.native.records.find(entry => entry.name === `${mode}-nested`).response.bodyJson.map(item => item.Id);
    assert.deepEqual(nested('regular'), [ids.inner, ids.outer, ids.collection, userRootId].map(idKey));
    assert.deepEqual(nested('userless'), [ids.inner, ids.outer, ids.physical, report.graph.aggregateId].map(idKey));
    assert.ok(!nested('regular').includes(idKey(ids.decoy)));
  } catch (error) { failure = error; report.failure = { name: error.name, message: error.message, stack: error.stack }; }
  finally {
    try { await stop(); } catch (error) { failure ??= error; report.cleanup.push({ name: 'native', error: error.message }); }
    if (application) try {
      const listeners = application.networkHost.listeners;
      await application.close(); assert.ok(listeners.every(listener => !listener.server.listening));
      for (const listener of listeners.filter(entry => entry.bound)) assert.equal(await portAvailable(listener.port), true);
      report.cleanup.push({ name: 'production-entry', closed: true, listenerReleased: true,
        listeners: listeners.map(({ scheme, address, port, server }) => ({ scheme, address, port, listening: server.listening })) });
    }
    catch (error) { failure ??= error; report.cleanup.push({ name: 'production-entry', error: error.message }); }
    try { await dropPostgresTestDatabase(database); report.cleanup.push({ name: 'postgres-schema', closed: true }); }
    catch (error) { failure ??= error; report.cleanup.push({ name: 'postgres-schema', error: error.message }); }
    if (current) try { await current.finish(); } catch (error) { failure ??= error; report.inputVerificationFailure = error.message; }
    await writeFile(path.join(root, 'report.json'), filterEvidenceJson(report));
    await output.publishAndClose();
  }
  if (failure) throw output.publicError(failure);
});
