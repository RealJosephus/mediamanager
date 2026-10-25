import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput, filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createWebServerFixture } from '../web/web-fixture.js';
import { dateTicks, idKey, MIN_DATE } from '../../src/library/records.js';
import { nativeRootUserViewIdentity } from '../../src/library/identity.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const enabled = process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES
  && process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE && process.env.MEDIAMANAGER_JELLYFIN_DLL;
const authorization = token => `MediaBrowser Client="Live TV configuration", Device="Isolated", DeviceId="live-tv-configuration", Version="1"${token ? `, Token="${token}"` : ''}`;
const tables = ['BaseItems', 'AncestorIds', 'UserData', 'Permissions', 'Preferences', 'BaseItemImageInfos',
  'BaseItemProviders', 'BaseItemMetadataFields', 'ItemValues', 'ItemValuesMap', 'LinkedChildren', 'MediaStreamInfos'];
const stableRows = rows => rows.map(row => JSON.stringify(row, (_, value) => typeof value === 'bigint' ? String(value) : value)).sort();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
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
const wireContract = response => {
  const body = Object.hasOwn(response, 'bodyJson') ? structuredClone(response.bodyJson) : response.bodyText;
  if (body && typeof body === 'object' && Object.hasOwn(body, 'traceId')) {
    assert.ok(typeof body.traceId === 'string' && body.traceId);
    body.traceId = '$trace';
  }
  return { status: response.status, contentType: response.contentType, body };
};

