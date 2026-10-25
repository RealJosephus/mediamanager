import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderRefreshService } from '../../src/metadata/provider-refresh-service.js';

const first = { Id: 'A1000000-0000-0000-0000-000000000001', Type: 'Folder', IsFolder: true };
const second = { Id: 'A1000000-0000-0000-0000-000000000002', Type: 'Folder', IsFolder: true };

test('provider refresh lifecycle exposes ordered active state and ignores stale progress', () => {
  const refreshes = new ProviderRefreshService();
  const events = [];
  refreshes.on('RefreshStarted', ({ Item }) => events.push(['started', Item.Id, refreshes.getRefreshProgress(Item.Id)]));
  refreshes.on('RefreshProgress', ({ Item, Progress }) => events.push(['progress', Item.Id, Progress, refreshes.getRefreshProgress(Item.Id)]));
  refreshes.on('RefreshCompleted', ({ Item }) => events.push(['completed', Item.Id, refreshes.getRefreshProgress(Item.Id)]));

  assert.equal(refreshes.reportProgress(first, 1), false, 'inactive items do not publish progress');
  refreshes.reportStarted(first);
  assert.equal(refreshes.getRefreshProgress(first.Id), 0);
  assert.equal(refreshes.reportProgress(first, 0), false);
  assert.equal(refreshes.reportProgress(first, -1), false);
  assert.equal(refreshes.reportProgress(first, 25), true);
  assert.equal(refreshes.reportProgress(first, 25), false);
  assert.equal(refreshes.reportProgress(first, 10), false);

  const snapshot = refreshes.snapshot();
  snapshot.set(first.Id.replaceAll('-', '').toLowerCase(), 99);
  assert.equal(refreshes.getRefreshProgress(first.Id), 25, 'snapshots cannot mutate authoritative progress');

  refreshes.reportStarted(second);
  assert.deepEqual([...refreshes.snapshot().values()], [25, 0]);
  refreshes.reportCompleted(first);
  assert.equal(refreshes.getRefreshProgress(first.Id), null, 'completion removes state before observers run');
  assert.equal(refreshes.reportProgress(first, 50), false);
  refreshes.reportCompleted(first);

  assert.deepEqual(events, [
    ['started', first.Id, 0],
    ['progress', first.Id, 25, 25],
    ['started', second.Id, 0],
    ['completed', first.Id, null],
    ['completed', first.Id, null]
  ]);
});

test('provider refresh observer and error-reporter failures cannot break refresh ownership', () => {
  const observerFailure = new Error('observer failed');
  const reported = [];
  const refreshes = new ProviderRefreshService({ onError(error) {
    reported.push(error);
    throw new Error('error reporter failed');
  } });
  refreshes.on('RefreshStarted', () => { throw observerFailure; });
  refreshes.on('RefreshProgress', () => { throw observerFailure; });
  refreshes.on('RefreshCompleted', () => { throw observerFailure; });

  assert.doesNotThrow(() => refreshes.reportStarted(first));
  assert.equal(refreshes.getRefreshProgress(first.Id), 0);
  assert.equal(refreshes.reportProgress(first, 12.5), true);
  assert.equal(refreshes.getRefreshProgress(first.Id), 12.5);
  assert.doesNotThrow(() => refreshes.reportCompleted(first));
  assert.equal(refreshes.getRefreshProgress(first.Id), null);
  assert.deepEqual(reported, [observerFailure, observerFailure, observerFailure]);

  assert.throws(() => refreshes.reportProgress(first, '50'), /must be a number/);
  assert.throws(() => refreshes.reportStarted({}), /with an Id/);
});
