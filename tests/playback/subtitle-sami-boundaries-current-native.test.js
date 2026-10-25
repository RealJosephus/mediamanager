import test from 'node:test';
import { runSubtitleTextScenario } from './helpers/subtitle-text-scenario.js';
import { subtitleSamiUtf8BoundaryInput } from './fixtures/subtitle-sami-boundaries-current/utf8-bom.js';
import { generatedBodyProjection, readGeneratedBody } from './fixtures/subtitle-ttml-current/projection.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_POSTGRES;

test('current Native explicitly UTF-8 SAMI text boundaries match real Local/PG HTTP, public errors and writer readers', {
  skip: !enabled, timeout: 600000,
}, t => runSubtitleTextScenario(t, { prefix: 'subtitle-sami-utf8-boundaries-current', scenarios: subtitleSamiUtf8BoundaryInput(),
  generatedBodyProjection, readGeneratedBody,
  fixtureFiles: [new URL('./fixtures/subtitle-sami-boundaries-current/input.js', import.meta.url),
    new URL('./fixtures/subtitle-sami-boundaries-current/utf8-bom.js', import.meta.url),
    new URL('./fixtures/subtitle-sami-boundaries-current/README.md', import.meta.url),
    new URL('./fixtures/subtitle-sami-boundaries-current/.gitattributes', import.meta.url),
    new URL('./fixtures/subtitle-ttml-current/projection.js', import.meta.url),
    new URL('./fixtures/subtitle-ttml-current/read-generated.js', import.meta.url),
    new URL('./helpers/subtitle-text-scenario.js', import.meta.url), new URL(import.meta.url)] }));
