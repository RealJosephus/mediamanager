import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { cp, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput, filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createWebServerFixture } from '../web/web-fixture.js';
import { dateTicks, idKey } from '../../src/library/records.js';

const enabled = process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES
  && process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE;
const authorization = token => `MediaBrowser Client="Guide info consumer", Device="Isolated", DeviceId="guide-info-consumer", Version="1"${token ? `, Token="${token}"` : ''}`;
const tables = ['BaseItems', 'AncestorIds', 'UserData', 'Permissions', 'Preferences', 'BaseItemImageInfos',
  'BaseItemProviders', 'BaseItemMetadataFields', 'ItemValues', 'ItemValuesMap', 'LinkedChildren', 'MediaStreamInfos'];
const stableRows = rows => rows.map(row => JSON.stringify(row, (_, value) => typeof value === 'bigint' ? String(value) : value)).sort();
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
const withoutNulls = value => Array.isArray(value) ? value.map(withoutNulls) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([, value]) => value != null).map(([key, value]) => [key, withoutNulls(value)])) : value;

test('Live TV info and guide windows match current native HTTP, permissions and configuration', {
  skip: !enabled, timeout: 240000,
}, async () => {
  const output = await createPrivateFilterOutput(path.join(validationOutputRoot(), 'live-tv-info-' + randomUUID()));
  output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
  await mkdir(output.root);
  const root = await realpath(output.root), port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const report = { cases: [], preparation: {}, cleanup: [], differences: [] };
  let current, native, fixture, failure, referenceRoot, baseline, stateAtClose;
  const request = async (server, route, { token, body, method = 'GET' } = {}) => {
    const startedAt = Date.now();
    // Independent runtimes can sample a quantized wall clock at different
    // edges. Bracket the HTTP observation with actual adjacent samples while
    // retaining the narrower HTTP interval for diagnosis.
    await new Promise(resolve => setTimeout(resolve, 3));
    const httpStartedAt = Date.now();
    const response = await fetch(server + route, { method, signal: AbortSignal.timeout(20000),
      headers: { Authorization: authorization(token), Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const bodyText = await response.text(), httpFinishedAt = Date.now();
    await new Promise(resolve => setTimeout(resolve, 3));
    const finishedAt = Date.now();
    let bodyJson;
    try { if (bodyText !== '') bodyJson = JSON.parse(bodyText); } catch { /* Keep non-JSON wire responses. */ }
    return { status: response.status, contentType: response.headers.get('content-type'), bodyText,
      ...(bodyJson === undefined ? {} : { bodyJson }), startedAt, httpStartedAt, httpFinishedAt, finishedAt };
  };
  const nativeSnapshot = () => {
    const database = new DatabaseSync(path.join(referenceRoot, 'data/data/jellyfin.db'), { readOnly: true });
    try {
      return Object.fromEntries(tables.map(table => {
        const statement = database.prepare(`SELECT * FROM "${table}"`);
        statement.setReadBigInts(true);
        return [table, stableRows(statement.all())];
      }));
    } finally { database.close(); }
  };
  const nodeSnapshot = () => fixture.application.store.run(async database => Object.fromEntries(
    await Promise.all(tables.map(async table => [table, stableRows(await database.rows(table))]))));
  const snapshot = async () => ({ native: nativeSnapshot(), node: await nodeSnapshot() });
  try {
    current = await currentNativeReference();
    output.addSecret(current.accessToken);
    report.input = current.preparation;
    report.sourceBindings = await current.sourceBindings(['Jellyfin.Api/Controllers/LiveTvController.cs',
      'src/Jellyfin.LiveTv/LiveTvManager.cs', 'src/Jellyfin.LiveTv/Guide/GuideManager.cs',
      'MediaBrowser.Model/LiveTv/LiveTvInfo.cs', 'MediaBrowser.Model/LiveTv/LiveTvServiceInfo.cs',
      'MediaBrowser.Model/LiveTv/LiveTvOptions.cs', 'Jellyfin.Server.Implementations/Users/UserManager.cs',
      'Jellyfin.Data/UserEntityExtensions.cs']);
    referenceRoot = path.join(root, 'reference');
    await cp(current.sourceRoot, referenceRoot, { recursive: true,
      filter: filename => !path.relative(current.sourceRoot, filename).replaceAll('\\', '/').startsWith('log/') });
    await mkdir(path.join(referenceRoot, 'log'), { recursive: true });
    await current.prepareClone(referenceRoot, port);
    native = current.start({ referenceRoot, outputRoot: root, label: 'reference', origin });
    await native.ready();
    fixture = await createWebServerFixture({ preparation: report.preparation });
    for (const secret of fixture.secrets) output.addSecret(secret);
    const appName = 'GuideInfo_' + randomUUID();
    assert.equal((await request(origin, '/Auth/Keys?app=' + appName, { token: current.accessToken, method: 'POST' })).status, 204);
    assert.equal((await fixture.administratorRequest('/Auth/Keys?app=' + appName, { method: 'POST' })).status, 204);
    const nativeKeys = await request(origin, '/Auth/Keys', { token: current.accessToken });
    const nodeKeys = await (await fixture.administratorRequest('/Auth/Keys')).json();
    const keys = { native: nativeKeys.bodyJson.Items.find(value => value.AppName === appName).AccessToken,
      node: nodeKeys.Items.find(value => value.AppName === appName).AccessToken };
    Object.values(keys).forEach(token => output.addSecret(token));
    const servers = { native: origin, node: fixture.origin }, users = {}, tokens = {};
    const initialUsers = {};
    for (const type of ['native', 'node']) {
      const listed = await request(servers[type], '/Users', { token: keys[type] });
      assert.equal(listed.status, 200);
      initialUsers[type] = listed.bodyJson;
    }
    const suffix = randomUUID().slice(0, 8);
    const subjects = [
      { role: 'allowed', name: fixture.username, password: fixture.password, EnableLiveTvAccess: true },
      { role: 'disabled', name: 'InfoDisabled_' + suffix, password: randomUUID(), EnableLiveTvAccess: true, IsDisabled: true, IsHidden: true },
      { role: 'denied', name: 'InfoDenied_' + suffix, password: randomUUID(), EnableLiveTvAccess: false },
    ];
    subjects.forEach(value => output.addSecret(value.password));
    for (const type of ['native', 'node']) {
      users[type] = [];
      tokens[type] = {};
      for (const original of initialUsers[type]) {
        if (original.Name === fixture.username) continue;
        const policy = { ...original.Policy, EnableLiveTvAccess: false };
        assert.equal((await request(servers[type], `/Users/${original.Id}/Policy`, { token: keys[type], method: 'POST', body: policy })).status, 204);
        users[type].push({ role: 'bootstrap:' + original.Name, id: original.Id, policy });
      }
      for (const subject of subjects) {
        let user = initialUsers[type].find(value => value.Name === subject.name);
        if (!user) {
          const created = await request(servers[type], '/Users/New', { token: keys[type], method: 'POST',
            body: { Name: subject.name, Password: subject.password } });
          assert.equal(created.status, 200);
          user = created.bodyJson;
        }
        const policy = { ...user.Policy, EnableLiveTvAccess: subject.EnableLiveTvAccess,
          IsDisabled: subject.IsDisabled ?? false, IsHidden: subject.IsHidden ?? false };
        assert.equal((await request(servers[type], `/Users/${user.Id}/Policy`, { token: keys[type], method: 'POST', body: policy })).status, 204);
        users[type].push({ role: subject.role, id: user.Id, policy });
        if (!policy.IsDisabled) {
          const login = await request(servers[type], '/Users/AuthenticateByName', { method: 'POST', body: { Username: subject.name, Pw: subject.password } });
          assert.equal(login.status, 200);
          tokens[type][subject.role] = login.bodyJson.AccessToken;
          output.addSecret(login.bodyJson.AccessToken);
        }
      }
    }
    assert.deepEqual(users.native.map(value => value.role).sort(), users.node.map(value => value.role).sort());
    report.userBindings = users;
    const originalConfiguration = await request(origin, '/System/Configuration/livetv', { token: keys.native });
    assert.equal(originalConfiguration.status, 200);
    const nodeConfiguration = await fixture.application.liveTv.getConfiguration();
    assert.deepEqual(withoutNulls(nodeConfiguration), originalConfiguration.bodyJson);
    report.configurationBoundary = 'Native named-configuration HTTP preparation and the Node cached configuration object are controlled inputs; no Node configuration POST acceptance.';
    const stateAtStart = await snapshot();
    const stateKey = await fixture.application.store.run(database => database.getState('liveTvNativeState'));
    const storeClose = fixture.application.store.close.bind(fixture.application.store);
    fixture.application.store.close = async () => { stateAtClose = await nodeSnapshot(); return storeClose(); };
    const normalize = (response, type, { kind, days, configured }) => {
      if (response.bodyText === '') return { status: response.status, contentType: response.contentType, body: { empty: true } };
      let body = response.bodyJson === undefined ? response.bodyText : structuredClone(response.bodyJson);
      if (body && typeof body === 'object' && Object.hasOwn(body, 'traceId')) {
        assert.ok(typeof body.traceId === 'string' && body.traceId);
        body.traceId = '$trace';
      }
      if (response.status === 200 && kind === 'guide') {
        assert.deepEqual(Object.keys(body).sort(), ['EndDate', 'StartDate']);
        assert.ok(response.startedAt <= response.httpStartedAt && response.httpStartedAt <= response.httpFinishedAt
          && response.httpFinishedAt <= response.finishedAt);
        const start = dateTicks(body.StartDate), end = dateTicks(body.EndDate), epoch = 621355968000000000n;
        assert.ok(start >= epoch + BigInt(response.startedAt) * 10000n && start < epoch + BigInt(response.finishedAt + 1) * 10000n);
        assert.equal(end - start, BigInt(days) * 864000000000n);
        body = { StartDate: '$request-now', EndDate: '$request-now+' + days + 'd' };
      } else if (response.status === 200 && kind === 'info') {
        const expected = configured ? users[type].filter(value => value.policy.EnableLiveTvAccess).map(value => idKey(value.id)).sort() : [];
        assert.deepEqual(body.EnabledUsers, expected);
        const byId = new Map(users[type].map(value => [idKey(value.id), value.role]));
        body.EnabledUsers = body.EnabledUsers.map(id => { assert.ok(byId.has(id)); return byId.get(id); }).sort();
      }
      return { status: response.status, contentType: response.contentType, body };
    };
    for (const [index, sample] of [
      { name: 'default', GuideDays: null, configured: false }, { name: 'minimum', GuideDays: 1, configured: true },
      { name: 'zero clamps', GuideDays: 0, configured: true }, { name: 'negative clamps', GuideDays: -2147483648, configured: true },
      { name: 'middle', GuideDays: 10, configured: true }, { name: 'maximum', GuideDays: 14, configured: true },
      { name: 'overflow clamps', GuideDays: 2147483647, configured: true }, { name: 'default configured', GuideDays: null, configured: true },
      { name: 'empty again', GuideDays: 3, configured: false },
    ].entries()) {
      const changes = { GuideDays: sample.GuideDays, TunerHosts: sample.configured ? [{ Id: 'controlled', Type: 'unregistered', Url: 'controlled://guide' }] : [] };
      assert.equal((await request(origin, '/System/Configuration/livetv', { token: keys.native, method: 'POST',
        body: { ...originalConfiguration.bodyJson, ...changes } })).status, 204);
      Object.assign(nodeConfiguration, changes);
      const before = await snapshot();
      for (const kind of ['info', 'guide']) {
        const days = Math.max(1, Math.min(14, sample.GuideDays ?? 7));
        const route = kind === 'info' ? '/LiveTv/Info' : '/LiveTv/GuideInfo';
        const modes = index === 0 ? ['anonymous', 'invalid', 'allowed', 'denied', 'apiKey'] : ['allowed', 'apiKey'];
        for (const mode of modes) {
          const pair = { name: sample.name, kind, mode, days, configured: sample.configured, method: 'GET',
            route: route + (mode === 'allowed' ? '?userId=not-a-guid&minStartDate=ignored' : '') };
          for (const type of ['native', 'node']) pair[type] = await request(servers[type], pair.route,
            { token: mode === 'apiKey' ? keys[type] : mode === 'invalid' ? 'invalid-guide-token' : tokens[type][mode] });
          report.cases.push(pair);
          try {
            assert.equal(pair.native.status, ['anonymous', 'invalid'].includes(mode) ? 401 : mode === 'denied' ? 403 : 200);
            assert.deepEqual(normalize(pair.node, 'node', pair), normalize(pair.native, 'native', pair));
          } catch (error) { report.differences.push({ name: sample.name, kind, mode, message: error.message }); }
        }
      }
      const after = await snapshot();
      report.readStages ??= [];
      report.readStages.push({ name: sample.name, before, after });
      assert.deepEqual(after, before);
      assert.equal(await fixture.application.store.run(database => database.getState('liveTvNativeState')), stateKey);
    }
    baseline = await snapshot();
    report.beforeReads = stateAtStart;
    report.afterReads = baseline;
    assert.deepEqual(baseline, stateAtStart);
    assert.deepEqual(fixture.errors, []);
    assert.deepEqual(report.differences, []);
  } catch (error) { failure = error; report.failure = { name: error.name, message: error.message, stack: error.stack }; }
  finally {
    if (native) {
      try {
        report.nativeProcess = await native.stop(async () => (await request(origin, '/System/Shutdown', { method: 'POST', token: current.accessToken })).status,
          () => portAvailable(port));
        if (!report.nativeProcess.cleanShutdown || !report.nativeProcess.pidGone || !report.nativeProcess.portAvailable) failure ??= new Error('Native Live TV process did not stop cleanly.');
        report.nativeAfterShutdown = nativeSnapshot();
        if (baseline) assert.deepEqual(report.nativeAfterShutdown, baseline.native);
      } catch (error) { failure ??= error; report.nativeShutdownFailure = error.message; }
    }
    if (current) try { await current.finish(); } catch (error) { failure ??= error; report.inputVerificationFailure = error.message; }
    if (fixture) try { await fixture.close(); report.cleanup.push({ name: 'production-entry-and-postgres', closed: true }); }
    catch (error) { failure ??= error; report.cleanup.push({ name: 'production-entry-and-postgres', closed: false, error: error.message }); }
    report.nodeAfterShutdown = stateAtClose;
    if (baseline && stateAtClose) try { assert.deepEqual(stateAtClose, baseline.node); }
    catch (error) { failure ??= error; report.nodeShutdownFailure = error.message; }
    report.passed = !failure;
    report.phaseAcceptance = false;
    await writeFile(path.join(root, 'report.json'), filterEvidenceJson(report));
    await output.publishAndClose();
  }
  if (failure) throw output.publicError(failure);
});
