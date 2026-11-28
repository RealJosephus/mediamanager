import assert from 'node:assert/strict';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { quoteIdentifier } from '../../src/database/model.js';
import { StorageFileSystem } from '../../src/storage/files.js';
import { readZipDirectory } from '../../src/storage/zip-directory.js';
import { BackupRestored, SystemBackups } from '../../src/system/backups.js';
import { backupFormat, withBackupArchive, writeBackupArchive } from '../../src/system/backup-archive.js';
import { createMetadataHttpFixture, metadataMovieId } from '../helpers/metadata-http-fixture.js';

export const requiredValidationServices = ['postgres'];

async function archivedRows(archive, schema, name) {
  const inventory = archive.json('Database/catalog.json').layout.tables;
  const index = inventory.findIndex(table => table.schema === schema && table.name === name);
  assert.notEqual(index, -1, name);
  const pages = await text(archive.stream(archive.directory.get('Database/' + index + '.ndjson')));
  return pages.split('\n').filter(Boolean).flatMap(line => JSON.parse(line));
}

for (const includeDatabase of [false, true]) {
  test('a slow file copy retains its storage generation and allows user writes, Database=' + includeDatabase, async t => {
    const { runtime, database, request, programDataPath } = await createMetadataHttpFixture(t);
    const storedNames = async () => database.withConnection(async db => (await db.client.query(
      'SELECT to_json("Username") AS name FROM ' + quoteIdentifier(db.schemaName) + '."Users"')).rows.map(row => row.name).sort());
    const before = await storedNames();
    assert.ok(before.length > 0);
    const { dataPath } = runtime.applicationPaths;
    const subtitles = path.join(dataPath, 'subtitles'), trickplay = path.join(dataPath, 'trickplay');
    const next = path.resolve(programDataPath, '../next-trickplay'), slow = path.join(subtitles, 'held.srt');
    for (const root of [subtitles, trickplay, next]) await mkdir(root, { recursive: true });
    await writeFile(slow, 'subtitle');
    await writeFile(path.join(trickplay, 'tile'), 'admitted volume');
    await writeFile(path.join(next, 'tile'), 'replacement volume');
    const entered = Promise.withResolvers(), resume = Promise.withResolvers();
    const createStream = StorageFileSystem.prototype.createReadStream;
    t.mock.method(StorageFileSystem.prototype, 'createReadStream', function (filename, ...args) {
      const stream = createStream.call(this, filename, ...args);
      if (filename !== slow) return stream;
      return Readable.from((async function* () { entered.resolve(); await resume.promise; yield* stream; })());
    });
    const backup = request('/Backup/Create', { method: 'POST', body: { Database: includeDatabase, Subtitles: true, Trickplay: true } });
    try {
      await Promise.race([entered.promise, backup.then(result => assert.fail('Backup ended before the held file: ' + result.status))]);
      const free = await database.withConnection(async db => (await db.client.query(
        'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS free', ['mediamanager:domain-write:' + db.schemaName])).rows[0].free);
      assert.equal(free, true, 'an independent PG connection can acquire the domain writer lock');
      const name = 'Created during file copy';
      const user = await request('/Users/New', { method: 'POST', body: { Name: name } });
      assert.equal(user.status, 200);
      assert.equal((await database.withConnection(db => db.rows('Users', { where: { Username: name } }))).length, 1);

      const config = (await request('/Storage/Configuration')).body;
      config.instances.push({ id: 'next-tiles', type: 'local', config: { root: next, writable: true } });
      config.mounts.push({ instanceId: 'next-tiles', path: '/next-tiles', capabilities: {} });
      config.prefixes.push({ identityRoot: trickplay, accessRoot: '/next-tiles', purpose: 'metadata',
        style: process.platform === 'win32' ? 'windows' : 'posix', returnAccess: 'Replacement tile volume.' });
      assert.equal((await request('/Storage/Configuration', { method: 'POST', body: config })).status, 200);
      const liveTile = await runtime.fileSystem.readFile(path.join(trickplay, 'tile'), 'utf8');
      assert.equal(liveTile, 'replacement volume');
      resume.resolve();
      const result = await backup;
      assert.equal(result.status, 200);
      await withBackupArchive(result.body.Path, async archive => {
        const archivedTile = await text(archive.stream(archive.directory.get('Data/trickplay/tile')));
        assert.equal(archivedTile, 'admitted volume');
        assert.equal(archive.directory.has('Database/catalog.json'), includeDatabase);
        if (includeDatabase) {
          const names = (await archivedRows(archive, database.schemaName, 'Users')).map(row => row.Username);
          assert.deepEqual(names.sort(), before);
        }
        t.diagnostic(JSON.stringify({ includeDatabase, lockAvailableDuringFileRead: free, userStatusBeforeRelease: user.status,
          createStatus: result.status, liveTile, archivedTile }));
      });
    } finally { resume.resolve(); await backup; }
  });
}

