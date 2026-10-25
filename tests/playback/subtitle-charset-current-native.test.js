import test from 'node:test';
import { runSubtitleTextScenario } from './helpers/subtitle-text-scenario.js';
import scenarios from './fixtures/subtitle-charset-current/input.json' with { type: 'json' };

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_POSTGRES;

test('current Native external subtitle encoding matches warm and cold Local/PG public conversion and original delivery', {
  skip: !enabled, timeout: 600000,
}, t => runSubtitleTextScenario(t, { prefix: 'subtitle-charset-current', scenarios,
  fixtureFiles: [new URL('./fixtures/subtitle-charset-current/input.json', import.meta.url),
    new URL('./fixtures/subtitle-charset-current/README.md', import.meta.url),
    new URL('./helpers/subtitle-text-scenario.js', import.meta.url), new URL(import.meta.url)] }));
