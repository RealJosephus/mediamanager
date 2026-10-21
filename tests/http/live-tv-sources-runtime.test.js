import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRuntime } from '../../src/runtime.js';
import { refreshGuideTaskId } from '../../src/tasks/refresh-guide-task.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { nativeTextBytes } from '../../src/database/native-text.js';
import { internalImagePath } from '../../src/metadata/image-paths.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import liveTvModel from '../../src/core/resources/live-tv-configuration-model.json' with { type: 'json' };
import { dateTicks, idKey } from '../../src/library/records.js';

export const requiredValidationServices = ['postgres'];
const stamp = date => date.toISOString().replace(/[-:TZ]/gu, '').slice(0, 14) + ' +0000';
async function within(promise, description) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out waiting for ' + description + '.')), 30000);
    })]);
  } finally { clearTimeout(timer); }
}

test('production source routes queue the real guide task through official mapped M3U and XMLTV providers and persist readable programs', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 180000,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mm-live-tv-runtime-'));
  const output = path.join(validationOutputRoot(), 'live-tv-runtime-routes-' + randomUUID()); await fs.mkdir(output);
  const errors = [], executions = [];
  let runtime, database;
  try {
    const programDataPath = path.join(root, 'data'), cachePath = path.join(programDataPath, 'cache');
    await fs.mkdir(cachePath, { recursive: true });
    const countries = Buffer.from('{"Controlled":[{"fullName":"Country byte control","shortName":"CC"}]}\n');
    await fs.writeFile(path.join(cachePath, 'sd-countries.json'), countries);
    const playlist = path.join(programDataPath, 'source.m3u'), xml = path.join(programDataPath, 'guide.xml');
    await fs.writeFile(playlist, '#EXTM3U\n#EXTINF:-1 tvg-id="c1" tvg-chno="1",Controlled channel\nhttp://127.0.0.1:1/original.ts\n');
    const start = new Date(Date.now() - 1800000), end = new Date(Date.now() + 1800000);
    start.setUTCMilliseconds(0); end.setUTCMilliseconds(0);
    await fs.writeFile(xml, '<tv><channel id="c1"><display-name>Controlled channel</display-name></channel>'
      + '<programme channel="c1" start="' + stamp(start) + '" stop="' + stamp(end) + '">'
      + '<title>Controlled programme</title><category>kids</category></programme></tv>');
    database = await createPostgresTestDatabase(null, 'live_tv_runtime');
    runtime = await createRuntime({ database, programDataPath, configuration: { IsStartupWizardCompleted: true },
      serverId: 'live-tv-runtime', onError: error => errors.push(error) });
    runtime.tasks.on('completed', event => { if (event.Task.Key === 'RefreshGuide') executions.push(event.Result); });
    assert.ok(runtime.liveTvSources && runtime.liveTvTuners && runtime.liveTvGuide && runtime.liveTvGuideImages && runtime.liveTvCountries);
    const admin = await runtime.users.createUser({ Name: 'Guide administrator', Password: 'controlled' });
    await runtime.users.updatePolicy(admin.Id, { ...(await runtime.users.getUser(admin.Id)).Policy, IsAdministrator: true });
    const reader = await runtime.users.createUser({ Name: 'Guide reader', Password: 'controlled' });
    const login = user => runtime.authentication.login({ Username: user.Name, Pw: 'controlled' }, {
      Client: 'LiveTvRuntime', Device: 'Controlled', DeviceId: user.Id, Version: '1' }, { remoteEndPoint: '127.0.0.1' });
    const adminLogin = await login(admin), readerLogin = await login(reader);
    await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + runtime.server.address().port;
    const request = (route, { user = adminLogin, method = 'GET', body } = {}) => fetch(origin + route, {
      method, headers: { Authorization: 'MediaBrowser Token="' + user.AccessToken + '"', ...(body && { 'Content-Type': 'application/json' }) },
      ...(body && { body: JSON.stringify(body) }) });
    const hidden = await (await request('/ScheduledTasks?isHidden=true')).json();
    assert.ok(hidden.some(task => task.Id === refreshGuideTaskId));
    assert.equal((await request('/LiveTv/TunerHosts', { user: readerLogin, method: 'POST', body: { Type: 'm3u', Url: playlist } })).status, 403);
    assert.equal((await request('/LiveTv/ListingProviders/SchedulesDirect/Countries', { user: readerLogin })).status, 403);
    const countryResponse = await request('/LiveTv/ListingProviders/SchedulesDirect/Countries');
    assert.equal(countryResponse.status, 200); assert.equal(countryResponse.headers.get('content-type'), 'application/json');
    assert.deepEqual(Buffer.from(await countryResponse.arrayBuffer()), countries);
    const listings = await request('/LiveTv/ListingProviders?validateListings=true', { method: 'POST', body: { Type: 'xmltv', Path: xml } });
    assert.equal(listings.status, 200); const listing = await listings.json(); assert.match(listing.Id, /^[0-9a-f]{32}$/u);
    const tunerResponse = await request('/LiveTv/TunerHosts', { method: 'POST', body: { Type: 'm3u', Url: playlist } });
    assert.equal(tunerResponse.status, 200); const tuner = await tunerResponse.json(); assert.match(tuner.Id, /^[0-9a-f]{32}$/u);
    const deadline = Date.now() + 60000;
    let channels, programs, task;
    do {
      task = await runtime.tasks.get(refreshGuideTaskId);
      const response = await request('/LiveTv/Channels?enableImages=false', { user: readerLogin });
      assert.equal(response.status, 200); channels = await response.json();
      if (channels.Items.length === 1) {
        const programmeResponse = await request('/LiveTv/Programs?channelIds=' + channels.Items[0].Id + '&enableImages=false', { user: readerLogin });
        assert.equal(programmeResponse.status, 200); programs = await programmeResponse.json();
      }
      if (task.State === 'Idle' && task.LastExecutionResult?.Status === 'Completed' && programs?.Items.length === 1) break;
      assert.ok(Date.now() < deadline, 'The actual queued guide task must complete and publish the mapped programme.');
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (true);
    assert.equal(task.IsHidden, false); assert.equal(channels.Items[0].Name, 'Controlled channel');
    assert.equal(programs.Items[0].Name, 'Controlled programme');
    const persisted = await runtime.library.itemCreation.getItemById(programs.Items[0].Id);
    assert.equal(dateTicks(persisted.StartDate), dateTicks(start.toISOString())); assert.equal(dateTicks(persisted.EndDate), dateTicks(end.toISOString()));
    assert.equal(idKey(persisted.ChannelId), idKey(channels.Items[0].Id)); assert.ok(persisted.Tags.includes('Kids'));
    const playbackResponse = await request('/Items/' + channels.Items[0].Id + '/PlaybackInfo', { user: readerLogin });
    assert.equal(playbackResponse.status, 200); const playbackInfo = await playbackResponse.json();
    assert.match(playbackInfo.PlaySessionId, /^[0-9a-f]{32}$/u); assert.equal(playbackInfo.MediaSources.length, 1);
    const source = playbackInfo.MediaSources[0];
    assert.equal(source.Type, 'Default'); assert.equal(source.Path, 'http://127.0.0.1:1/original.ts');
    assert.equal(source.BufferMs, 1500); assert.equal(source.IsInfiniteStream, true); assert.equal(source.RequiresOpening, true);
    assert.deepEqual(source.MediaStreams.map(stream => stream.Type), ['Video', 'Audio']);
    assert.ok(source.MediaStreams.every(stream => stream.Index === -1));
    assert.match(source.OpenToken, new RegExp('^[0-9a-f]{32}_LiveTvChannel_' + channels.Items[0].Id + '_' + source.Id + '$', 'u'));
    const selectedResponse = await request('/Items/' + channels.Items[0].Id + '/PlaybackInfo', {
      user: readerLogin, method: 'POST', body: { MediaSourceId: source.Id.toUpperCase() } });
    assert.equal(selectedResponse.status, 200); const selectedInfo = await selectedResponse.json();
    assert.deepEqual(selectedInfo.MediaSources, playbackInfo.MediaSources); assert.notEqual(selectedInfo.PlaySessionId, playbackInfo.PlaySessionId);
    const savedXml = await fs.readFile(path.join(root, 'config', 'livetv.xml'), 'utf8');
    assert.ok(savedXml.includes(tuner.Id) && savedXml.includes(listing.Id));
    // Actual DefaultLiveTvService.GetChannelsAsync and ListingsManager metadata
    // catches log the owned cancellation while a newer source save supersedes
    // an earlier Guide. Keep those diagnostics with the real Cancelled result.
    for (const error of errors) {
      assert.equal(error.code, 'cancelled'); assert.equal(error.status, 499); assert.equal(error.statusCode, 499);
      assert.equal(error.message, 'The RefreshGuide task was superseded.');
      assert.match(error.stack, /[/\\]src[/\\]tasks[/\\]refresh-library-task\.js/u);
      assert.ok(executions.some(result => result.Status === 'Cancelled'));
    }
    await runtime.close(); runtime = undefined;
    assert.deepEqual(await fs.readFile(path.join(cachePath, 'sd-countries.json')), countries);
    assert.ok((await fs.readFile(playlist, 'utf8')).includes('original.ts'));
  } finally {
    try { await runtime?.close(); }
    finally {
      await fs.writeFile(path.join(output, 'diagnostics.json'), JSON.stringify({ executions,
        diagnostics: errors.map(error => ({ name: error.name, code: error.code, status: error.status, statusCode: error.statusCode,
          message: error.message, stack: error.stack })), phaseAcceptance: false, releaseAcceptance: false }, null, 2) + '\n');
      await dropPostgresTestDatabase(database);
      assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('mm-live-tv-runtime-'));
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test('runtime shutdown after a real guide program COMMIT drains its subsequent independent image download and repository save', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 180000,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mm-live-tv-runtime-'));
  const committed = Promise.withResolvers(), releaseCommit = Promise.withResolvers();
  const imageEntered = Promise.withResolvers(), releaseImage = Promise.withResolvers();
  const png = await fs.readFile(new URL('../images/fixtures/http/poster.png', import.meta.url));
  const output = path.join(validationOutputRoot(), 'live-tv-runtime-close-' + randomUUID()); await fs.mkdir(output);
  const report = { events: [], phaseAcceptance: false, releaseAcceptance: false };
  const mark = async phase => {
    report.events.push({ phase, at: new Date().toISOString() });
    await fs.writeFile(path.join(output, 'progress.json'), JSON.stringify(report, null, 2) + '\n');
  };
  const requests = [], errors = [];
  const imageServer = createServer(async (request, response) => {
    requests.push(request.url); await mark('image-http-admitted'); imageEntered.resolve(); await releaseImage.promise;
    response.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length }); response.end(png);
  });
  let runtime, database, running, closing;
  try {
    await new Promise(resolve => imageServer.listen(0, '127.0.0.1', resolve));
    const programDataPath = path.join(root, 'data'), playlist = path.join(programDataPath, 'source.m3u'), xml = path.join(programDataPath, 'guide.xml');
    await fs.mkdir(programDataPath);
    await fs.writeFile(playlist, '#EXTM3U\n#EXTINF:-1 tvg-id="c1",Closing channel\nhttp://127.0.0.1:1/original.ts\n');
    await fs.writeFile(xml, '<tv><channel id="c1"><display-name>Closing channel</display-name></channel><programme channel="c1" start="'
      + stamp(new Date(Date.now() - 1800000)) + '" stop="' + stamp(new Date(Date.now() + 1800000)) + '">'
      + '<title>Closing programme</title><icon src="http://127.0.0.1:' + imageServer.address().port + '/guide-image.png"/></programme></tv>');
    database = await createPostgresTestDatabase(null, 'live_tv_runtime_close');
    runtime = await createRuntime({ database, programDataPath, configuration: { IsStartupWizardCompleted: true },
      serverId: 'live-tv-runtime-close', onError: error => errors.push(error) });
    const configuration = await runtime.liveTv.getConfiguration();
    configuration.TunerHosts = [{ ...structuredClone(liveTvModel.definitions.TunerHostInfo.defaults),
      Id: 'a9810000000000000000000000000001', Type: 'm3u', Url: playlist, AllowStreamSharing: true }];
    configuration.ListingProviders = [{ ...structuredClone(liveTvModel.definitions.ListingsProviderInfo.defaults),
      Id: 'a9810000000000000000000000000002', Type: 'xmltv', Path: xml, EnableAllTuners: true }];
    await runtime.liveTv.saveConfiguration(configuration);
    const programType = 'MediaBrowser.Controller.LiveTv.LiveTvProgram', encodedType = nativeTextBytes(programType);
    const programTransactions = new WeakSet(); let held = false;
    database.queryHook = async (...args) => {
      const sql = typeof args[0] === 'string' ? args[0] : args[0].text;
      const values = typeof args[0] === 'string' ? args[1] : args[0].values;
      const owner = database.operationContext.getStore()?.client;
      const result = await database.client.query(...args);
      if (/^INSERT INTO (?:"[^"]+"\.)?"BaseItems"/u.test(sql) && values?.some(value => Buffer.isBuffer(value) && value.equals(encodedType))) {
        assert.ok(owner, 'The real program write belongs to an operation connection.'); programTransactions.add(owner);
      }
      if (sql === 'COMMIT' && owner && programTransactions.has(owner) && !held) {
        held = true; await mark('program-physically-committed'); committed.resolve(); await releaseCommit.promise;
      }
      return result;
    };
    await mark('starting-guide-task'); running = runtime.tasks.execute(refreshGuideTaskId);
    await within(Promise.race([committed.promise, running.then(result => { throw new Error('The guide task ended before its program COMMIT: ' + JSON.stringify(result)); })]), 'the real program COMMIT');
    // Guide creation also queues a UserView refresh behind this admitted
    // operation. Observe the physical COMMIT on an independent SQL connection;
    // a new DomainStore request would first wait for that background queue.
    const rows = await within(database.withConnection(db => db.rows('BaseItems', { where: { Type: programType }, limit: 2 })), 'committed program visibility');
    await mark('committed-program-readable');
    assert.equal(rows.length, 1); assert.equal(rows[0].Name, 'Closing programme');
    const imagePath = path.join(internalImagePath({ ...rows[0], Type: 'LiveTvProgram' }, path.join(programDataPath, 'metadata')), 'poster.png');
    let drained = false;
    await mark('starting-runtime-close'); closing = runtime.close().then(() => { drained = true; });
    releaseCommit.resolve();
    await within(Promise.race([imageEntered.promise, closing.then(() => { throw new Error('Runtime closed before the admitted guide image phase.'); })]), 'the post-COMMIT image request');
    assert.equal(drained, false); assert.deepEqual(requests, ['/guide-image.png']);
    releaseImage.resolve();
    assert.equal((await running).Status, 'Aborted'); await closing;
    await mark('runtime-closed');
    assert.deepEqual(await fs.readFile(imagePath), png);
    for (const error of errors) {
      assert.equal(error.name, 'AbortError');
      assert.match(error.stack, /MetadataRefreshHost\.cancel \(file:[^\n]+\/src\/metadata\/refresh-host\.js:\d+:\d+\)/u);
      assert.match(error.stack, /at cancelMetadata \(file:[^\n]+\/src\/runtime\.js:\d+:\d+\)/u);
    }
    report.shutdownDiagnostics = errors.map(error => ({ name: error.name, message: error.message, stack: error.stack,
      kind: 'owned-metadata-shutdown-cancellation' }));
    await mark('shutdown-diagnostics-verified');
    assert.equal(database.closed, true); runtime = undefined;
  } catch (error) {
    report.error = { name: error.name, message: error.message, stack: error.stack }; await mark('failed'); throw error;
  } finally {
    releaseCommit.resolve(); releaseImage.resolve();
    await mark('cleanup-gates-released');
    await Promise.allSettled([running, closing]);
    try { await runtime?.close(); }
    finally {
      if (database) database.queryHook = null;
      await dropPostgresTestDatabase(database);
      imageServer.closeAllConnections(); await new Promise(resolve => imageServer.close(resolve));
      assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('mm-live-tv-runtime-'));
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});
