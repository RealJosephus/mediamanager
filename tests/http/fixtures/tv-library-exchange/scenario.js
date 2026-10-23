import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, rename, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SqliteDatabase } from '../../../../src/database/sqlite.js';
import { nativeModel } from '../../../../src/database/model.js';
import { databaseDigest, getNativeEnvelope } from '../../../../src/migration/database-transfer.js';
import { nativeGuid } from '../../../../src/users/native.js';
import { readXml, child, textOf, escapeXml } from '../../../../src/core/xml.js';
import { validationExecutable } from '../../../../tools/validation/paths.js';
import { describeFile } from '../../../../tools/validation/inventory.js';

export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
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
  assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
  return resolved;
}
export async function fileSnapshot(filename) {
  const info = await lstat(filename);
  assert.ok(info.isFile() && !info.isSymbolicLink(), 'The fixture must use ordinary private files.');
  const bytes = await readFile(filename);
  return { bytes: bytes.length, sha256: sha(bytes) };
}
export async function stoppedDatabase(filename) {
  await fileSnapshot(filename);
  for (const suffix of ['-wal', '-journal']) {
    try { assert.equal((await fileSnapshot(filename + suffix)).bytes, 0, 'A transfer cannot omit pending journal bytes.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
export function removeSyntheticPreparation(instanceRoot) {
  const database = new SqliteDatabase(databaseFilename(instanceRoot), { requireMigrationHistory: true });
  try {
    const [movie] = database.rows('BaseItems', { where: { Id: '22222222-2222-2222-2222-222222222222' } });
    const [folder] = database.rows('BaseItems', { where: { Id: '11111111-1111-1111-1111-111111111111' } });
    assert.equal(movie.Path, 'Z:\\SyntheticMedia\\feature.mkv'); assert.equal(folder.Path, 'Z:\\SyntheticMedia');
    assert.equal(idKey(movie.ParentId), idKey(folder.Id));
    database.transaction(() => { database.delete('BaseItems', { Id: movie.Id }); database.delete('BaseItems', { Id: folder.Id }); });
    return { beforeFirstPrivateBoot: true, removed: [movie, folder] };
  } finally { database.close(); }
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
    sqliteSequence: envelope.sqliteSequence.map(row => ({ ...row })),
    nativeSchemaFingerprint: envelope.fingerprint };
}
export async function prepareMedia(root) {
  const directory = ownedPath(root, path.join(root, 'media'));
  await mkdir(directory);
  const source = ownedPath(root, path.join(root, 'source.mkv'));
  const executables = await Promise.all([validationExecutable('ffmpeg'), validationExecutable('ffprobe')].map(describeFile));
  const generation = await new Promise((resolve, reject) => {
    execFile(validationExecutable('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-n', '-f', 'lavfi',
      '-i', 'color=size=32x32:rate=10:duration=0.4', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono',
      '-t', '0.4', '-threads', '1', '-c:v', 'ffv1', '-c:a', 'pcm_s16le', source],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 }, (error, stdout, stderr) => {
      if (error) reject(error); else resolve({ stdout, stderr, fixtureInputOnly: true });
    });
  });
  const seriesPath = path.join(directory, input.series.directory);
  const series = { ...input.series, type: 'Series', path: seriesPath, nfo: path.join(seriesPath, 'tvshow.nfo') };
  const seasons = input.seasons.map(season => ({ ...season, type: 'Season', parent: series.key,
    path: path.join(seriesPath, season.directory), nfo: path.join(seriesPath, season.directory, 'season.nfo') }));
  const episode = entry => {
    const season = seasons.find(value => value.key === entry.season);
    const filename = path.join(season.path, entry.filename);
    return { ...entry, type: 'Episode', parent: season.key, seasonNumber: season.number,
      path: filename, nfo: filename.replace(/\.mkv$/u, '.nfo') };
  };
  return { root: directory, source, file: await fileSnapshot(source), sourceBytesBase64: (await readFile(source)).toString('base64'), generation, executables,
    definitions: [series, ...seasons, ...input.episodes.map(episode)], continued: episode(input.continuedEpisode) };
}
function nfoFor(entry) {
  const element = (name, value) => `<${name}>${escapeXml(value)}</${name}>`;
  const root = { Series: 'tvshow', Season: 'season', Episode: 'episodedetails' }[entry.type];
  return '<?xml version="1.0" encoding="utf-8"?>\n<' + root + '>\n'
    + element('title', entry.name) + element('plot', entry.overview) + element('genre', input.genre) + element('tag', input.tag)
    + (entry.type === 'Series' ? element('tvdbid', entry.tvdb) + element('displayorder', 'aired') : '')
    + (entry.type === 'Season' ? element('seasonnumber', entry.number) : '')
    + (entry.type === 'Episode' ? element('season', entry.seasonNumber) + element('episode', entry.number)
      + element('showtitle', input.series.name) : '')
    + `<exchangeExtension marker="${entry.key}">${escapeXml(input.unknownNfoText)}</exchangeExtension>`
    + '\n</' + root + '>\n';
}
export async function materialize(media, continuation = false) {
  const entries = continuation ? [media.continued] : media.definitions;
  for (const entry of entries) {
    if (entry.type !== 'Episode') await mkdir(entry.path);
    else await copyFile(media.source, entry.path, constants.COPYFILE_EXCL);
    await writeFile(entry.nfo, nfoFor(entry), { flag: 'wx' });
  }
}
export async function assertFiles(media, { continued = false, overviews = {} } = {}) {
  const entries = continued ? [...media.definitions, media.continued] : media.definitions, result = [];
  for (const entry of entries) {
    const file = entry.type === 'Episode' ? await fileSnapshot(entry.path) : null;
    if (file) assert.deepEqual(file, media.file, 'Every real Episode must retain its complete source bytes.');
    const nfoBytes = await readFile(entry.nfo), document = readXml(nfoBytes.toString('utf8'));
    const extension = child(document, 'exchangeExtension');
    assert.equal(textOf(document, 'title'), entry.name);
    assert.equal(textOf(document, 'plot'), overviews[entry.key] ?? entry.overview);
    assert.equal(extension?.attributes.marker, entry.key); assert.equal(extension?.text, input.unknownNfoText);
    if (entry.type === 'Season') assert.equal(textOf(document, 'seasonnumber'), String(entry.number));
    if (entry.type === 'Episode') {
      assert.equal(textOf(document, 'season'), String(entry.seasonNumber));
      assert.equal(textOf(document, 'episode'), String(entry.number));
    }
    result.push({ key: entry.key, path: entry.path, source: file, nfo: { bytes: nfoBytes.length, sha256: sha(nfoBytes),
      sourceBytesBase64: nfoBytes.toString('base64') },
      semantic: { root: document.name, title: textOf(document, 'title'), overview: textOf(document, 'plot'),
        extension: { attributes: extension.attributes, text: extension.text } } });
  }
  return result;
}
// A declared external metadata edit exercises Native's reader on the actual
// Node-saved XML. It changes one payload, without regenerating its structure.
export async function changeNodeNfoForNative(media) {
  const entry = media.definitions.find(value => value.key === 'episode1');
  const before = await readFile(entry.nfo, 'utf8');
  assert.equal(textOf(readXml(before), 'plot'), input.nodeOverview);
  const old = '<plot>' + escapeXml(input.nodeOverview) + '</plot>';
  assert.equal(before.split(old).length, 2);
  const after = before.replace(old, '<plot>' + escapeXml(input.nativeReadOverview) + '</plot>');
  await writeFile(entry.nfo, after);
  // Native's public local-metadata monitor ignores changes within one minute
  // of its own save. Declare a later input timestamp, without changing clocks.
  const timestamp = new Date(Date.now() + 120000);
  await utimes(entry.nfo, timestamp, timestamp);
  return { key: entry.key, beforeSha256: sha(before), afterSha256: sha(after),
    declaredEdit: 'plot text only', declaredLastWriteUtc: timestamp.toISOString() };
}
export async function assertPersisted(database, media, ids, continued = false) {
  const result = [];
  for (const entry of continued ? [...media.definitions, media.continued] : media.definitions) {
    const [row] = await database.rows('BaseItems', { where: { Id: nativeGuid(ids[entry.key]) } });
    assert.ok(row); assert.equal(row.Type, 'MediaBrowser.Controller.Entities.TV.' + entry.type);
    assert.equal(row.Path, entry.path); assert.equal(row.Name, entry.name);
    if (entry.parent) assert.equal(idKey(row.ParentId), ids[entry.parent]);
    if (entry.type !== 'Series') {
      assert.equal(idKey(row.SeriesId), ids.series); assert.equal(row.IndexNumber, entry.number);
    }
    const ancestors = await database.rows('AncestorIds', { where: { ItemId: row.Id } });
    assert.ok(ancestors.length > 0);
    let streams = [];
    if (entry.type === 'Episode') {
      assert.equal(idKey(row.SeasonId), ids[entry.parent]); assert.equal(row.ParentIndexNumber, entry.seasonNumber);
      streams = await database.rows('MediaStreamInfos', { where: { ItemId: row.Id } });
      assert.ok(streams.some(value => value.StreamType === 0)); assert.ok(streams.some(value => value.StreamType === 1));
    }
    result.push({ key: entry.key, row, ancestors, streams });
  }
  return result;
}
export async function configureStorage(root) {
  const style = process.platform === 'win32' ? 'windows' : 'posix', caseSensitive = style === 'posix';
  const ancestors = path.join(root, 'empty-ancestors'); await mkdir(ancestors);
  const mountContract = { mounts: [{ mountId: 'tv-exchange', identityRoot: root, accessRoot: '/tv-exchange',
    pathStyle: style, caseSensitive, returnPolicy: 'required' }] };
  const storage = { instances: [{ id: 'tv-exchange', type: 'local', config: { root, writable: true } },
    { id: 'empty-ancestors', type: 'local', config: { root: ancestors, writable: false } }],
  mounts: [{ path: '/tv-exchange', instanceId: 'tv-exchange', capabilities: {
    create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true } },
  { path: '/known-ignore-ancestors', instanceId: 'empty-ancestors', capabilities: {} }],
  prefixes: [{ identityRoot: root, accessRoot: '/tv-exchange', style, caseSensitive, purpose: 'library',
    returnAccess: 'The same private TV media and instance remain available to Native after export.' }],
  ignorePrefixes: [{ identityRoot: path.parse(root).root, accessRoot: '/known-ignore-ancestors', style, caseSensitive,
    returnAccess: 'Declared empty ancestors of the isolated TV fixture.' }] };
  await writeFile(path.join(root, 'storage.json'), JSON.stringify(storage, null, 2) + '\n', { flag: 'wx' });
  return mountContract;
}
export async function installStoppedExport(root, instanceRoot, exported) {
  const destination = ownedPath(root, databaseFilename(instanceRoot)); ownedPath(root, exported);
  await stoppedDatabase(destination); await stoppedDatabase(exported);
  await rename(destination, ownedPath(root, path.join(root, 'native-before-node-export.db')));
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { await unlink(ownedPath(root, destination + suffix)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await copyFile(exported, destination, constants.COPYFILE_EXCL);
  assert.deepEqual(await fileSnapshot(destination), await fileSnapshot(exported));
}
