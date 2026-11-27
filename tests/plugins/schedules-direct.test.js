import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSchedulesDirectProvider } from '../../plugins/schedules-direct/provider.js';

test('Schedules Direct validates an account, adds its lineup and reuses completed schedule days', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sd-guide-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [], date = '2025-03-01', id = 'EP012345678901', start = date + 'T12:00:00Z';
  const provider = createSchedulesDirectProvider({ cachePath: root, fileSystem: fs, now: () => Date.parse(start),
    fetch: async (url, init) => {
      const uri = new URL(url), route = uri.pathname.slice('/20141201'.length), body = init.body && JSON.parse(init.body);
      assert.equal(uri.origin, 'https://json.schedulesdirect.org');
      calls.push([init.method, route]);
      if (route !== '/token') assert.equal(init.headers.token, 'session-token');
      let result;
      switch (route) {
        case '/token':
          assert.deepEqual(body, { username: 'test-user', password: createHash('sha1').update('fixture-password').digest('hex') });
          result = { message: 'OK', token: 'session-token' }; break;
        case '/status': result = { systemStatus: [{ status: 'Online' }], lineups: [{ lineup: 'A', modified: start }] }; break;
        case '/lineups': result = { lineups: [] }; break;
        case '/lineups/A': result = init.method === 'PUT' ? { code: 0 } : { map: [{ stationID: '21', channel: '0007' }],
          stations: [{ stationID: '21', name: 'News', callsign: 'NN' }] }; break;
        case '/headends':
          assert.equal(uri.searchParams.get('postalcode'), '12345'); result = [{ lineups: [{ lineup: 'A', name: 'Local' }] }]; break;
        case '/schedules/md5': assert.deepEqual(body, [{ stationID: '21', date: [date] }]); result = { 21: { [date]: { md5: 'hash' } } }; break;
        case '/schedules': result = [{ metadata: { startDate: date, md5: 'hash' }, programs: [{ programID: id, airDateTime: start, duration: 1800 }] }]; break;
        case '/programs': assert.deepEqual(body, [id]); result = [{ programID: id, entityType: 'Episode', titles: [{ title120: 'Midday' }], genres: ['News'] }]; break;
        default: assert.fail(route);
      }
      return Response.json(result);
    },
  });
  const info = { Username: 'test-user', Password: 'fixture-password', ListingsId: 'A' };
  await assert.rejects(provider.validate({}, true, false), { status: 400 });
  assert.deepEqual(calls, []);
  await provider.validate(info, true, true);
  assert.deepEqual(await provider.getLineups(info, 'USA', '12345'), [{ Name: 'Local', Id: 'A' }]);
  for (let i = 0; i < 2; i++) {
    const [channel] = await provider.getChannels(info);
    assert.deepEqual([channel.Id, channel.Name, channel.Number], ['21', 'News', '7']);
    const [show] = await provider.getPrograms(info, 'I21.json.schedulesdirect.org', start, date + 'T13:00:00Z');
    assert.deepEqual([show.Name, show.ChannelId, show.IsSeries, show.IsNews, show.EndDate], ['Midday', '21', true, true, date + 'T12:30:00.000Z']);
  }
  for (const route of ['/token', '/status', '/schedules', '/programs']) assert.equal(calls.filter(([, p]) => p === route).length, 1, route);
  assert.deepEqual(calls.filter(([, p]) => p === '/lineups/A').map(([method]) => method), ['PUT', 'GET']);
});

test('only a covered schedule window prunes days, scoped to its station', async t => {
  const cachePath = await fs.mkdtemp(path.join(os.tmpdir(), 'sd-window-'));
  t.after(() => fs.rm(cachePath, { recursive: true, force: true }));
  const first = '2025-03-01', second = '2025-03-02', missing = '2025-03-03';
  const provider = createSchedulesDirectProvider({ cachePath, fileSystem: fs, fetch: async (url, init) => {
    const route = new URL(url).pathname.slice('/20141201'.length);
    if (route === '/token') return Response.json({ message: 'OK', token: 'guide-token' });
    if (route === '/status') return Response.json({ systemStatus: [{ status: 'Online' }] });
    const [{ stationID, date: dates }] = JSON.parse(init.body);
    if (route === '/schedules/md5') return Response.json({ [stationID]: Object.fromEntries(dates.map(date => [date, { md5: date }])) });
    assert.equal(route, '/schedules');
    return Response.json(dates.filter(date => date !== missing).map(date => ({ metadata: { startDate: date, md5: date }, programs: [] })));
  } });
  const refresh = (station, date) => provider.getPrograms({ Username: 'guide', Password: 'fixture' }, station,
    date + 'T12:00:00Z', date + 'T12:30:00Z');
  const storedDays = async station => {
    const directory = path.join(cachePath, 'schedulesdirect', 'schedules', station);
    const dates = [];
    for (const file of await fs.readdir(directory)) {
      dates.push(JSON.parse(await fs.readFile(path.join(directory, file), 'utf8')).Schedule.metadata.startDate);
    }
    return dates.sort();
  };
  await refresh('21', first);
  await refresh('210', first);
  await assert.rejects(refresh('21', missing), /Could not get the schedule/);
  assert.deepEqual(await storedDays('21'), [first]);
  await refresh('21', second);
  assert.deepEqual(await storedDays('21'), [second]);
  assert.deepEqual(await storedDays('210'), [first]);
});
