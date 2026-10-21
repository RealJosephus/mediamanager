import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { cp, mkdir, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput, filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createWebServerFixture } from '../web/web-fixture.js';
import { dateTicks, idKey, MIN_DATE } from '../../src/library/records.js';
import { nativeRootUserViewIdentity } from '../../src/library/identity.js';
import { tableDefinition } from '../../src/database/model.js';

const enabled = process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES
  && process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE;
const tables = ['BaseItems', 'AncestorIds', 'UserData', 'Permissions', 'Preferences', 'BaseItemImageInfos',
  'BaseItemProviders', 'BaseItemMetadataFields', 'ItemValues', 'ItemValuesMap', 'LinkedChildren', 'MediaStreamInfos'];
const authorization = token => `MediaBrowser Client="Live TV views", Device="Isolated", DeviceId="live-tv-views", Version="1"${token ? `, Token="${token}"` : ''}`;
const jsonRows = rows => rows.map(row => JSON.stringify(row, (_, value) => typeof value === 'bigint' ? String(value) : value)).sort();
const sorted = values => values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
const portAvailable = port => new Promise(resolve => {
  const server = createServer();
  server.once('error', () => resolve(false)).listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
});
const unusedPort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject).listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(error => error ? reject(error) : resolve(port));
  });
});
function etag(stamp) {
  const bytes = createHash('md5').update(Buffer.from(String(dateTicks(stamp ?? MIN_DATE)), 'utf16le')).digest();
  const result = Buffer.from(bytes);
  result.writeUInt32BE(bytes.readUInt32LE(0), 0); result.writeUInt16BE(bytes.readUInt16LE(4), 4); result.writeUInt16BE(bytes.readUInt16LE(6), 6);
  return result.toString('hex');
}

