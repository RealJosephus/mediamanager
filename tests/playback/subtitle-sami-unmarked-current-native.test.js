import test from 'node:test';
import { runSubtitleTextScenario } from './helpers/subtitle-text-scenario.js';
import { subtitleSamiBoundaryInput } from './fixtures/subtitle-sami-boundaries-current/input.js';
import { generatedBodyProjection, readGeneratedBody } from './fixtures/subtitle-ttml-current/projection.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_POSTGRES;
const fixtureFiles = [new URL('./fixtures/subtitle-sami-boundaries-current/input.js', import.meta.url),
  new URL('./fixtures/subtitle-sami-boundaries-current/.gitattributes', import.meta.url),
  new URL('./fixtures/subtitle-sami-unmarked-current/README.md', import.meta.url),
  new URL('./helpers/subtitle-text-scenario.js', import.meta.url), new URL(import.meta.url)];

test('current Native unmarked SAMI sources retain actual original delivery and converted text through warm and cold Local/PG HTTP', {
  skip: !enabled, timeout: 600000,
}, t => runSubtitleTextScenario(t, { prefix: 'subtitle-sami-unmarked-current', scenarios: subtitleSamiBoundaryInput(),
  generatedBodyProjection, readGeneratedBody, fixtureFiles }));

test('a detector result without an available encoding retains the actual Native text-reader fallback and cleanup', {
  skip: !enabled, timeout: 600000,
}, t => {
  const sources = [{ name: 'utf7-signature-unavailable-encoding', format: 'srt',
    text: '+/v8-1\r\n00:00:01,180 --> 00:00:04,250\r\nOrdinary subtitle text\r\n' }];
  const scenarios = { schemaVersion: 1, sources, conversions: ['srt', 'vtt', 'json'].map(format => ({
    source: sources[0].name, format, name: sources[0].name + '-' + format, start: '0', end: '0', copy: true,
  })) };
  return runSubtitleTextScenario(t, { prefix: 'subtitle-unavailable-charset-current', scenarios, fixtureFiles });
});
