import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  chapterIntervals,
  matchingIntervals,
  recurringInterval,
  secondsPerHash,
} from '../../plugins/skip-segments/detection.js';
import {
  blocksSkipperAddition,
  projectSkipper,
  skipperLayout,
  skipperProvider,
  skipperRows,
  updateSkipperMarker,
} from '../../src/migration/intro-skipper.js';
import { mediaSegmentProviderId } from '../../src/library/media-segment-service.js';
import { writeMarker } from '../../src/migration/emby/chapter-markers.js';

test('exact chapter boundaries leave room for a cold open and a post-credits scene', () => {
  const names = ['Cold open', 'ＯＰ１', 'Main', '片尾曲', 'Stinger'];
  const rows = names.map((Name, i) => ({ Name, StartPositionTicks: BigInt(i) * 10000001n }));
  assert.deepEqual(chapterIntervals(rows, 50000005n), [
    { Type: 5, StartTicks: 10000001n, EndTicks: 20000002n },
    { Type: 4, StartTicks: 30000003n, EndTicks: 40000004n },
  ]);
  assert.deepEqual(chapterIntervals([{ Name: 'Opening', StartPositionTicks: 0n }], 100000000n), []);
  assert.deepEqual(chapterIntervals([{ Name: 'Opening the door', StartPositionTicks: 0n }], 100000000n), []);
});

function audio(seed, n) {
  let x = seed;
  return Array.from({ length: n }, () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return x >>> 0;
  });
}
test('recurring audio is aligned per episode, rejects silence, duplicates and competing themes, and retains trailing scenes', () => {
  const theme = audio(18, 215),
    at = (offset, id, tail = 200) => [
      ...audio(id, offset),
      ...theme.map((x, i) => (x ^ (i % 16 === 1 ? 8 : 0)) >>> 0),
      ...audio(id + 107, tail),
    ];
  const target = { start: 100, hashes: at(75, 14) },
    peers = [36, 110].map((off, i) => ({ start: 95, hashes: at(off, 21 + i) }));
  const result = recurringInterval(target, peers, 4);
  assert.equal(result.Type, 4);
  assert.ok(Math.abs(Number(result.StartTicks) / 1e7 - (100 + 75 * secondsPerHash)) < 0.4);
  assert.ok(Math.abs(Number(result.EndTicks) / 1e7 - (100 + 290 * secondsPerHash)) < 0.4);
  assert.deepEqual(matchingIntervals(Array(400).fill(0), Array(400).fill(0), 180), []);
  assert.deepEqual(matchingIntervals(theme, theme, 180), []);
  assert.equal(recurringInterval(target, [peers[0], { start: 0, hashes: audio(5, 350) }], 5), null);
  const theme2 = audio(73, 205),
    double = (id) => [...at(70, id, 40), ...theme2, ...audio(id + 26, 53)];
  assert.equal(
    recurringInterval({ start: 0, hashes: double(48) }, [{ start: 0, hashes: double(65) }], 5),
    null,
  );
});

const item = '1B9CC117-5E5F-406A-80FD-11CEAD115117',
  first = '0AE10EC0-93A7-45B9-BE73-0C07DF9A371C';
function fixture(t, schema) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(
    "CREATE TABLE BaseItems(Id TEXT PRIMARY KEY); CREATE TABLE MediaSegments(Id TEXT PRIMARY KEY,ItemId TEXT,Type INTEGER,StartTicks INTEGER,EndTicks INTEGER,SegmentProviderId TEXT); ATTACH ':memory:' AS skipper;" +
      schema,
  );
  db.prepare('INSERT INTO BaseItems VALUES(?)').run(item);
  return db;
}
const modern =
  'CREATE TABLE skipper.Segments(Id TEXT PRIMARY KEY,ItemId TEXT,Type INTEGER,StartTicks INTEGER,EndTicks INTEGER,Source INTEGER,State INTEGER,ConfigHash TEXT,UpdatedAt TEXT);CREATE TABLE skipper.DisabledItems(ItemId TEXT PRIMARY KEY);CREATE TABLE skipper.ProjectionQueue(ItemId TEXT PRIMARY KEY,Version INTEGER,AttemptCount INTEGER,NextAttemptAt TEXT,Failure TEXT)';
