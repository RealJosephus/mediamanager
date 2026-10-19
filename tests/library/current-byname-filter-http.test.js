import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { recordArtistFilters } from '../../tools/compat/record-artist-filters.js';
import { recordStudioFilters } from '../../tools/compat/record-studio-filters.js';
import { recordGenreFilters } from '../../tools/compat/record-genre-filters.js';
import { recordAlbumFilters } from '../../tools/compat/record-album-filters.js';
import { loadCurrentByNameScenario, compareCurrentByNameCandidate } from '../helpers/current-byname-filter-scenario.js';

const inputs = {
  artist: await readFile(new URL('./fixtures/current-byname-filters/artist-input.json', import.meta.url)),
  studio: await readFile(new URL('./fixtures/current-byname-filters/studio-input.json', import.meta.url)),
  genre: await readFile(new URL('./fixtures/current-byname-filters/genre-input.json', import.meta.url)),
  album: await readFile(new URL('./fixtures/current-byname-filters/album-input.json', import.meta.url)),
};
const pins = JSON.parse(await readFile(new URL('./fixtures/current-byname-filters/input-identities.json', import.meta.url)));
const studioExpectations = await readFile(new URL('./fixtures/current-byname-filters/studio-expected.json', import.meta.url));
const recorders = { artist: recordArtistFilters, studio: recordStudioFilters, genre: recordGenreFilters, album: recordAlbumFilters };
const counts = { artist: [49, 95], studio: [34, 68], genre: [34, 68], album: [59, 112] };

for (const kind of ['artist', 'studio', 'genre', 'album']) test(`postgres: current native ${kind} filter requests and mutations`, {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || !process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE, timeout: 300000,
}, async () => {
  assert.equal(createHash('sha256').update(inputs[kind]).digest('hex'), pins[`${kind}-input.json`]);
  if (kind === 'studio') assert.equal(createHash('sha256').update(studioExpectations).digest('hex'), pins['studio-expected.json']);
  const output = path.join(validationOutputRoot(), `current-${kind}-filters-${randomUUID()}`);
  const interval = { startedAt: new Date().toISOString() };
  await recorders[kind](output, 19000, 'main');
  interval.finishedAt = new Date().toISOString();
  const scenario = await loadCurrentByNameScenario(kind, output, inputs[kind], interval);
  assert.equal(scenario.fixture.cases.length, counts[kind][0]);
  assert.equal(scenario.records.length, counts[kind][1]);
  await compareCurrentByNameCandidate(scenario);
});
