import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SqliteDatabase } from '../../../../src/database/sqlite.js';
import { nativeModel } from '../../../../src/database/model.js';
import { nativeTextBytes } from '../../../../src/database/native-text.js';
import { canonicalCell } from '../../../../src/database/values.js';
import { databaseDigest, getNativeEnvelope } from '../../../../src/migration/database-transfer.js';
import { nativeGuid } from '../../../../src/users/native.js';
import { readXml, textOf } from '../../../../src/core/xml.js';

export const sha = value => createHash('sha256').update(value).digest('hex');
export const idKey = value => String(value).replaceAll('-', '').toLowerCase();
export const databaseFilename = root => path.join(root, 'data/data/jellyfin.db');
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
  assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative),
    'Music exchange writes must stay below their private root.');
  return resolved;
}
export async function optionalFile(filename) {
  try {
    const info = await lstat(filename);
    assert.ok(info.isFile() && !info.isSymbolicLink(), 'Music exchange assets must be ordinary owned files.');
    const bytes = await readFile(filename);
    return { bytes: bytes.length, sha256: sha(bytes) };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function stoppedDatabase(filename) {
  assert.ok(await optionalFile(filename));
  for (const suffix of ['-wal', '-journal']) {
    const journal = await optionalFile(filename + suffix);
    assert.ok(!journal || journal.bytes === 0, 'A stopped transfer cannot omit pending journal bytes.');
  }
}

// Remove only the two documented preparation rows, before the private clone's
// first boot. Every music entity below must be created by an actual scanner.
export function removeSyntheticPreparation(instanceRoot) {
  const database = new SqliteDatabase(databaseFilename(instanceRoot), { requireMigrationHistory: true });
  try {
    const movie = database.rows('BaseItems', { where: { Id: '22222222-2222-2222-2222-222222222222' } });
    const folder = database.rows('BaseItems', { where: { Id: '11111111-1111-1111-1111-111111111111' } });
    assert.equal(movie.length, 1); assert.equal(folder.length, 1);
    assert.equal(movie[0].Path, 'Z:\\SyntheticMedia\\feature.mkv');
    assert.equal(folder[0].Path, 'Z:\\SyntheticMedia');
    assert.equal(idKey(movie[0].ParentId), idKey(folder[0].Id));
    database.transaction(() => { database.delete('BaseItems', { Id: movie[0].Id }); database.delete('BaseItems', { Id: folder[0].Id }); });
    return { beforeFirstNativeStartup: true, removed: [...movie, ...folder] };
  } finally { database.close(); }
}

function riffChunk(name, data) {
  const header = Buffer.alloc(8);
  header.write(name, 0, 4, 'ascii'); header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, Buffer.alloc(data.length % 2)]);
}
export function waveBytes(track) {
  const format = Buffer.alloc(16), samples = input.sampleRate * track.seconds;
  format.writeUInt16LE(1, 0); format.writeUInt16LE(1, 2);
  format.writeUInt32LE(input.sampleRate, 4); format.writeUInt32LE(input.sampleRate * 2, 8);
  format.writeUInt16LE(2, 12); format.writeUInt16LE(16, 14);
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index++) pcm.writeInt16LE(((index * (track.number + 1)) % 64 - 32) * 128, index * 2);
  const tags = { INAM: track.title, IART: input.artist, IPRD: input.album,
    ITRK: String(track.number), ICRD: String(input.year), IGNR: input.genre };
  const info = Buffer.concat([Buffer.from('INFO'), ...Object.entries(tags)
    .map(([name, value]) => riffChunk(name, Buffer.from(value + '\0', 'ascii')))]);
  const body = Buffer.concat([Buffer.from('WAVE'), riffChunk('fmt ', format), riffChunk('LIST', info), riffChunk('data', pcm)]);
  return riffChunk('RIFF', body);
}
export async function createMedia(root) {
  const mediaRoot = ownedPath(root, path.join(root, 'media'));
  const artistRoot = path.join(mediaRoot, input.artist), albumRoot = path.join(artistRoot, input.album);
  await mkdir(albumRoot, { recursive: true });
  const sources = input.tracks.map(track => waveBytes(track));
  const files = input.tracks.map(track => path.join(albumRoot, track.filename));
  for (const index of [0, 1]) await writeFile(files[index], sources[index], { flag: 'wx' });
  const sibling = path.join(albumRoot, 'unrelated.keep');
  await writeFile(sibling, input.siblingText, { flag: 'wx' });
  return { root: mediaRoot, artistRoot, albumRoot, files, sources, sibling };
}
export async function addTrack(media, index) {
  await writeFile(media.files[index], media.sources[index], { flag: 'wx' });
}
export async function assetSnapshot(media, present) {
  const tracks = [];
  for (const [index, filename] of media.files.entries()) {
    const file = await optionalFile(filename);
    assert.deepEqual(file, present.includes(index)
      ? { bytes: media.sources[index].length, sha256: sha(media.sources[index]) } : null);
    tracks.push({ index, filename, file });
  }
  const sibling = await optionalFile(media.sibling);
  assert.deepEqual(sibling, { bytes: Buffer.byteLength(input.siblingText), sha256: sha(input.siblingText) });
  return { tracks, sibling };
}
export async function albumNfoSnapshot(media, overview) {
  const filename = path.join(media.albumRoot, 'album.nfo');
  assert.ok(await optionalFile(filename), 'The actual album save must write its NFO through the storage plugin.');
  const bytes = await readFile(filename), root = readXml(bytes.toString('utf8'));
  assert.equal(root.name, 'album');
  assert.equal(textOf(root, 'title'), input.album);
  assert.equal(textOf(root, 'review'), overview);
  return { filename, bytes: bytes.length, sha256: sha(bytes), rawBase64: bytes.toString('base64') };
}

