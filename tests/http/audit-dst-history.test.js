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

export const requiredValidationServices = ['dotnet','jellyfinDll','postgres'];
test('user playback history retains both occurrences of a repeated Berlin wall time', async t => {
  const zone = 'Europe/Berlin', priorZone = process.env.TZ;
  const output = path.join(validationOutputRoot(), 'audit-dst-' + randomUUID());
  await mkdir(output, {recursive:true});
  const cases = [
    {name:'summer offset',input:'2026-10-25T02:30:00.1234567+02:00'},
    {name:'winter offset',input:'2026-10-25T02:30:00.1234567+01:00'},
    {name:'no offset',input:'2026-10-25T02:30:00.1234567'},
    {name:'explicit UTC',input:'2026-10-25T01:30:00.1234567Z'}
  ];
  const input = path.join(output, 'input.json');
  await writeFile(input, JSON.stringify({cases}));
  await recordOracle({project:'tests/consumer-contracts/fixtures/date-roundtrip-current/Oracle.csproj',
    output:path.join(output,'native'), args:[input,'{output}/native.json'], environment:{...process.env,TZ:zone}});
  const native = JSON.parse(await readFile(path.join(output,'native','native.json'),'utf8'));
  assert.equal(native.timezone,zone);
  process.env.TZ = zone;
  let runtime, db;
  try {
    const seed = JSON.parse(await readFile(new URL('../sessions/fixtures/user-data-binding/seed.json',import.meta.url),'utf8'),
      (_key,value) => value?.$integer ? BigInt(value.$integer) : value);
    db = await createPostgresTestDatabase(null,'dst_history');
    await db.transaction(async connection => {
      await connection.client.query('SET CONSTRAINTS ALL DEFERRED');
      for (const table of dependencyOrder()) for (const row of seed[table.name] ?? []) await connection.insert(table.name,row);
    });
    runtime = await createTestRuntime({database:db,configuration:{UICulture:'en-US',IsStartupWizardCompleted:true},serverId:'audit-dst'});
    const origin = 'http://127.0.0.1:' + runtime.networkHost.listeners.find(l=>l.scheme==='http').port;
    const headers = {Authorization:'MediaBrowser Client="History", Device="Fixture", DeviceId="history-offset", Version="1"', 'Content-Type':'application/json'};
    const login = await fetch(origin + '/Users/AuthenticateByName', {method:'POST',headers,
      body:JSON.stringify({Username:'CoreFlowAdmin',Pw:'isolated-core-flow-password'})});
    assert.equal(login.status,200);
    const session = await login.json();
    headers.Authorization += ', Token="' + session.AccessToken + '"';
    const item = '22222222222222222222222222222222';
    const uri = origin + '/UserItems/' + item + '/UserData';
    const rows = [];
    for (const [i,c] of cases.entries()) {
      const response = await fetch(uri,{method:'POST',headers,body:JSON.stringify({LastPlayedDate:c.input,PlayCount:7})});
      assert.equal(response.status,200);
      const stored = await db.rows('UserData',{where:{UserId:nativeGuid(session.User.Id),ItemId:nativeGuid(item)},columns:['LastPlayedDate']});
      const read = await fetch(uri,{headers});
      assert.equal(read.status,200);
      rows.push({...c,http:(await response.json()).LastPlayedDate,read:(await read.json()).LastPlayedDate,
        postgres:stored.map(row=>row.LastPlayedDate),native:native.observations[i].wire,nativeStored:native.observations[i].stored});
    }
    const result = {zone,rows,assemblies:native.assemblies};
    await writeFile(path.join(output,'report.json'),JSON.stringify(result));
    t.diagnostic('AUDIT ' + JSON.stringify(result));
    for (const row of rows) {
      assert.equal(row.http,row.native,row.name);
      assert.equal(row.read,row.native,row.name);
      assert.deepEqual(row.postgres,[row.nativeStored],row.name);
    }
  } finally {
    try { await runtime?.close(); } finally { await dropPostgresTestDatabase(db); }
    if (priorZone === undefined) delete process.env.TZ; else process.env.TZ = priorZone;
  }
});
