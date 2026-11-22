import assert from 'node:assert/strict';
import { startProductionInstance } from '../../src/main.js';

const [instance, schema, storage, username, movie, expected] = process.argv.slice(2);
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
  const response = await fetch(base + '/MediaSegments/' + movie, { headers: { Authorization: client + ', Token="' + AccessToken + '"' } });
  assert.equal(response.status, 200);
  const actual = await response.json();
  assert.equal(actual.TotalRecordCount, actual.Items.length);
  assert.deepEqual(actual.Items.map(s => [s.Type, s.StartTicks, s.EndTicks]), JSON.parse(expected));
} finally {
  await app.close();
}
