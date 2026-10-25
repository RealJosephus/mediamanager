import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeMetadata } from '../../src/metadata/merge.js';

const input = JSON.parse(readFileSync(new URL('./fixtures/merge-input.json', import.meta.url), 'utf8'));
const oracle = JSON.parse(readFileSync(new URL('./fixtures/merge-oracle.json', import.meta.url), 'utf8'));
const fieldsByType = { Movie: ['CollectionName'], Series: ['AirTime', 'Status', 'AirDays', 'DisplayOrder'], Episode: ['AirsBeforeSeasonNumber', 'AirsAfterSeasonNumber', 'AirsBeforeEpisodeNumber', 'IndexNumberEnd'], Season: [] };
const specialized = new Set(Object.values(fieldsByType).flat());
const initialize = (value, Type) => {
  const Item = { Type, Genres: [], Studios: [], Tags: [], ProductionLocations: [], ProviderIds: {},
    RemoteTrailers: [], LockedFields: [], IsLocked: false, ...structuredClone(value.Item) };
  // The frozen CLR oracle names the JsonIgnore alias. Candidate producers use
  // the sole serialized native property instead of recreating that alias.
  if (Type === 'Movie' && Object.hasOwn(Item, 'CollectionName')) {
    Item.TmdbCollectionName = Item.CollectionName;
    delete Item.CollectionName;
  }
  return { Item, People: structuredClone(value.People) };
};
function projectPeople(people) {
  return people?.map(person => ({ Name: person.Name ?? null, Role: person.Role ?? null, Type: person.Type ?? 'Unknown', SortOrder: person.SortOrder ?? null, ImageUrl: person.ImageUrl ?? null, ProviderIds: person.ProviderIds ?? {} })) ?? null;
}
test('metadata merge projections match actual current Jellyfin services', async t => {
  for (const sample of input.cases) await t.test(sample.id, async () => {
    const target = initialize(sample.target, sample.type);
    await mergeMetadata(initialize(sample.source, sample.type), target, sample.options);
    const Item = Object.fromEntries(input.fields.map(key => [key,
      specialized.has(key) && !fieldsByType[sample.type].includes(key) ? null
        : key === 'CollectionName' ? target.Item.TmdbCollectionName ?? null : target.Item[key] ?? null]));
    assert.deepEqual({ id: sample.id, Item, People: projectPeople(target.People) }, oracle.find(result => result.id === sample.id));
  });
});
