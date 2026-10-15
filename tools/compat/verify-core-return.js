import { validationPath } from '../validation/paths.js';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SqliteDatabase } from '../../src/database/sqlite.js';

const [base, candidateDirectory, output] = process.argv.slice(2);
if (new URL(base).hostname !== '127.0.0.1') throw new Error('An isolated loopback reference is required.');
const state = JSON.parse(await readFile(path.join(candidateDirectory, 'migration-state.json'), 'utf8'));
const headers = { Authorization: `MediaBrowser Token="${state.accessToken}"`, Accept: 'application/json' };
const call = async (route, options = {}) => {
  const response = await fetch(base + route, { headers, ...options });
  assert.ok(response.ok, `${route} returned ${response.status}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
};
const user = await call('/Users/Me');
assert.equal(user.Id, state.userId);
assert.equal(user.Name, 'CoreFlowMigrated');
assert.deepEqual(user.Configuration, state.configuration);
assert.deepEqual(user.Policy, state.policy);
const data = await call(`/UserItems/${state.movieId}/UserData`);
assert.deepEqual(data, state.userData);
const authenticated = await call('/Users/AuthenticateByName', { method: 'POST', headers: {
  'Content-Type': 'application/json', Authorization: 'MediaBrowser Client="ReturnValidation", Device="IsolatedTest", DeviceId="return-password", Version="1.0"' },
  body: JSON.stringify({ Username: state.username, Pw: 'isolated-migrated-password' }) });
assert.equal(authenticated.User.Id, state.userId);
const original = new SqliteDatabase(validationPath('.agent-docs/reference-instance/data/data/jellyfin.db'), { readOnly: true });
const adminToken = original.rows('Devices', { where: { DeviceId: 'fixture-oracle' } })[0].AccessToken;
original.close();
const shutdown = await fetch(base + '/System/Shutdown', { method: 'POST', headers: { Authorization: `MediaBrowser Token="${adminToken}"` } });
assert.equal(shutdown.status, 204);
const report = { checkedAt: new Date().toISOString(), migratedSessionAuthenticated: true, candidateCreatedUserReadable: true,
  candidatePasswordAuthenticated: true, configurationPreserved: true, policyPreserved: true, progressAndFavoritePreserved: true,
  shutdownStatus: shutdown.status, mediaAccessVerified: false,
  limitations: ['Synthetic media record with no remote byte access.', 'No complete library scan, sidecar generation, client or failure-recovery matrix.'] };
await writeFile(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
