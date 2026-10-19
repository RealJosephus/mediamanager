import test from 'node:test';
import assert from 'node:assert/strict';
import samples from './fixtures/probe-descriptive/oracle.json' with { type: 'json' };
import { descriptiveProbeInfo } from '../../src/storage/probe-tags.js';
import { parseExternalPath } from '../../src/storage/external-streams.js';
import { normalizeProbeChapters } from '../../src/storage/probe-metadata.js';

test('descriptive probe metadata and external names match the frozen native DLL oracle', async t => {
  for (const { input, expected } of samples) await t.test(input.name, () => {
    const actual = input.chapterNames ? normalizeProbeChapters(input.chapterNames.map(Name=>({Name,StartPositionTicks:0n}))).map(chapter=>chapter.Name) : input.filename ? parseExternalPath(input.filename, input.extra, input.type) : descriptiveProbeInfo(input.raw, { isAudio: input.isAudio });
    const projected = structuredClone(expected);
    if (projected?.People) projected.People = projected.People.map(({ Name, Type, Role }) => ({ Name, Type, Role }));
    assert.deepEqual(actual, projected);
  });
});
