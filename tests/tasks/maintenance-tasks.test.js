import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import { nativeDate } from '../../src/users/native.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';

test('native maintenance tasks clean committed activity rows and the owned cache and temp directories', {
  skip: !postgresTestConnectionString, timeout: 30000,
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mm-maintenance-'));
  let database, runtime;
  t.after(async () => {
    try { await runtime?.close(); }
    finally {
      try { await dropPostgresTestDatabase(database); }
      finally { await rm(root, { recursive: true, force: true }); }
    }
  });
  database = await createPostgresTestDatabase(null, 'maintenance');
  const program = path.join(root, 'program'), cache = path.join(root, 'configured-cache');
  const temp = path.join(program, 'cache', 'temp');
  const daysAgo = days => new Date(Date.now() - days * 86_400_000);
  const transcode = path.join(cache, 'transcodes'), staleSegment = path.join(transcode, 'old', 'segment.ts');
  const freshSegment = path.join(transcode, 'playing.ts');
  const logs = path.join(root, 'log', 'nested'), expiredLog = path.join(logs, 'ffmpeg.log');
  const managedLog = path.join(logs, 'log_old.log'), recentLog = path.join(logs, 'recent.log');
  for (const [filename, age] of [[staleSegment, 2], [freshSegment, 0], [expiredLog, 8], [managedLog, 30], [recentLog, 4]]) {
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, 'fixture');
    await utimes(filename, daysAgo(age), daysAgo(age));
  }
  runtime = await createTestRuntime({ database, programDataPath: program, serverId: 'maintenance-fixture',
    configuration: { ...defaultConfiguration('server'), IsStartupWizardCompleted: true, ActivityLogRetentionDays: 7, LogFileRetentionDays: 7, CachePath: cache } });
  const owner = (await database.rows('BaseItems')).find(item => item.IsFolder);
  const credit = { Name: 'Credit Fixture', PersonType: 'Actor' }, orphan = randomUUID(), duplicate = randomUUID(), original = randomUUID();
  await database.insert('Peoples', { ...credit, Id: original });
  await database.insert('Peoples', { ...credit, Id: duplicate });
  await database.insert('Peoples', { ...credit, Id: orphan, Name: 'Orphan Fixture' });
  for (const [PeopleId, Role] of [[original, 'First role'], [duplicate, 'Second role']]) {
    await database.insert('PeopleBaseItemMap', { ItemId: owner.Id, PeopleId, Role, ListOrder: 0, SortOrder: null });
  }
  const returning = await runtime.library.getOrCreatePerson('Returning Fixture');
  await database.insert('Peoples', { Id: returning.Id, Name: returning.Name, PersonType: 'Director' });
  await database.insert('PeopleBaseItemMap', { ItemId: owner.Id, PeopleId: returning.Id, Role: '', ListOrder: 1, SortOrder: null });
  await database.update('BaseItems', { Id: returning.Id }, { DateLastRefreshed: nativeDate(daysAgo(31)), Overview: 'Keep biography' });
  const dead = await runtime.library.getOrCreatePerson('Uncredited Fixture');
  const locked = await runtime.library.getOrCreatePerson('Locked Fixture');
  await database.update('BaseItems', { Id: locked.Id }, { IsLocked: true, DateLastRefreshed: nativeDate(daysAgo(1)) });
  runtime.libraryScanLifecycle.isScanRunning = true;
  try {
    await runtime.tasks.execute('866456ed0d44e15468124ce33d85961e');
    assert.equal((await database.rows('Peoples', { where: { Id: orphan } })).length, 1);
  } finally { runtime.libraryScanLifecycle.isScanRunning = false; }
  for (const [Name, age] of [['Expired activity', 8], ['Retained activity', 6]]) await database.insert('ActivityLogs', {
    Name, Type: 'RetentionFixture', UserId: '00000000-0000-0000-0000-000000000000', DateCreated: nativeDate(daysAgo(age)),
    LogSeverity: 2, RowVersion: 0n,
  });
  const cacheOld = path.join(cache, 'old', 'nested', 'cache.bin'), cacheKeep = path.join(cache, 'keep', 'cache.bin');
  const tempOld = path.join(temp, 'old', 'tmp.bin'), tempKeep = path.join(temp, 'keep.tmp'), outside = path.join(root, 'outside.bin');
  for (const [filename, age] of [[cacheOld, 31], [cacheKeep, 29], [tempOld, 2], [tempKeep, 0], [outside, 90]]) {
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, path.basename(filename));
    await utimes(filename, daysAgo(age), daysAgo(age));
  }
  await mkdir(path.join(temp, 'empty', 'child'), { recursive: true });

  const token = (await runtime.apiKeys.create('Maintenance fixture')).AccessToken;
  const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port}`;
  const request = (route, method = 'GET') => fetch(origin + '/ScheduledTasks' + route,
    { method, headers: { 'X-Emby-Token': token }, signal: t.signal });
  const list = await request('?isHidden=false&isEnabled=true');
  assert.equal(list.status, 200);
  const tasks = await list.json();
  for (const [key, id, triggers] of [
    ['CleanActivityLog', 'b461ef918ab28520928183e794350e3c', []],
    ['DeleteCacheFiles', '241d4fcb19a1d557ee62428e411da609', [{ Type: 'IntervalTrigger', IntervalTicks: 864000000000 }]],
    ['CleanLogFiles', '1c8ede62c521bea0bf851344f5b8ca40', [{ Type: 'IntervalTrigger', IntervalTicks: 864000000000 }]],
    ['DeleteTranscodeFiles', '7d8088c10902f1bf4072ded42437bcfb', [{ Type: 'StartupTrigger' }, { Type: 'IntervalTrigger', IntervalTicks: 864000000000 }]],
    ['RefreshPeople', '866456ed0d44e15468124ce33d85961e', [{ Type: 'IntervalTrigger', IntervalTicks: 6048000000000 }]],
  ]) {
    const task = tasks.find(task => task.Key === key);
    assert.ok(task, key);
    assert.equal(task.Id, id);
    assert.equal(task.Category, key === 'RefreshPeople' ? 'Library' : 'Maintenance');
    if (key === 'CleanLogFiles') assert.match(task.Description, /7 days/);
    assert.deepEqual(task.Triggers, triggers);
    const previous = task.LastExecutionResult?.StartTimeUtc;
    // Leave the startup trigger in charge of cleaning the preexisting segment.
    if (key !== 'DeleteTranscodeFiles') assert.equal((await request('/Running/' + id.toUpperCase(), 'POST')).status, 204);
    const deadline = Date.now() + 15000;
    for (;;) {
      const result = await request('/' + id);
      assert.equal(result.status, 200);
      const status = await result.json();
      if (status.LastExecutionResult && status.State === 'Idle'
        && (key === 'DeleteTranscodeFiles' || previous !== status.LastExecutionResult.StartTimeUtc)) {
        assert.equal(status.LastExecutionResult.Status, 'Completed', JSON.stringify(status.LastExecutionResult));
        break;
      }
      assert.ok(Date.now() < deadline, `Timed out waiting for ${key}`);
      await delay(20, undefined, { signal: t.signal });
    }
  }
  await runtime.close();
  const cold = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema: database.schemaName });
  try {
    const rows = await cold.rows('ActivityLogs', { where: { Type: 'RetentionFixture' } });
    assert.deepEqual(rows.map(row => row.Name), ['Retained activity']);
    assert.deepEqual((await cold.rows('Peoples')).map(row => row.Name).sort(), [credit.Name, returning.Name]);
    const links = (await cold.rows('PeopleBaseItemMap', { where: { ItemId: owner.Id } })).filter(row => row.PeopleId !== returning.Id);
    assert.equal((await cold.rows('BaseItems', { where: { Id: dead.Id } })).length, 0);
    assert.equal((await cold.rows('BaseItems', { where: { Id: locked.Id } }))[0]?.IsLocked, true);
    const refreshed = (await cold.rows('BaseItems', { where: { Id: returning.Id } }))[0];
    assert.equal(refreshed.Overview, 'Keep biography');
    assert.ok(Date.parse(refreshed.DateLastRefreshed) > daysAgo(1).valueOf());
    assert.equal(new Set(links.map(row => row.PeopleId)).size, 1);
    assert.deepEqual(links.map(row => row.Role).sort(), ['First role', 'Second role']);
    const person = (await cold.rows('BaseItems', { where: { Name: credit.Name } }))[0];
    assert.equal(person?.Type, 'MediaBrowser.Controller.Entities.Person');
    assert.ok(Date.parse(person.DateLastRefreshed) > daysAgo(1).valueOf());
  } finally { await cold.close(); }
  for (const file of [freshSegment, managedLog, recentLog]) assert.equal(await readFile(file, 'utf8'), 'fixture');
  for (const removed of [staleSegment, path.dirname(staleSegment), expiredLog, cacheOld, path.join(cache, 'old'), tempOld, path.join(temp, 'old'), path.join(temp, 'empty')])
    await assert.rejects(stat(removed), { code: 'ENOENT' });
  for (const retained of [cacheKeep, tempKeep, outside]) assert.equal(await readFile(retained, 'utf8'), path.basename(retained));
  assert.ok((await stat(cache)).isDirectory());
  assert.ok((await stat(temp)).isDirectory());
});

test('scheduled cache cleanup removes an expired image written on its configured backend', { skip: !postgresTestConnectionString }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mm-mapped-cleanup-'));
  const program = path.join(root, 'program');
  const imageCache = path.join(program, 'cache', 'images');
  const backend = path.join(root, 'image-backend');
  const tempRoot = path.join(program, 'cache', 'temp'), tempBackend = path.join(root, 'temp-backend');
  const storageConfiguration = path.join(root, 'storage.json');
  let database, runtime;
  try {
    await Promise.all([mkdir(backend), mkdir(tempBackend)]);
    const mappings = [['images', imageCache, backend], ['temp-metadata', path.join(tempRoot, 'mapped'), tempBackend]];
    await writeFile(storageConfiguration, JSON.stringify({
      instances: mappings.map(([id, , directory]) => ({ id, type: 'local', config: { root: directory, writable: true } })),
      mounts: mappings.map(([id]) => ({ path: '/' + id, instanceId: id, capabilities: {
        create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true } })),
      prefixes: mappings.map(([id, identityRoot]) => ({ identityRoot, accessRoot: '/' + id, purpose: 'metadata',
        style: process.platform === 'win32' ? 'windows' : 'posix', returnAccess: 'Isolated cache directory.' })),
    }));
    database = await createPostgresTestDatabase(null, 'mapped_cache_cleanup');
    runtime = await createTestRuntime({ database, programDataPath: program, storageConfiguration,
      serverId: 'mapped-cache-test', configuration: { IsStartupWizardCompleted: true } });
    const source = path.join(program, 'data', 'sample.png');
    const bytes = await readFile(new URL('../images/fixtures/processor/grid.png', import.meta.url));
    await runtime.fileSystem.writeFile(source, bytes);
    const result = await runtime.imageProcessor.process({
      assets: new MetadataImageAssets({ fileSystem: runtime.fileSystem, stateRoots: [program] }),
      image: { Path: source, DateModified: '2026-01-01T00:00:00Z', Width: 20, Height: 12 },
      Width: 8, Quality: 80, SupportedOutputFormats: ['Png'],
    });
    assert.equal(result.original, false);
    const physical = path.join(backend, path.relative(imageCache, result.path));
    assert.deepEqual(await readFile(physical), result.bytes);
    const expired = new Date(Date.now() - 32 * 86400000);
    await utimes(physical, expired, expired);
    const fresh = path.join(path.dirname(physical), 'fresh.png');
    await writeFile(fresh, bytes);
    // This name is hidden by the metadata mount and belongs to a different backend.
    await mkdir(path.dirname(result.path), { recursive: true });
    await writeFile(result.path, 'shadowed');
    await utimes(result.path, expired, expired);
    const temp = path.join(tempRoot, 'scratch');
    await mkdir(path.dirname(temp), { recursive: true });
    await writeFile(temp, 'temporary');
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000);
    await utimes(temp, twoDaysAgo, twoDaysAgo);
    const excluded = path.join(tempBackend, 'excluded.tmp'), link = path.join(backend, 'outside-cache');
    await writeFile(excluded, 'excluded');
    await utimes(excluded, expired, expired);
    await symlink(tempBackend, link, process.platform === 'win32' ? 'junction' : 'dir');
    const task = (await runtime.tasks.list()).find(entry => entry.Key === 'DeleteCacheFiles');
    await runtime.tasks.execute(task.Id);
    assert.equal((await runtime.tasks.get(task.Id)).LastExecutionResult.Status, 'Completed');
    await assert.rejects(stat(physical), { code: 'ENOENT' });
    assert.deepEqual(await readFile(fresh), bytes);
    assert.equal(await readFile(result.path, 'utf8'), 'shadowed');
    await assert.rejects(stat(temp), { code: 'ENOENT' });
    assert.equal(await readFile(excluded, 'utf8'), 'excluded');
    assert.ok((await lstat(link)).isSymbolicLink());
  } finally {
    try { await runtime?.close(); }
    finally {
      try { await dropPostgresTestDatabase(database); }
      finally { await rm(root, { recursive: true, force: true }); }
    }
  }
});
