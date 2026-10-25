import test from 'node:test';
import { runSubtitleTextScenario } from './helpers/subtitle-text-scenario.js';
import { subtitleSourceFormatInput } from './fixtures/subtitle-source-formats-current/input.js';
import { generatedBodyProjection, readGeneratedBody } from './fixtures/subtitle-ttml-current/projection.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_POSTGRES;

test('current Native SAMI and text SUB sources match real Local/PG HTTP, output readers and cancellation', {
  skip: !enabled, timeout: 600000,
}, t => runSubtitleTextScenario(t, { prefix: 'subtitle-source-formats-current', scenarios: subtitleSourceFormatInput(),
  generatedBodyProjection, readGeneratedBody,
  fixtureFiles: [new URL('./fixtures/subtitle-source-formats-current/input.js', import.meta.url),
    new URL('./fixtures/subtitle-source-formats-current/README.md', import.meta.url),
    new URL('./fixtures/subtitle-source-formats-current/.gitattributes', import.meta.url),
    new URL('./fixtures/subtitle-ttml-current/projection.js', import.meta.url),
    new URL('./fixtures/subtitle-ttml-current/read-generated.js', import.meta.url),
    new URL('./helpers/subtitle-text-scenario.js', import.meta.url), new URL(import.meta.url)] }));
