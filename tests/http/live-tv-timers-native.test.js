import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput, filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { dateTicks } from '../../src/library/records.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { createTimerRuntime, databaseFilename, documentSnapshot, guid, idKey, itemIdentity, makeDocuments,
  seedGuide, sha, sqliteSnapshot, timerIdentity, writeDocuments } from './fixtures/live-tv-timers-http/scenario.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const inputBytes = await readFile(new URL('./fixtures/live-tv-timers-http/input.json', import.meta.url));
const input = JSON.parse(inputBytes);
const enabled = process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_JELLYFIN_DLL;
const authorization = token => `MediaBrowser Client="Saved Live TV timers", Device="Isolated", DeviceId="saved-live-tv-timers", Version="1"${token ? `, Token="${token}"` : ''}`;
const unusedPort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject).listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); });
});
const portAvailable = port => new Promise(resolve => {
  const server = createServer(); server.once('error', () => resolve(false)).listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
});
const dates = new Set(['StartDate', 'EndDate', 'DateCreated', 'DateLastSaved', 'DateLastRefreshed', 'PremiereDate']);
const wire = response => {
  const project = (value, key) => {
    if (Array.isArray(value)) return value.map(entry => project(entry));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, project(entry, name)]));
    if (key === 'traceId') { assert.ok(typeof value === 'string' && value); return '$trace'; }
    if (dates.has(key) && typeof value === 'string') return { ticks: String(dateTicks(value)), utc: value.endsWith('Z') };
    return value;
  };
  return { status: response.status, contentType: response.contentType,
    body: Object.hasOwn(response, 'bodyJson') ? project(response.bodyJson) : response.bodyText };
};
const guidForms = n => {
  const d = guid(n).toLowerCase(), raw = idKey(n);
  return [raw, d, '{' + d + '}', '(' + d + ')', `{0x${raw.slice(0,8)},0x${raw.slice(8,12)},0x${raw.slice(12,16)},{${raw.slice(16).match(/../gu).map(value => '0x' + value).join(',')}}}`];
};

