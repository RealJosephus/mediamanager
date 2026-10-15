import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMetadataName } from '../../src/metadata/naming.js';
import { TmdbClient } from '../../plugins/tmdb/client.js';
import { defaultTmdbApiKey } from '../../plugins/tmdb/default-key.js';

const cases = JSON.parse(readFileSync(new URL('./fixtures/naming-oracle.json', import.meta.url), 'utf8'));
test('metadata lookup name and year match the current native naming DLL', () => {
  for (const sample of cases) assert.deepEqual(parseMetadataName(sample.Input), { Name: sample.Name, Year: sample.Year }, String(sample.Input));
});
test('TMDB runtime uses the source public application default and preserves configured key overrides', async () => {
  for (const [configuration, apiKey, expected] of [[{}, undefined, defaultTmdbApiKey], [{ TmdbApiKey: '' }, undefined, defaultTmdbApiKey], [{ TmdbApiKey: 'configured-fixture' }, undefined, 'configured-fixture'], [{ TmdbApiKey: 'configured-fixture' }, 'injected-fixture', 'injected-fixture']]) {
    let valid = false;
    const client = new TmdbClient({ configuration, apiKey, fetch: async url => { valid = new URL(url).searchParams.get('api_key') === expected; return Response.json({}); } });
    await client.request('fixture'); assert.equal(valid, true); client.close();
  }
});
