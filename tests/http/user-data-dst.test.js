import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { dependencyOrder } from '../../src/database/model.js';
import { nativeGuid } from '../../src/users/native.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { createTestRuntime } from '../helpers/runtime.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];

test('UserData binds both occurrences of the Berlin autumn transition through HTTP and PostgreSQL', async t => {
  const zone = 'Europe/Berlin', previous = process.env.TZ;
  const output = path.join(validationOutputRoot(), 'user-data-dst-' + randomUUID());
  await mkdir(output);
  const cases = [
    { name: 'summer offset', input: '2026-10-25T02:30:00.1234567+02:00', hour: '00' },
    { name: 'winter offset', input: '2026-10-25T02:30:00.1234567+01:00', hour: '01' },
    { name: 'wall time', input: '2026-10-25T02:30:00.1234567', hour: '01' },
    { name: 'UTC', input: '2026-10-25T01:30:00.1234567Z', hour: '01' },
  ];
  const expected = cases.map(({ hour }) => ({
    wire: '2026-10-25T' + hour + ':30:00.1234567Z', stored: '2026-10-25 ' + hour + ':30:00.1234567',
  }));
  // Windows TimeZoneInfo.Local follows the machine-wide zone. POSIX can run
  // the designated assemblies in Berlin without changing other test processes.
  if (process.platform !== 'win32') {
    const input = path.join(output, 'input.json');
    await writeFile(input, JSON.stringify({ cases }));
    await recordOracle({ project: 'tests/consumer-contracts/fixtures/date-roundtrip-current/Oracle.csproj',
      output: path.join(output, 'native'), args: [input, '{output}/native.json'], environment: { ...process.env, TZ: zone } });
    const native = JSON.parse(await readFile(path.join(output, 'native/native.json'), 'utf8'));
    assert.equal(native.timezone, zone);
    assert.deepEqual(native.observations.map(({ wire, stored }) => ({ wire, stored })), expected);
  }
  process.env.TZ = zone;
  let runtime, db;
  try {
    const seed = JSON.parse(await readFile(new URL('../sessions/fixtures/user-data-binding/seed.json', import.meta.url), 'utf8'),
      (_key, value) => value?.$integer ? BigInt(value.$integer) : value);
    db = await createPostgresTestDatabase(null, 'dst_history');
    await db.transaction(async connection => {
      await connection.client.query('SET CONSTRAINTS ALL DEFERRED');
      for (const table of dependencyOrder()) for (const row of seed[table.name] ?? []) await connection.insert(table.name, row);
    });
    runtime = await createTestRuntime({ database: db, configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true }, serverId: 'dst-history' });
    const origin = 'http://127.0.0.1:' + runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port;
    const headers = { Authorization: 'MediaBrowser Client="History", Device="Fixture", DeviceId="history-offset", Version="1"', 'Content-Type': 'application/json' };
    const login = await fetch(origin + '/Users/AuthenticateByName', { method: 'POST', headers,
      body: JSON.stringify({ Username: 'CoreFlowAdmin', Pw: 'isolated-core-flow-password' }) });
    assert.equal(login.status, 200);
    const session = await login.json();
    headers.Authorization += ', Token="' + session.AccessToken + '"';
    const item = '22222222222222222222222222222222', uri = origin + '/UserItems/' + item + '/UserData';
    for (const [i, sample] of cases.entries()) {
      const response = await fetch(uri, { method: 'POST', headers, body: JSON.stringify({ LastPlayedDate: sample.input, PlayCount: 7 }) });
      assert.equal(response.status, 200);
      const read = await fetch(uri, { headers });
      assert.equal(read.status, 200);
      const rows = await db.rows('UserData', { where: { UserId: nativeGuid(session.User.Id), ItemId: nativeGuid(item) }, columns: ['LastPlayedDate'] });
      const actual = { post: (await response.json()).LastPlayedDate, get: (await read.json()).LastPlayedDate, stored: rows[0]?.LastPlayedDate };
      t.diagnostic(JSON.stringify({ input: sample.input, ...actual }));
      assert.equal(rows.length, 1);
      assert.deepEqual(actual, { post: expected[i].wire, get: expected[i].wire, stored: expected[i].stored }, sample.name);
    }
  } finally {
    try { await runtime?.close(); } finally {
      if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
      await dropPostgresTestDatabase(db);
    }
  }
});