const unboundItemRelations = new Set(['CustomItemDisplayPreferences', 'ItemDisplayPreferences', 'MediaSegments', 'TrickplayInfos']);
const itemRelations = nativeModel.tables.flatMap(table => {
  const columns = [...new Set(table.foreignKeys.filter(key => key.table === 'BaseItems').flatMap(key => key.columns))];
  if (table.name === 'BaseItems') columns.unshift('Id');
  if (unboundItemRelations.has(table.name) && !columns.includes('ItemId')) columns.push('ItemId');
  return columns.length ? [{ table, columns }] : [];
});
export async function itemSnapshot(database, ids) {
  const nativeIds = ids.map(nativeGuid), items = [], relations = {};
  for (const id of nativeIds) {
    const [item] = await database.rows('BaseItems', { where: { Id: id } });
    const [raw] = await database.rows('BaseItems', { where: { Id: id }, columns: ['Data'], consumer: 'exchange' });
    items.push({ id: idKey(id), item: item ?? null, dataHex: raw?.Data == null ? null : nativeTextBytes(raw.Data).toString('hex') });
  }
  for (const { table, columns } of itemRelations) {
    const rows = await database.rows(table.name, { whereAny: Object.fromEntries(columns.map(column => [column, nativeIds])), consumer: 'exchange' });
    relations[table.name] = rows.map(row => table.columns.map(column => canonicalCell(row[column.name])));
  }
  return { items, relations };
}
export function assertRemoved(snapshot, id) {
  assert.deepEqual(snapshot.items, [{ id: idKey(id), item: null, dataHex: null }]);
  for (const [table, rows] of Object.entries(snapshot.relations)) assert.deepEqual(rows, [], `${table} must not retain a deleted track reference.`);
}
export async function completeSnapshot(database) {
  const envelope = await getNativeEnvelope(database), tables = await databaseDigest(database);
  assert.deepEqual(tables.map(table => table.name), nativeModel.tables.map(table => table.name));
  if (database.dialect === 'sqlite') {
    assert.deepEqual(database.schema.tables.map(table => table.name).sort(),
      [...nativeModel.tables.map(table => table.name), '__EFMigrationsHistory', '__EFMigrationsLock'].sort());
    assert.deepEqual(database.database.prepare('SELECT * FROM "__EFMigrationsLock"').all(), []);
  }
  return { tables, migrationHistory: envelope.history, sqliteSequence: envelope.sqliteSequence,
    nativeSchemaFingerprint: envelope.fingerprint };
}
export async function installStoppedExport({ root, instanceRoot, exported }) {
  const destination = ownedPath(root, databaseFilename(instanceRoot)); ownedPath(root, exported);
  await stoppedDatabase(destination); await stoppedDatabase(exported);
  await rename(destination, ownedPath(root, path.join(root, 'native-before-node-export.db')));
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { await unlink(ownedPath(root, destination + suffix)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await copyFile(exported, destination, constants.COPYFILE_EXCL);
  assert.deepEqual(await optionalFile(destination), await optionalFile(exported));
}
