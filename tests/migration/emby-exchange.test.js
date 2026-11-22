import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { writeEmby } from '../../src/migration/emby/write-emby.js';
import { translatedRows } from '../../src/migration/emby/identities.js';
import { changesBetween } from '../../src/migration/emby/reconcile.js';
import { collectAssets, projectAssetRows } from '../../src/migration/emby/assets.js';
import { editObjectFields, fromBlob, toBlob } from '../../src/migration/emby/format.js';
import { mergeAssets } from '../../src/migration/emby/files.js';
import { markerProviderId, readMarkers, reserveChapterIndexes, writeMarker } from '../../src/migration/emby/chapter-markers.js';

function markerFixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE Chapters3(ItemId INTEGER,ChapterIndex INTEGER,StartPositionTicks INTEGER,Name TEXT,
      ImagePath TEXT,ImageDateModified INTEGER,MarkerType INTEGER,PRIMARY KEY(ItemId,ChapterIndex));
    CREATE TABLE MediaSegments(Id TEXT PRIMARY KEY,ItemId TEXT,Type INTEGER,StartTicks INTEGER,EndTicks INTEGER,SegmentProviderId TEXT);
    CREATE TABLE ItemExtradataTypes(ExtradataTypeId INTEGER,Name TEXT);
    CREATE TABLE ItemExtradata(ItemId INTEGER,ExtradataTypeId INTEGER);
    INSERT INTO ItemExtradataTypes VALUES(7,'IntroDetectionExtradata'),(8,'Other');
    INSERT INTO ItemExtradata VALUES(1,7),(1,8);
  `);
  const issues = [], report = (...issue) => issues.push(issue);
  const read = (type, runtime) => {
    const item = { RunTimeTicks: runtime, IntroSkip: null, CreditsSkip: null };
    readMarkers(db, type, new Map([[type === 'emby' ? 1n : 'movie', item]]), () => 'movie', report);
    return item;
  };
  return { db, read, issues, report };
}

test('typed intro boundaries preserve exact ticks, native identity, ordinary chapters and private marker metadata', t => {
  const { db, read, report } = markerFixture(t);
  const end = 9007199254740993n, runtime = String(end + 100n);
  db.exec("INSERT INTO Chapters3 VALUES(1,0,0,'Chapter',NULL,NULL,NULL),(1,1,0,'Opening','poster',123,1),(1,16,9007199254740993,'Cut',NULL,NULL,2)");
  const original = read('emby', runtime);
  assert.deepEqual(original.IntroSkip, { StartTicks: '0', EndTicks: String(end) });
  writeMarker(db, 'jellyfin', 'movie', 'id', 'IntroSkip', original.IntroSkip, null, runtime, report);
  const inserted = db.prepare('SELECT Id,SegmentProviderId FROM MediaSegments').get();
  assert.equal(inserted.SegmentProviderId, markerProviderId);
  db.prepare("UPDATE MediaSegments SET EndTicks=?,SegmentProviderId='existing provider'").run(end - 4n);
  const edited = read('jellyfin', runtime);
  writeMarker(db, 'emby', 1, 'id', 'IntroSkip', edited.IntroSkip, original, runtime, report);
  assert.deepEqual(read('emby', runtime).IntroSkip, edited.IntroSkip);
  reserveChapterIndexes(db, 1, [{ ChapterIndex: 0 }, { ChapterIndex: 1 }]);
  const point = db.prepare('SELECT * FROM Chapters3 WHERE MarkerType=1').get();
  assert.deepEqual([point.Name, point.ImagePath, point.ImageDateModified], ['Opening', 'poster', 123]);
  assert.notEqual(point.ChapterIndex, 1);
  assert.equal(db.prepare('SELECT ExtradataTypeId FROM ItemExtradata').get().ExtradataTypeId, 8);
  writeMarker(db, 'jellyfin', 'movie', 'id', 'IntroSkip', original.IntroSkip, edited, runtime, report);
  assert.deepEqual({ ...db.prepare('SELECT Id,SegmentProviderId FROM MediaSegments').get() },
    { Id: inserted.Id, SegmentProviderId: 'existing provider' });
  writeMarker(db, 'emby', 1, 'id', 'IntroSkip', null, edited, runtime, report);
  assert.deepEqual(db.prepare('SELECT Name FROM Chapters3').all().map(r => r.Name), ['Chapter']);
});

test('a sole credits start has no known end; only an explicit policy or an existing native tail provides one', t => {
  const { db, read, issues, report } = markerFixture(t);
  db.exec("INSERT INTO Chapters3 VALUES(1,10,70,'Credits Start',NULL,NULL,3)");
  const start = read('emby', null).CreditsSkip;
  assert.deepEqual(start, { StartTicks: '70', EndTicks: null });
  const write = (runtime, policy) => writeMarker(db, 'jellyfin', 'movie', 'id', 'CreditsSkip', start,
    read('jellyfin', runtime), runtime, report, policy);
  write('100');
  write(null, 'runtime');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM MediaSegments').get().n, 0);
  assert.equal(issues.at(-1)[0], 'origin-only');
  write('100', 'runtime');
  assert.equal(issues.at(-1)[0], 'inferred');
  db.exec("UPDATE MediaSegments SET StartTicks=82");
  write('100');
  assert.deepEqual(read('jellyfin', '100').CreditsSkip, { StartTicks: '70', EndTicks: '100' });
  db.exec("UPDATE MediaSegments SET EndTicks=87");
  write('100', 'runtime');
  assert.equal(issues.at(-1)[0], 'conflict');
  assert.equal(db.prepare('SELECT EndTicks FROM MediaSegments').get().EndTicks, 87);
  assert.equal(Object.hasOwn(read('jellyfin', '100'), 'CreditsSkip'), false);
});

test('incomplete, repeated and future marker types never overwrite existing intervals', t => {
  const { db, read, issues, report } = markerFixture(t);
  db.exec("INSERT INTO Chapters3 VALUES(1,1,20,NULL,NULL,NULL,1),(1,2,50,NULL,NULL,NULL,3),(1,3,62,NULL,NULL,NULL,9)");
  assert.equal(Object.hasOwn(read('emby', '80'), 'IntroSkip'), false);
  assert.equal(Object.hasOwn(read('emby', '80'), 'CreditsSkip'), false);
  db.exec("INSERT INTO Chapters3 VALUES(1,4,9,NULL,NULL,NULL,2)");
  assert.equal(Object.hasOwn(read('emby', '80'), 'IntroSkip'), false);
  db.exec("UPDATE Chapters3 SET StartPositionTicks=24 WHERE MarkerType=2; INSERT INTO Chapters3 VALUES(1,5,22,NULL,NULL,NULL,2)");
  assert.equal(Object.hasOwn(read('emby', '80'), 'IntroSkip'), false);
  db.exec("INSERT INTO MediaSegments VALUES('1','movie',5,1,5,'a'),('2','movie',5,1,5,'b'),('3','movie',3,0,1,'a')");
  const target = read('jellyfin', '80');
  writeMarker(db, 'jellyfin', 'movie', 'id', 'IntroSkip', null, target, '80', report);
  assert.equal(issues.at(-1)[0], 'conflict');
  assert.deepEqual(db.prepare('SELECT Id FROM MediaSegments ORDER BY Id').all().map(r => r.Id), ['1', '2', '3']);
  assert.ok(issues.some(issue => issue[3] === 'MediaSegments.Type' && issue[4] === '3'));
});

test('marker reconciliation distinguishes a first import, ambiguous points, independent edits and legacy ordinary chapters', () => {
  const m = row => new Map(row ? [['item/id', row]] : []);
  const a = { StartTicks: '1', EndTicks: '5' }, b = { ...a, EndTicks: '7' }, c = { ...a, EndTicks: '9' };
  const issues = [], plan = (s, t, oldS, oldT) =>
    changesBetween(m(s), m(t), m(oldS), m(oldT), (...i) => issues.push(i), { legacyChapters: true });
  assert.deepEqual(plan({ IntroSkip: a }, { IntroSkip: null }, {}, {})[0].fields, ['IntroSkip']);
  assert.deepEqual(plan({ IntroSkip: null }, { IntroSkip: a }, {}, {}), []);
  assert.deepEqual(plan({}, { IntroSkip: a }, { IntroSkip: a }, { IntroSkip: a }), []);
  assert.deepEqual(plan({ IntroSkip: null }, { IntroSkip: a }, { IntroSkip: a }, { IntroSkip: a })[0].fields, ['IntroSkip']);
  assert.deepEqual(plan({ IntroSkip: b }, { IntroSkip: c }, { IntroSkip: a }, { IntroSkip: a }), []);
  assert.equal(issues.at(-1)[0], 'conflict');
  const old = [{ Name: 'Custom', ChapterIndex: 1 }], after = [{ ...old[0], ImageDateModified: null }];
  assert.deepEqual(plan({ Chapters: after }, { Chapters: [] }, { Chapters: old }, { Chapters: old }), []);
});

test('each side has its own baseline; divergent edits and deletion keep the target', () => {
  const map = (row) => new Map(row ? [['item/id', row]] : []),
    reports = [];
  const source = { Name: 'original', Length: '9007199254740993' },
    target = { Name: 'source name rounded', Length: '200' };
  const plan = (a, b) =>
    changesBetween(map(a), map(b), map(source), map(target), (...args) => reports.push(args));
  assert.deepEqual(plan(source, { ...target, Name: 'edited B' }), []);
  assert.deepEqual(plan({ ...source, Length: '9007199254740995' }, { ...target, Name: 'edited B' })[0].fields, [
    'Length',
  ]);
  assert.deepEqual(plan({ ...source, Name: 'edited A' }, { ...target, Name: 'edited B' }), []);
  assert.equal(reports.at(-1)[3], 'Name');
  assert.deepEqual(plan(null, { ...target, Name: 'edited B' }), []);
  assert.equal(reports.at(-1)[3], 'deletion');
  assert.deepEqual(plan(null, target), [{ key: 'item/id', value: null, fields: [] }]);
});
test('editing a media container preserves unknown 64-bit values and duplicate JSON keys', () => {
  const original = '{"Unknown":90071992547409935, "X":1,"X":2, "Container":"old" }';
  assert.equal(
    editObjectFields(original, { Container: 'wav', IndexNumberEnd: 2 }),
    original.replace('"old"', '"wav"').replace('}', ',"IndexNumberEnd":2}'),
  );
});

test('both stream projections translate native kinds by meaning and preserve unknown or occupied indexes', () => {
  const records = streams => streams && new Map([['item/movie', { Streams: streams }]]);
  const stream = (index, type, title) => ({ StreamIndex: index, StreamType: type, Title: title });
  const read = (sourceType, input, target, beforeSource, beforeTarget) => {
    const issues = [];
    const result = changesBetween(records(input), records(target) ?? new Map(), records(beforeSource) ?? new Map(),
      records(beforeTarget) ?? new Map(), (...args) => issues.push(args), { sourceType });
    return { streams: result[0]?.value.Streams, issues: issues.map(i => [i[0], i[3]]) };
  };
  const jellyfin = [0, 1, 2, 3, 4].map((kind, i) => stream(i, kind, String(i)));
  const emby = [1, 2, 3, 4, 6].map((kind, i) => stream(i, kind, String(i)));
  assert.deepEqual(read('emby', emby), { streams: jellyfin, issues: [] });
  assert.deepEqual(read('jellyfin', jellyfin), { streams: emby, issues: [] });
  const attachment = stream(5, 5, 'font'), unknown = stream(6, 0, 'unknown'), future = stream(7, 17, 'future');
  for (const row of [attachment, unknown, future]) {
    assert.deepEqual(read('emby', [...emby, row]), { streams: jellyfin, issues: [['origin-only', 'Streams']] });
  }
  const lyric = stream(5, 5, 'lyrics');
  assert.deepEqual(read('jellyfin', [...jellyfin, lyric]), { streams: emby, issues: [['origin-only', 'Streams']] });
  const target = [attachment, future];
  assert.deepEqual(read('jellyfin', [stream(5, 0, 'song'), stream(8, 1, 'video')], target, [], target),
    { streams: [...target, stream(8, 2, 'video')], issues: [['conflict', 'Streams']] });

  // A pre-fix receipt copied Emby's video ordinal 2 into a Jellyfin subtitle slot.
  const wrong = [stream(0, 2, 'old')];
  assert.deepEqual(read('jellyfin', [stream(0, 2, 'edited')], wrong, wrong, wrong),
    { streams: undefined, issues: [['conflict', 'Streams']] });
  assert.deepEqual(read('jellyfin', [stream(0, 1, 'corrected')], wrong, wrong, wrong),
    { streams: [stream(0, 2, 'corrected')], issues: [] });
  assert.deepEqual(read('emby', emby, jellyfin, emby, jellyfin), { streams: undefined, issues: [] });
});
test('native .NET GUIDs use mixed endian fields', () => {
  const guid = '00112233-4455-6677-8899-AABBCCDDEEFF';
  assert.equal(toBlob(guid).toString('hex'), '33221100554477668899aabbccddeeff');
  assert.equal(fromBlob(toBlob(guid), 'unused'), guid);
});
test('an explicitly paired account can have different native login names at the two endpoints', () => {
  const source = new Map([['user/u', { Username: 'runner' }]]),
    target = new Map([['user/t', { Username: 'bridge' }]]);
  const map = { items: {}, users: { u: 't' } };
  assert.equal(translatedRows(source, map, target, true).get('user/t').Username, 'bridge');
  assert.equal(translatedRows(source, map, target, false).get('user/t').Username, 'runner');
});
test('a shared Emby playback key accepts agreed fields, preserves divergent progress, and deletes only after both items clear it', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(
    'CREATE TABLE MediaItems(Id INTEGER PRIMARY KEY,UserDataKeyId INTEGER); INSERT INTO MediaItems VALUES(1,13),(2,13); CREATE TABLE UserDatas(UserDataKeyId INTEGER,userId INTEGER,Played INTEGER,PlayCount INTEGER,IsFavorite INTEGER,PlaystateLastModified INTEGER,RatingLastModified INTEGER); INSERT INTO UserDatas VALUES(13,3,0,7,0,0,0)',
  );
  const catalog = {
    items: new Map([
      ['a', { Id: 1 }],
      ['b', { Id: 2 }],
    ]),
    users: new Map([['u', { Id: 3 }]]),
    shared: new Map([[13n, ['a', 'b']]]),
  };
  const left = 'play/a/u',
    right = 'play/b/u';
  const a = { IsFavorite: 1, PlayCount: 9 },
    b = { IsFavorite: 1, PlayCount: 11 };
  const source = {
      rows: new Map([
        [left, a],
        [right, b],
      ]),
    },
    report = [];
  const apply = (changes) => writeEmby(db, changes, catalog, source, (...e) => report.push(e));
  await apply([
    { key: left, value: a, fields: ['IsFavorite', 'PlayCount'] },
    { key: right, value: b, fields: ['IsFavorite', 'PlayCount'] },
  ]);
  assert.deepEqual(
    { ...db.prepare('SELECT IsFavorite,PlayCount FROM UserDatas').get() },
    { IsFavorite: 1, PlayCount: 7 },
  );
  assert.equal(report.length, 1);
  assert.equal(report[0][3], 'PlayCount');
  source.rows.delete(left);
  await apply([{ key: left, value: null, fields: [] }]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM UserDatas').get().n, 1);
  source.rows.delete(right);
  await apply([
    { key: left, value: null, fields: [] },
    { key: right, value: null, fields: [] },
  ]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM UserDatas').get().n, 0);
});
test('a stopped Emby custom metadata base and foreign sidecar paths become portable while preserving edits on both sides', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mm-asset-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const instance = path.join(root, 'source'),
    external = path.join(root, 'external'),
    physical = path.join(root, 'sidecars');
  await mkdir(path.join(instance, 'config'), { recursive: true });
  await mkdir(path.join(external, 'metadata'), { recursive: true });
  await mkdir(physical);
  const xml =
    '<ServerConfiguration><MetadataPath>' +
    external.replaceAll('&', '&amp;') +
    '</MetadataPath></ServerConfiguration>';
  await writeFile(path.join(instance, 'config', 'system.xml'), xml);
  await writeFile(path.join(external, 'metadata', 'poster.jpg'), 'first');
  await writeFile(path.join(physical, 'scene.en.srt'), 'captions');
  await writeFile(path.join(physical, 'scene.mkv'), 'media');
  const issues = [];
  const assets = await collectAssets({
    instance,
    original: instance,
    type: 'emby',
    stage: path.join(root, 'capture'),
    roots: [{ id: 'library', identityRoot: 'Z:\\Movies', directory: physical }],
    report: (...e) => issues.push(e),
  });
  assert.equal(await readFile(path.join(assets.directory, 'poster.jpg'), 'utf8'), 'first');
  await assert.rejects(readFile(path.join(assets.directory, 'migration-assets/library/scene.mkv')), {
    code: 'ENOENT',
  });
  const row = {
    Images: [{ Path: path.join(external, 'metadata', 'poster.jpg') }],
    Chapters: [],
    Streams: [{ Path: 'Z:\\Movies\\scene.en.srt', IsExternal: 1 }],
  };
  const result = await projectAssetRows(new Map([['item/id', row]]), assets, (...e) => issues.push(e));
  const value = result.rows.get('item/id');
  assert.equal(value.Images[0].Path, '%MetadataPath%' + path.sep + 'poster.jpg');
  assert.equal(
    value.Streams[0].Path,
    ['%MetadataPath%', 'migration-assets', 'library', 'scene.en.srt'].join(path.sep),
  );
  const to = path.join(root, 'published'),
    report = (...e) => issues.push(e);
  const first = await mergeAssets(assets.directory, to, undefined, undefined, report);
  await writeFile(path.join(assets.directory, 'poster.jpg'), 'source edit');
  await writeFile(path.join(to, 'poster.jpg'), 'target edit');
  await mergeAssets(assets.directory, to, first.source, first.target, report);
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0].slice(0, 4), ['conflict', 'asset', 'poster.jpg', 'bytes']);
  assert.equal(await readFile(path.join(to, 'poster.jpg'), 'utf8'), 'target edit');
  assert.equal(await readFile(path.join(instance, 'config/system.xml'), 'utf8'), xml);
});