test('a database backup retains one snapshot across tables when an independent transaction commits mid-export', async t => {
  const { database, request } = await createMetadataHttpFixture(t);
  const schema = quoteIdentifier(database.schemaName);
  const tables = [
    { name: 'BaseItemProviders', column: 'ProviderValue', key: { ItemId: metadataMovieId, ProviderId: 'ObsoleteFixture' } },
    { name: 'BaseItems', column: 'Name', key: { Id: metadataMovieId } },
  ];
  for (const table of tables) {
    table.before = (await database.client.query('SELECT to_json(' + quoteIdentifier(table.column) + ') AS value FROM ' +
      schema + '.' + quoteIdentifier(table.name))).rows.map(row => row.value).sort();
  }
  const locked = schema + '."BaseItems"';
  let backup;
  try {
    await database.withConnection(writer => writer.transaction(async db => {
      await db.client.query('LOCK TABLE ' + locked + ' IN ACCESS EXCLUSIVE MODE');
      backup = request('/Backup/Create', { method: 'POST', body: { Database: true } });
      const deadline = AbortSignal.timeout(8000);
      while (!(await db.client.query("SELECT EXISTS (SELECT FROM pg_locks WHERE relation = $1::regclass AND mode = 'AccessShareLock' AND NOT granted) AS waiting",
        [locked])).rows[0].waiting) await delay(20, undefined, { signal: deadline });
      for (const { name, key, column } of tables) assert.equal(await db.update(name, key, { [column]: 'after snapshot' }), 1n);
    }));
    const result = await backup;
    assert.equal(result.status, 200);
    await withBackupArchive(result.body.Path, async archive => {
      for (const { name, column, key, before } of tables) {
        const rows = await archivedRows(archive, database.schemaName, name);
        assert.deepEqual(rows.map(row => row[column]).sort(), before);
        assert.equal((await database.rows(name, { where: key }))[0][column], 'after snapshot');
      }
    });
  } finally { await backup; }
});

