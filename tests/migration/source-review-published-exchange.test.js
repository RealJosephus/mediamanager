import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { exchange } from '../../src/migration/emby/exchange.js';
import { toBlob } from '../../src/migration/emby/format.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';
import { runEmby } from '../../tools/database/emby.js';
import { exchangeFixture, exchangeId, stoppedEmby } from './emby-exchange-fixture.js';

test('the published Emby return retains plugin directory permissions and modification time', async t => {
  const fixture = await exchangeFixture(t);
  fixture.emby.prepare("INSERT INTO MediaItems(Id,guid,type,Name) VALUES(1,?,5,'Movie')").run(toBlob(exchangeId(1)));
  const original = await stoppedEmby(fixture);
  const relative = path.join('plugins', 'LocalPlugin');
  const origin = path.join(original, relative);
  await mkdir(origin, { recursive:true });
  await writeFile(path.join(origin, 'state'), 'unchanged');
  await chmod(origin, 0o750);
  const stamp = new Date('2020-02-03T04:05:06Z');
  await utimes(origin, stamp, stamp);
  const inbound = await exchange({ direction:'import', source:original, output:path.join(fixture.directory,'manager') });
  const returned = await exchange({ direction:'export', source:inbound.output, output:path.join(fixture.directory,'returned') });
  const output = path.join(returned.output, relative);
  assert.equal(await readFile(path.join(output,'state'),'utf8'), 'unchanged');
  const source = await stat(origin);
  if (process.platform !== 'win32') assert.equal(source.mode & 0o777, 0o750);
  assert.equal(source.mtime.getTime(), stamp.getTime());
  const observed = await stat(output);
  assert.deepEqual([observed.mode & 0o777,observed.mtime.toISOString()], [source.mode & 0o777,stamp.toISOString()]);
});

test('the operator import command accepts equivalent Windows roots from the native library and its sidecar', async t => {
  const fixture = await exchangeFixture(t);
  const identity = 'X:\\Media';
  fixture.emby.prepare("INSERT INTO MediaItems(Id,guid,type,Name,Path) VALUES(1,?,4,'Movies',?)").run(toBlob(exchangeId(1)), '%RootFolderPath%/Movies');
  fixture.emby.prepare("INSERT INTO ItemExtradataTypes(ExtradataTypeId,Name) VALUES(734,'LibraryOptions')").run();
  fixture.emby.prepare("INSERT INTO ItemExtradata(ItemId,ExtradataTypeId,Value) VALUES(1,734,?)").run(JSON.stringify({PathInfos:[{Path:identity}]}));
  const original = await stoppedEmby(fixture);
  const options = path.join(original, 'root','default','Movies');
  await mkdir(options, { recursive:true });
  const setPath = value => writeFile(path.join(options,'options.xml'), '<LibraryOptions><PathInfos><MediaPathInfo><Path>' + value + '</Path></MediaPathInfo></PathInfos></LibraryOptions>');
  const imported = async name => {
    const schema = 'review_' + randomUUID().replaceAll('-','').slice(0,20);
    const output = path.join(fixture.directory,name);
    t.after(async () => dropPostgresTestDatabase(await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema })));
    await runEmby('import',['--source',original,'--output',output,'--schema',schema,'--postgres-url-env','MEDIAMANAGER_TEST_POSTGRES']);
    return JSON.parse(await readFile(path.join(output,'config','mediamanager-mounts.json'),'utf8'));
  };
  await setPath(identity);
  const control = await imported('canonical');
  assert.equal(control.mounts.length,1);
  assert.equal(control.mounts[0].identityRoot,identity);
  await setPath('x:/media/');
  assert.deepEqual(await imported('equivalent'),control);
});
