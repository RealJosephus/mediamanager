import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { artistFilterInput } from '../../tools/compat/artist-filter-input.js';
import { recordArtistFilters } from '../../tools/compat/record-artist-filters.js';
import { loadCurrentByNameScenario, compareCurrentByNameCandidate } from '../helpers/current-byname-filter-scenario.js';

const bytes = await readFile(new URL('./fixtures/current-byname-filters/artist-input.json', import.meta.url));
for (const mode of ['probe-unknown-credit', 'probe-bom-credit', 'probe-request-order', 'probe-bom-order']) {
  test(`postgres: current native artist ${mode} preserves selector creation and request order`, {
    skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || !process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE,
    timeout: 300000,
  }, async () => {
    const fixture = artistFilterInput(JSON.parse(bytes), mode);
    const output = path.join(validationOutputRoot(), `current-artist-${mode}-${randomUUID()}`);
    const interval = { startedAt: new Date().toISOString() };
    await recordArtistFilters(output, 19000, mode);
    interval.finishedAt = new Date().toISOString();
    const scenario = await loadCurrentByNameScenario('artist', output, bytes, interval, { fixture, mode });
    assert.equal(scenario.records.length, 2);
    await compareCurrentByNameCandidate(scenario);
  });
}