test('elevated Backup routes create, list and read genuine archives with selectable payloads', async t => {
  const { runtime, request, reader, errors } = await createMetadataHttpFixture(t);
  const routes = [['GET', '/Backup'], ['GET', '/Backup/Manifest'], ['POST', '/Backup/Create'], ['POST', '/Backup/Restore']];
  for (const [method, route] of routes) {
    assert.ok(runtime.implementedRoutes.includes(method + ' ' + route));
    for (const [token, status] of [[null, 401], [reader, 403]]) assert.equal((await request(route, { method, token })).status, status);
  }
  assert.deepEqual((await request('/Backup')).body, []);
  assert.equal((await request('/Backup/Manifest')).status, 400);
  assert.equal((await request('/Backup/Manifest?path=missing.zip')).status, 404);
  assert.equal((await request('/Backup/Restore', { method: 'POST', body: { ArchiveFileName: 'missing.zip' } })).status, 404);
  assert.equal((await request('/Backup/Create', { method: 'POST', body: { Database: 'false' } })).status, 400);
  for (const include of [false, true]) {
    const options = { Database: include, Metadata: false, Trickplay: false, Subtitles: false };
    const created = await request('/Backup/Create', { method: 'POST', body: include ? {} : { database: false } });
    assert.equal(created.status, 200, errors.map(error => error.stack).join('\n'));
    assert.deepEqual(created.body.Options, options);
    const { Path: archive } = created.body;
    assert.equal(path.dirname(archive), path.join(runtime.applicationPaths.dataPath, 'backups'));
    const manifest = await request('/Backup/Manifest?path=' + encodeURIComponent(archive));
    assert.equal(manifest.status, 200);
    assert.deepEqual(manifest.body, created.body);
    const file = await open(archive);
    try {
      const { entries } = readZipDirectory(file.fd, (await file.stat()).size);
      assert.ok(entries.some(entry => entry.key === 'manifest.json'));
      assert.ok(entries.some(entry => entry.key === 'Database/catalog.json') === include);
      assert.ok(entries.every(entry => !entry.key.startsWith('Data/metadata/')));
      t.diagnostic(JSON.stringify({ database: include, entries: entries.length, bytes: (await file.stat()).size }));
    } finally { await file.close(); }
    assert.deepEqual((await request('/Backup')).body[0], created.body);
  }
  await writeFile(path.join(runtime.applicationPaths.dataPath, 'backups', 'invalid.zip'), 'not a ZIP archive');
  assert.equal((await request('/Backup/Manifest?path=invalid.zip')).status, 204);
  assert.equal((await request('/Backup')).body.length, 2);
});

test('restore checks server and engine versions before restart admission and again before cold writes', async t => {
  const { runtime, request } = await createMetadataHttpFixture(t);
  const active = runtime.backups;
  const server = serverVersion => new SystemBackups({ paths: active.paths, store: active.store, openStorage: active.openStorage,
    serverId: active.serverId, serverVersion });
  const producer = server('13.10.0'), older = server('13.9.0');
  const options = { Database: false, Metadata: false, Subtitles: false, Trickplay: false };
  const config = path.join(active.paths.configurationDirectoryPath, 'version-marker.xml');
  await mkdir(path.dirname(config), { recursive: true });
  await writeFile(config, '<marker>archived</marker>');
  const archive = await producer.create(options);
  await writeFile(config, '<marker>current</marker>');
  const rejectAdmission = { admit() { assert.fail('An incompatible restore reserved a restart'); } };
  const pending = path.join(active.pending, 'request.json');
  assert.equal((await request('/Backup/Restore', { method: 'POST', body: { ArchiveFileName: archive.Path } })).status, 422);
  await assert.rejects(older.stageRestore(archive.Path, rejectAdmission), { status: 422 });
  await assert.rejects(stat(pending), { code: 'ENOENT' });
  for (const [field, value] of [['BackupEngineVersion', '2.0.0'], ['ServerVersion', 'invalid']]) {
    const file = path.join(active.directory, field + '.zip');
    await writeBackupArchive(file, active.directory, { ...archive, [field]: value },
      { format: backupFormat, serverId: active.serverId, metadataPath: active.paths.metadataPath }, async () => {});
    await assert.rejects(producer.stageRestore(file, rejectAdmission), { status: 422 });
  }

  await producer.stageRestore(archive.Path, { admit: () => ({ cancel() {} }) });
  await assert.rejects(older.restorePending(), { status: 422 });
  assert.equal(await readFile(config, 'utf8'), '<marker>current</marker>');
  const staged = await readFile(pending, 'utf8'), incompatible = JSON.parse(staged);
  incompatible.manifest.BackupEngineVersion = '1.1.0';
  await writeFile(pending, JSON.stringify(incompatible));
  await assert.rejects(producer.restorePending(), { status: 422 });
  assert.equal(await readFile(config, 'utf8'), '<marker>current</marker>');
  await writeFile(pending, staged);
  await assert.rejects(server('13.10.0.0').restorePending(), BackupRestored);
  assert.equal(await readFile(config, 'utf8'), '<marker>archived</marker>');
});
