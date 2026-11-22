import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { cloneDirectory, stateDirectory } from '../../src/migration/emby/files.js';

export async function verifyProviderRoundtrip({ root, original, wireId, item, exchange, postgres, nativeProviders }) {
  const instance = name => path.join(root, 'providers-' + name);
  const source = instance('source'), template = instance('template');
  const first = instance('manager'), emby = instance('emby'), second = instance('return'), repeated = instance('repeat');
  const originalFields = 'Tmdb=100|Imdb=tt1000|Tvdb=60|TvRage=600';
  await cloneDirectory(original, source);
  setProviders(source, originalFields);
  await exchange('import', source, first, 'migration_providers');
  await makeOldReceipt(first);
  await cloneDirectory(source, template);
  setProviders(template, 'Tmdb=100|IMDB=tt2000|Tvdb=62|Private=private');
  await postgres('migration_providers', async db => {
    for (const [ProviderId, ProviderValue] of [['Tmdb', '200'], ['Tvdb', '61'], ['TvRage', '601']])
      await db.update('BaseItemProviders', { ItemId: item, ProviderId }, { ProviderValue });
  });
  const exported = await exchange('export', first, emby, 'migration_providers', '--template', template);
  assert.equal(readProviders(emby), 'Tmdb=200|IMDB=tt2000|Tvdb=62|Private=private');
  const open = await conflicts(exported);
  assert.equal(open.length, 2);
  assert.deepEqual(open.map(i => [i.source.values, i.target.values]), [
    [[['Tvdb', '61']], [['Tvdb', '62']]],
    [[['TvRage', '601']], []],
  ]);
  assert.ok(open.every(i => i.source.instanceId.startsWith('jellyfin:') && i.target.instanceId.startsWith('emby:')));
  const imported = await exchange('import', emby, second, 'migration_providers_return');
  const state = await postgres('migration_providers_return', async db => Object.fromEntries(
    (await db.rows('BaseItemProviders', { where: { ItemId: item } })).map(r => [r.ProviderId, r.ProviderValue])));
  assert.deepEqual(state, { Tmdb: '200', Imdb: 'tt2000', Tvdb: '61', TvRage: '601', Private: 'private' });
  const reverse = await conflicts(imported);
  const final = await exchange('export', second, repeated, 'migration_providers_return');
  const again = await conflicts(final);
  assert.equal(readProviders(repeated), readProviders(emby));
  assert.deepEqual(reverse.map(i => i.firstSeen), open.map(i => i.firstSeen));
  assert.deepEqual(again.map(i => i.firstSeen), open.map(i => i.firstSeen));
  for (let i = 0; i < reverse.length; i++) {
    assert.equal(reverse[i].source.instanceId, open[i].target.instanceId);
    assert.equal(reverse[i].target.instanceId, open[i].source.instanceId);
  }
  const live = Object.fromEntries(Object.entries(await nativeProviders(repeated)).map(([key, value]) => [key.toLowerCase(), value]));
  assert.deepEqual(live, { tmdb: '200', imdb: 'tt2000', tvdb: '62', private: 'private' });
  await makeOldReceipt(repeated, item);
  const old = await exchange('import', repeated, instance('from-old-conflict'), 'migration_providers_old');
  const recovered = await conflicts(old);
  assert.deepEqual(recovered.map(i => [i.source.values, i.target.values]), reverse.map(i => [i.source.values, i.target.values]));
  return { merged: live, conflicts: open, returnRounds: 2, olderReceipts: true };

  function withEmbyDatabase(instance, operation) {
    const db = new DatabaseSync(path.join(instance, 'data/library.db'));
    try {
      return operation(db);
    } finally {
      db.close();
    }
  }
  function readProviders(instance) {
    return withEmbyDatabase(instance, db => db.prepare('SELECT ProviderIds FROM MediaItems WHERE Id=?').get(wireId).ProviderIds);
  }
  function setProviders(instance, providers) {
    withEmbyDatabase(instance, db => {
      assert.equal(db.prepare('UPDATE MediaItems SET ProviderIds=? WHERE Id=?').run(providers, wireId).changes, 1);
    });
  }
}

async function makeOldReceipt(instance, unresolvedItem) {
  const state = name => path.join(instance, stateDirectory, name + '.json');
  const base = JSON.parse(await readFile(state('base'), 'utf8'));
  delete base.providerState;
  const bytes = JSON.stringify(base) + '\n';
  const manifest = JSON.parse(await readFile(state('manifest'), 'utf8'));
  manifest.baseHash = createHash('sha256').update(bytes).digest('hex');
  await writeFile(state('base'), bytes);
  await writeFile(state('manifest'), JSON.stringify(manifest) + '\n');
  if (unresolvedItem) await writeFile(state('report'), JSON.stringify({
    issues: [{ status: 'conflict', kind: 'item', id: unresolvedItem, field: 'Providers', reason: 'both endpoints edited' }],
  }));
}

async function conflicts(result) {
  const { issues } = JSON.parse(await readFile(result.report, 'utf8'));
  return issues.filter(i => i.status === 'conflict' && i.field === 'Providers').map(i => i.evidence)
    .sort((a, b) => a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0);
}
