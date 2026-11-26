import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { on } from 'node:events';
import { refreshLibraryTaskId } from '../../../src/tasks/index.js';
import { createTestRuntime } from '../../helpers/runtime.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../../database/postgres-fixture.js';
import { validationOutputRoot } from '../../../tools/validation/paths.js';

export async function verifyRemoteTvScan(t, vfs, type, baseUrl, credential) {
  const output = validationOutputRoot();
  await mkdir(output, { recursive: true });
  const root = await mkdtemp(path.join(output, 'remote-tv-'));
  const name = 'tv-' + randomUUID(), remote = '/network/' + name, identity = 'Z:\\' + name;
  const failures = [];
  let runtime, database;
  try {
    await vfs.mkdir(remote);
    const series = remote + '/Audit Show (2020)', season = series + '/Season 01';
    await vfs.mkdir(series); await vfs.mkdir(season);
    for (const marker of ['playlist.xml', 'collection.xml']) {
      const marked = remote + '/Marked ' + marker;
      await vfs.mkdir(marked);
      await vfs.write(marked + '/' + marker, Buffer.from('<fixture/>'), { overwrite: false });
    }
    const fixture = await readFile(new URL('../../playback/fixtures/vobsub-delivery/source.mkv', import.meta.url));
    const episode = n => season + '/Audit Show S01E0' + n + '.mkv';
    await vfs.write(episode(1), fixture, { overwrite: false });
    const storageConfiguration = path.join(root, 'storage.json');
    const accessRoot = '/tv-media';
    await writeFile(storageConfiguration, JSON.stringify({
      instances: [{ id: 'tv', type, config: { baseUrl, credentialRef: 'TV_SCAN_CREDENTIAL', pageSize: 2 } }],
      mounts: [{ path: accessRoot, instanceId: 'tv', root: vfs.resolve('/network').path, capabilities: {} }],
      prefixes: [{ identityRoot: 'Z:\\', accessRoot, style: 'windows', returnAccess: 'Remote TV fixture.' }],
    }));
    const errors = [];
    database = await createPostgresTestDatabase(null, 'remote_tv_scan');
    runtime = await createTestRuntime({ database, programDataPath: path.join(root, 'program'), storageConfiguration,
      environment: { ...process.env, TV_SCAN_CREDENTIAL: credential }, onError: error => errors.push(error.message),
      configuration: { IsStartupWizardCompleted: true }, serverId: 'remote-tv' });
    const token = (await runtime.apiKeys.create('Remote TV scan')).AccessToken;
    const origin = 'http://127.0.0.1:' + runtime.networkHost.listeners.find(value => value.scheme === 'http').port;
    const request = (suffix, method = 'GET', body) => fetch(origin + suffix, { method, signal: t.signal,
      headers: { 'X-Emby-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const create = await request('/Library/VirtualFolders?name=Shows&collectionType=tvshows', 'POST', {
      LibraryOptions: { PathInfos: [{ Path: identity }], TypeOptions: ['Series', 'Season', 'Episode'].map(Type => ({
        Type, MetadataFetchers: [], ImageFetchers: [] })) } });
    assert.equal(create.status, 204, await create.text());
    const scan = async () => {
      const signal = AbortSignal.any([t.signal, AbortSignal.timeout(300_000)]);
      const completions = on(runtime.tasks, 'completed', { signal });
      try {
        assert.equal((await request('/Library/Refresh', 'POST')).status, 204);
        for await (const [{ Result }] of completions) {
          if (Result.Id !== refreshLibraryTaskId) continue;
          assert.equal(Result.Status, 'Completed', Result.ErrorMessage);
          const status = await request('/ScheduledTasks/' + refreshLibraryTaskId);
          assert.equal(status.status, 200);
          const { State, LastExecutionResult } = await status.json();
          assert.equal(State, 'Idle');
          assert.equal(LastExecutionResult.StartTimeUtc, Result.StartTimeUtc);
          assert.equal(LastExecutionResult.Status, 'Completed');
          break;
        }
      } finally { await completions.return(); }
      const response = await request('/Items?Recursive=true&IncludeItemTypes=Series,Season,Episode&Fields=Path');
      assert.equal(response.status, 200);
      return (await response.json()).Items;
    };
    const initial = await scan();
    assert.deepEqual(initial.map(item => item.Type).sort(), ['Episode', 'Season', 'Series'], JSON.stringify({ errors,
      items: (await database.rows('BaseItems')).map(({ Name, Type, Path }) => ({ Name, Type, Path })) }));
    const first = initial.find(item => item.Type === 'Episode');
    assert.equal(first.IndexNumber, 1);
    assert.equal(first.SeriesId, initial.find(item => item.Type === 'Series').Id);
    assert.equal(first.SeasonId, initial.find(item => item.Type === 'Season').Id);
    // One remote rename makes the old path absent and the new episode visible in the same listing.
    await vfs.rename(episode(1), episode(2));
    const next = await scan();
    assert.equal(next.length, 4);
    assert.ok(next.some(item => item.Id === first.Id), 'A weak absence preserves the existing episode');
    assert.ok(next.some(item => item.Type === 'Episode' && item.IndexNumber === 2 && item.SeasonId === first.SeasonId));
  } catch (error) { failures.push(error); }
  for (const cleanup of [
    () => runtime?.close(),
    () => dropPostgresTestDatabase(database),
    () => vfs.delete(remote, { recursive: true }),
    () => { assert.equal(path.dirname(root), output); return rm(root, { recursive: true, force: true }); },
  ]) {
    try { await cleanup(); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures,
    'Remote TV scan failures: ' + failures.map(error => error?.message ?? String(error)).join('; '), { cause: failures[0] });
}
