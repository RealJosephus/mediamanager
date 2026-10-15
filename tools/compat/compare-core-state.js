import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SqliteDatabase } from '../../src/database/sqlite.js';

const [scenario, candidateDirectory] = process.argv.slice(2);
const ids = JSON.parse(await readFile(path.join(scenario, 'identities.json'), 'utf8'));
const id = value => value?.replaceAll('-', '').toLowerCase();
const reference = new SqliteDatabase(path.join(scenario, 'reference/data/data/jellyfin.db'), { readOnly: true, requireMigrationHistory: true });
const candidate = new SqliteDatabase(path.join(candidateDirectory, 'flow-final.db'), { readOnly: true, requireMigrationHistory: true });
try {
  const differences = [];
  const ignored = ['LastLoginDate', 'LastActivityDate'];
  for (const name of ['Users', 'Permissions', 'Preferences', 'AccessSchedules', 'UserData']) {
    const select = db => db.rows(name).filter(row => [ids.adminId, ids.readerId].includes(id(name === 'Users' ? row.Id : row.UserId)));
    const expected = select(reference), actual = select(candidate);
    const key = row => name === 'Users' ? id(row.Id) : name === 'UserData' ? `${id(row.UserId)}/${id(row.ItemId)}/${row.CustomDataKey}` : `${id(row.UserId)}/${row.Kind ?? row.Id}`;
    for (const row of expected) {
      const found = actual.find(entry => key(entry) === key(row));
      if (!found) { differences.push({ table: name, key: key(row), missing: true }); continue; }
      for (const column of Object.keys(row)) {
        if (ignored.includes(column)) continue;
        if (row[column] !== found[column]) differences.push({ table: name, key: key(row), column,
          ...(column === 'Password' ? { valuesRedacted: true } : { expected: row[column], actual: found[column] }) });
      }
    }
    for (const row of actual) if (!expected.some(entry => key(entry) === key(row))) differences.push({ table: name, key: key(row), unexpected: true });
  }
  const report = { checkedAt: new Date().toISOString(), tables: ['Users', 'Permissions', 'Preferences', 'AccessSchedules', 'UserData'],
    normalized: ignored.map(column => `${column}: generated wall clock timestamp`), differences,
    nativeLogoutRevokedDevices: reference.rows('Devices').filter(row => row.DeviceId.startsWith('core-flow')).length === 0,
    candidateLogoutRevokedDevices: candidate.rows('Devices').filter(row => row.DeviceId.startsWith('core-flow')).length === 0 };
  const json = JSON.stringify(report, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2);
  await writeFile(path.join(candidateDirectory, 'state-report.json'), json);
  console.log(json);
} finally { reference.close(); candidate.close(); }
