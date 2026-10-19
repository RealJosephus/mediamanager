import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { expandPostgresPlayItems } from '../../src/library/playback-items.js';
import { fixture, fixtureSha256, cases, openInstantMixFixture, observeInstantMix,
  assertInstantMix, writeInstantMixEvidence } from './instant-mix-fixture.js';

test('InstantMix fixture binds actual MusicManager and UserView execution to the designated source', async () => {
  const provenance = JSON.parse(await readFile(new URL('./fixtures/instant-mix/provenance.json', import.meta.url), 'utf8'));
  assert.equal(fixtureSha256, provenance.nativeSha256);
  assert.equal(provenance.build.status, 0);
  assert.equal(provenance.process.status, 0);
  assert.equal(provenance.completeBuildInputClosure, false);
  assert.equal(provenance.phaseAcceptance, false);
  assert.equal(provenance.cases, 66);
  assert.equal(fixture.observations.length, 66);
  assert.equal(fixture.actualMusicManager, true);
  assert.equal(fixture.actualUserViewBuilder, true);
  assert.equal(fixture.databaseOpened, false);
  assert.equal(fixture.portOpened, false);
  for (const source of provenance.oracleSources) {
    const filename = source.name === 'Directory.Build.props' ? '../Directory.Build.props' : `./fixtures/instant-mix/${source.name}`;
    assert.equal(createHash('sha256').update(await readFile(new URL(filename, import.meta.url))).digest('hex'), source.sha256);
  }
  const book = fixture.observations.find(entry => entry.name === 'audio-book');
  assert.equal(book.ids[0], book.Id);
  assert.equal(book.calls.at(-1).Limit, 200);
  assert.deepEqual(book.calls.at(-1).includeItemTypes, ['Audio']);
  const selected = fixture.observations.find(entry => entry.name === 'tvshowseries-selected');
  assert.equal(selected.failure.type, 'System.InvalidCastException');
  assert.ok(!selected.calls.some(call => call.random));
});

test('postgres: InstantMix audio inheritance and view empty/error branches match actual native execution', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const state = await openInstantMixFixture(process.env.MEDIAMANAGER_TEST_POSTGRES);
  const observations = [];
  t.after(() => state.close());
  try {
    for (const entry of cases) {
      await t.test(entry.name, async () => {
        const observation = await observeInstantMix(state, entry, expandPostgresPlayItems);
        observations.push(observation);
        assertInstantMix(entry, observation);
      });
    }
  } finally { await writeInstantMixEvidence(observations, { cases: cases.length }); }
});
