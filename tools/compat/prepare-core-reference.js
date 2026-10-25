import { validationPath } from '../validation/paths.js';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SqliteDatabase } from '../../src/database/sqlite.js';

const [base, directory] = process.argv.slice(2);
if (!base || new URL(base).hostname !== '127.0.0.1' || !directory) throw new Error('An explicit loopback reference and isolated output directory are required.');
const source = new SqliteDatabase(validationPath('.test-input/reference-instance/data/data/jellyfin.db'), { readOnly: true });
const device = source.rows('Devices', { where: { DeviceId: 'fixture-oracle' } })[0];
source.close();
const headers = { Authorization: `MediaBrowser Token="${device.AccessToken}"`, 'Content-Type': 'application/json' };
async function call(route, options = {}) {
  const response = await fetch(new URL(route, base), { headers, ...options });
  const body = await response.text();
  if (!response.ok) throw new Error(`${route}: ${response.status} ${body}`);
  return body ? JSON.parse(body) : null;
}
const info = await call('/System/Info/Public');
const user = await call('/Users/New', { method: 'POST', body: JSON.stringify({ Name: 'CoreFlowAdmin', Password: 'isolated-core-flow-password' }) });
await call(`/Users/${user.Id}/Policy`, { method: 'POST', body: JSON.stringify({ ...user.Policy, IsAdministrator: true, IsHidden: false }) });
const reader = await call('/Users/New', { method: 'POST', body: JSON.stringify({ Name: 'CoreFlowReader', Password: 'isolated-reader-password' }) });
await writeFile(path.join(directory, 'identities.json'), JSON.stringify({ serverId: info.Id, serverName: info.ServerName, version: info.Version, adminId: user.Id, readerId: reader.Id }, null, 2));
await call('/System/Shutdown', { method: 'POST' });
console.log(JSON.stringify({ usersCreated: 2, shutdownRequested: true }));
