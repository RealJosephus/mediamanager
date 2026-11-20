import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { readInstanceConfiguration } from '../../src/configuration.js';
import { readXml, textOf } from '../../src/core/xml.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { dateTicks } from '../../src/library/records.js';
import { captureMediaProcess } from '../../src/media-execution/process.js';
import { recordTransportStream } from '../../src/media-execution/recording.js';
import { transferDatabase } from '../../src/migration/database-transfer.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput } from '../../tools/compat/filter-reference-output.js';
import { validationExecutable, validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { readFrozenAv } from '../helpers/frozen-av.js';
import { declareNativeHttpTestFile } from '../helpers/native-http-test-file.js';
import { writeLocalFixtureStorage } from '../helpers/local-state-storage.js';
import { createTestRuntime } from '../helpers/runtime.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES);
const nativeCase = declareNativeHttpTestFile({ enabled });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const describe = bytes => ({ length: bytes.length, sha256: digest(bytes) });
const pause = () => delay(150);
async function until(read, matches, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (true) {
    const value = await read();
    if (matches(value)) return value;
    assert.ok(Date.now() < deadline, label);
    await pause();
  }
}

test('M3U EVENT playback, recordings, retries and XMLTV series schedules match Native', {
  skip: !enabled, timeout: 420000,
}, nativeCase(async (t, port) => {
  const publication = await createPrivateFilterOutput(path.join(validationOutputRoot(), 'live-dvr-' + randomUUID()));
  const root = publication.root, referenceRoot = path.join(root, 'reference'), nativeOrigin = 'http://127.0.0.1:' + port;
  const report = { native: {}, node: {}, source: {}, remuxRequests: { native: 0, node: 0 } }, upstream = [];
  let native, runtime, database, source, authorization, failure;
  let holding = false, livePlayback = false, engine = 'native';
  const requestAt = origin => async (route, { method = 'GET', body, status = 200 } = {}) => {
    const response = await fetch(origin + route, { method, signal: t.signal, headers: {
      Authorization: authorization, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    assert.equal(response.status, status, `${engine} ${method} ${route} ${text}`);
    return text && response.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(text) : text;
  };
  const stopNative = async () => {
    if (!native) return;
    const instance = native; native = undefined;
    const outcome = await instance.stop(async () => {
      const response = await fetch(nativeOrigin + '/System/Shutdown', { method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { Authorization: authorization, Connection: 'close' } });
      await response.arrayBuffer(); return response.status;
    }, () => new Promise(resolve => {
      const server = createServer(); server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(error => resolve(!error)));
    }));
    (report.shutdowns ??= []).push(outcome); assert.ok(outcome.cleanShutdown && outcome.pidGone && outcome.portAvailable);
  };
  const startNative = async label => {
    native = current.start({ referenceRoot, outputRoot: root, label, origin: nativeOrigin });
    await native.ready();
  };
  let current;
  try {
    await mkdir(root);
    current = await currentNativeReference();
    publication.addSecret(root);
    publication.addSecret(current.accessToken); publication.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
    authorization = `MediaBrowser Client="DVR fixture", Device="Isolated", DeviceId="fixture-dvr", Version="1", Token="${current.accessToken}"`;
    report.reference = current.preparation;
    report.bindings = await current.sourceBindings(['src/Jellyfin.LiveTv/Recordings/RecordingsManager.cs',
      'src/Jellyfin.LiveTv/Timers/TimerManager.cs', 'src/Jellyfin.LiveTv/IO/DirectRecorder.cs',
      'MediaBrowser.Controller/Streaming/ProgressiveFileStream.cs']);
    await cp(current.sourceRoot, referenceRoot, { recursive: true }); await current.prepareClone(referenceRoot, port);
    const fixture = await readFrozenAv('dual-avc.m2ts', { signal: t.signal });
    const input = path.join(root, 'source.m2ts'); await writeFile(input, fixture.bytes);
    const remux = async (format, repeated = []) => {
      const { exitCode, stdout } = await captureMediaProcess(validationExecutable('ffmpeg'), ['-nostdin', '-hide_banner', '-loglevel', 'error', ...repeated, '-i', input,
        '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-f', format, 'pipe:1'],
      { signal: t.signal, timeoutMs: 20000, maxOutputBytes: 16 * 1024 * 1024 });
      assert.equal(exitCode, 0);
      return stdout;
    };
    const [bytes, matroska, liveTransport] = await Promise.all([remux('mpegts'), remux('matroska'), remux('mpegts', ['-stream_loop', '8'])]);
    assert.ok(bytes.length >= 20000 && bytes.length % 188 === 0 && bytes[0] === 0x47);
    report.source = { media: fixture.source, transport: describe(bytes), matroska: describe(matroska) };
    const postProcessor = path.join(root, 'recording processor.mjs');
    await writeFile(postProcessor, `import { readFile, writeFile } from 'node:fs/promises';
const recording = process.argv[2];
await writeFile(recording + '.processed', String((await readFile(recording)).length));\n`);
    const baseTime = Math.floor(Date.now() / 1000) * 1000;
    const xmlDate = value => new Date(value).toISOString().replaceAll(/[-:T]/gu, '').slice(0, 14) + ' +0000';
    const entries = [false, true].map((repeat, index) => {
      const start = baseTime + (index + 2) * 86400000 + 7200000;
      return `<programme start="${xmlDate(start)}" stop="${xmlDate(start + 3600000)}" channel="dvr-fixture">`
        + `<title>DVR fixture series</title><sub-title>Episode ${index + 1}</sub-title><episode-num system="xmltv_ns">0.${index}.0</episode-num>`
        + (repeat ? '<previously-shown />' : '<new />') + '</programme>';
    });
    const retentionName = 'DVR retention series';
    for (let index = 0; index < 3; index++) {
      const offset = index * 600000;
      entries.push(`<programme start="${xmlDate(baseTime - 3600000 + offset)}" stop="${xmlDate(baseTime + 3600000 + offset)}" channel="dvr-fixture">`
        + `<title>${retentionName}</title><sub-title>Episode ${index + 1}</sub-title><episode-num system="xmltv_ns">0.${index}.0</episode-num>`
        + '<new /></programme>');
    }
    const guide = '<?xml version="1.0" encoding="UTF-8"?><tv><channel id="dvr-fixture"><display-name>DVR fixture channel</display-name></channel>'
      + entries.join('') + '</tv>';
    let sourceOrigin;
    source = createServer((request, response) => {
      if (request.url === '/tuner.m3u') {
        response.setHeader('Content-Type', 'application/x-mpegURL');
        response.end('#EXTM3U\n#EXTINF:-1 tvg-id="dvr-fixture" tvg-chno="7",DVR fixture channel\n' + sourceOrigin + '/program.ts\n'
          + '#EXTINF:-1 tvg-id="dvr-remux" tvg-chno="8",DVR remux channel\n' + sourceOrigin + '/program.mkv\n');
        return;
      }
      if (request.url === '/tuner.xml') {
        response.setHeader('Content-Type', 'application/xml'); response.end(guide); return;
      }
      if (request.url === '/program.mkv') {
        report.remuxRequests[engine]++;
        response.setHeader('Content-Type', 'video/x-matroska'); response.end(matroska); return;
      }
      if (request.url !== '/program.ts') { response.writeHead(404).end(); return; }
      const observation = { engine, holding, livePlayback, closed: false };
      let timer;
      upstream.push(observation); response.once('close', () => { observation.closed = true; clearInterval(timer); });
      response.setHeader('Content-Type', 'video/mp2t');
      if (livePlayback) {
        let offset = 0;
        timer = setInterval(() => {
          const end = Math.min(offset + 188 * 96, liveTransport.length);
          response.write(liveTransport.subarray(offset, end)); offset = end;
          if (offset === liveTransport.length) clearInterval(timer);
        }, 80);
      } else if (holding) response.write(bytes);
      else response.end(bytes);
    });
    await new Promise((resolve, reject) => source.once('error', reject).listen(0, '127.0.0.1', resolve));
    sourceOrigin = 'http://127.0.0.1:' + source.address().port;
    const buffered = [];
    let recordingPublished = false;
    await recordTransportStream({ ready: true, encoderPath: validationExecutable('ffmpeg'), getEncodingOptions: () => ({ EncodingThreadCount: 0 }) },
      {}, sourceOrigin + '/program.mkv', bytes => {
        assert.equal(recordingPublished, true);
        buffered.push(bytes);
      }, async () => {
        // The entire short input can finish while the timer update is pending.
        await delay(1000, undefined, { signal: t.signal });
        recordingPublished = true;
      }, { signal: t.signal });
    const bufferedTransport = Buffer.concat(buffered);
    assert.ok(bufferedTransport.length > 20000 && bufferedTransport.length % 188 === 0 && bufferedTransport[0] === 0x47);
    report.outputWhilePublishing = describe(bufferedTransport);
    await writeFile(path.join(referenceRoot, 'config/livetv.xml'), '<LiveTvOptions><TunerHosts /><ListingProviders /></LiveTvOptions>');
    await startNative('native-prepare');
    const nativeRequest = requestAt(nativeOrigin);
    for (const task of await nativeRequest('/ScheduledTasks')) {
      await nativeRequest('/ScheduledTasks/' + task.Id + '/Triggers', { method: 'POST', body: [], status: 204 });
    }
    await nativeRequest('/LiveTv/TunerHosts', { method: 'POST', body: { Type: 'm3u', Url: sourceOrigin + '/tuner.m3u',
      AllowStreamSharing: false, TunerCount: 2, EnableStreamLooping: false } });
    await nativeRequest('/LiveTv/ListingProviders', { method: 'POST', body: { Type: 'xmltv', Path: sourceOrigin + '/tuner.xml', EnableAllTuners: true } });
    const channels = await until(() => nativeRequest('/LiveTv/Channels?enableImages=false').then(value => value.Items),
      channels => channels.length === 2, 'The official M3U tuner must provide both live guide channels.');
    const channelId = channels.find(value => value.Name === 'DVR fixture channel').Id;
    const remuxChannelId = channels.find(value => value.Name === 'DVR remux channel').Id;
    const programRoute = '/LiveTv/Programs?channelIds=' + channelId + '&enableImages=false&enableUserData=false';
    const programs = await until(() => nativeRequest(programRoute).then(value => value.Items),
      values => values.filter(value => value.Name === 'DVR fixture series').length === 2
        && values.filter(value => value.Name === retentionName).length === 3, 'The official XMLTV guide must provide all five episodes.');
    const byStart = (a, b) => Date.parse(a.StartDate) - Date.parse(b.StartDate);
    const futureEpisodes = programs.filter(value => value.Name === 'DVR fixture series').sort(byStart);
    const retentionEpisodes = programs.filter(value => value.Name === retentionName).sort(byStart);
    const [episode] = futureEpisodes;
    await stopNative();
    const configuration = await readInstanceConfiguration(referenceRoot);
    database = await createPostgresTestDatabase(null, 'live_dvr');
    const sqlite = new SqliteDatabase(path.join(configuration.dataPath, 'jellyfin.db'), { readOnly: true, requireMigrationHistory: true });
    try { await transferDatabase(sqlite, database); } finally { sqlite.close(); }
    const start = new Date(baseTime - 60000), finish = new Date(+start + 300000);
    const future = new Date(+start + 86400000);
    const timersPath = path.join(configuration.dataPath, 'livetv', 'timers.json');
    const readRows = async () => {
      const deadline = Date.now() + 2000;
      while (true) {
        try { return JSON.parse(await readFile(timersPath, 'utf8')); }
        catch (error) {
          if (error.code === 'ENOENT') return [];
          // Native replaces the file contents in place while recordings change state.
          if (engine !== 'native' || !(error instanceof SyntaxError) || Date.now() >= deadline) throw error;
          await delay(30, undefined, { signal: t.signal });
        }
      }
    };
    const run = async (origin, side) => {
      const request = requestAt(origin), expected = report[side];
      const recordings = path.join(configuration.dataPath, side + '-recordings');
      await mkdir(recordings);
      await writeFile(path.join(recordings, '.ignore'), 'fixture-unrelated-folder/\n');
      const liveTv = await request('/System/Configuration/livetv');
      const [tuner] = liveTv.TunerHosts;
      await request('/LiveTv/TunerHosts', { method: 'POST', body: { ...tuner, AllowStreamSharing: false } });
      liveTv.TunerHosts = [{ ...tuner, AllowStreamSharing: false }];
      await request('/System/Configuration/livetv', { method: 'POST', body: { ...liveTv, RecordingPath: recordings,
        MediaLocationsCreated: [], EnableRecordingSubfolders: true, RecordingPostProcessor: process.execPath,
        RecordingPostProcessorArguments: `"${postProcessor}" "{PATH}"` }, status: 204 });
      const openToken = (await request('/Items/' + channelId + '/PlaybackInfo')).MediaSources[0].OpenToken;
      const inputSource = (await request('/LiveStreams/Open', { method: 'POST', body: { ItemId: channelId, OpenToken: openToken } })).MediaSource;
      expected.input = { container: inputSource.Container, codecs: inputSource.MediaStreams.map(value => value.Codec) };
      assert.equal(inputSource.Container, 'ts');
      await request('/LiveStreams/Close?liveStreamId=' + encodeURIComponent(inputSource.LiveStreamId), { method: 'POST', status: 204 });
      await request('/LiveTv/TunerHosts', { method: 'POST', body: { ...tuner, AllowStreamSharing: true } });
      const seed = { ChannelId: channelId, ServiceName: 'Emby', StartDate: future.toISOString(),
        EndDate: new Date(+future + 300000).toISOString(), Name: 'Scheduled DVR fixture', Priority: 20 };
      const lookup = name => request('/LiveTv/Timers').then(value => value.Items.find(item => item.Name === name));
      const post = (route, body) => request(route, { method: 'POST', body, status: 204 });
      await post('/LiveTv/Timers', seed);
      const pending = await lookup(seed.Name);
      assert.ok(pending);
      assert.match(pending.ExternalId, /^[a-f0-9]{32}$/u);
      await post('/LiveTv/Timers/' + pending.Id, { ...pending, Name: 'Ignored update name', PrePaddingSeconds: 3,
        PostPaddingSeconds: 7, IsPrePaddingRequired: true });
      const updated = await lookup(seed.Name);
      expected.scheduled = { Name: updated.Name, Status: updated.Status, ChannelId: updated.ChannelId, Priority: updated.Priority,
        PrePaddingSeconds: updated.PrePaddingSeconds, PostPaddingSeconds: updated.PostPaddingSeconds, IsPrePaddingRequired: updated.IsPrePaddingRequired,
        Start: String(dateTicks(updated.StartDate)), End: String(dateTicks(updated.EndDate)) };
      await request('/LiveTv/Timers/' + pending.Id, { method: 'DELETE', status: 204 });
      assert.equal(await lookup(seed.Name), undefined);
      holding = true;
      const live = { ...seed, Name: 'Active DVR fixture', StartDate: start.toISOString(), EndDate: finish.toISOString() };
      await post('/LiveTv/Timers', live);
      const timer = await until(() => lookup(live.Name), value => value?.Status === 'InProgress', side + ' must begin actual recording.');
      await post('/LiveTv/Timers/' + timer.Id, { ...timer, PostPaddingSeconds: 33 });
      assert.equal((await lookup(live.Name)).PostPaddingSeconds, 0, 'Active recording padding remains fixed.');
      const stream = await fetch(origin + '/LiveTv/LiveRecordings/' + timer.ExternalId + '/stream', {
        signal: AbortSignal.any([t.signal, AbortSignal.timeout(25000)]),
      });
      assert.equal(stream.status, 200);
      assert.equal(stream.headers.get('content-type'), 'video/mp2t');
      assert.equal(stream.headers.get('content-length'), null);
      const reader = stream.body.getReader(), chunks = [];
      let length = 0;
      try {
        while (length < bytes.length) {
          const value = await reader.read();
          assert.equal(value.done, false, side + ' must supply the growing recording.');
          chunks.push(Buffer.from(value.value)); length += value.value.length;
        }
        expected.active = describe(Buffer.concat(chunks));
        assert.deepEqual(expected.active, describe(bytes));
        assert.equal(upstream.some(value => value.engine === side && value.holding && !value.closed), true);
        await request('/LiveTv/Timers/' + timer.Id, { method: 'DELETE', status: 204 });
      } finally { await reader.cancel(); }
      const completed = await until(() => readRows().then(values => values.find(value => value.Id === timer.ExternalId)),
        value => value?.Status === 'Completed', side + ' must finalize a nonempty cancelled recording.');
      expected.completed = { status: completed.Status, manual: completed.IsManual, name: completed.Name,
        channel: completed.ChannelId, filename: path.relative(recordings, completed.RecordingPath).split(path.sep).join('/'),
        bytes: describe(await readFile(completed.RecordingPath)) };
      assert.deepEqual(expected.completed.bytes, describe(bytes));
      const processed = async filename => until(async () => {
        try { return await readFile(filename + '.processed', 'utf8'); }
        catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
      }, Boolean, side + ' must run its configured post processor after the media file is finalized.');
      expected.completed.postProcess = Number(await processed(completed.RecordingPath));
      assert.equal(expected.completed.postProcess, bytes.length);
      const nfo = async filename => {
        const content = await readFile(filename.replace(/\.ts$/u, '.nfo'), 'utf8');
        const xml = readXml(content.replace(/^\ufeff/u, ''));
        const added = Date.parse((textOf(xml, 'dateadded') ?? '').replace(' ', 'T') + 'Z');
        assert.ok(added >= baseTime && added <= Date.now());
        return { type: xml.name, values: xml.children.filter(value => value.name !== 'dateadded').map(value => [value.name, value.text]) };
      };
      expected.completed.nfo = await nfo(completed.RecordingPath);
      await request('/LiveTv/LiveRecordings/' + timer.ExternalId + '/stream', { status: 404 });
      assert.equal(await lookup(live.Name), undefined);
      await until(() => upstream.filter(value => value.engine === side && value.holding), values => values.length && values.every(value => value.closed),
        side + ' must release the tuner upstream.');
      holding = false;

      livePlayback = true;
      const profile = { Name: 'Controlled event playback', DirectPlayProfiles: [], ContainerProfiles: [], CodecProfiles: [], SubtitleProfiles: [],
        TranscodingProfiles: [{ Type: 'Video', Context: 'Streaming', Protocol: 'hls', Container: 'ts',
          VideoCodec: 'h264', AudioCodec: 'aac', MinSegments: 2, SegmentLength: 2 }] };
      const playback = await request('/Items/' + channelId + '/PlaybackInfo', { method: 'POST', body: {
        DeviceProfile: profile, AutoOpenLiveStream: true, EnableDirectPlay: false, EnableDirectStream: false,
        EnableTranscoding: true, MaxStreamingBitrate: 8000000,
      } });
      const [liveSource] = playback.MediaSources;
      assert.ok(liveSource.LiveStreamId && liveSource.SupportsTranscoding && liveSource.TranscodingUrl, side + ' must negotiate an open HLS source.');
      const master = await request(liveSource.TranscodingUrl);
      const lines = value => value.split(/\r?\n/u).filter(line => line && !line.startsWith('#'));
      const relative = value => value.pathname + value.search;
      const playlistUri = new URL(lines(master)[0], new URL(liveSource.TranscodingUrl, origin));
      assert.match(playlistUri.pathname, /\/live\.m3u8$/iu);
      const event = await request(relative(playlistUri));
      assert.match(event, /#EXT-X-PLAYLIST-TYPE:EVENT/u);
      assert.doesNotMatch(event, /#EXT-X-ENDLIST/u);
      assert.ok(lines(event).length >= 2);
      const observation = upstream.find(value => value.engine === side && value.livePlayback);
      assert.ok(observation && !observation.closed, 'HLS segments are ready while the real tuner is still publishing.');
      const segment = new URL(lines(event)[0], playlistUri);
      const delivered = await fetch(segment, { headers: { Authorization: authorization }, signal: t.signal });
      assert.equal(delivered.status, 200);
      assert.equal(delivered.headers.get('content-type'), 'video/mp2t');
      const segmentBytes = Buffer.from(await delivered.arrayBuffer());
      assert.ok(segmentBytes.length >= 188 && segmentBytes[0] === 0x47);
      expected.live = { segment: describe(segmentBytes), targetDuration: event.match(/#EXT-X-TARGETDURATION:\d+/u)?.[0] };
      const shared = (await request('/LiveStreams/Open', { method: 'POST', body: { ItemId: channelId, OpenToken: openToken } })).MediaSource;
      assert.equal(shared.LiveStreamId, liveSource.LiveStreamId);
      assert.equal(shared.Path, liveSource.Path);
      await request('/Videos/ActiveEncodings?' + new URLSearchParams({ deviceId: 'fixture-dvr', playSessionId: playback.PlaySessionId }),
        { method: 'DELETE', status: 204 });
      assert.equal(observation.closed, false, side + ' must retain the independent viewer while stopping HLS.');
      await request('/LiveStreams/Close?liveStreamId=' + encodeURIComponent(shared.LiveStreamId), { method: 'POST', status: 204 });
      await request('/LiveStreams/Close?liveStreamId=' + encodeURIComponent(shared.LiveStreamId), { method: 'POST', status: 204 });
      await until(() => observation.closed, Boolean, side + ' must release the shared event input.');
      livePlayback = false;

      await request('/LiveTv/TunerHosts', { method: 'POST', body: { ...tuner, AllowStreamSharing: false } });
      const token = (await request('/Items/' + remuxChannelId + '/PlaybackInfo')).MediaSources[0].OpenToken;
      const remuxSource = (await request('/LiveStreams/Open', { method: 'POST',
        body: { ItemId: remuxChannelId, OpenToken: token } })).MediaSource;
      assert.ok(remuxSource.Container && !/ts$/iu.test(remuxSource.Container), 'The Matroska source must select the FFmpeg recording path.');
      await request('/LiveStreams/Close?liveStreamId=' + encodeURIComponent(remuxSource.LiveStreamId), { method: 'POST', status: 204 });
      const encoded = { ...live, Name: 'Remux DVR fixture', ChannelId: remuxChannelId };
      await post('/LiveTv/Timers', encoded);
      const remuxRow = await until(async () => {
        const row = (await readRows()).find(value => value.Name === encoded.Name);
        (report.remuxProgress ??= {})[side] = row && { status: row.Status, retries: row.RetryCount };
        return row;
      },
        value => value?.Status === 'Completed', side + ' must remux the Matroska recording.');
      const encodedBytes = await readFile(remuxRow.RecordingPath);
      assert.ok(encodedBytes.length > 20000 && encodedBytes.length % 188 === 0 && encodedBytes[0] === 0x47);
      expected.remux = { container: remuxSource.Container, bytes: describe(encodedBytes),
        postProcess: Number(await processed(remuxRow.RecordingPath)), nfo: await nfo(remuxRow.RecordingPath) };
      assert.equal(expected.remux.postProcess, encodedBytes.length);
      const recorded = await until(() => request('/LiveTv/Recordings?fields=Path&enableImages=false&enableUserData=false').then(value => value.Items),
        values => [completed, remuxRow].every(row => values.some(value => value.Path === row.RecordingPath)), side + ' must index both recordings.');
      expected.library = [completed, remuxRow].map(row => {
        const item = recorded.find(value => value.Path === row.RecordingPath);
        return { type: item.Type, name: item.Name, mediaType: item.MediaType };
      });

      const defaults = await request('/LiveTv/Timers/Defaults?programId=' + episode.Id);
      await post('/LiveTv/SeriesTimers', { ...defaults, RecordAnyTime: true, RecordNewOnly: true, SkipEpisodesInLibrary: false });
      const [{ Id: seriesId }] = (await request('/LiveTv/SeriesTimers')).Items;
      const series = await request('/LiveTv/SeriesTimers/' + seriesId);
      assert.equal(series.Name, 'DVR fixture series');
      assert.equal(series.RecordNewOnly, true);
      const occurrences = async () => (await request('/LiveTv/Timers?seriesTimerId=' + seriesId)).Items.map(item => ({
        ProgramId: item.ProgramId, Start: String(dateTicks(item.StartDate)), End: String(dateTicks(item.EndDate)),
        Status: item.Status, PrePaddingSeconds: item.PrePaddingSeconds, ChannelId: item.ChannelId,
      })).sort((a, b) => a.Start.localeCompare(b.Start));
      expected.series = { initial: await occurrences() };
      assert.deepEqual(expected.series.initial.map(value => value.Status), ['New', 'Cancelled']);
      await post('/LiveTv/SeriesTimers/' + seriesId, { ...series, RecordNewOnly: false, KeepUpTo: 2, PrePaddingSeconds: 11 });
      const updatedSeries = await request('/LiveTv/SeriesTimers/' + seriesId);
      assert.equal(updatedSeries.RecordNewOnly, false);
      assert.equal(updatedSeries.KeepUpTo, 2);
      expected.series.updated = await occurrences();
      assert.deepEqual(expected.series.updated.map(value => [value.Status, value.PrePaddingSeconds]), [['New', 11], ['New', 11]]);
      const { Items: scheduled } = await request('/LiveTv/Timers?seriesTimerId=' + seriesId);
      assert.equal(new Set(scheduled.map(value => value.ExternalId)).size, 2);
      await post('/LiveTv/SeriesTimers/' + seriesId, { ...updatedSeries, KeepUpTo: 0 });
      await request('/LiveTv/TunerHosts', { method: 'POST', body: { ...tuner, AllowStreamSharing: true } });
      const readEpisodeTimer = number => readRows().then(values => {
        const rows = values.filter(value => value.Name === retentionName);
        (report.retentionProgress ??= {})[side] = rows.map(row => ({ status: row.Status, number: row.EpisodeNumber,
          series: row.SeriesTimerId === series.ExternalId }));
        return rows.find(value => value.SeriesTimerId === series.ExternalId && value.EpisodeNumber === number);
      });
      const startEpisode = number => post('/LiveTv/Timers', { ...live, ProgramId: retentionEpisodes[number - 1].Id, SeriesTimerId: seriesId });
      const fileSize = async filename => {
        try { return (await stat(filename)).size; }
        catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
      };
      const cancelEpisode = async row => {
        const file = path.join(recordings, 'Series', retentionName, 'Season 1', `${retentionName} S01E0${row.EpisodeNumber} Episode ${row.EpisodeNumber}.ts`);
        await until(() => fileSize(file), size => size >= bytes.length - 4096, side + ' must write the current episode before cancellation.');
        const active = (await request('/LiveTv/Timers?seriesTimerId=' + seriesId)).Items.find(value => value.ExternalId === row.Id);
        assert.ok(active);
        await request('/LiveTv/Timers/' + active.Id, { method: 'DELETE', status: 204 });
      };
      const retained = [];
      for (const number of [1, 2]) {
        holding = true;
        await startEpisode(number);
        const active = await until(() => readEpisodeTimer(number), value => value?.Status === 'InProgress', side + ' must start a previous episode.');
        await cancelEpisode(active);
        holding = false;
        const row = await until(() => readEpisodeTimer(number), value => value?.Status === 'Completed', side + ' must record a previous episode.');
        assert.deepEqual(describe(await readFile(row.RecordingPath)), describe(bytes));
        retained.push(row);
      }
      await until(() => request('/LiveTv/Recordings?fields=Path&enableImages=false').then(value => value.Items),
        values => retained.every(row => values.some(value => value.Path === row.RecordingPath)), side + ' must index the previous episodes.');
      await post('/LiveTv/SeriesTimers/' + seriesId, { ...updatedSeries, KeepUpTo: 2 });
      holding = true;
      await startEpisode(3);
      const third = await until(() => readEpisodeTimer(3), value => value?.Status === 'InProgress', side + ' must record a third episode.');
      await until(async () => !await readEpisodeTimer(1) && !await fileSize(retained[0].RecordingPath),
        Boolean, side + ' must prune the oldest file and completed timer while recording the next episode.');
      assert.equal(await fileSize(retained[1].RecordingPath), bytes.length);
      await cancelEpisode(third);
      holding = false;
      const finalEpisode = await until(() => readEpisodeTimer(3), value => value?.Status === 'Completed', side + ' must retain the final episode.');
      const recordingItems = await until(() => request('/LiveTv/Recordings?fields=Path&enableImages=false').then(value => value.Items),
        values => [retained[1], finalEpisode].every(row => values.some(value => value.Path === row.RecordingPath)),
        side + ' must index both retained episodes.');
      assert.equal(recordingItems.some(value => value.Path === retained[0].RecordingPath), false, side + ' must remove the old library entry.');
      expected.retention = await Promise.all([retained[1], finalEpisode].map(async row => ({ episode: row.EpisodeNumber,
        filename: path.relative(recordings, row.RecordingPath).split(path.sep).join('/'), bytes: describe(await readFile(row.RecordingPath)) })));
      assert.deepEqual(expected.retention.map(value => value.bytes), [describe(bytes), describe(bytes)]);
      await request('/LiveTv/SeriesTimers/' + seriesId, { method: 'DELETE', status: 204 });
      assert.deepEqual((await request('/LiveTv/SeriesTimers')).Items, []);
      assert.deepEqual((await occurrences()).filter(value => futureEpisodes.some(program => program.Id === value.ProgramId)), []);

      await request('/LiveTv/TunerHosts', { method: 'POST', body: { ...tuner, TunerCount: 1, AllowStreamSharing: false } });
      const viewer = (await request('/LiveStreams/Open', { method: 'POST',
        body: { ItemId: remuxChannelId, OpenToken: token } })).MediaSource;
      assert.ok(viewer.LiveStreamId);
      const attempt = Date.now();
      const retry = { ...live, Name: 'Retry DVR fixture', PrePaddingSeconds: 9,
        StartDate: new Date(attempt - 1000).toISOString(), EndDate: new Date(attempt + 80000).toISOString() };
      const readRetry = async () => (await readRows()).find(value => value.Name === retry.Name);
      const originalInputs = upstream.length;
      await post('/LiveTv/Timers', retry);
      const deferred = await until(readRetry, value => value?.RetryCount === 1, side + ' must reschedule after the tuner conflict.');
      const nextStart = Date.parse(deferred.StartDate);
      assert.ok(nextStart >= attempt + 59000 && nextStart <= Date.now() + 61000);
      assert.equal(deferred.Status, 'New');
      assert.equal(deferred.PrePaddingSeconds, 0);
      assert.ok(!deferred.RecordingPath);
      assert.equal(upstream.length, originalInputs, side + ' must leave input acquisition to the retry.');
      const retryTimer = await lookup(retry.Name);
      assert.equal(retryTimer.Status, 'New');
      assert.equal(Date.parse(retryTimer.StartDate), nextStart);
      await request('/LiveStreams/Close?liveStreamId=' + encodeURIComponent(viewer.LiveStreamId), { method: 'POST', status: 204 });
      holding = true;
      const recovered = await until(readRetry, value => value?.Status === 'Completed', side + ' must record after the tuner is released.', 105000);
      holding = false;
      assert.equal(recovered.Id, deferred.Id);
      assert.equal(recovered.RetryCount, 1);
      assert.equal(Date.parse(recovered.StartDate), nextStart);
      assert.ok(Date.now() >= nextStart);
      expected.retry = { status: recovered.Status, retryCount: recovered.RetryCount, bytes: describe(await readFile(recovered.RecordingPath)),
        postProcess: Number(await processed(recovered.RecordingPath)) };
      assert.deepEqual(expected.retry.bytes, describe(bytes));
      assert.equal(expected.retry.postProcess, bytes.length);
    };
    await startNative('native-recording');
    await run(nativeOrigin, 'native');
    await stopNative();
    // PostgreSQL starts with the pre-recording rows and a fresh timer document.
    await writeFile(timersPath, '[]');
    const syntheticSeed = path.join(referenceRoot, 'empty-synthetic-media');
    await mkdir(syntheticSeed);
    const storageConfiguration = await writeLocalFixtureStorage(path.join(referenceRoot, 'fixture-storage.json'), referenceRoot, { syntheticSeed });
    engine = 'node';
    runtime = await createTestRuntime({ ...await readInstanceConfiguration(referenceRoot), database, storageConfiguration, onError: error => {
      const stack = error.stack?.match(/\bsrc[/\\][a-z0-9-]+[/\\][a-z0-9-]+\.js:\d+/giu) ?? [];
      (report.diagnostics ??= []).push({ message: publication.publicError(error).message, stack });
    } });
    const nodeOrigin = 'http://127.0.0.1:' + runtime.networkHost.listeners.find(value => value.scheme === 'http').port;
    await run(nodeOrigin, 'node');
    const authority = JSON.parse(await runtime.store.run(db => db.getState('liveTvNativeState')));
    assert.equal(authority.timers.sourceSha256, digest(await readFile(timersPath)));
    assert.deepEqual(runtime.liveStreams.snapshot(), []);
    assert.deepEqual(report.node, report.native);
    await current.finish();
  } catch (error) { failure = publication.publicError(error); report.error = failure.message; }
  finally {
    for (const cleanup of [stopNative, () => runtime?.close(), () => database && dropPostgresTestDatabase(database), () => source && new Promise(resolve => {
      source.closeAllConnections(); source.close(resolve);
    })]) try { await cleanup(); }
    catch (error) { failure ??= publication.publicError(error); }
    report.upstream = upstream;
    try { await writeFile(path.join(root, 'capture.json'), JSON.stringify(report)); }
    finally { await publication.publishAndClose(); }
  }
  if (failure) throw failure;
}));
