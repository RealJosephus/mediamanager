import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { copyFile, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { SqliteDatabase } from '../../../../src/database/sqlite.js';
import { nativeModel } from '../../../../src/database/model.js';
import { nativeTextBytes } from '../../../../src/database/native-text.js';
import { canonicalCell } from '../../../../src/database/values.js';
import { databaseDigest, getNativeEnvelope } from '../../../../src/migration/database-transfer.js';
import { nativeGuid } from '../../../../src/users/native.js';
import { dateTicks } from '../../../../src/library/records.js';

export const sha = value => createHash('sha256').update(value).digest('hex');
export const idKey = value => String(value).replaceAll('-', '').toLowerCase();
export const databaseFilename = root => path.join(root, 'data/data/jellyfin.db');
export const photoBytes = await readFile(new URL('../../../images/fixtures/processor/single.png', import.meta.url));
export const inputBytes = await readFile(new URL('./input.json', import.meta.url));
export const input = JSON.parse(inputBytes);

export const unusedPort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject).listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(error => error ? reject(error) : resolve(port));
  });
});
export const portAvailable = port => new Promise(resolve => {
  const server = createServer();
  server.once('error', () => resolve(false)).listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
});

export function ownedPath(root, filename) {
  const resolved = path.resolve(filename), relative = path.relative(path.resolve(root), resolved);
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    'Exchange writes must stay below the private fixture root.');
  return resolved;
}

