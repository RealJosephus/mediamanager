import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cleanName, normalizeTitle, normalizeLanguage, imageLanguages, parseTmdbId } from '../../plugins/tmdb/utils.js';
import { parseNfo } from '../../plugins/nfo/parser.js';

// Recorded by the isolated .NET harness against built baseline DLLs, not inferred from Node output.
const oracle = JSON.parse(await readFile(new URL('./fixtures/baseline-oracle.json', import.meta.url), 'utf8'));

test('actual baseline DLL differential: TMDB normalization, language parameters and Int32 IDs', () => {
  for (const value of oracle.Names) {
    assert.equal(cleanName(value.Input), value.Clean, value.Input);
    assert.equal(normalizeTitle(value.Input), value.Normalized, value.Input);
  }
  for (const value of oracle.Languages) {
    assert.equal(normalizeLanguage(value.Language, value.Country), value.Normalized);
    assert.equal(imageLanguages(value.Language, value.Country), value.Images);
  }
  for (const value of oracle.Ids) assert.equal(parseTmdbId(value.Input), value.Value, value.Input);
});

for (const expected of oracle.Metadata) test(`actual baseline DLL differential: NFO ${expected.Fixture}`, async () => {
  const xml = await readFile(new URL(`./fixtures/${expected.Fixture}.nfo`, import.meta.url), 'utf8');
  const type = expected.Fixture === 'Justice League' ? 'Movie' : 'Episode';
  const { Item: item, People: people, RemoteImages: images } = parseNfo(xml, { type, externalIds: ['Tmdb', 'Imdb'] });
  const actual = { Fixture: expected.Fixture };
  for (const key of ['Name', 'OriginalTitle', 'Overview', 'ProductionYear', 'IndexNumber', 'IndexNumberEnd', 'ParentIndexNumber']) actual[key] = item[key] ?? null;
  actual.RunTimeTicks = item.RunTimeTicks == null ? null : String(item.RunTimeTicks);
  actual.ProviderIds = item.ProviderIds;
  actual.People = people.map((person) => ({ Name: person.Name, Type: person.Type, Role: person.Role ?? null, SortOrder: person.SortOrder ?? null, ImageUrl: person.ImageUrl ?? null }));
  actual.RemoteImageCount = images.length;
  assert.deepEqual(actual, expected);
});