test('saved timers, series timers and defaults match real native HTTP with fresh first-import PostgreSQL state', {
  skip: !enabled, timeout: 540000,
}, async () => {
  const output = await createPrivateFilterOutput(path.join(validationOutputRoot(), 'live-tv-timers-http-' + randomUUID()));
  output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
  await mkdir(output.root);
  const root = await realpath(output.root), referenceRoot = path.join(root, 'reference'), port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const clock = Math.floor(Date.now() / 3600000) * 3600000;
  const report = { inputSha256: sha(inputBytes), clock: new Date(clock).toISOString(), stages: [], cases: [], differences: [], cleanup: [] };
  let current, native, fixture, failure, liveRootId, guide;
  const nativeCredentials = {};
  const request = async (server, route, { token, body, method = 'GET' } = {}) => {
    const response = await fetch(server + route, { method, signal: AbortSignal.timeout(20000), headers: {
      Authorization: authorization(token), Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const bodyText = await response.text();
    let bodyJson;
    try { if (bodyText !== '') bodyJson = JSON.parse(bodyText); } catch { /* Keep non-JSON and empty wire bodies distinct. */ }
    return { status: response.status, contentType: response.headers.get('content-type'), bodyText,
      ...(bodyJson === undefined ? {} : { bodyJson }) };
  };
  const collect = (name, action) => { try { action(); } catch (error) { report.differences.push({ name, message: error.message }); } };
  const nativeSnapshot = async () => ({ database: sqliteSnapshot(referenceRoot), documents: await documentSnapshot(referenceRoot) });
  const credentials = async (server, administratorToken, label, existing) => {
    const result = {}, password = randomUUID(); output.addSecret(password);
    for (const [role, policy] of [['allowed', { EnableLiveTvAccess: true }], ['denied', { EnableLiveTvAccess: false }],
      ['admin', { IsAdministrator: true, EnableLiveTvAccess: false }]]) {
      const username = `Timers_${label}_${role}_${randomUUID().slice(0,8)}`;
      const created = await request(server, '/Users/New', { token: administratorToken, method: 'POST', body: { Name: username, Password: password } });
      assert.equal(created.status, 200);
      const user = created.bodyJson;
      assert.equal((await request(server, '/Users/' + user.Id + '/Policy', { token: administratorToken, method: 'POST', body: { ...user.Policy, ...policy } })).status, 204);
      const login = await request(server, '/Users/AuthenticateByName', { method: 'POST', body: { Username: username, Pw: password } });
      assert.equal(login.status, 200); output.addSecret(login.bodyJson.AccessToken); result[role] = login.bodyJson.AccessToken;
    }
    const app = 'Timer fixture ' + randomUUID();
    assert.equal((await request(server, '/Auth/Keys?app=' + encodeURIComponent(app), { token: administratorToken, method: 'POST' })).status, 204);
    const listed = await request(server, '/Auth/Keys', { token: administratorToken }); assert.equal(listed.status, 200);
    result.apiKey = listed.bodyJson.Items.find(item => item.AppName === app).AccessToken; output.addSecret(result.apiKey);
    result.anonymous = undefined; result.invalid = 'invalid-timer-token';
    Object.assign(existing ?? {}, result); return result;
  };
  const routes = populated => {
    const samples = [];
    const add = (name, route, modes = ['allowed', 'apiKey']) => samples.push({ name, route, modes });
    for (const route of ['/LiveTv/Timers', '/LiveTv/SeriesTimers', '/LiveTv/Timers/Defaults']) add('authorization ' + route, route,
      ['anonymous', 'invalid', 'denied', 'allowed', 'admin', 'apiKey']);
    add('ignored unbound timer selectors', '/LiveTv/Timers?userId=not-a-guid&StartIndex=100&Limit=0&SortBy=Name&Fields=Path');
    add('series default name order', '/LiveTv/SeriesTimers');
    for (const query of ['sortBy=Priority', 'sortBy=PRIORITY&sortOrder=Descending', 'sortBy=Name&sortOrder=Descending',
      'sortBy=unknown&sortOrder=42', 'sortBy=Priority&sortOrder=unknown', 'StartIndex=99&Limit=0&userId=bad']) add('series ' + query, '/LiveTv/SeriesTimers?' + query);
    for (const query of ['isActive=true', 'isActive=false', 'isScheduled=true', 'isScheduled=false',
      'isActive=true&isScheduled=true', 'isActive=false&isScheduled=false', 'isActive=not-a-bool', 'isScheduled=not-a-bool',
      'channelId=', 'seriesTimerId=', 'channelId=not-a-guid', 'seriesTimerId=not-a-guid']) add('timer filter ' + query, '/LiveTv/Timers?' + query);
    add('missing timer', '/LiveTv/Timers/' + '0'.repeat(32));
    add('missing series timer', '/LiveTv/SeriesTimers/' + '0'.repeat(32));
    add('malformed timer detail remains a string lookup', '/LiveTv/Timers/not-a-guid');
    add('malformed series detail remains a string lookup', '/LiveTv/SeriesTimers/not-a-guid');
    add('required timer whitespace', '/LiveTv/Timers/%20');
    add('defaults ignored user and fields', '/LiveTv/Timers/Defaults?userId=not-a-guid&Fields=unknown');
    add('defaults malformed program', '/LiveTv/Timers/Defaults?programId=not-a-guid');
    add('defaults missing program', '/LiveTv/Timers/Defaults?programId=' + '0'.repeat(32));
    if (populated) {
      for (const item of input.timers) {
        add('timer detail ' + item.Id, '/LiveTv/Timers/' + timerIdentity(item.Id));
        add('timer detail upper ' + item.Id, '/LiveTv/Timers/' + timerIdentity(item.Id).toUpperCase());
      }
      add('timer D format is not an external identity', '/LiveTv/Timers/' + guid(timerIdentity('new-one')));
      for (const item of input.seriesTimers) add('series detail ' + item.Id, '/LiveTv/SeriesTimers/' + timerIdentity(item.Id));
      for (const value of guidForms(itemIdentity('LiveTvChannel', 'channel-one'))) add('channel GUID form ' + value, '/LiveTv/Timers?channelId=' + encodeURIComponent(value));
      for (const value of guidForms(timerIdentity('series-two'))) add('series GUID form ' + value, '/LiveTv/Timers?seriesTimerId=' + encodeURIComponent(value));
      for (const [index, id] of guide.programIds.entries()) add('program defaults ' + index, '/LiveTv/Timers/Defaults?programId=' + id);
      add('defaults wrong item type', '/LiveTv/Timers/Defaults?programId=' + guide.channelIds[0]);
      add('defaults GUID D form', '/LiveTv/Timers/Defaults?programId=' + guid(guide.programIds[0]));
    }
    return samples;
  };
  const observations = async (type, server, tokens, populated, runtimeErrors) => {
    const values = [];
    for (const sample of routes(populated)) for (const mode of sample.modes) {
      const errorIndex = runtimeErrors?.length ?? 0;
      const response = await request(server, sample.route, { token: tokens[mode] });
      const value = { name: sample.name, mode, request: { method: 'GET', route: sample.route }, response,
        ...(runtimeErrors ? { runtimeErrors: runtimeErrors.slice(errorIndex) } : {}) };
      if (runtimeErrors && response.status < 500) {
        // Application middleware reports a thrown domain error before sending
        // its 400 response. Bind this one request failure exactly; unrelated
        // background errors must still fail successful and binding responses.
        const expected = sample.name === 'defaults missing program' && response.status === 400
          ? [{ name: 'Error', message: "Guid can't be empty. (Parameter 'id')" }] : [];
        assert.deepEqual(value.runtimeErrors, expected, sample.name + ': only the exact request failure may be reported');
      }
      values.push(value);
      await writeFile(path.join(root, `${type}-${populated ? 'populated' : 'empty'}-progress.log`), filterEvidenceJson(value), { flag: 'a' });
    }
    return values;
  };
  const stopNative = async label => {
    if (!native) return;
    const process = await native.stop(async () => (await request(origin, '/System/Shutdown', { token: current.accessToken, method: 'POST' })).status,
      () => portAvailable(port));
    report.cleanup.push({ name: label, ...process }); native = undefined;
    assert.ok(process.cleanShutdown && process.pidGone && process.portAvailable, label);
  };
  try {
    current = await currentNativeReference(); output.addSecret(current.accessToken); report.input = current.preparation;
    report.sourceBindings = await current.sourceBindings(['Jellyfin.Api/Controllers/LiveTvController.cs',
      'src/Jellyfin.LiveTv/LiveTvManager.cs', 'src/Jellyfin.LiveTv/DefaultLiveTvService.cs',
      'src/Jellyfin.LiveTv/Timers/TimerManager.cs', 'src/Jellyfin.LiveTv/Timers/SeriesTimerManager.cs',
      'src/Jellyfin.LiveTv/LiveTvDtoService.cs', 'Emby.Server.Implementations/Dto/DtoService.cs',
      'MediaBrowser.Model/LiveTv/BaseTimerInfoDto.cs', 'MediaBrowser.Model/LiveTv/TimerInfoDto.cs', 'MediaBrowser.Model/LiveTv/SeriesTimerInfoDto.cs',
      'MediaBrowser.Controller/LiveTv/TimerInfo.cs', 'MediaBrowser.Controller/LiveTv/SeriesTimerInfo.cs',
      'MediaBrowser.Controller/LiveTv/LiveTvChannel.cs', 'MediaBrowser.Controller/LiveTv/LiveTvProgram.cs']);
    await cp(current.sourceRoot, referenceRoot, { recursive: true, filter: filename => !path.relative(current.sourceRoot, filename).replaceAll('\\', '/').startsWith('log/') });
    await mkdir(path.join(referenceRoot, 'log'), { recursive: true }); await current.prepareClone(referenceRoot, port);
    await writeFile(path.join(referenceRoot, 'config/livetv.xml'), '<LiveTvOptions><PrePaddingSeconds>-7</PrePaddingSeconds><PostPaddingSeconds>13</PostPaddingSeconds><TunerHosts><TunerHostInfo><Id>controlled</Id><Type>unregistered</Type><Url>controlled://timers</Url></TunerHostInfo></TunerHosts></LiveTvOptions>');
    const emptyDocuments = makeDocuments(input, clock, true);
    await writeDocuments(referenceRoot, emptyDocuments);
    native = current.start({ referenceRoot, outputRoot: root, label: 'reference-empty', origin }); await native.ready();
    await credentials(origin, current.accessToken, 'native', nativeCredentials);
    const views = await request(origin, '/UserViews?IncludeHidden=true&UserId=' + idKey(current.userId), { token: nativeCredentials.apiKey }); assert.equal(views.status, 200);
    const view = views.bodyJson.Items.find(item => item.CollectionType === 'livetv'); assert.ok(view);
    liveRootId = idKey(view.Id); report.liveTvView = view;
    const deadline = Date.now() + 30000;
    while (true) {
      const db = new SqliteDatabase(databaseFilename(referenceRoot), { readOnly: true, requireMigrationHistory: true });
      let row;
      try { row = db.rows('BaseItems', { where: { Id: guid(liveRootId) } })[0]; } finally { db.close(); }
      if (row?.DateLastRefreshed && dateTicks(row.DateLastRefreshed) > dateTicks('0001-01-01T00:00:00Z')) { report.liveTvViewCommittedRow = row; break; }
      assert.ok(Date.now() < deadline, 'The native view must commit its initial metadata refresh before read-only evidence starts.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    for (const populated of [false, true]) {
      const stage = { name: populated ? 'populated' : 'empty', nodeShutdownStates: [], nodeErrors: [] };
      report.stages.push(stage);
      const documents = makeDocuments(input, clock, !populated);
      if (populated) {
        guide = await seedGuide(referenceRoot, liveRootId, clock, path.join(root, 'guide-assets')); report.guide = guide;
        await writeDocuments(referenceRoot, documents);
      }
      const nodeRoot = path.join(root, populated ? 'node-populated' : 'node-empty');
      // The native process is stopped for the source SQLite copy used to seed
      // each fresh PG runtime. No PG timer state exists before runtime startup.
      if (!populated) {
        stage.nativeBeforeReads = await nativeSnapshot();
        stage.native = await observations('native', origin, nativeCredentials, false);
        stage.nativeAfterReads = await nativeSnapshot(); assert.deepEqual(stage.nativeAfterReads, stage.nativeBeforeReads);
        await stopNative('native-empty'); stage.nativeAfterShutdown = await nativeSnapshot();
        assert.deepEqual(stage.nativeAfterShutdown, stage.nativeAfterReads);
      }
      fixture = await createTimerRuntime({ sourceRoot: referenceRoot, root: nodeRoot, serverId: current.preparation.nativeServerId,
        errors: stage.nodeErrors, documents, shutdownStates: stage.nodeShutdownStates, reservedPorts: [port] });
      stage.nodePorts = [Number(new URL(fixture.origin).port)];
      const bootstrapPassword = randomUUID(); output.addSecret(bootstrapPassword);
      const bootstrap = await fixture.application.users.createUser({ Name: 'TimersBootstrap_' + randomUUID(), Password: bootstrapPassword });
      await fixture.application.users.updatePolicy(bootstrap.Id, { ...(await fixture.application.users.getUser(bootstrap.Id)).Policy, IsAdministrator: true });
      const bootstrapLogin = await request(fixture.origin, '/Users/AuthenticateByName', { method: 'POST', body: { Username: bootstrap.Name, Pw: bootstrapPassword } });
      assert.equal(bootstrapLogin.status, 200); output.addSecret(bootstrapLogin.bodyJson.AccessToken);
      const nodeCredentials = await credentials(fixture.origin, bootstrapLogin.bodyJson.AccessToken, 'node');
      assert.deepEqual(stage.nodeErrors, [], 'The fresh runtime and preparation must not hide background failures.');
      if (populated) {
        native = current.start({ referenceRoot, outputRoot: root, label: 'reference-populated', origin }); await native.ready();
        stage.nativeBeforeReads = await nativeSnapshot(); stage.native = await observations('native', origin, nativeCredentials, true);
        stage.nativeAfterReads = await nativeSnapshot(); assert.deepEqual(stage.nativeAfterReads, stage.nativeBeforeReads);
      }
      stage.nodeBeforeReads = { database: await fixture.snapshot(), documents: await documentSnapshot(nodeRoot) };
      const nativeSource = stage.nativeBeforeReads.documents;
      assert.deepEqual(stage.nodeBeforeReads.documents, nativeSource, 'Both first readers consume the same original document bytes.');
      const imported = JSON.parse(stage.nodeBeforeReads.database.liveTvNativeState);
      for (const [kind, filename] of [['timers', 'timers.json'], ['seriesTimers', 'seriestimers.json']]) {
        assert.equal(imported[kind].issue, null);
        assert.equal(imported[kind].rows.length, populated ? input[kind].length : 0);
        assert.equal(imported[kind].sourceSha256, nativeSource[filename].sha256);
        assert.equal(Buffer.from(imported[kind].sourceHex, 'hex').toString('base64'), nativeSource[filename].base64);
        assert.equal(sha(Buffer.from(imported[kind].sourceHex, 'hex')), imported[kind].sourceSha256);
      }
      stage.node = await observations('node', fixture.origin, nodeCredentials, populated, stage.nodeErrors);
      stage.nodeAfterReads = { database: await fixture.snapshot(), documents: await documentSnapshot(nodeRoot) };
      assert.deepEqual(stage.nodeAfterReads, stage.nodeBeforeReads);
      assert.equal(stage.node.length, stage.native.length);
      for (const [index, value] of stage.node.entries()) {
        const expected = stage.native[index]; report.cases.push({ stage: stage.name, name: value.name, mode: value.mode, request: value.request,
          native: expected.response, node: value.response });
        collect(stage.name + ': ' + value.name + ':' + value.mode, () => {
          assert.deepEqual(value.request, expected.request); assert.equal(value.name, expected.name); assert.equal(value.mode, expected.mode);
          assert.deepEqual(wire(value.response), wire(expected.response));
        });
      }
      if (populated) {
        const rows = stage.native.find(item => item.name === 'authorization /LiveTv/Timers' && item.mode === 'allowed').response.bodyJson;
        assert.equal(rows.TotalRecordCount, input.timers.length - 1); assert.equal(rows.StartIndex, 0);
        assert.ok(rows.Items.every(item => item.Status !== 'Completed'));
        const newTimer = rows.Items.find(item => item.ExternalId === 'new-one');
        assert.equal(newTimer.Id, timerIdentity('new-one')); assert.equal(newTimer.ChannelId, guide.channelIds[0]);
        assert.equal(newTimer.ProgramInfo.Id, guide.programIds[0]); assert.ok(newTimer.ChannelPrimaryImageTag);
        assert.ok(newTimer.ProgramInfo.ParentThumbImageTag); assert.ok(newTimer.ProgramInfo.ParentPrimaryImageTag);
        const original = await request(fixture.origin, '/LiveTv/Timers', { token: nodeCredentials.allowed });
        await writeDocuments(nodeRoot, { 'timers.json': '[]\n', 'seriestimers.json': '[]\n' });
        const warm = await request(fixture.origin, '/LiveTv/Timers', { token: nodeCredentials.allowed });
        assert.deepEqual(wire(warm), wire(original)); assert.deepEqual(await fixture.snapshot(), stage.nodeBeforeReads.database);
        stage.sourceMutation = { original, warm, changedDocuments: await documentSnapshot(nodeRoot), stateUnchanged: true };
        for (const filename of ['timers.json', 'seriestimers.json']) {
          assert.notEqual(stage.sourceMutation.changedDocuments[filename].sha256, stage.nodeBeforeReads.documents[filename].sha256);
          assert.equal(stage.sourceMutation.changedDocuments[filename].base64, Buffer.from('[]\n').toString('base64'));
        }
        await fixture.restart();
        stage.nodePorts.push(Number(new URL(fixture.origin).port));
        const cold = await request(fixture.origin, '/LiveTv/Timers', { token: nodeCredentials.allowed });
        assert.deepEqual(wire(cold), wire(original)); assert.deepEqual(await fixture.snapshot(), stage.nodeBeforeReads.database);
        stage.sourceMutation.cold = cold;
        await stopNative('native-populated'); stage.nativeAfterShutdown = await nativeSnapshot();
        assert.deepEqual(stage.nativeAfterShutdown, stage.nativeAfterReads);
      }
      await fixture.close(); fixture = undefined;
      for (const port of new Set(stage.nodePorts)) assert.equal(await portAvailable(port), true, 'Every closed Node listener must be released.');
      report.cleanup.push({ name: 'node-' + stage.name, runtimeClosed: true, postgresSchemaDropped: true, listenerPortsReleased: true });
      assert.ok(stage.nodeShutdownStates.length >= 1);
      for (const state of stage.nodeShutdownStates) assert.deepEqual(state.database, stage.nodeBeforeReads.database);
      if (!populated) assert.deepEqual(stage.nodeShutdownStates[0].documents, stage.nodeBeforeReads.documents);
      else for (const state of stage.nodeShutdownStates) assert.deepEqual(state.documents, stage.sourceMutation.changedDocuments);
    }
    assert.deepEqual(report.differences, []);
  } catch (error) { failure = error; report.failure = { name: error.name, message: error.message, stack: error.stack }; }
  finally {
    if (native) try { await stopNative('native-finally'); } catch (error) { failure ??= error; }
    if (fixture) try { await fixture.close(); } catch (error) { failure ??= error; }
    if (current) try { await current.finish(); report.cleanup.push({ name: 'protected-inputs', unchanged: true }); } catch (error) { failure ??= error; report.inputVerificationFailure = error.message; }
    report.passed = !failure; report.phaseAcceptance = false; report.releaseAcceptance = false;
    report.boundary = 'Actual designated native HTTP and fresh PostgreSQL runtime HTTP. No production CLI import, tuner/listing/recording execution, state-package success after source mutation, pixels or complete Live TV acceptance.';
    await writeFile(path.join(root, 'report.json'), filterEvidenceJson(report));
    await output.publishAndClose();
  }
  if (failure) throw output.publicError(failure);
});
