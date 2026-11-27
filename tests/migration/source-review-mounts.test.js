import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { embyLibraryMounts } from '../../src/migration/emby/mounts.js';
import { exchangeFixture, stoppedEmby } from './emby-exchange-fixture.js';

test('automatic Emby mounts coalesce equivalent Windows paths from SQLite and options.xml', async t => {
  const fixture = await exchangeFixture(t);
  const fromDb = 'X:\\Media';
  fixture.emby.prepare('INSERT INTO ItemExtradataTypes(ExtradataTypeId,Name) VALUES(?,?)').run(734, 'LibraryOptions');
  fixture.emby.prepare('INSERT INTO ItemExtradata(ItemId,ExtradataTypeId,Value) VALUES(?,?,?)').run(831, 734, JSON.stringify({PathInfos:[{Path:fromDb}]}));
  const root = await stoppedEmby(fixture);
  const library = path.join(root, 'root', 'default', 'Movies');
  await mkdir(library, {recursive:true});
  const setPath = value => writeFile(path.join(library, 'options.xml'), '<LibraryOptions><PathInfos><MediaPathInfo><Path>' + value + '</Path></MediaPathInfo></PathInfos></LibraryOptions>');
  await setPath(fromDb);
  const control = await embyLibraryMounts(root);
  assert.equal(control.mounts.length, 1);
  assert.equal(control.mounts[0].identityRoot, fromDb);
  await setPath('x:/media/');
  const alternate = await embyLibraryMounts(root);
  assert.deepEqual(alternate, control);
});
