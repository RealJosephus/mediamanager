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
