import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderRefreshService } from '../../src/metadata/provider-refresh-service.js';
import {
  RefreshProgressNotifier,
  isRefreshProgressItem,
  refreshProgressThrottleMs
} from '../../src/sessions/refresh-progress-notifier.js';
import { idKey } from '../../src/library/records.js';

const ids = {
  first: 'B1000000-0000-0000-0000-000000000001',
  second: 'B1000000-0000-0000-0000-000000000002',
  nested: 'B1000000-0000-0000-0000-000000000003',
  collection: 'C1000000-0000-0000-0000-000000000001',
  otherCollection: 'C1000000-0000-0000-0000-000000000002'
};

const folder = (Id, overrides = {}) => ({
  Id,
  Type: 'MediaBrowser.Controller.Entities.Folder',
  IsFolder: true,
  IsRoot: false,
  TopParentId: Id,
  ...overrides
});

const collection = (Id = ids.collection, physical = [ids.first, ids.second]) => ({
  Id,
  Type: 'MediaBrowser.Controller.Entities.CollectionFolder',
  IsFolder: true,
  PhysicalFolderIds: physical
});

function fixture({ folders = [], send, getFolders, onError, clock: suppliedClock } = {}) {
  const refreshes = new ProviderRefreshService();
  const messages = [];
  const errors = [];
  let now = 0;
  const sessions = {
    async sendMessageToAdminSessions(messageType, data) {
      messages.push({ messageType, data });
      await send?.({ messageType, data, index: messages.length - 1 });
    }
  };
  const library = {
    async getCollectionFolders(item) {
      return getFolders ? getFolders(item) : folders;
    }
  };
  const notifier = new RefreshProgressNotifier({
    refreshes,
    sessions,
    library,
    clock: suppliedClock ?? (() => now),
    onError: onError ?? (error => errors.push(error))
  });
  notifier.start();
  return {
    refreshes, messages, errors, notifier,
    setClock(value) { now = value; }
  };
}

test('refresh progress accepts only non-root top-level physical folders', () => {
  assert.equal(refreshProgressThrottleMs, 1000);
  for (const accepted of [
    folder(ids.first),
    folder(ids.first, { TopParentId: null, IsTopParent: true }),
    folder(ids.first, { TopParentId: null, Parent: { Type: 'MediaBrowser.Controller.Entities.AggregateFolder' } }),
    folder(ids.first, { TopParentId: null, ParentType: 'MediaBrowser.Controller.Entities.AggregateFolder' })
  ]) assert.equal(isRefreshProgressItem(accepted), true, `expected ${JSON.stringify(accepted)} to pass`);

  for (const rejected of [
    null,
    folder(ids.first, { IsFolder: false, Type: 'MediaBrowser.Controller.Entities.Movies.Movie' }),
    folder(ids.first, { IsRoot: true }),
    folder(ids.first, { Type: 'MediaBrowser.Controller.Entities.AggregateFolder' }),
    folder(ids.first, { Type: 'MediaBrowser.Controller.Entities.UserRootFolder' }),
    folder(ids.first, { Type: 'MediaBrowser.Controller.Entities.UserView' }),
    folder(ids.first, { Type: 'MediaBrowser.Controller.Entities.Channel' }),
    folder(ids.nested, { TopParentId: ids.first }),
    folder(ids.first, { IsTopParent: false }),
    folder(ids.first, { Type: 'MediaBrowser.Controller.Entities.CollectionFolder', TopParentId: null })
  ]) assert.equal(isRefreshProgressItem(rejected), false, `expected ${JSON.stringify(rejected)} to be filtered`);
});

test('intermediate progress is throttled per item while start and completion always publish string payloads', async () => {
  const state = fixture();
  const first = folder(ids.first), second = folder(ids.second);
  try {
    state.setClock(0);
    state.refreshes.reportStarted(first);
    state.refreshes.reportStarted(second);
    state.setClock(100);
    assert.equal(state.refreshes.reportProgress(first, 10), true);
    state.setClock(999);
    assert.equal(state.refreshes.reportProgress(first, 20), true);
    state.setClock(1000);
    assert.equal(state.refreshes.reportProgress(first, 30), true);
    assert.equal(state.refreshes.reportProgress(second, 50), true,
      'one item sending at the boundary does not throttle another item');
    state.setClock(1001);
    assert.equal(state.refreshes.reportProgress(first, 40), true);
    state.refreshes.reportCompleted(first);
    state.refreshes.reportStarted(first);
    await state.notifier.drain();

    assert.deepEqual(state.messages, [
      { messageType: 'RefreshProgress', data: { ItemId: idKey(ids.first), Progress: '0' } },
      { messageType: 'RefreshProgress', data: { ItemId: idKey(ids.second), Progress: '0' } },
      { messageType: 'RefreshProgress', data: { ItemId: idKey(ids.first), Progress: '30' } },
      { messageType: 'RefreshProgress', data: { ItemId: idKey(ids.second), Progress: '50' } },
      { messageType: 'RefreshProgress', data: { ItemId: idKey(ids.first), Progress: '100' } },
      { messageType: 'RefreshProgress', data: { ItemId: idKey(ids.first), Progress: '0' } }
    ]);
    for (const message of state.messages) {
      assert.deepEqual(Object.keys(message.data).toSorted(), ['ItemId', 'Progress']);
      assert.equal(typeof message.data.ItemId, 'string');
      assert.equal(typeof message.data.Progress, 'string');
    }
  } finally { await state.notifier.close(); }
});