test('Live TV named configuration POST matches native replacement, XML consumption and cold HTTP readers', {
  skip: !enabled, timeout: 360000,
}, async () => {
  const output = await createPrivateFilterOutput(path.join(validationOutputRoot(), 'live-tv-configuration-http-' + randomUUID()));
  output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
  await mkdir(output.root);
  const root = await realpath(output.root), port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const report = { cases: [], preparation: {}, stages: [], cleanup: [], differences: [] };
  const consumers = [], consumedPairs = [];
  let current, native, fixture, referenceRoot, failure, baseline;
  const nodeShutdownStates = [];
  const request = async (server, route, { token, body, rawBody, contentType = 'application/json', method = 'GET' } = {}) => {
    const startedAt = Date.now();
    await new Promise(resolve => setTimeout(resolve, 3));
    const httpStartedAt = Date.now();
    const response = await fetch(server + route, { method, signal: AbortSignal.timeout(20000),
      headers: { Authorization: authorization(token), Accept: 'application/json',
        ...(body === undefined && rawBody === undefined ? {} : { 'Content-Type': contentType }) },
      ...(rawBody !== undefined ? { body: rawBody } : body === undefined ? {} : { body: JSON.stringify(body) }) });
    const bodyText = await response.text(), httpFinishedAt = Date.now();
    await new Promise(resolve => setTimeout(resolve, 3));
    const finishedAt = Date.now();
    let bodyJson;
    try { if (bodyText !== '') bodyJson = JSON.parse(bodyText); } catch { /* Preserve the complete non-JSON response. */ }
    return { status: response.status, contentType: response.headers.get('content-type'), bodyText,
      ...(bodyJson === undefined ? {} : { bodyJson }), startedAt, httpStartedAt, httpFinishedAt, finishedAt };
  };
  const nativeSnapshot = () => {
    const database = new DatabaseSync(path.join(referenceRoot, 'data/data/jellyfin.db'), { readOnly: true });
    try { return Object.fromEntries(tables.map(table => {
      const statement = database.prepare(`SELECT * FROM "${table}"`); statement.setReadBigInts(true);
      return [table, stableRows(statement.all())];
    })); } finally { database.close(); }
  };
  const nodeSnapshot = () => fixture.application.store.run(async database => ({
    tables: Object.fromEntries(await Promise.all(tables.map(async table => [table, stableRows(await database.rows(table))]))),
    liveTvNativeState: await database.getState('liveTvNativeState'),
  }));
  const configurationFilename = type => type === 'native' ? path.join(referenceRoot, 'config/livetv.xml')
    : path.join(fixture.application.liveTv.configurationDirectoryPath, 'livetv.xml');
  const fileSnapshot = async type => {
    try {
      const bytes = await readFile(configurationFilename(type));
      return { exists: true, bytes: bytes.length, sha256: sha(bytes), base64: bytes.toString('base64') };
    } catch (error) { if (error.code === 'ENOENT') return { exists: false }; throw error; }
  };
  const snapshot = async () => ({ native: nativeSnapshot(), node: await nodeSnapshot(),
    files: { native: await fileSnapshot('native'), node: await fileSnapshot('node') } });
  const captureNodeShutdown = () => {
    const store = fixture.application.store, close = store.close.bind(store);
    store.close = async () => {
      nodeShutdownStates.push({ database: await nodeSnapshot(), file: await fileSnapshot('node') });
      return close();
    };
  };
  const collect = (name, check) => {
    try { check(); } catch (error) { report.differences.push({ name, message: error.message }); }
  };
  try {
    current = await currentNativeReference(); output.addSecret(current.accessToken); report.input = current.preparation;
    report.sourceBindings = await current.sourceBindings(['Jellyfin.Api/Controllers/ConfigurationController.cs',
      'Emby.Server.Implementations/AppBase/BaseConfigurationManager.cs', 'Emby.Server.Implementations/AppBase/ConfigurationHelper.cs',
      'Emby.Server.Implementations/Serialization/MyXmlSerializer.cs', 'src/Jellyfin.Extensions/Json/JsonDefaults.cs',
      'src/Jellyfin.Extensions/Json/Converters/JsonStringConverter.cs', 'src/Jellyfin.Extensions/Json/Converters/JsonNullableStructConverter.cs',
      'MediaBrowser.Model/LiveTv/LiveTvOptions.cs', 'MediaBrowser.Model/LiveTv/TunerHostInfo.cs',
      'MediaBrowser.Model/LiveTv/ListingsProviderInfo.cs', 'MediaBrowser.Model/Dto/NameValuePair.cs',
      'src/Jellyfin.LiveTv/Configuration/LiveTvConfigurationFactory.cs', 'src/Jellyfin.LiveTv/Recordings/RecordingsManager.cs',
      'Jellyfin.Api/Controllers/LiveTvController.cs', 'src/Jellyfin.LiveTv/LiveTvManager.cs', 'src/Jellyfin.LiveTv/Guide/GuideManager.cs',
      'Emby.Server.Implementations/Library/UserViewManager.cs', 'Jellyfin.Api/Controllers/UserViewsController.cs',
      'Emby.Server.Implementations/Library/LibraryManager.cs', 'MediaBrowser.Providers/Manager/MetadataService.cs',
      'MediaBrowser.Providers/Folders/UserViewMetadataService.cs', 'Jellyfin.Server.Implementations/Item/BaseItemMapper.cs']);
    referenceRoot = path.join(root, 'reference');
    await cp(current.sourceRoot, referenceRoot, { recursive: true,
      filter: filename => !path.relative(current.sourceRoot, filename).replaceAll('\\', '/').startsWith('log/') });
    await mkdir(path.join(referenceRoot, 'log'), { recursive: true }); await current.prepareClone(referenceRoot, port);
    native = current.start({ referenceRoot, outputRoot: root, label: 'reference', origin }); await native.ready();
    fixture = await createWebServerFixture({ preparation: report.preparation });
    for (const secret of fixture.secrets) output.addSecret(secret);
    const appName = 'LiveTvConfiguration_' + randomUUID(), keys = {}, users = {}, tokens = {};
    const servers = { native: origin, node: fixture.origin };
    assert.equal((await request(origin, '/Auth/Keys?app=' + appName, { token: current.accessToken, method: 'POST' })).status, 204);
    assert.equal((await fixture.administratorRequest('/Auth/Keys?app=' + appName, { method: 'POST' })).status, 204);
    const nativeKeys = await request(origin, '/Auth/Keys', { token: current.accessToken });
    const nodeKeys = await (await fixture.administratorRequest('/Auth/Keys')).json();
    keys.native = nativeKeys.bodyJson.Items.find(value => value.AppName === appName).AccessToken;
    keys.node = nodeKeys.Items.find(value => value.AppName === appName).AccessToken;
    Object.values(keys).forEach(value => output.addSecret(value));
    const created = await request(origin, '/Users/New', { token: keys.native, method: 'POST',
      body: { Name: fixture.username, Password: fixture.password } });
    assert.equal(created.status, 200);
    for (const type of ['native', 'node']) {
      const login = await request(servers[type], '/Users/AuthenticateByName', { method: 'POST',
        body: { Username: fixture.username, Pw: fixture.password } });
      assert.equal(login.status, 200); assert.equal(login.bodyJson.User.Policy.IsAdministrator, false);
      output.addSecret(login.bodyJson.AccessToken); tokens[type] = login.bodyJson.AccessToken;
      const listed = await request(servers[type], '/Users', { token: keys[type] }); assert.equal(listed.status, 200);
      users[type] = listed.bodyJson;
    }
    report.userBindings = Object.fromEntries(Object.entries(users).map(([type, values]) => [type,
      values.map(user => ({ name: user.Name, id: user.Id, EnableLiveTvAccess: user.Policy.EnableLiveTvAccess }))]));
    assert.deepEqual(users.native.map(user => user.Name).sort(), users.node.map(user => user.Name).sort());
    captureNodeShutdown();
    const pair = async (name, route = '/System/Configuration/livetv', options = {}) => {
      const item = { name, route, request: { method: options.method ?? 'GET',
        ...(Object.hasOwn(options, 'body') ? { body: options.body } : {}),
        ...(Object.hasOwn(options, 'rawBody') ? { rawBody: options.rawBody } : {}),
        ...(options.contentType ? { contentType: options.contentType } : {}), mode: options.mode ?? 'apiKey' } };
      for (const type of ['native', 'node']) item[type] = await request(servers[type], route, { ...options,
        token: options.mode === 'anonymous' ? undefined : options.mode === 'invalid' ? 'invalid-live-tv-configuration-token'
          : options.mode === 'ordinary' ? tokens[type] : keys[type] });
      report.cases.push(item);
      collect(name, () => assert.deepEqual(wireContract(item.node), wireContract(item.native)));
      return item;
    };
    const initial = await pair('initial defaults'); assert.equal(initial.native.status, 200);
    const filesBeforeAuth = await snapshot();
    for (const mode of ['anonymous', 'invalid', 'ordinary']) {
      const read = await pair('GET authentication: ' + mode, undefined, { mode });
      assert.equal(read.native.status, mode === 'ordinary' ? 200 : 401);
      const saved = await pair('POST authentication: ' + mode, undefined, { mode, method: 'POST', body: { GuideDays: 11 } });
      assert.equal(saved.native.status, mode === 'ordinary' ? 403 : 401);
    }
    report.authenticationStages = { before: filesBeforeAuth, after: await snapshot() };
    assert.deepEqual(report.authenticationStages.after, filesBeforeAuth);
    const saveFiles = async name => {
      const files = { native: await fileSnapshot('native'), node: await fileSnapshot('node') };
      const names = {};
      for (const type of ['native', 'node']) {
        assert.equal(files[type].exists, true);
        const filename = path.join(root, `saved-${consumers.length}.xml`), consumerName = `${name}:${type}`;
        await writeFile(filename, Buffer.from(files[type].base64, 'base64'), { flag: 'wx' });
        consumers.push({ name: consumerName, filename }); names[type] = consumerName;
      }
      consumedPairs.push({ name, ...names }); return files;
    };
    const accepted = async (name, options) => {
      const before = await snapshot();
      const saved = await pair(name, options.route, { ...options, method: 'POST' });
      assert.equal(saved.native.status, 204, name); assert.equal(saved.node.status, 204, name);
      const files = await saveFiles(name), read = await pair(name + ' readback', options.route);
      assert.equal(read.native.status, 200);
      const after = await snapshot();
      assert.deepEqual(after.native, before.native, name + ': native configuration save must leave media and user state unchanged');
      assert.deepEqual(after.node, before.node, name + ': Node configuration save must leave PostgreSQL state unchanged');
      assert.deepEqual(after.files, files, name + ': GET must not rewrite saved XML');
      report.stages.push({ name, before, after }); return read;
    };
    const full = {
      GuideDays: 10, RecordingPath: '', MovieRecordingPath: '', SeriesRecordingPath: '',
      EnableRecordingSubfolders: true, EnableOriginalAudioWithEncodedRecordings: true,
      PrePaddingSeconds: -12, PostPaddingSeconds: 43, MediaLocationsCreated: [], RecordingPostProcessor: '',
      RecordingPostProcessorArguments: '"{path}" 中文 & <test>', SaveRecordingNFO: false, SaveRecordingImages: false,
      TunerHosts: [{ Id: 'controlled', Url: 'controlled://configuration', Type: 'unregistered', DeviceId: 'device',
        FriendlyName: '控制 & tuner', ImportFavoritesOnly: true, AllowHWTranscoding: false,
        AllowFmp4TranscodingContainer: true, AllowStreamSharing: false, FallbackMaxStreamingBitrate: 12345,
        EnableStreamLooping: true, Source: 'source', TunerCount: 2, UserAgent: 'configuration-test',
        IgnoreDts: false, ReadAtNativeFramerate: true }],
      ListingProviders: [{ Id: 'listing', Type: 'unregistered', Username: '', Password: '', ListingsId: 'list',
        ZipCode: 'zip', Country: 'TW', Path: '', EnabledTuners: ['controlled', 'controlled'], EnableAllTuners: false,
        NewsCategories: ['新闻', 'news'], SportsCategories: [], KidsCategories: ['kids'], MovieCategories: ['movie'],
        ChannelMappings: [{ Name: 'A', Value: 'one' }, { Name: 'A', Value: 'two' }, { Name: null, Value: '' }],
        MoviePrefix: '電影', PreferredLanguage: 'zh-TW', UserAgent: 'listing-test' }],
    };
    await accepted('all configuration fields', { body: full });
    const defaults = await accepted('empty object replaces all fields', { body: {} });
    assert.deepEqual(defaults.native.bodyJson, initial.native.bodyJson);
    const ignored = await accepted('property names are case sensitive and unknown subtrees are ignored', {
      rawBody: '{"guideDays":12,"tunerHosts":[{"Id":"ignored"}],"Unknown":{"nested":[1,true,null]}}',
    });
    assert.deepEqual(ignored.native.bodyJson, initial.native.bodyJson);
    const numbers = await accepted('quoted numbers, strings and repeated tokens', {
      rawBody: '{"GuideDays":"2","GuideDays":"13","PrePaddingSeconds":"-2147483648","PostPaddingSeconds":"2147483647","RecordingPath":false,"TunerHosts":[{"Id":42,"TunerCount":"3","FallbackMaxStreamingBitrate":"5000000"}],"ListingProviders":[{"Id":"defaults"}]}',
    });
    assert.equal(numbers.native.bodyJson.GuideDays, 13);
    assert.equal(numbers.native.bodyJson.RecordingPath, 'false');
    const nullable = await accepted('nullable empty string and explicit null fields', {
      rawBody: '{"GuideDays":"","RecordingPath":null,"RecordingPostProcessorArguments":null,"ListingProviders":null}',
    });
    assert.equal(Object.hasOwn(nullable.native.bodyJson, 'GuideDays'), false);
    const nullTuners = await accepted('explicit null tuner collection is preserved live', { body: { TunerHosts: null } });
    assert.equal(Object.hasOwn(nullTuners.native.bodyJson, 'TunerHosts'), false);
    const nullInfo = await pair('Info consumes explicit null tuner collection', '/LiveTv/Info', { mode: 'ordinary' });
    assert.equal(nullInfo.native.status, 500);
    await accepted('reset after null tuner collection', { body: {} });
    for (const sample of [
      { name: 'invalid first duplicate is not hidden', rawBody: '{"GuideDays":{},"GuideDays":7}' },
      { name: 'strict Boolean', rawBody: '{"SaveRecordingNFO":"true"}' },
      { name: 'integer overflow', rawBody: '{"PrePaddingSeconds":"2147483648"}' },
      { name: 'fractional integer', rawBody: '{"GuideDays":1.5}' },
      { name: 'invalid nested field', rawBody: '{"TunerHosts":[{"TunerCount":null}]}' },
      { name: 'root array', rawBody: '[]' }, { name: 'root scalar', rawBody: '42' },
      { name: 'root null', rawBody: 'null' }, { name: 'malformed JSON', rawBody: '{"GuideDays":' },
      { name: 'incomplete nested JSON document', rawBody: '{"ListingProviders":[{"Id":' },
      { name: 'incomplete JSON document after Unicode text', rawBody: '{"RecordingPath":"目錄","GuideDays":' },
      { name: 'empty body', rawBody: '' },
      { name: 'unsupported media type', rawBody: '{}', contentType: 'text/plain' },
    ]) {
      const before = await snapshot();
      const rejected = await pair(sample.name, undefined, { ...sample, method: 'POST' });
      assert.ok(rejected.native.status >= 400, sample.name);
      const after = await snapshot(); report.stages.push({ name: sample.name, before, after });
      assert.deepEqual(after, before, sample.name + ': failed binding or deserialization must not save');
      await pair(sample.name + ' leaves cache unchanged');
    }
    const infoContract = (response, type, configured) => {
      const contract = wireContract(response); assert.equal(response.status, 200);
      const expected = configured ? users[type].filter(user => user.Policy.EnableLiveTvAccess).map(user => idKey(user.Id)).sort() : [];
      assert.deepEqual(contract.body.EnabledUsers, expected);
      const names = new Map(users[type].map(user => [idKey(user.Id), user.Name]));
      contract.body.EnabledUsers = contract.body.EnabledUsers.map(id => { assert.ok(names.has(id)); return names.get(id); }).sort();
      return contract;
    };
    const guideContract = (response, days) => {
      assert.equal(response.status, 200);
      const contract = wireContract(response), { StartDate, EndDate } = contract.body;
      const start = dateTicks(StartDate), end = dateTicks(EndDate), epoch = 621355968000000000n;
      assert.deepEqual(Object.keys(contract.body).sort(), ['EndDate', 'StartDate']);
      assert.ok(response.startedAt <= response.httpStartedAt && response.httpStartedAt <= response.httpFinishedAt
        && response.httpFinishedAt <= response.finishedAt);
      assert.ok(start >= epoch + BigInt(response.startedAt) * 10000n && start < epoch + BigInt(response.finishedAt + 1) * 10000n);
      assert.equal(end - start, BigInt(days) * 864000000000n);
      contract.body = { StartDate: '$request-now', EndDate: '$request-now+' + days + 'd' }; return contract;
    };
    const viewIds = {};
    const consumersAfterPost = async (name, configured, days) => {
      const before = await snapshot();
      const info = { name: name + ' Info', route: '/LiveTv/Info' }, guide = { name: name + ' GuideInfo', route: '/LiveTv/GuideInfo' };
      for (const type of ['native', 'node']) {
        info[type] = await request(servers[type], info.route, { token: tokens[type] });
        guide[type] = await request(servers[type], guide.route, { token: tokens[type] });
      }
      report.cases.push(info, guide);
      collect(info.name, () => assert.deepEqual(infoContract(info.node, 'node', configured), infoContract(info.native, 'native', configured)));
      collect(guide.name, () => assert.deepEqual(guideContract(guide.node, days), guideContract(guide.native, days)));
      const afterReads = await snapshot(); assert.deepEqual(afterReads, before);
      const views = { name: name + ' UserViews', route: '/UserViews?includeExternalContent=true' };
      for (const type of ['native', 'node']) {
        views[type] = await request(servers[type], views.route, { token: tokens[type] });
        assert.equal(views[type].status, 200);
        const live = views[type].bodyJson.Items.filter(item => item.CollectionType === 'livetv');
        assert.equal(live.length, configured ? 1 : 0);
        if (configured) {
          const options = type === 'native' ? { programDataPath: path.join(referenceRoot, 'data') } : fixture.application.library.options;
          const identity = nativeRootUserViewIdentity('livetv', options);
          assert.equal(idKey(live[0].Id), idKey(identity.Id)); assert.equal(live[0].Path, identity.Path);
          assert.equal(live[0].Name, 'Live TV');
          if (viewIds[type]) assert.equal(live[0].Id, viewIds[type]);
          viewIds[type] = live[0].Id;
        }
      }
      report.cases.push(views); await fixture.application.library.userViews.drain();
      const identity = nativeRootUserViewIdentity('livetv', { programDataPath: path.join(referenceRoot, 'data') });
      const viewRow = state => {
        const rows = state.BaseItems.map(value => JSON.parse(value)).filter(row => idKey(row.Id) === idKey(identity.Id));
        assert.ok(rows.length <= 1); return rows[0] ?? null;
      };
      const previousView = viewRow(before.native);
      const refresh = { Id: identity.Id, beforeRow: previousView, createdByThisRead: configured && previousView === null,
        samples: [], completedRow: null };
      const stage = { name: name + ' consumers', before, afterReads, nativeViewRefresh: refresh };
      report.stages.push(stage);
      if (refresh.createdByThisRead) {
        // GetNamedView queues this new entity's first refresh. MetadataService
        // stamps DateLastRefreshed before its first SaveInternal commit, and
        // BaseItemMapper persists that stamp in the real BaseItems column.
        // Wait for that specific row's committed stamp rather than a quiet
        // interval in which the queued refresh might not have started yet.
        for (let attempt = 0; attempt < 200; attempt++) {
          const row = viewRow(nativeSnapshot()), at = Date.now();
          const stamp = row?.DateLastRefreshed ?? null;
          refresh.samples.push({ at, exists: row !== null, DateLastRefreshed: stamp,
            DateLastSaved: row?.DateLastSaved ?? null, rowSha256: row ? sha(JSON.stringify(row)) : null });
          if (dateTicks(stamp ?? MIN_DATE) > dateTicks(MIN_DATE)) {
            const item = views.native.bodyJson.Items.find(item => idKey(item.Id) === idKey(identity.Id));
            assert.ok(item); assert.equal(row.Type, 'MediaBrowser.Controller.Entities.UserView');
            assert.equal(row.Path.replaceAll('\\', '/'), identity.StoredPath.replaceAll('\\', '/'));
            assert.equal(dateTicks(row.DateCreated), dateTicks(item.DateCreated));
            const started = 621355968000000000n + BigInt(views.native.startedAt) * 10000n;
            const finished = 621355968000000000n + BigInt(at + 1) * 10000n;
            assert.ok(dateTicks(stamp) >= started && dateTicks(stamp) < finished);
            assert.ok(dateTicks(row.DateLastSaved ?? MIN_DATE) >= dateTicks(stamp));
            refresh.completedRow = row; break;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(refresh.completedRow, 'The newly created native Live TV view must commit its first metadata refresh.');
      }
      stage.afterViews = await snapshot();
    };
    await accepted('configured consumer state', { body: { GuideDays: 12, TunerHosts: [{ Id: 'controlled', Type: 'unregistered' }] } });
    await consumersAfterPost('enabled by POST', true, 12);
    await accepted('clear consumer state with complete replacement', { body: { GuideDays: 0 } });
    await consumersAfterPost('removed by POST', false, 1);
    await accepted('restore existing global view', { body: { GuideDays: 19, TunerHosts: [{ Id: 'controlled', Type: 'unregistered' }] } });
    await consumersAfterPost('restored by POST', true, 14);
    // The store caches exact keys, while the physical file is lower case.
    const lower = await pair('canonical cache before differently cased save');
    const mixed = await accepted('differently cased key has an independent live cache', {
      route: '/System/Configuration/LiveTv', body: { GuideDays: 4, TunerHosts: [] },
    });
    const unchanged = await pair('canonical warmed key after differently cased save');
    assert.deepEqual(unchanged.native.bodyJson, lower.native.bodyJson);
    assert.equal(mixed.native.bodyJson.GuideDays, 4);
    await consumersAfterPost('canonical consumers retain warm value', true, 14);
    baseline = await snapshot(); report.beforeColdRestart = baseline;
    const stopped = await native.stop(async () => (await request(origin, '/System/Shutdown', { token: current.accessToken, method: 'POST' })).status,
      () => portAvailable(port));
    native = undefined; report.firstNativeProcess = stopped;
    assert.equal(stopped.cleanShutdown && stopped.pidGone && stopped.portAvailable, true);
    assert.deepEqual(nativeSnapshot(), baseline.native);
    await fixture.restart();
    assert.deepEqual(nodeShutdownStates.at(-1), { database: baseline.node, file: baseline.files.node });
    captureNodeShutdown();
    native = current.start({ referenceRoot, outputRoot: root, label: 'reference-cold', origin }); await native.ready();
    const cold = await pair('cold canonical read consumes differently cased saved file');
    assert.equal(cold.native.bodyJson.GuideDays, 4); assert.deepEqual(cold.native.bodyJson.TunerHosts, []);
    const coldMixed = await pair('cold differently cased key reads the same file', '/System/Configuration/LiveTv');
    assert.deepEqual(coldMixed.native.bodyJson, cold.native.bodyJson);
    await consumersAfterPost('cold consumers read persisted state', false, 4);
    const consumerInput = path.join(root, 'consumer-input.json');
    await writeFile(consumerInput, JSON.stringify({ cases: consumers }), { flag: 'wx' });
    const recording = await recordOracle({ project: 'tests/library/fixtures/live-tv-configuration/Oracle.csproj',
      output: path.join(root, 'xml-consumer'), args: [consumerInput, '{output}/native.json'] });
    const consumed = JSON.parse(await readFile(path.join(root, 'xml-consumer/native.json'), 'utf8'));
    assert.ok(recording.passed && consumed.actualXmlSerializer && consumed.actualConfigurationHelper && consumed.privateInputsRemoved);
    assert.equal(consumed.inputSha256, sha(await readFile(consumerInput)));
    assert.equal(consumed.results.length, consumers.length);
    report.xmlConsumer = { ...consumed, source: 'actual MyXmlSerializer and ConfigurationHelper reading exact saved bytes' };
    for (const saved of consumedPairs) {
      const node = consumed.results.find(value => value.name === saved.node), reference = consumed.results.find(value => value.name === saved.native);
      assert.ok(node.accepted && reference.accepted, saved.name);
      collect(saved.name + ' native XML consumer', () => assert.deepEqual(node.value, reference.value));
    }
    report.afterColdRestart = await snapshot();
    assert.deepEqual(report.afterColdRestart, baseline, 'Cold startup and readers must preserve saved media/user/configuration state.');
    baseline = report.afterColdRestart;
    assert.deepEqual(report.differences, []);
  } catch (error) { failure = error; report.failure = { name: error.name, message: error.message, stack: error.stack }; }
  finally {
    if (native) try {
      report.nativeProcess = await native.stop(async () => (await request(origin, '/System/Shutdown', { token: current.accessToken, method: 'POST' })).status,
        () => portAvailable(port));
      assert.equal(report.nativeProcess.cleanShutdown && report.nativeProcess.pidGone && report.nativeProcess.portAvailable, true);
      report.nativeAfterShutdown = { database: nativeSnapshot(), file: await fileSnapshot('native') };
      if (baseline) assert.deepEqual(report.nativeAfterShutdown, { database: baseline.native, file: baseline.files.native });
    } catch (error) { failure ??= error; report.nativeShutdownFailure = error.message; }
    if (current) try { await current.finish(); } catch (error) { failure ??= error; report.inputVerificationFailure = error.message; }
    if (fixture) try { await fixture.close(); report.cleanup.push({ name: 'production-entry-postgres-and-private-instance', closed: true }); }
    catch (error) { failure ??= error; report.cleanup.push({ name: 'production-entry-postgres-and-private-instance', closed: false, error: error.message }); }
    report.nodeShutdownStates = nodeShutdownStates;
    if (baseline && nodeShutdownStates.length) try {
      assert.deepEqual(nodeShutdownStates.at(-1), { database: baseline.node, file: baseline.files.node });
    } catch (error) { failure ??= error; report.nodeShutdownFailure = error.message; }
    report.passed = !failure; report.phaseAcceptance = false; report.releaseAcceptance = false;
    report.httpCases = report.cases.length;
    await writeFile(path.join(root, 'report.json'), filterEvidenceJson(report)); await output.publishAndClose();
  }
  if (failure) throw output.publicError(failure);
});