export async function optionalFile(filename) {
  try {
    const info = await lstat(filename);
    assert.ok(info.isFile() && !info.isSymbolicLink(), 'Exchange assets must be ordinary owned files.');
    const bytes = await readFile(filename);
    return { bytes: bytes.length, sha256: sha(bytes) };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function stoppedDatabase(filename) {
  assert.ok(await optionalFile(filename));
  for (const suffix of ['-wal', '-journal']) {
    const journal = await optionalFile(filename + suffix);
    assert.ok(!journal || journal.bytes === 0, 'A stopped SQLite transfer cannot omit pending journal bytes.');
  }
}

// The same-run supplied instance contains two documented synthetic scaffold
// rows. Remove only those rows on the new private clone before its first boot;
// the business photos below are created by the real Native resolver and scan.
export function removeSyntheticPreparation(instanceRoot) {
  const database = new SqliteDatabase(databaseFilename(instanceRoot), { requireMigrationHistory: true });
  try {
    const movie = database.rows('BaseItems', { where: { Id: '22222222-2222-2222-2222-222222222222' } });
    const folder = database.rows('BaseItems', { where: { Id: '11111111-1111-1111-1111-111111111111' } });
    assert.equal(movie.length, 1); assert.equal(folder.length, 1);
    assert.equal(movie[0].Path, 'Z:\\SyntheticMedia\\feature.mkv');
    assert.equal(folder[0].Path, 'Z:\\SyntheticMedia');
    assert.equal(movie[0].ParentId.toLowerCase(), folder[0].Id.toLowerCase());
    database.transaction(() => {
      database.delete('BaseItems', { Id: movie[0].Id });
      database.delete('BaseItems', { Id: folder[0].Id });
    });
    return { beforeFirstNativeStartup: true, removed: [...movie, ...folder] };
  } finally { database.close(); }
}

export async function createMedia(root) {
  const mediaRoot = ownedPath(root, path.join(root, 'media'));
  await mkdir(mediaRoot);
  const files = input.photos.map(name => path.join(mediaRoot, name + '.png'));
  for (const filename of files) await writeFile(filename, photoBytes, { flag: 'wx' });
  const sibling = path.join(mediaRoot, 'sibling.keep');
  await writeFile(sibling, input.assetText, { flag: 'wx' });
  return { root: mediaRoot, files, sibling };
}

export async function addOpaquePreparation(instanceRoot, opaqueId) {
  const database = new SqliteDatabase(databaseFilename(instanceRoot), { requireMigrationHistory: true });
  let data;
  try {
    const [item] = database.rows('BaseItems', { where: { Id: nativeGuid(opaqueId) } });
    assert.equal(item.Type, 'MediaBrowser.Controller.Entities.Photo');
    assert.equal(typeof item.Data, 'string');
    const parsed = JSON.parse(item.Data);
    assert.equal(Object.hasOwn(parsed, 'ExchangeUnknown'), false);
    const end = item.Data.lastIndexOf('}');
    assert.ok(end >= 0 && item.Data.slice(end + 1).trim() === '');
    data = item.Data.slice(0, end) + (Object.keys(parsed).length ? ',' : '') + '\n' + input.opaqueMember + '\n' + item.Data.slice(end);
    database.update('BaseItems', { Id: item.Id }, { Data: data });
  } finally { database.close(); }
  const filename = path.join(instanceRoot, 'data/data/deletion-exchange-unknown/opaque.bin');
  await mkdir(path.dirname(filename));
  await writeFile(filename, Buffer.from([0, 255, 128, 42, 0, 13, 10]), { flag: 'wx' });
  return { opaqueId, dataHex: Buffer.from(data, 'utf8').toString('hex'), filename, file: await optionalFile(filename),
    preparation: 'One unknown Data member and an unrelated binary state asset added only to the stopped private clone.' };
}

const unboundItemRelations = new Set(['CustomItemDisplayPreferences', 'ItemDisplayPreferences', 'MediaSegments', 'TrickplayInfos']);
const itemRelations = nativeModel.tables.flatMap(table => {
  const columns = [...new Set(table.foreignKeys.filter(key => key.table === 'BaseItems').flatMap(key => key.columns))];
  if (table.name === 'BaseItems') columns.unshift('Id');
  if (unboundItemRelations.has(table.name) && !columns.includes('ItemId')) columns.push('ItemId');
  return columns.length ? [{ table, columns }] : [];
});

export async function itemSnapshot(database, ids) {
  const nativeIds = ids.map(nativeGuid);
  const items = [], relations = {};
  for (const id of nativeIds) {
    const [item] = await database.rows('BaseItems', { where: { Id: id } });
    const [raw] = await database.rows('BaseItems', { where: { Id: id }, columns: ['Data'], consumer: 'exchange' });
    items.push({ id: idKey(id), item: item ?? null,
      dataHex: raw?.Data == null ? null : nativeTextBytes(raw.Data).toString('hex') });
  }
  for (const { table, columns } of itemRelations) {
    const rows = await database.rows(table.name, { whereAny: Object.fromEntries(columns.map(column => [column, nativeIds])), consumer: 'exchange' });
    relations[table.name] = rows.map(row => table.columns.map(column => canonicalCell(row[column.name])));
  }
  return { items, relations };
}

export async function userDataSnapshot(database, ids) {
  return await database.rows('UserData', { whereIn: { ItemId: ids.map(nativeGuid) } });
}

export async function assertUserDataRetention(database, initial, removedIds) {
  const result = [], removed = new Set(removedIds.map(idKey));
  for (const original of initial) {
    const rows = await database.rows('UserData', { where: { UserId: original.UserId, CustomDataKey: original.CustomDataKey } });
    assert.equal(rows.length, 1, 'Every original favorite must remain uniquely attached or retained.');
    const [row] = rows;
    if (removed.has(idKey(original.ItemId))) {
      assert.equal(idKey(row.ItemId), '00000000000000000000000000000001');
      assert.equal(typeof row.RetentionDate, 'string');
      assert.ok(dateTicks(row.RetentionDate) > 0n);
      assert.deepEqual({ ...row, ItemId: original.ItemId, RetentionDate: original.RetentionDate }, original);
    } else assert.deepEqual(row, original);
    result.push(row);
  }
  return result;
}

export async function completeSnapshot(database) {
  const envelope = await getNativeEnvelope(database);
  const tables = await databaseDigest(database);
  assert.deepEqual(tables.map(table => table.name), nativeModel.tables.map(table => table.name));
  if (database.dialect === 'sqlite') {
    assert.deepEqual(database.schema.tables.map(table => table.name).sort(),
      [...nativeModel.tables.map(table => table.name), '__EFMigrationsHistory', '__EFMigrationsLock'].sort());
    assert.deepEqual(database.database.prepare('SELECT * FROM "__EFMigrationsLock"').all(), []);
  }
  return { tables, migrationHistory: envelope.history, sqliteSequence: envelope.sqliteSequence,
    nativeSchemaFingerprint: envelope.fingerprint };
}

export function assertRemoved(snapshot, ids) {
  assert.deepEqual(snapshot.items.map(value => value.id), ids.map(idKey));
  assert.ok(snapshot.items.every(value => value.item === null));
  for (const [table, rows] of Object.entries(snapshot.relations)) assert.deepEqual(rows, [], `${table} must not retain references to deleted items.`);
}

export async function imageFiles(database, ids, instanceRoot, privateRoot) {
  const rows = await database.rows('BaseItemImageInfos', { whereIn: { ItemId: ids.map(nativeGuid) } });
  return await Promise.all(rows.map(async row => {
    const filename = ownedPath(privateRoot, row.Path
      .replaceAll('%MetadataPath%', path.join(instanceRoot, 'data/metadata'))
      .replaceAll('%AppDataPath%', path.join(instanceRoot, 'data/data')));
    const file = await optionalFile(filename);
    assert.ok(file, 'Every recorded image relation must reference a real private asset.');
    return { itemId: idKey(row.ItemId), imageId: row.Id, imageType: row.ImageType, path: filename, file };
  }));
}

export async function assertAssets(media, images, opaque, removed) {
  const observation = { media: [], images: [], sibling: await optionalFile(media.sibling), opaque: await optionalFile(opaque.filename) };
  for (let index = 0; index < media.files.length; index++) {
    const file = await optionalFile(media.files[index]);
    assert.deepEqual(file, removed.includes(index) ? null : { bytes: photoBytes.length, sha256: sha(photoBytes) });
    observation.media.push({ path: media.files[index], file });
  }
  for (const image of images) {
    const file = await optionalFile(image.path);
    assert.deepEqual(file, removed.some(index => image.itemId === media.ids[index]) ? null : image.file,
      'Deletion must remove only the requested item source and internal images.');
    observation.images.push({ ...image, file });
  }
  assert.deepEqual(observation.sibling, { bytes: Buffer.byteLength(input.assetText), sha256: sha(input.assetText) });
  assert.deepEqual(observation.opaque, opaque.file);
  return observation;
}

export async function installStoppedExport({ root, instanceRoot, exported }) {
  const destination = ownedPath(root, databaseFilename(instanceRoot));
  ownedPath(root, exported);
  await stoppedDatabase(destination); await stoppedDatabase(exported);
  await rename(destination, ownedPath(root, path.join(root, 'native-before-node-export.db')));
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { await unlink(ownedPath(root, destination + suffix)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await copyFile(exported, destination, constants.COPYFILE_EXCL);
  assert.deepEqual(await optionalFile(destination), await optionalFile(exported));
}

export function responseProjection(response) {
  if (!response.contentType?.startsWith('application/json')) return { status: response.status, contentType: response.contentType, body: response.bodyText };
  assert.ok(Object.hasOwn(response, 'bodyJson'), 'An advertised JSON response must contain a valid JSON body.');
  const body = structuredClone(response.bodyJson);
  if (body && Object.hasOwn(body, 'traceId')) {
    assert.match(body.traceId, /^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/u);
    assert.equal(response.bodyText.split(body.traceId).length, 2);
    body.traceId = '$TRACE';
  }
  return { status: response.status, contentType: response.contentType, body };
}