test('configured Live TV user views match native HTTP, global identity and creation lifecycle', {
  skip: !enabled, timeout: 240000,
}, async () => {
  const output = await createPrivateFilterOutput(path.join(validationOutputRoot(), 'live-tv-user-views-' + randomUUID()));
  output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
  await mkdir(output.root);
  const root = await realpath(output.root), port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const report = { cases: [], preparation: {}, differences: [], cleanup: [], stages: [] };
  let current, native, fixture, referenceRoot, baseline, nodeAtClose, failure;
  const request = async (server, route, { token, body, method = 'GET' } = {}) => {
    const response = await fetch(server + route, { method, signal: AbortSignal.timeout(20000),
      headers: { Authorization: authorization(token), Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const bodyText = await response.text(); let bodyJson;
    try { if (bodyText !== '') bodyJson = JSON.parse(bodyText); } catch { /* Preserve non-JSON responses. */ }
    return { status: response.status, contentType: response.headers.get('content-type'), bodyText,
      ...(bodyJson === undefined ? {} : { bodyJson }) };
  };
  const nativeSnapshot = () => {
    const database = new DatabaseSync(path.join(referenceRoot, 'data/data/jellyfin.db'), { readOnly: true });
    try { return Object.fromEntries(tables.map(table => {
      const statement = database.prepare(`SELECT * FROM "${table}"`); statement.setReadBigInts(true);
      return [table, jsonRows(statement.all())];
    })); } finally { database.close(); }
  };
  const nodeSnapshot = () => fixture.application.store.run(async database => Object.fromEntries(
    await Promise.all(tables.map(async table => [table, jsonRows(await database.rows(table))]))));
  const directories = async directory => {
    const entries = [];
    const visit = async (current, relative = '') => {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const name = relative ? relative + '/' + entry.name : entry.name;
        assert.equal(entry.isDirectory(), true, 'These empty global views must not generate media or metadata files.');
        const info = await stat(path.join(current, entry.name), { bigint: true });
        entries.push({ path: name, birthtimeNs: String(info.birthtimeNs), mtimeNs: String(info.mtimeNs) });
        await visit(path.join(current, entry.name), name);
      }
    };
    try { await visit(directory); return { exists: true, entries: sorted(entries) }; }
    catch (error) { if (error.code === 'ENOENT') return { exists: false, entries: [] }; throw error; }
  };
  const snapshot = async () => ({
    native: nativeSnapshot(), node: await nodeSnapshot(),
    files: { native: await directories(path.join(referenceRoot, 'data/metadata/views')),
      node: await directories(path.join(fixture.application.library.options.metadataPath, 'views')) },
  });
  try {
    current = await currentNativeReference(); output.addSecret(current.accessToken); report.input = current.preparation;
    report.sourceBindings = await current.sourceBindings(['Emby.Server.Implementations/Library/UserViewManager.cs',
      'Emby.Server.Implementations/Library/LibraryManager.cs', 'MediaBrowser.Model/Library/UserViewQuery.cs',
      'MediaBrowser.Controller/Entities/UserView.cs', 'MediaBrowser.Controller/Entities/BaseItem.cs', 'src/Jellyfin.LiveTv/LiveTvManager.cs',
      'Jellyfin.Api/Controllers/UserViewsController.cs']);
    referenceRoot = path.join(root, 'reference');
    await cp(current.sourceRoot, referenceRoot, { recursive: true,
      filter: filename => !path.relative(current.sourceRoot, filename).replaceAll('\\', '/').startsWith('log/') });
    await mkdir(path.join(referenceRoot, 'log'), { recursive: true }); await current.prepareClone(referenceRoot, port);
    native = current.start({ referenceRoot, outputRoot: root, label: 'reference', origin }); await native.ready();
    fixture = await createWebServerFixture({ preparation: report.preparation });
    for (const secret of fixture.secrets) output.addSecret(secret);
    const appName = 'LiveTvViews_' + randomUUID();
    assert.equal((await request(origin, '/Auth/Keys?app=' + appName, { token: current.accessToken, method: 'POST' })).status, 204);
    assert.equal((await fixture.administratorRequest('/Auth/Keys?app=' + appName, { method: 'POST' })).status, 204);
    const keys = {}, servers = { native: origin, node: fixture.origin }, users = {};
    const subjects = [{ role: 'primary', name: fixture.username, password: fixture.password },
      { role: 'secondary', name: 'LiveTvViews_' + randomUUID().slice(0, 8), password: randomUUID() }];
    subjects.forEach(value => output.addSecret(value.password));
    for (const type of ['native', 'node']) {
      const listed = type === 'native' ? (await request(origin, '/Auth/Keys', { token: current.accessToken })).bodyJson
        : await (await fixture.administratorRequest('/Auth/Keys')).json();
      keys[type] = listed.Items.find(value => value.AppName === appName).AccessToken; output.addSecret(keys[type]);
      users[type] = {};
      const original = await request(servers[type], '/Users', { token: keys[type] }); assert.equal(original.status, 200);
      for (const subject of subjects) {
        let user = original.bodyJson.find(user => user.Name === subject.name);
        if (!user) {
          const created = await request(servers[type], '/Users/New', { token: keys[type], method: 'POST', body: { Name: subject.name, Password: subject.password } });
          assert.equal(created.status, 200); user = created.bodyJson;
        }
        const login = await request(servers[type], '/Users/AuthenticateByName', { method: 'POST', body: { Username: subject.name, Pw: subject.password } });
        assert.equal(login.status, 200); output.addSecret(login.bodyJson.AccessToken);
        users[type][subject.role] = { id: user.Id, policy: user.Policy, configuration: user.Configuration, token: login.bodyJson.AccessToken };
      }
    }
    report.userBindings = Object.fromEntries(Object.entries(users).map(([type, values]) => [type,
      Object.entries(values).map(([role, value]) => ({ role, id: value.id }))]));
    report.rootDiscovery = {};
    for (const type of ['native', 'node']) {
      report.rootDiscovery[type] = await request(servers[type], '/Items/Root', { token: users[type].primary.token });
      assert.equal(report.rootDiscovery[type].status, 200);
      assert.equal(report.rootDiscovery[type].bodyJson.Type, 'UserRootFolder');
    }
    const nativeConfiguration = await request(origin, '/System/Configuration', { token: keys.native });
    const nativeLiveTv = await request(origin, '/System/Configuration/livetv', { token: keys.native });
    assert.equal(nativeConfiguration.status, 200); assert.equal(nativeLiveTv.status, 200);
    const nodeLiveTv = await fixture.application.liveTv.getConfiguration();
    const roots = { native: { programDataPath: path.join(referenceRoot, 'data') }, node: fixture.application.library.options };
    const identities = Object.fromEntries(Object.entries(roots).map(([type, options]) => [type,
      Object.fromEntries(['livetv', 'folders'].map(viewType => [viewType, nativeRootUserViewIdentity(viewType, options)]))]));
    report.viewBindings = identities;
    for (const viewType of ['livetv', 'folders']) assert.equal(idKey(identities.native[viewType].Id), idKey(identities.node[viewType].Id));
    const viewIds = new Set(Object.values(identities.native).map(value => idKey(value.Id)));
    const rows = snapshot => snapshot.BaseItems.map(value => JSON.parse(value));
    report.beforeReads = await snapshot();
    for (const type of ['native', 'node']) assert.equal(rows(report.beforeReads[type]).some(row => viewIds.has(idKey(row.Id))), false);
    const storeClose = fixture.application.store.close.bind(fixture.application.store);
    fixture.application.store.close = async () => { nodeAtClose = await nodeSnapshot(); return storeClose(); };
    const scenes = [
      { name: 'unconfigured default', configured: false, visible: [] },
      { name: 'configured explicitly excluded before creation', query: 'includeExternalContent=false', visible: [] },
      { name: 'configured denied before creation', access: false, visible: [] },
      { name: 'first global view', visible: ['livetv'] },
      { name: 'repeat global view', query: 'presetViews=livetv,movies', visible: ['livetv'] },
      { name: 'folder and live alphabetical order', folders: true, visible: ['folders', 'livetv'] },
      { name: 'explicit live first', folders: true, ordered: ['livetv', 'folders'], visible: ['livetv', 'folders'] },
      { name: 'hidden live', folders: true, hidden: ['livetv'], ordered: ['livetv'], visible: ['folders'] },
      { name: 'include hidden live', folders: true, hidden: ['livetv'], query: 'includeHidden=true', visible: ['folders', 'livetv'] },
      { name: 'external false overrides hidden', folders: true, query: 'includeExternalContent=false&includeHidden=true', visible: ['folders'] },
      { name: 'administrator permission does not enable live', folders: true, access: false, administrator: true, visible: ['folders'] },
      { name: 'ordinary denied user', folders: true, access: false, visible: ['folders'] },
      { name: 'second user shares global view', role: 'secondary', folders: true, visible: ['folders', 'livetv'] },
      { name: 'clear tuner configuration', configured: false, folders: true, visible: ['folders'] },
      { name: 'restore same global view', query: 'includeExternalContent=true', visible: ['livetv'] },
    ];
    report.configurationBoundary = 'Native configuration POST and Node cached configuration are controlled preparation; this does not accept the Node configuration POST API.';
    const bodyContract = (response, type, stage) => {
      assert.equal(response.status, 200); assert.equal(response.contentType, 'application/json; charset=utf-8');
      const body = structuredClone(response.bodyJson);
      assert.equal(body.TotalRecordCount, body.Items.length); assert.equal(body.StartIndex, 0);
      for (const item of body.Items) {
        assert.ok(viewIds.has(idKey(item.Id)), 'The controlled instance has only these two global views.');
        const row = rows(stage.after[type]).find(row => idKey(row.Id) === idKey(item.Id)); assert.ok(row);
        assert.equal(dateTicks(item.DateCreated), dateTicks(row.DateCreated));
        const stamps = new Set([etag(MIN_DATE)]);
        for (const prefix of [...report.stages, stage]) for (const snapshot of [prefix.before[type], prefix.after[type]]) {
          for (const saved of rows(snapshot)) if (idKey(saved.Id) === idKey(item.Id)) stamps.add(etag(saved.DateLastSaved));
        }
        assert.match(item.Etag, /^[a-f0-9]{32}$/u);
        if (!stamps.has(item.Etag)) {
          // GetNamedView saves the new entity, then queues a refresh. Its first
          // response can carry an intermediate save clock already superseded
          // by the after-request SQL snapshot. Repeated reads remain bound to
          // observed stamps; only initial creation has this asynchronous clock.
          assert.equal(rows(stage.before[type]).some(row => idKey(row.Id) === idKey(item.Id)), false);
          assert.ok(['livetv', 'folders'].includes(item.CollectionType));
          assert.ok(dateTicks(row.DateLastSaved) > 0n);
          report.creationEtags ??= [];
          report.creationEtags.push({ type, name: stage.name, endpoint: stage.endpoint, Id: item.Id, Etag: item.Etag,
            afterSaved: row.DateLastSaved, afterRefreshed: row.DateLastRefreshed,
            classification: 'initial global view save and queued refresh overlap the first response; intermediate clock is not retained by the SQL snapshot' });
        }
        item.DateCreated = '$own-created'; item.Etag = '$own-saved-etag';
        const identity = identities[type][item.CollectionType]; assert.ok(identity);
        assert.equal(item.Path, identity.Path); item.Path = identity.StoredPath.replaceAll('\\', '/');
        assert.ok(item.ServerId); item.ServerId = '$instance';
      }
      return body;
    };
    for (const scene of scenes) {
      const changes = { TunerHosts: scene.configured === false ? [] : [{ Id: 'controlled', Type: 'unregistered', Url: 'controlled://views' }] };
      assert.equal((await request(origin, '/System/Configuration/livetv', { token: keys.native, method: 'POST', body: { ...nativeLiveTv.bodyJson, ...changes } })).status, 204);
      Object.assign(nodeLiveTv, changes);
      assert.equal((await request(origin, '/System/Configuration', { token: keys.native, method: 'POST', body: { ...nativeConfiguration.bodyJson, UICulture: 'en-US', EnableFolderView: scene.folders === true } })).status, 204);
      fixture.application.configuration.EnableFolderView = scene.folders === true;
      for (const type of ['native', 'node']) {
        const user = users[type][scene.role ?? 'primary'];
        const policy = { ...user.policy, EnableLiveTvAccess: scene.access !== false, IsAdministrator: scene.administrator === true };
        const configuration = { ...user.configuration,
          OrderedViews: (scene.ordered ?? []).map(viewType => idKey(identities[type][viewType].Id)),
          MyMediaExcludes: (scene.hidden ?? []).map(viewType => idKey(identities[type][viewType].Id)) };
        for (const [suffix, body] of [['Policy', policy], ['Configuration', configuration]]) {
          assert.equal((await request(servers[type], `/Users/${user.id}/${suffix}`, { token: keys[type], method: 'POST', body })).status, 204);
        }
      }
      for (const endpoint of ['views', 'legacy']) {
        const stage = { name: scene.name, endpoint, before: await snapshot() };
        const pair = { name: scene.name, endpoint, role: scene.role ?? 'primary', scene };
        for (const type of ['native', 'node']) {
          const user = users[type][pair.role];
          const route = endpoint === 'views' ? `/UserViews?userId=${user.id}&${scene.query ?? ''}` : `/Users/${user.id}/Views?${scene.query ?? ''}`;
          pair[type] = { route, ...await request(servers[type], route, { token: user.token }) };
        }
        stage.after = await snapshot(); report.cases.push(pair);
        try {
          for (const type of ['native', 'node']) {
            assert.deepEqual(pair[type].bodyJson?.Items?.map(item => idKey(item.Id)), scene.visible.map(viewType => idKey(identities[type][viewType].Id)));
            for (const table of tables.filter(table => !['BaseItems', 'AncestorIds', 'ItemValues', 'ItemValuesMap'].includes(table))) {
              assert.deepEqual(stage.after[type][table], stage.before[type][table]);
            }
          }
          assert.deepEqual(bodyContract(pair.node, 'node', stage), bodyContract(pair.native, 'native', stage));
        } catch (error) { report.differences.push({ name: scene.name, endpoint, message: error.message }); }
        report.stages.push(stage);
      }
    }
    await fixture.application.library.userViews.drain();
    baseline = await snapshot(); report.afterReads = baseline;
    const rowContract = (row, type) => {
      const data = JSON.parse(row.Data ?? '{}'); delete data.DateLastSaved;
      assert.equal(dateTicks(JSON.parse(row.Data).DateLastSaved), dateTicks(row.DateLastSaved));
      assert.ok(dateTicks(row.DateCreated) > 0n); assert.ok(dateTicks(row.DateLastSaved) > 0n);
      const viewType = data.ViewType, identity = identities[type][viewType]; assert.ok(identity);
      assert.equal(row.Path.replaceAll('\\', '/'), identity.StoredPath.replaceAll('\\', '/'));
      return Object.fromEntries(tableDefinition('BaseItems').columns.filter(column => !['DateCreated', 'DateModified', 'DateLastSaved', 'DateLastRefreshed'].includes(column.name)).map(column => {
        const value = column.name === 'Data' ? data : row[column.name];
        return [column.name, column.name === 'Path' ? value.replaceAll('\\', '/') : value == null ? value
          : column.clrType.replace('?', '') === 'bool' ? value === true || value === 1 || value === '1'
            : column.clrType.replace('?', '') === 'Guid' ? idKey(value)
              : ['int', 'long'].includes(column.clrType.replace('?', '')) ? String(value) : value];
      }));
    };
    const finalRows = {};
    for (const type of ['native', 'node']) {
      const newRows = rows(baseline[type]).filter(row => viewIds.has(idKey(row.Id)));
      assert.equal(newRows.length, 2); finalRows[type] = sorted(newRows.map(row => rowContract(row, type)));
      assert.deepEqual(baseline.files[type].entries.map(entry => entry.path).sort(), ['folders', 'livetv']);
      assert.deepEqual(rows(baseline[type]).filter(row => !viewIds.has(idKey(row.Id))), rows(report.beforeReads[type]));
    }
    report.finalViewRows = finalRows; assert.deepEqual(finalRows.node, finalRows.native);
    assert.deepEqual(fixture.errors, []); assert.deepEqual(report.differences, []);
  } catch (error) { failure = error; report.failure = { name: error.name, message: error.message, stack: error.stack }; }
  finally {
    if (native) try {
      report.nativeProcess = await native.stop(async () => (await request(origin, '/System/Shutdown', { method: 'POST', token: current.accessToken })).status, () => portAvailable(port));
      assert.equal(report.nativeProcess.cleanShutdown, true); assert.equal(report.nativeProcess.pidGone, true); assert.equal(report.nativeProcess.portAvailable, true);
      report.nativeAfterShutdown = nativeSnapshot(); if (baseline) assert.deepEqual(report.nativeAfterShutdown, baseline.native);
    } catch (error) { failure ??= error; report.nativeShutdownFailure = error.message; }
    if (current) try { await current.finish(); } catch (error) { failure ??= error; report.inputVerificationFailure = error.message; }
    if (fixture) try { await fixture.close(); report.cleanup.push({ name: 'production-entry-and-postgres', closed: true }); }
    catch (error) { failure ??= error; report.cleanup.push({ name: 'production-entry-and-postgres', closed: false, error: error.message }); }
    report.nodeAfterShutdown = nodeAtClose;
    if (baseline && nodeAtClose) try { assert.deepEqual(nodeAtClose, baseline.node); } catch (error) { failure ??= error; report.nodeShutdownFailure = error.message; }
    report.passed = !failure; report.phaseAcceptance = false;
    await writeFile(path.join(root, 'report.json'), filterEvidenceJson(report)); await output.publishAndClose();
  }
  if (failure) throw output.publicError(failure);
});
