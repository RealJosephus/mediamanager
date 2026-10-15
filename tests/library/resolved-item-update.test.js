import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseLosslessJson } from '../../src/core/json.js';
import { updateFromResolvedItem } from '../../src/library/resolved-item-update.js';
import { VIDEO_TYPES } from '../../src/library/records.js';
import { assertProjectedEqual } from '../comparison-observations.js';
const functional = ({ assignment, ...value }) => value;

const root = new URL('./fixtures/resolved-item-update/', import.meta.url);
const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(async name => parseLosslessJson(await readFile(new URL(name, root), 'utf8'))));
const emptyStrings = Object.freeze([]);
const hydrate = value => Object.fromEntries(Object.entries(structuredClone(value))
  .map(([field, entry]) => [field, Array.isArray(entry) && !entry.length ? emptyStrings : entry]));
const videoType = value => typeof value === 'number' ? ['VideoFile', 'Iso', 'Dvd', 'BluRay'][value] ?? String(value) : value ?? 'VideoFile';
const capture = item => ({
  ...Object.fromEntries(['Type', 'Name', 'Path', 'IsInMixedFolder', 'ProductionYear', 'RunTimeTicks', 'IndexNumber', 'Overview', 'ProviderIds']
    .map(field => [field, item[field]])),
  VideoType: VIDEO_TYPES.has(item.Type) ? videoType(item.VideoType) : null,
  AdditionalParts: VIDEO_TYPES.has(item.Type) ? item.AdditionalParts : null,
  LocalAlternateVersions: VIDEO_TYPES.has(item.Type) ? item.LocalAlternateVersions : null
});
const invoke = (current, resolved) => {
  try { return { updateType: updateFromResolvedItem(current, resolved), exception: null, parameter: null }; }
  catch (error) { return { updateType: null, exception: error.nativeException ?? error.name, parameter: error.parameterName ?? null }; }
};

test('resolved-item controls bind actual native methods, precise Int64 inputs and source files', async () => {
  for (const file of Object.values(provenance.files)) {
    assert.equal(createHash('sha256').update(await readFile(new URL('../../' + file.path, import.meta.url))).digest('hex'), file.sha256, file.path);
  }
  assert.equal(native.actualNativeUpdateFromResolvedItem, true);
  assert.equal(native.candidateVerified, false);
  assert.equal(provenance.candidateVerified, false);
  assert.ok(Object.values(provenance.sources).every(value => /^[a-f0-9]{64}$/u.test(value)));
  assert.equal(native.results.length, 86);
  assert.deepEqual(native.results.map(value => value.name), input.map(value => value.name));
  assert.equal(input[0].current.RunTimeTicks, 9223372036854775807n);
  assert.equal(native.results[0].after.RunTimeTicks, 9223372036854775807n);
});

for (const sample of input) test(`resolved item update matches native ${sample.name}`, t => {
  const expected = native.results.find(value => value.name === sample.name);
  const current = hydrate(sample.current), resolved = hydrate(sample.resolved);
  const first = invoke(current, resolved), after = capture(current);
  const assignment = VIDEO_TYPES.has(current.Type) && VIDEO_TYPES.has(resolved.Type) ? {
    additionalParts: current.AdditionalParts === resolved.AdditionalParts,
    alternateVersions: current.LocalAlternateVersions === resolved.LocalAlternateVersions
  } : null;
  const repeat = invoke(current, resolved);
  assertProjectedEqual(t, sample.name, { name: sample.name, first, after, assignment, repeat }, expected, functional);
});

test('the resolved-item comparison rejects metadata overwrite, lost precision, case folding and changed flags', () => {
  const expected = native.results.find(value => value.name === 'Movie-combined');
  for (const mutate of [
    value => { value.after.Name = 'Resolved name'; },
    value => { value.after.RunTimeTicks = 9223372036854775806n; },
    value => { value.first.updateType = 2; },
    value => { value.after.LocalAlternateVersions = ['v']; },
    value => { value.repeat.updateType = 3; }
  ]) {
    const changed = structuredClone(expected);
    mutate(changed);
    assert.throws(() => assert.deepEqual(changed, expected), assert.AssertionError);
  }
});
