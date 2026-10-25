import test from 'node:test';
import { runSubtitleTextScenario } from './helpers/subtitle-text-scenario.js';
import { subtitleTtmlInput } from './fixtures/subtitle-ttml-current/input.js';
import { generatedBodyProjection, readGeneratedBody } from './fixtures/subtitle-ttml-current/projection.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_POSTGRES;

test('current Native TTML output matches real Local/PG HTTP, complete XML and actual writer-body readers', {
  skip: !enabled, timeout: 600000,
}, t => runSubtitleTextScenario(t, { prefix: 'subtitle-ttml-current', scenarios: subtitleTtmlInput(),
  generatedBodyProjection, readGeneratedBody,
  fixtureFiles: [new URL('./fixtures/subtitle-ttml-current/input.js', import.meta.url),
    new URL('./fixtures/subtitle-ttml-current/projection.js', import.meta.url),
    new URL('./fixtures/subtitle-ttml-current/read-generated.js', import.meta.url),
    new URL('./fixtures/subtitle-ttml-current/README.md', import.meta.url),
    new URL('./fixtures/subtitle-ttml-current/.gitattributes', import.meta.url),
    new URL('./fixtures/subtitle-writers-current/input.js', import.meta.url),
    new URL('./helpers/subtitle-text-scenario.js', import.meta.url), new URL(import.meta.url)] }));