test('collection folder messages use active physical-folder averages and completion removes a root first', async () => {
  const state = fixture({ folders: [collection()] });
  const first = folder(ids.first), second = folder(ids.second);
  const report = async operation => { operation(); await state.notifier.drain(); };
  try {
    state.setClock(0);
    await report(() => state.refreshes.reportStarted(first));
    state.setClock(1000);
    await report(() => state.refreshes.reportProgress(first, 25));
    await report(() => state.refreshes.reportStarted(second));
    state.setClock(2000);
    await report(() => state.refreshes.reportProgress(second, 75));
    await report(() => state.refreshes.reportCompleted(first));
    await report(() => state.refreshes.reportCompleted(second));

    assert.deepEqual(state.messages.map(message => message.data), [
      { ItemId: idKey(ids.first), Progress: '0' },
      { ItemId: idKey(ids.collection), Progress: '0' },
      { ItemId: idKey(ids.first), Progress: '25' },
      { ItemId: idKey(ids.collection), Progress: '25' },
      { ItemId: idKey(ids.second), Progress: '0' },
      { ItemId: idKey(ids.collection), Progress: '12.5' },
      { ItemId: idKey(ids.second), Progress: '75' },
      { ItemId: idKey(ids.collection), Progress: '50' },
      { ItemId: idKey(ids.first), Progress: '100' },
      { ItemId: idKey(ids.collection), Progress: '75' },
      { ItemId: idKey(ids.second), Progress: '100' },
      { ItemId: idKey(ids.collection), Progress: '0' }
    ]);
  } finally { await state.notifier.close(); }
});

test('progress uses invariant general-format exponent thresholds', async () => {
  const state = fixture();
  const first = folder(ids.first);
  try {
    state.refreshes.reportStarted(first);
    state.setClock(1000);
    state.refreshes.reportProgress(first, 1e-5);
    state.setClock(2000);
    state.refreshes.reportProgress(first, 1e-4);
    state.refreshes.reportProgress(first, 1e17);
    await state.notifier.drain();
    assert.deepEqual(state.messages.map(message => message.data.Progress), ['0', '1E-05', '0.0001', '1E+17']);
  } finally { await state.notifier.close(); }
});

test('send and collection lookup failures are isolated without poisoning later ordered messages', async () => {
  const sendFailure = new Error('item send failed');
  const lookupFailure = new Error('collection lookup failed');
  const errors = [];
  let failSend = true;
  let lookup = 0;
  const state = fixture({
    send() {
      if (failSend) { failSend = false; throw sendFailure; }
    },
    getFolders() {
      lookup++;
      if (lookup === 2) throw lookupFailure;
      return lookup === 1 ? [collection(ids.otherCollection, [ids.first])] : [];
    },
    onError(error) {
      errors.push(error);
      if (error === sendFailure) throw new Error('error reporter failed');
    }
  });
  const first = folder(ids.first);
  try {
    state.setClock(0);
    state.refreshes.reportStarted(first);
    await state.notifier.drain();
    state.setClock(1000);
    state.refreshes.reportProgress(first, 10);
    await state.notifier.drain();
    state.setClock(2000);
    state.refreshes.reportProgress(first, 20);
    await state.notifier.drain();

    assert.deepEqual(errors, [sendFailure, lookupFailure]);
    assert.deepEqual(state.messages.map(message => message.data), [
      { ItemId: idKey(ids.first), Progress: '0' },
      { ItemId: idKey(ids.otherCollection), Progress: '0' },
      { ItemId: idKey(ids.first), Progress: '10' },
      { ItemId: idKey(ids.first), Progress: '20' }
    ]);
  } finally { await state.notifier.close(); }
});

test('a blocked send does not defer dispatch of a later lifecycle event', async () => {
  let release;
  let startedResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const state = fixture({ folders: [collection(ids.otherCollection, [ids.first])], send: async () => {
    calls++;
    if (calls === 1) { startedResolve(); await blocked; }
  } });
  const first = folder(ids.first);
  try {
    state.refreshes.reportStarted(first);
    await started;
    state.setClock(1000);
    state.refreshes.reportProgress(first, 25);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(state.messages.map(message => `${message.data.ItemId}:${message.data.Progress}`).toSorted(), [
      `${idKey(ids.first)}:0`, `${idKey(ids.first)}:25`,
      `${idKey(ids.otherCollection)}:0`, `${idKey(ids.otherCollection)}:25`
    ].toSorted(), 'a blocked physical send does not block its collection or the next event');
    release();
    await state.notifier.drain();
  } finally { release?.(); await state.notifier.close(); }
});

test('close removes lifecycle listeners, ignores later events, drains an active send and is idempotent', async () => {
  let release;
  let startedResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const state = fixture({ send: async () => { startedResolve(); await blocked; } });
  const first = folder(ids.first);

  state.refreshes.reportStarted(first);
  await started;
  let closed = false;
  const closing = state.notifier.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false, 'close waits for a send that already started');
  assert.equal(state.refreshes.listenerCount('RefreshStarted'), 0);
  assert.equal(state.refreshes.listenerCount('RefreshProgress'), 0);
  assert.equal(state.refreshes.listenerCount('RefreshCompleted'), 0);

  state.setClock(1000);
  state.refreshes.reportProgress(first, 50);
  assert.equal(state.messages.length, 1, 'closed notifier ignores later lifecycle events');
  release();
  await closing;
  assert.equal(closed, true);
  await state.notifier.close();
});
