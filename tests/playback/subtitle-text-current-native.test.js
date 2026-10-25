import test from 'node:test';
import { runSubtitleTextScenario } from './helpers/subtitle-text-scenario.js';
import { subtitleTextInput } from './fixtures/subtitle-text-current/input.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_POSTGRES;

test('current Native ASS/SSA text consumers match real Local/PG HTTP, cold reopen, markup and reader cancellation', {
  skip: !enabled, timeout: 600000,
}, t => runSubtitleTextScenario(t, { prefix: 'subtitle-text-current', scenarios: subtitleTextInput(),
  fixtureFiles: [new URL('./helpers/subtitle-text-scenario.js', import.meta.url), new URL(import.meta.url)] }));
