import assert from 'node:assert/strict';
import { startProductionInstance } from '../../src/main.js';

const [instance, schema, storage, username, movie, expected, afterAnalysis] = process.argv.slice(2);
const app = await startProductionInstance({ environment: {
  ...process.env, MEDIAMANAGER_INSTANCE: instance, MEDIAMANAGER_POSTGRES: process.env.MEDIAMANAGER_TEST_POSTGRES,
  MEDIAMANAGER_POSTGRES_SCHEMA: schema, MEDIAMANAGER_STORAGE: storage,
} });
try {
  const base = 'http://127.0.0.1:' + app.networkHost.listeners.find(l => l.scheme === 'http').port;
  const client = 'MediaBrowser Client="Marker Test", Device="CI", DeviceId="marker-test", Version="1"';
  const session = await fetch(base + '/Users/AuthenticateByName', { method: 'POST',
    headers: { Authorization: client, 'Content-Type': 'application/json' },
    body: JSON.stringify({ Username: username, Pw: process.env.MM_FIXTURE_PASSWORD }) });
  assert.equal(session.status, 200);
  const { AccessToken } = await session.json();
  const headers = { Authorization: client + ', Token="' + AccessToken + '"', 'Content-Type': 'application/json' };
  const observations = [];
  async function observe(phase) {
    const rows = await app.store.run(async db => {
      const read = (table, columns) => db.rows(table, { where: { ItemId: movie }, columns, limit: 16 });
      return {
        chapters: await read('Chapters', ['ChapterIndex', 'Name', 'StartPositionTicks']),
        segments: await read('MediaSegments', ['SegmentProviderId', 'Type', 'StartTicks', 'EndTicks']),
        streams: await read('MediaStreamInfos', ['StreamIndex', 'StreamType']),
      };
    }, { readOnly: true });
    observations.push({ phase, ...rows });
  }
  const evidence = () => JSON.stringify(observations, (_, value) => typeof value === 'bigint' ? String(value) : value);
  async function read() {
    const playback = await fetch(base + '/Items/' + movie + '/PlaybackInfo', { headers });
    assert.equal(playback.status, 200);
    await observe('after PlaybackInfo');
    const source = (await playback.json()).MediaSources.find(s => s.Id.toLowerCase().replaceAll('-', '') === movie.toLowerCase().replaceAll('-', ''));
    assert.equal(source?.HasSegments, true, 'Standard Jellyfin Web must discover the available segments at playback start');
    const response = await fetch(base + '/MediaSegments/' + movie + '?includeSegmentTypes=Intro&includeSegmentTypes=Outro', { headers });
    assert.equal(response.status, 200);
    const actual = await response.json();
    assert.equal(actual.TotalRecordCount, actual.Items.length);
    return actual.Items.map(s => [s.Type, s.StartTicks, s.EndTicks]);
  }
  await observe('before playback');
  assert.deepEqual(observations[0].streams.map(s => [s.StreamIndex, s.StreamType]).sort((a, b) => a[0] - b[0]),
    [[0, 1], [1, 0], [2, 2]], 'The migrated video, audio and subtitle must have native Jellyfin kinds before probing');
  assert.deepEqual(await read(), JSON.parse(expected), evidence());
  if (afterAnalysis) {
    const enable = await fetch(base + '/Plugins/skip-segments/Enabled', { method: 'POST', headers, body: JSON.stringify({ enabled:true }) });
    assert.equal(enable.status, 200, await enable.text());
    const list = async () => (await (await fetch(base + '/ScheduledTasks', { headers })).json()).find(t => t.Key === 'AnalyzeIntroAndCredits');
    const task = await list();
    assert.ok(task);
    const start = await fetch(base + '/ScheduledTasks/Running/' + task.Id, { method:'POST', headers });
    assert.ok(start.ok, await start.text());
    let result;
    for (let i = 0; i < 120; i++) {
      result = await list();
      if (result.State === 'Idle' && result.LastExecutionResult && result.LastExecutionResult.StartTimeUtc !== task.LastExecutionResult?.StartTimeUtc) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(result.LastExecutionResult?.Status, 'Completed', JSON.stringify(result.LastExecutionResult));
    assert.notEqual(result.LastExecutionResult.StartTimeUtc, task.LastExecutionResult?.StartTimeUtc);
    await observe('after analysis');
    assert.deepEqual(await read(), JSON.parse(afterAnalysis), evidence());
  }
} finally {
  await app.close();
}
