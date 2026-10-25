import test from 'node:test';
import { runSubtitleTextScenario } from './helpers/subtitle-text-scenario.js';
import { subtitleVttStyleInput } from './fixtures/subtitle-vtt-style-current/input.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_POSTGRES;

test('current Native WebVTT STYLE conversion matches actual ASS/SSA files and Local/PG HTTP readers', {
  skip: !enabled, timeout: 600000,
}, t => runSubtitleTextScenario(t, { prefix: 'subtitle-vtt-style-current', scenarios: subtitleVttStyleInput(),
  fixtureFiles: [new URL('./fixtures/subtitle-vtt-style-current/input.js', import.meta.url),
    new URL('./fixtures/subtitle-vtt-style-current/README.md', import.meta.url),
    new URL('./fixtures/subtitle-vtt-style-current/.gitattributes', import.meta.url),
    new URL('./helpers/subtitle-text-scenario.js', import.meta.url), new URL(import.meta.url)] }));
