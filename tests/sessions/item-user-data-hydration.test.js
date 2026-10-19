import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { fixtureRow } from '../database/fixtures.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { itemRequiresJson } from '../../src/library/item-data.js';
import { itemHasArtist, itemHasAlbumArtist } from '../../src/library/item-relations.js';
import { hydrateItem, userDataKeys, UserDataService } from '../../src/sessions/user-data.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
const fixtures = await Promise.all([
  ['item-user-data-hydration', 132, 'actualFrozenItemUserDataHydration'],
  ['item-user-data-ignored-getters', 54, 'actualFrozenItemUserDataIgnoredGetters']
].map(async ([name, count, flag]) => {
  const root = new URL('./fixtures/' + name + '/', import.meta.url);
  const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json'].map(async file => parseLosslessJson(await readFile(new URL(file, root), 'utf8'))));
  return { name, count, flag, input, native, provenance };
}));
const input = fixtures.flatMap(value => value.input), native = { results: fixtures.flatMap(value => value.native.results) };
const hash = value => createHash('sha256').update(value).digest('hex');
const compare = (actual, expected) => assert.deepEqual(actual, expected);
const userId = '97900000-0000-0000-0000-000000000001';
const blankItem = Object.fromEntries(tableDefinition('BaseItems').columns.filter(column => !column.generated).map(column => [column.name,
  column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));
const rowFor = (sample, expected) => ({ ...blankItem, ...expected.columns,
  Id: sample.item.id, Type: expected.nativeType, ParentId: sample.parents[0]?.id ?? null, OwnerId: null,
  Data: sample.hydrationData });
async function observation(db, row) {
  const item = await hydrateItem(db, row);
  return { requiresJson: itemRequiresJson(item), keys: await userDataKeys(db, item),
    trailers: item.RemoteTrailers.map(trailer => trailer.Url),
    hydratedLists: Object.fromEntries(['Genres', 'Studios', 'Tags', 'ProductionLocations', 'Artists', 'AlbumArtists'].map(field => [field,
      field === 'Artists' && !itemHasArtist(item) || field === 'AlbumArtists' && !itemHasAlbumArtist(item) ? null : item[field]])) };
}
const expectedFor = expected => ({ requiresJson: expected.requiresJson, keys: expected.keys,
  trailers: expected.trailers, hydratedLists: expected.hydratedLists });
for (const fixture of fixtures) test(fixture.name + ' seals actual mapper, EF lists and concrete user-data getters', async () => {
  const { input, native, provenance } = fixture;
  for (const file of Object.values(provenance.files)) assert.equal(hash(await readFile(new URL('../../' + file.path, import.meta.url))), file.sha256, file.path);
  assert.equal(native.inputSha256, provenance.files.input.sha256);
  assert.equal(native.sourceFilesSha256, provenance.sourceFilesSha256);
  assert.equal(provenance.runtime.jellyfinDll.sha256, '29c34541350089dc0522c4309ecd617e78fd402774681f32491d089803939c03');
  assert.equal(native[fixture.flag], true);
  assert.equal(native.candidateVerified, false); assert.equal(provenance.candidateVerified, false);
  assert.equal(input.length, fixture.count); assert.equal(native.results.length, fixture.count);
  compare(native.results.map(value => value.name), input.map(value => value.name));
  assert.ok(native.results.every(value => value.exception === null));
  assert.equal(new Set(input.map(value => value.item.type)).size, 27);
});
test('session key comparison rejects serialized runtime aliases', () => {
  const expected = expectedFor(native.results.find(value => value.name === 'type-Movie-runtime-aliases-false'));
  for (const keys of [['serialized-fake-key', 'serialized-second-key'], ['serialized-imdb', ...expected.keys]]) {
    assert.throws(() => compare({ ...expected, keys }, expected), assert.AssertionError);
  }
});
test('session hydration comparison rejects poisoned trailers, NULL lists and changed key order', () => {
  const expected = expectedFor(native.results.find(value => value.name === 'type-AudioBook-poison-sql-lists-null'));
  for (const change of [value => { value.trailers.push('https://invalid.example/poison'); },
    value => { value.hydratedLists.AlbumArtists = null; }, value => { value.keys.reverse(); }]) {
    const value = structuredClone(expected); change(value); assert.throws(() => compare(value, expected), assert.AssertionError);
  }
});
for (const sample of input) test('native session item hydration ' + sample.name, async () => {
  const expected = native.results.find(value => value.name === sample.name);
  // The native hydrated parent controls contain no Series or providers.
  compare(await observation({ rows: async () => [] }, rowFor(sample, expected)), expectedFor(expected));
});
for (const sample of input) test('postgres: persisted session hydration and favorite ' + sample.name, async t => {
    const database = await createPostgresTestDatabase(null, 'session_hydration');
    const store = new DomainStore(database);
    t.after(async () => { await store.close(); await dropPostgresTestDatabase(database); });
    await database.insert('Users', { ...fixtureRow(tableDefinition('Users')), Id: userId, InternalId: 1n,
      Username: 'Hydration', NormalizedUsername: 'HYDRATION', RowVersion: 0n });
    for (let index = sample.parents.length - 1; index >= 0; index--) {
      const definition = sample.parents[index];
      const type = native.results.find(value => value.nativeType.split('.').at(-1) === definition.type)?.nativeType;
      assert.ok(type, 'the native fixture supplies the concrete parent type');
      await database.insert('BaseItems', { ...blankItem, Id: definition.id, Type: type, Name: definition.type, IsFolder: true,
        ParentId: sample.parents[index + 1]?.id ?? null, Data: '{}' });
    }
    const expected = native.results.find(value => value.name === sample.name), row = rowFor(sample, expected);
    await database.insert('BaseItems', row);
    const current = () => database.rows('BaseItems', { where: { Id: row.Id } });
    const snapshot = (await current())[0];
    compare(await observation(database, snapshot), expectedFor(expected));
    const service = new UserDataService({ store });
    const events = []; service.on('UserDataSaved', event => events.push(event));
    const dto = await service.setFavorite(userId, row.Id, true);
    assert.equal(dto.IsFavorite, true); assert.equal(dto.Key, expected.keys[0]);
    compare(events.map(event => event.Keys), [expected.keys]);
    const saved = await database.rows('UserData', { where: { UserId: userId, ItemId: row.Id } });
    compare(saved.map(value => value.CustomDataKey).sort(), [...expected.keys].sort());
    assert.ok(saved.every(value => value.IsFavorite === true && value.PlayCount === 0 && value.PlaybackPositionTicks === 0n));
    compare((await current())[0], snapshot, 'session reads and mutations preserve the stored nullable columns and Data');
    assert.equal(snapshot.Data, sample.hydrationData);
  });