test('Intro Skipper v2 mirrors the authoritative manual rows and suppression state, and returns edits to the private database', (t) => {
  const db = fixture(t, modern),
    issues = [],
    report = (...i) => issues.push(i);
  assert.equal(skipperLayout(db, 'skipper'), 'v2');
  assert.equal(skipperProvider, mediaSegmentProviderId('Intro Skipper'));
  const put = db.prepare("INSERT INTO skipper.Segments VALUES(?,?,?,?,?,?,?,'hash','2026-01-01')");
  put.run(first, item, 0, 10000001, 35000003, 2, 0);
  put.run('00000000-0000-0000-0000-000000000002', item, 1, 502, 602, 2, 1);
  put.run('00000000-0000-0000-0000-000000000003', item, 3, 1, 3, 5, 0);
  db.prepare("INSERT INTO MediaSegments VALUES('keep',?,1,0,3,'other')").run(item);
  projectSkipper(db, 'v2', report);
  assert.deepEqual(
    db
      .prepare('SELECT Type FROM MediaSegments ORDER BY Type')
      .all()
      .map((r) => r.Type),
    [1, 3, 5],
  );
  assert.equal(blocksSkipperAddition(db, 'v2', item, 4, { StartTicks: '500', EndTicks: '610' }), true);
  const old = { Id: first, ItemId: item, Type: 5, StartTicks: 10000001n, EndTicks: 35000003n };
  assert.ok(updateSkipperMarker(db, 'v2', old, { StartTicks: '10000001', EndTicks: '34000007' }, report));
  assert.deepEqual(
    { ...db.prepare('SELECT Source,ConfigHash,EndTicks FROM skipper.Segments WHERE Id=?').get(first) },
    { Source: 5, ConfigHash: '', EndTicks: 34000007 },
  );
  assert.equal(db.prepare('SELECT Version FROM skipper.ProjectionQueue').get().Version, 1);
  assert.equal(updateSkipperMarker(db, 'v2', old, null, report), false);
  assert.equal(issues.at(-1)[0], 'conflict');
  db.prepare('INSERT INTO skipper.DisabledItems VALUES(?)').run(item);
  assert.equal(blocksSkipperAddition(db, 'v2', item, 5, { StartTicks: '400', EndTicks: '410' }), true);
  assert.ok(updateSkipperMarker(db, 'v2', { ...old, EndTicks: 34000007n }, null, report));
  projectSkipper(db, 'v2', report);
  assert.deepEqual(
    db
      .prepare('SELECT Type FROM MediaSegments ORDER BY Type')
      .all()
      .map((r) => r.Type),
    [1, 3],
  );
  assert.equal(db.prepare('SELECT count(*) n FROM skipper.Segments WHERE State=1').get().n, 1);
});

test('legacy seconds use native truncation and preserve the existing Jellyfin segment GUID on writes', (t) => {
  const db = fixture(
    t,
    'CREATE TABLE skipper.DbSegment(ItemId TEXT,Type INTEGER,Start REAL,End REAL,PRIMARY KEY(ItemId,Type))',
  );
  db.prepare('INSERT INTO skipper.DbSegment VALUES(?,0,1.5,4.125)').run(item);
  db.prepare('INSERT INTO MediaSegments VALUES(?,?,5,15000000,41250000,?)').run(first, item, skipperProvider);
  projectSkipper(db, 'legacy', assert.fail);
  assert.equal(db.prepare('SELECT Id FROM MediaSegments').get().Id, first);
  assert.ok(
    updateSkipperMarker(
      db,
      'legacy',
      { Id: first, ItemId: item, Type: 5, StartTicks: 15000000n, EndTicks: 41250000n },
      { StartTicks: '17500000', EndTicks: '41250000' },
      assert.fail,
    ),
  );
  assert.equal([...skipperRows(db, 'legacy', 'skipper')][0].start, 17500000n);
});

test('an imported marker can be opened, edited and removed in Intro Skipper using either native layout', (t) => {
  const schema = modern + '; ALTER TABLE skipper.Segments ADD CreatedAt TEXT';
  const legacy =
    'CREATE TABLE skipper.DbSegment(Id INTEGER PRIMARY KEY,ItemId TEXT,Type INTEGER,Start REAL,End REAL,IsUserProvided INTEGER NOT NULL,ConfigHash TEXT NOT NULL)';
  for (const [layout, ddl] of [
    ['v2', schema],
    ['legacy', legacy],
  ]) {
    const db = fixture(t, ddl);
    const range = { StartTicks: '12500000', EndTicks: '32500000' };
    const change = (value, before) =>
      writeMarker(
        db,
        'jellyfin',
        item,
        item,
        'IntroSkip',
        value,
        { IntroSkip: before },
        50000000n,
        assert.fail,
        'preserve',
        layout,
      );
    change(range, null);
    const stored = db.prepare('SELECT Id,SegmentProviderId FROM MediaSegments').get();
    assert.equal(stored.SegmentProviderId, skipperProvider);
    projectSkipper(db, layout, assert.fail);
    assert.equal(db.prepare('SELECT Id FROM MediaSegments').get().Id, stored.Id);
    const edited = { ...range, EndTicks: '35000000' };
    change(edited, range);
    assert.equal([...skipperRows(db, layout, 'skipper')][0].end, 35000000n);
    change(null, edited);
    assert.equal([...skipperRows(db, layout, 'skipper')].length, 0);
  }
});
