import test from 'node:test';
import { runSubtitleTextScenario } from './helpers/subtitle-text-scenario.js';
import { subtitleWriterInput } from './fixtures/subtitle-writers-current/input.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_POSTGRES;

test('current Native ASS/SSA output files match real Local/PG HTTP, cold reopen, readers and cancellation', {
  skip: !enabled, timeout: 600000,
}, t => runSubtitleTextScenario(t, { prefix: 'subtitle-writers-current', scenarios: subtitleWriterInput(),
  fixtureFiles: [new URL('./fixtures/subtitle-writers-current/input.js', import.meta.url),
    new URL('./fixtures/subtitle-writers-current/README.md', import.meta.url),
    new URL('./fixtures/subtitle-writers-current/.gitattributes', import.meta.url),
    new URL('./helpers/subtitle-text-scenario.js', import.meta.url), new URL(import.meta.url)] }));
