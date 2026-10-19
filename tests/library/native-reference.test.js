import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { LibraryService } from '../../src/library/index.js';
import { projectStream, selectDefaultTracks, videoColorRange } from '../../src/library/media-streams.js';
import { stringifyNativeJson } from '../../src/core/json.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/reference-media.json', import.meta.url), 'utf8'));
const streamsFixture = JSON.parse(readFileSync(new URL('./fixtures/reference-streams.json', import.meta.url), 'utf8'));
const trackScenarios = JSON.parse(readFileSync(new URL('./fixtures/reference-track-selection.json', import.meta.url), 'utf8'));
const wire = value => JSON.parse(stringifyNativeJson(value));
const itemId = streamsFixture.expectedSource.Id;
const user = { ...fixture.user, Configuration: streamsFixture.user };

async function seedFixture(db, streams = false) {
  for (const [table, rows] of Object.entries(fixture.tables)) {
    const columns = tableDefinition(table).columns;
    const pending = [...rows], inserted = new Set();
    while (pending.length) {
      const index = table === 'BaseItems' ? pending.findIndex(row => [row.ParentId, row.OwnerId].every(id => !id || inserted.has(id))) : 0;
      assert.notEqual(index, -1, 'Native fixture relations require a missing parent.');
      const [row] = pending.splice(index, 1);
      await db.insert(table, Object.fromEntries(Object.entries(row).map(([name, value]) => [name, value != null && columns.find(column => column.name === name)?.type === 'INTEGER' && typeof value === 'string' ? BigInt(value) : value])));
      inserted.add(row.Id);
    }
  }
  if (streams) for (const row of streamsFixture.rows) await db.insert('MediaStreamInfos', row);
}

async function compareNative(db, streams) {
  const library = new LibraryService({fileSystem: testFileSystem,  store: new DomainStore(db), serverId: fixture.serverId, programDataPath: fixture.programDataPath });
  try {
    if (!streams) {
      for (const response of fixture.responses.filter(response => response.name !== 'item')) {
        const actual = await library.queryItems(new URL(response.route, 'http://127.0.0.1').searchParams, { user });
        assert.deepEqual(wire(actual), response.body, response.name);
      }
    }
    const dto = wire(await library.getItem(itemId, { user }));
    if (streams) {
      assert.deepEqual(dto.MediaStreams, streamsFixture.expectedStreams);
      assert.deepEqual(dto.MediaSources[0], streamsFixture.expectedSource);
    } else {
      const expected = fixture.responses.find(response => response.name === 'item').body;
      assert.deepEqual(dto, expected);
      assert.equal(dto.SortName, 'alpha zhong wen');
    }
    return dto;
  } finally {
    await library.close();
  }
}

test('recorded native queries and complete static media sources match',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const db = await createPostgresTestDatabase(t, 'native_reference_queries');
  await seedFixture(db); await compareNative(db, false);
});

test('seven native populated streams and source track defaults match actual isolated Jellyfin',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const db = await createPostgresTestDatabase(t, 'native_reference_streams');
  await seedFixture(db, true); await compareNative(db, true);
});

test('derived user root matches real native DTO with aligned initialization time',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const db = await createPostgresTestDatabase(t, 'native_reference_root');
  const expected = streamsFixture.expectedRoot;
  let library;
  try {
    await seedFixture(db);
    library = new LibraryService({fileSystem: testFileSystem,  store: new DomainStore(db), serverId: fixture.serverId, programDataPath: path.win32.dirname(path.win32.dirname(expected.Path)), clock: () => ({ toISOString: () => expected.DateCreated }) });
    assert.deepEqual(wire(await library.getRoot({ user })), expected);
  } finally { await library?.close(); }
});

test('actual native Smart, OnlyForced, Always and None selection and subtitle scores match', () => {
  for (const { configuration, source: expected } of trackScenarios) {
    const source = { MediaStreams: streamsFixture.rows.map(row => projectStream(row)) };
    selectDefaultTracks(source, { MediaType: 'Video' }, { Configuration: configuration });
    assert.deepEqual(wire(source.MediaStreams), expected.MediaStreams, configuration.SubtitleMode);
    assert.equal(source.DefaultAudioStreamIndex, expected.DefaultAudioStreamIndex);
    assert.equal(source.DefaultSubtitleStreamIndex, expected.DefaultSubtitleStreamIndex);
  }
});

test('remembered subtitle selection cannot restore an unforced track in OnlyForced mode', () => {
  const source = { MediaStreams: streamsFixture.rows.map(row => projectStream(row)) };
  const config = { ...streamsFixture.user, SubtitleMode: 'OnlyForced', SubtitleLanguagePreference: 'zho' };
  selectDefaultTracks(source, { MediaType: 'Video' }, { Configuration: config }, { SubtitleStreamIndex: 3, AudioStreamIndex: 2 });
  assert.equal(source.DefaultSubtitleStreamIndex, 4);
  assert.equal(source.DefaultAudioStreamIndex, 2);
  const valid = { MediaStreams: streamsFixture.rows.map(row => projectStream(row)) };
  selectDefaultTracks(valid, { MediaType: 'Video' }, { Configuration: config }, { SubtitleStreamIndex: -1 });
  assert.equal(valid.DefaultSubtitleStreamIndex, -1);
  assert.equal(valid.MediaStreams.some(stream => stream.Score != null), false);
  assert.deepEqual(videoColorRange({ Type: 'Video', DvProfile: 8, RpuPresentFlag: 1, BlPresentFlag: 1, DvBlSignalCompatibilityId: 1, ColorTransfer: 'smpte2084' }), ['HDR', 'DOVIInvalid']);
});
