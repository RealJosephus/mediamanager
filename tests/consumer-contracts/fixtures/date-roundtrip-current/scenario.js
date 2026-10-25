import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { constants } from 'node:fs';
import { copyFile, lstat, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { SqliteDatabase } from '../../../../src/database/sqlite.js';
import { nativeModel } from '../../../../src/database/model.js';
import { databaseDigest, getNativeEnvelope } from '../../../../src/migration/database-transfer.js';

export const sha = value => createHash('sha256').update(value).digest('hex');
export const idKey = value => String(value).replaceAll('-', '').toLowerCase();
export const databaseFilename = root => path.join(root, 'data/data/jellyfin.db');
export const unusedPort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject).listen(0, '127.0.0.1', () => {
    const port = server.address().port; server.close(error => error ? reject(error) : resolve(port));
  });
});
export const portAvailable = port => new Promise(resolve => {
  const server = createServer();
  server.once('error', () => resolve(false)).listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
});
export function ownedPath(root, filename) {
  const target = path.resolve(filename), relative = path.relative(path.resolve(root), target);
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  return target;
}
export async function fileIdentity(filename) {
  try {
    const info = await lstat(filename); assert.ok(info.isFile() && !info.isSymbolicLink());
    const bytes = await readFile(filename); return { bytes: bytes.length, sha256: sha(bytes) };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function stoppedDatabase(filename) {
  assert.ok(await fileIdentity(filename));
  for (const suffix of ['-wal', '-journal']) {
    const journal = await fileIdentity(filename + suffix);
    assert.ok(!journal || journal.bytes === 0, 'A stopped transfer cannot omit pending SQLite journal bytes.');
  }
}
export async function completeSnapshot(database) {
  const envelope = await getNativeEnvelope(database), tables = await databaseDigest(database);
  assert.deepEqual(tables.map(table => table.name), nativeModel.tables.map(table => table.name));
  if (database.dialect === 'sqlite') {
    assert.deepEqual(database.schema.tables.map(table => table.name).sort(),
      [...nativeModel.tables.map(table => table.name), '__EFMigrationsHistory', '__EFMigrationsLock'].sort());
    assert.deepEqual(database.database.prepare('SELECT * FROM "__EFMigrationsLock"').all(), []);
  }
  return { tables, migrationHistory: envelope.history.map(row => ({ ...row })),
    sqliteSequence: envelope.sqliteSequence.map(row => ({ ...row })), nativeSchemaFingerprint: envelope.fingerprint };
}
export function removeSyntheticPreparation(instanceRoot) {
  const database = new SqliteDatabase(databaseFilename(instanceRoot), { requireMigrationHistory: true });
  try {
    const movie = database.rows('BaseItems', { where: { Id: '22222222-2222-2222-2222-222222222222' } });
    const folder = database.rows('BaseItems', { where: { Id: '11111111-1111-1111-1111-111111111111' } });
    assert.equal(movie.length, 1); assert.equal(folder.length, 1);
    assert.equal(movie[0].Path, 'Z:\\SyntheticMedia\\feature.mkv'); assert.equal(folder[0].Path, 'Z:\\SyntheticMedia');
    assert.equal(idKey(movie[0].ParentId), idKey(folder[0].Id));
    database.transaction(() => {
      database.delete('BaseItems', { Id: movie[0].Id }); database.delete('BaseItems', { Id: folder[0].Id });
    });
    return { beforeFirstNativeStartup: true, removed: [...movie, ...folder] };
  } finally { database.close(); }
}
export async function installStoppedExport({ root, instanceRoot, exported, label }) {
  const destination = ownedPath(root, databaseFilename(instanceRoot));
  ownedPath(root, exported); await stoppedDatabase(destination); await stoppedDatabase(exported);
  await rename(destination, ownedPath(root, path.join(root, label + '-before-node-export.db')));
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { await unlink(ownedPath(root, destination + suffix)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await copyFile(exported, destination, constants.COPYFILE_EXCL);
  assert.deepEqual(await fileIdentity(destination), await fileIdentity(exported));
}
export function canonicalUtc(value) {
  assert.equal(typeof value, 'string');
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?Z$/u.exec(value);
  assert.ok(match, 'UserData dates must expose the complete UTC instant.');
  return match[1] + '.' + (match[2] ?? '').padEnd(7, '0') + 'Z';
}
export const publicUserData = value => ({ ...value, LastPlayedDate: canonicalUtc(value.LastPlayedDate) });
export const storedUtc = value => canonicalUtc(value.replace(' ', 'T') + 'Z');
