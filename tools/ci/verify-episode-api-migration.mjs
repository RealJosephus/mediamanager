import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { music } from './migration-audio-fixture.mjs';

const [instance, schema, storage, username, expectationFile] = process.argv.slice(2);
if (instance === '--write-audio') {
  const samples = [
    ['first', 13, 10, 1, 19], ['second', 41, 21, 0.85, 19], ['moved', 47, 12, 0.9, 19],
    ['special1', 59, 10, 1, 23], ['special2', 63, 20, 0.85, 23], ['fallback', 83, 1000, 1, 19],
  ];
  for (const [name, ...recipe] of samples) await writeFile(path.join(schema, name + '.wav'), music(...recipe, 180));
} else {
  const { readFile } = await import('node:fs/promises');
  const { startProductionInstance } = await import('../../src/main.js');
  const expected = JSON.parse(await readFile(expectationFile, 'utf8'));
  const app = await startProductionInstance({ environment: {
    ...process.env, MEDIAMANAGER_INSTANCE: instance, MEDIAMANAGER_POSTGRES: process.env.MEDIAMANAGER_TEST_POSTGRES,
    MEDIAMANAGER_POSTGRES_SCHEMA: schema, MEDIAMANAGER_STORAGE: storage,
  } });
  try {
    const base = 'http://127.0.0.1:' + app.networkHost.listeners.find(listener => listener.scheme === 'http').port;
    const client = 'MediaBrowser Client="Episode Test", Device="CI", DeviceId="episode-test", Version="1"';
    let token = '';
    async function call(route, method = 'GET', body) {
      const response = await fetch(base + route, {
        method, headers: { Authorization: client + token, 'Content-Type': 'application/json' },
        body: body && JSON.stringify(body),
      });
      const text = await response.text();
      assert.ok(response.ok, route + ': HTTP ' + response.status + ' ' + text);
      return text && JSON.parse(text);
    }
    const session = await call('/Users/AuthenticateByName', 'POST', { Username: username, Pw: process.env.MM_FIXTURE_PASSWORD });
    token = ', Token="' + session.AccessToken + '"';
    const idKey = id => id?.replaceAll('-', '').toLowerCase();
    for (const [season, ids] of Object.entries(expected.seasons)) {
      const { Items } = await call('/Shows/' + expected.series + '/Episodes?seasonId=' + season + '&userId=' + session.User.Id);
      assert.deepEqual(Items.map(item => idKey(item.Id)).sort(), ids.map(idKey).sort(), season);
      for (const item of Items) assert.equal(idKey(item.SeasonId), idKey(season));
    }
    await call('/Users/' + session.User.Id + '/PlayedItems/' + expected.played, 'POST');
    const next = await call('/Shows/NextUp?seriesId=' + expected.series + '&userId=' + session.User.Id);
    assert.deepEqual(next.Items.map(item => idKey(item.Id)), [idKey(expected.nextUp)]);
    await call('/Plugins/skip-segments/Enabled', 'POST', { enabled: true });
    const task = async () => (await call('/ScheduledTasks')).find(row => row.Key === 'AnalyzeIntroAndCredits');
    const before = await task();
    assert.ok(before);
    await call('/ScheduledTasks/Running/' + before.Id, 'POST');
    let result;
    for (let i = 0; i < 240; i++) {
      const current = await task();
      if (current.State === 'Idle' && current.LastExecutionResult?.StartTimeUtc &&
          current.LastExecutionResult.StartTimeUtc !== before.LastExecutionResult?.StartTimeUtc) {
        result = current.LastExecutionResult;
        break;
      }
      await delay(250);
    }
    assert.equal(result?.Status, 'Completed', JSON.stringify(result));
    const observed = {};
    for (const [id, opening] of Object.entries(expected.intros)) {
      const { Items } = await call('/MediaSegments/' + id + '?includeSegmentTypes=Intro');
      if (opening == null) assert.equal(Items.length, 0, JSON.stringify({ id, Items }));
      else {
        assert.equal(Items.length, 1, JSON.stringify({ id, Items }));
        const [intro] = Items;
        assert.ok(Math.abs(intro.StartTicks / 1e7 - opening) < 3.5 && Math.abs(intro.EndTicks / 1e7 - (opening + 28)) < 4,
          JSON.stringify({ id, opening, intro }));
      }
      observed[id] = Items.map(({ StartTicks, EndTicks }) => [StartTicks, EndTicks]);
    }
    console.log(JSON.stringify(observed));
  } finally {
    await app.close();
  }
}
