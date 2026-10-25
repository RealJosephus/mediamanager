import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  LibraryChangedNotifier,
  isLibraryChangedItem,
  libraryChangedDefaultDelayMs,
  libraryChangedMaxBatchSize
} from '../../src/sessions/library-changed-notifier.js';
import { emptyGuid, guidN } from '../../src/sessions/user-data.js';

const ids = {
  firstUser: '10000000-0000-0000-0000-000000000001',
  secondUser: '10000000-0000-0000-0000-000000000002',
  additionalOnlyUser: '10000000-0000-0000-0000-000000000003',
  firstItem: '20000000-0000-0000-0000-000000000001',
  secondItem: '20000000-0000-0000-0000-000000000002',
  thirdItem: '20000000-0000-0000-0000-000000000003',
  fourthItem: '20000000-0000-0000-0000-000000000004',
  addedParent: '30000000-0000-0000-0000-000000000001',
  removedParent: '30000000-0000-0000-0000-000000000002',
  otherParent: '30000000-0000-0000-0000-000000000003'
};

class FakeScheduler {
  tasks = [];

  schedule = (callback, delay) => {
    const task = {
      callback,
      delay,
      cancelled: false,
      ran: false,
      unref() { this.unrefed = true; }
    };
    this.tasks.push(task);
    return task;
  };

  cancel = task => { task.cancelled = true; };

  pending() { return this.tasks.filter(task => !task.cancelled && !task.ran); }

  async runNext() {
    const task = this.pending()[0];
    assert.ok(task, 'expected a pending library-change timer');
    task.ran = true;
    await task.callback();
  }
}

const item = (Id, overrides = {}) => ({
  Id,
  Type: 'Movie',
  IsFolder: false,
  Path: `Z:\\Library\\${guidN(Id)}.mkv`,
  SourceType: 'Library',
  ...overrides
});

const folder = (Id, overrides = {}) => ({
  Id,
  Type: 'Folder',
  IsFolder: true,
  Path: null,
  SourceType: 'Library',
  ...overrides
});

function infoFromChanges(changes, user) {
  const project = values => values.map(value => guidN(value.Id));
  return {
    FoldersAddedTo: project(changes.foldersAddedTo),
    FoldersRemovedFrom: project(changes.foldersRemovedFrom),
    ItemsAdded: project(changes.itemsAdded),
    ItemsRemoved: project(changes.itemsRemoved),
    ItemsUpdated: project(changes.itemsUpdated),
    CollectionFolders: [],
    PerspectiveUserId: guidN(user.Id)
  };
}

function emptyInfo() {
  return {
    FoldersAddedTo: [],
    FoldersRemovedFrom: [],
    ItemsAdded: [],
    ItemsRemoved: [],
    ItemsUpdated: [],
    CollectionFolders: []
  };
}

function fixture({
  delayMs = 500,
  maxBatchSize,
  sessionRecords,
  usersById,
  getInfo = infoFromChanges,
  afterMessage
} = {}) {
  const events = new EventEmitter();
  const scheduler = new FakeScheduler();
  const errors = [];
  const libraryCalls = [];
  const userCalls = [];
  const messages = [];
  const records = sessionRecords ?? [{ Id: 'first-session', UserId: guidN(ids.firstUser), AdditionalUsers: [] }];
  const knownUsers = usersById ?? new Map([[guidN(ids.firstUser), { Id: guidN(ids.firstUser), Username: 'First' }]]);

  const sessions = {
    getPrimaryUserIds() {
      return [...new Set(records.map(record => guidN(record.UserId)).filter(userId => userId !== emptyGuid))];
    },
    async sendMessageToUserSessions(userIds, messageType, data) {
      const normalized = userIds.map(guidN);
      const recipients = records.filter(record => normalized.some(userId =>
        guidN(record.UserId) === userId
        || (record.AdditionalUsers ?? []).some(user => guidN(user.UserId) === userId)))
        .map(record => record.Id);
      const message = { userIds: normalized, messageType, data, recipients };
      messages.push(message);
      await afterMessage?.(message);
    }
  };
  const users = {
    async getUser(userId) {
      const normalized = guidN(userId);
      userCalls.push(normalized);
      return knownUsers.get(normalized) ?? null;
    }
  };
  const library = {
    async getLibraryUpdateInfo(changes, { user }) {
      libraryCalls.push({ changes, user });
      return getInfo(changes, user);
    }
  };
  const notifier = new LibraryChangedNotifier({
    events,
    sessions,
    users,
    library,
    delayMs,
    maxBatchSize,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    onError: error => errors.push(error)
  });
  notifier.start();
  return { events, scheduler, errors, libraryCalls, userCalls, messages, sessions, users, library, notifier };
}

test('library-change filtering matches the native folder, path, name-item and source gates', () => {
  assert.equal(libraryChangedDefaultDelayMs, 30000);
  assert.equal(libraryChangedMaxBatchSize, 2000);

  for (const accepted of [
    folder(ids.firstItem),
    item(ids.firstItem),
    folder(ids.firstItem, { Type: 'MusicArtist' }),
    folder(ids.firstItem, { NativeType: 'MediaBrowser.Controller.Entities.Audio.MusicArtist', Type: undefined }),
    item(ids.firstItem, { SourceType: null }),
    item(ids.firstItem, { SourceType: 0 })
  ]) assert.equal(isLibraryChangedItem(accepted), true, `expected ${accepted.Type ?? accepted.NativeType} to pass`);

  for (const rejected of [
    null,
    item(emptyGuid),
    item(ids.firstItem, { Path: null }),
    item(ids.firstItem, { Type: 'Person' }),
    item(ids.firstItem, { Type: 'Genre' }),
    item(ids.firstItem, { Type: 'MusicGenre' }),
    item(ids.firstItem, { Type: 'Studio' }),
    item(ids.firstItem, { Type: 'Year' }),
    item(ids.firstItem, { SourceType: 'Channel' }),
    item(ids.firstItem, { SourceType: 1 })
  ]) assert.equal(isLibraryChangedItem(rejected), false, `expected ${rejected?.Type ?? 'null'} to be filtered`);
});

test('the first accepted change owns a fixed window and filtered changes do not open one', async () => {
  const state = fixture({ delayMs: 725 });
  try {
    state.events.emit('ItemAdded', { Item: item(ids.firstItem, { Path: null }) });
    state.events.emit('ItemUpdated', { Item: item(ids.secondItem, { Type: 'Person' }) });
    assert.equal(state.scheduler.tasks.length, 0);

    state.events.emit('ItemAdded', { Item: item(ids.firstItem) });
    const firstWindow = state.scheduler.pending()[0];
    state.events.emit('ItemUpdated', { Item: item(ids.secondItem) });
    state.events.emit('ItemRemoved', { Item: item(ids.thirdItem) });

    assert.equal(state.scheduler.tasks.length, 1, 'later changes do not replace the first timer');
    assert.equal(state.scheduler.pending()[0], firstWindow);
    assert.equal(firstWindow.delay, 725);
    assert.equal(firstWindow.cancelled, false);
    assert.equal(firstWindow.unrefed, true);

    await state.scheduler.runNext();
    await state.notifier.drain();
    assert.equal(state.libraryCalls.length, 1);
    assert.deepEqual(state.messages.map(message => message.messageType), ['LibraryChanged']);

    state.events.emit('ItemUpdated', { Item: item(ids.fourthItem) });
    assert.equal(state.scheduler.tasks.length, 2, 'a change after rotation starts a new fixed window');
  } finally { await state.notifier.close(); }
});

test('configuration duration is sampled when each new batch opens', async () => {
  const events = new EventEmitter();
  const scheduler = new FakeScheduler();
  const configuration = { LibraryUpdateDuration: 1 };
  const notifier = new LibraryChangedNotifier({
    events,
    sessions: { getPrimaryUserIds: () => [], async sendMessageToUserSessions() {} },
    users: { async getUser() { return null; } },
    library: { async getLibraryUpdateInfo() { return emptyInfo(); } },
    configuration,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel
  });
  notifier.start();
  try {
    events.emit('ItemUpdated', { Item: item(ids.firstItem) });
    configuration.LibraryUpdateDuration = 2;
    events.emit('ItemUpdated', { Item: item(ids.secondItem) });
    assert.deepEqual(scheduler.tasks.map(task => task.delay), [1000], 'an open batch keeps its original duration');
    await scheduler.runNext();

    events.emit('ItemUpdated', { Item: item(ids.thirdItem) });
    assert.deepEqual(scheduler.tasks.map(task => task.delay), [1000, 2000], 'the next batch samples the current configuration');
  } finally { await notifier.close(); }
});

test('the global category cap can be reduced without counting same-category duplicates', async () => {
  const state = fixture({ delayMs: 3600000, maxBatchSize: 3 });
  try {
    const added = item(ids.firstItem, { Marker: 'latest add' });
    state.events.emit('ItemAdded', { Item: item(ids.firstItem, { Marker: 'old add' }) });
    const window = state.scheduler.pending()[0];
    state.events.emit('ItemAdded', { Item: added });
    assert.equal(window.cancelled, false, 'an overwrite in one category does not advance the cap');

    state.events.emit('ItemUpdated', { Item: item(ids.firstItem, { Marker: 'update' }) });
    assert.equal(window.cancelled, false, 'the same id in another category advances the global count only once there');
    state.events.emit('ItemRemoved', { Item: item(ids.firstItem, { Marker: 'remove' }) });

    assert.equal(window.cancelled, true);
    assert.equal(state.scheduler.pending().length, 0, 'a full batch rotates synchronously');
    await state.notifier.drain();

    const [changes] = state.libraryCalls.map(call => call.changes);
    assert.deepEqual(changes.itemsAdded, [added]);
    assert.deepEqual(changes.itemsUpdated, [], 'an added id suppresses its update only when the batch is rotated');
    assert.equal(changes.itemsRemoved[0].Marker, 'remove', 'remove remains independent of add/update coalescing');
    assert.equal(state.messages.length, 1);
  } finally { await state.notifier.close(); }
});

test('the default batch rotates synchronously on the 2000th distinct category entry', async () => {
  const state = fixture({ delayMs: 3600000 });
  try {
    for (let index = 1; index < libraryChangedMaxBatchSize; index++) {
      state.events.emit('ItemUpdated', { Item: item(`50000000-0000-0000-0000-${String(index).padStart(12, '0')}`) });
    }
    const window = state.scheduler.pending()[0];
    assert.ok(window);
    assert.equal(window.cancelled, false);
    assert.equal(state.libraryCalls.length, 0);

    state.events.emit('ItemUpdated', { Item: item('50000000-0000-0000-0000-000000002000') });
    assert.equal(window.cancelled, true);
    assert.equal(state.scheduler.pending().length, 0);
    await state.notifier.drain();
    assert.equal(state.libraryCalls.length, 1);
    assert.equal(state.libraryCalls[0].changes.itemsUpdated.length, libraryChangedMaxBatchSize);
    assert.equal(state.messages.length, 1);
  } finally { await state.notifier.close(); }
});

test('add, update, remove and parent maps coalesce independently and retain their latest references', async () => {
  const state = fixture();
  const latestAdded = item(ids.firstItem, { Marker: 'latest added' });
  const latestUpdated = item(ids.secondItem, { Marker: 'latest updated' });
  const latestRemoved = item(ids.firstItem, { Marker: 'latest removed' });
  const latestAddedParent = folder(ids.addedParent, { Marker: 'latest added parent' });
  const latestRemovedParent = folder(ids.removedParent, { Marker: 'latest removed parent' });
  try {
    state.events.emit('ItemAdded', { Item: item(ids.firstItem, { Marker: 'old added' }), Parent: folder(ids.addedParent, { Marker: 'old added parent' }) });
    state.events.emit('ItemAdded', { Item: latestAdded, Parent: latestAddedParent });
    state.events.emit('ItemUpdated', { Item: item(ids.firstItem, { Marker: 'suppressed update' }), Parent: folder(ids.otherParent) });
    state.events.emit('ItemUpdated', { Item: item(ids.secondItem, { Marker: 'old updated' }) });
    state.events.emit('ItemUpdated', { Item: latestUpdated, Parent: folder(ids.otherParent) });
    state.events.emit('ItemRemoved', { Item: item(ids.firstItem, { Marker: 'old removed' }), Parent: folder(ids.removedParent, { Marker: 'old removed parent' }) });
    state.events.emit('ItemRemoved', { Item: latestRemoved, Parent: latestRemovedParent });
    state.events.emit('ItemRemoved', { Item: item(ids.thirdItem), Parent: { Id: ids.otherParent, IsFolder: false } });

    await state.scheduler.runNext();
    await state.notifier.drain();
    const changes = state.libraryCalls[0].changes;

    assert.deepEqual(changes.itemsAdded, [latestAdded]);
    assert.deepEqual(changes.itemsUpdated, [latestUpdated]);
    assert.deepEqual(changes.itemsRemoved, [latestRemoved, item(ids.thirdItem)]);
    assert.deepEqual(changes.foldersAddedTo, [latestAddedParent]);
    assert.deepEqual(changes.foldersRemovedFrom, [latestRemovedParent]);
    assert.equal(changes.foldersAddedTo.some(parent => guidN(parent.Id) === guidN(ids.otherParent)), false,
      'updates never contribute parent folders');
  } finally { await state.notifier.close(); }
});

test('only primary users receive a tailored payload while session delivery includes their additional memberships', async () => {
  const first = guidN(ids.firstUser);
  const second = guidN(ids.secondUser);
  const additionalOnly = guidN(ids.additionalOnlyUser);
  const records = [
    { Id: 'shared', UserId: first, AdditionalUsers: [{ UserId: second }, { UserId: additionalOnly }] },
    { Id: 'second-primary', UserId: second, AdditionalUsers: [] }
  ];
  const usersById = new Map([
    [first, { Id: first, Username: 'First' }],
    [second, { Id: second, Username: 'Second' }],
    [additionalOnly, { Id: additionalOnly, Username: 'Additional only' }]
  ]);
  const state = fixture({ sessionRecords: records, usersById });
  try {
    state.events.emit('ItemAdded', { Item: item(ids.firstItem) });
    await state.scheduler.runNext();
    await state.notifier.drain();

    assert.deepEqual(state.userCalls, [first, second], 'an additional-only user does not get a separately built DTO');
    assert.deepEqual(state.messages.map(message => ({
      userId: message.userIds[0],
      perspective: message.data.PerspectiveUserId,
      recipients: message.recipients
    })), [
      { userId: first, perspective: first, recipients: ['shared'] },
      { userId: second, perspective: second, recipients: ['shared', 'second-primary'] }
    ]);
    assert.equal(state.messages.some(message => message.userIds[0] === additionalOnly), false);
  } finally { await state.notifier.close(); }
});

test('a send failure is reported and processing continues, while a DTO failure aborts later users', async () => {
  const first = guidN(ids.firstUser);
  const second = guidN(ids.secondUser);
  const third = guidN(ids.additionalOnlyUser);
  const sendFailure = new Error('first send failed');
  const dtoFailure = new Error('second DTO failed');
  const projected = [];
  const state = fixture({
    sessionRecords: [
      { Id: 'first', UserId: first, AdditionalUsers: [] },
      { Id: 'second', UserId: second, AdditionalUsers: [] },
      { Id: 'third', UserId: third, AdditionalUsers: [] }
    ],
    usersById: new Map([
      [first, { Id: first }],
      [second, { Id: second }],
      [third, { Id: third }]
    ]),
    getInfo(changes, user) {
      projected.push(guidN(user.Id));
      if (guidN(user.Id) === second) throw dtoFailure;
      return infoFromChanges(changes, user);
    },
    afterMessage(message) {
      if (message.userIds[0] === first) throw sendFailure;
    }
  });
  try {
    state.events.emit('ItemAdded', { Item: item(ids.firstItem) });
    await state.scheduler.runNext();
    await state.notifier.drain();

    assert.deepEqual(projected, [first, second], 'the DTO failure stops processing before the third primary user');
    assert.deepEqual(state.messages.map(message => message.userIds), [[first]], 'the failed first send was attempted and processing reached the second user');
    assert.deepEqual(state.errors, [sendFailure, dtoFailure]);
  } finally { await state.notifier.close(); }
});

test('empty per-user DTOs are skipped without preventing a later primary user notification', async () => {
  const first = guidN(ids.firstUser);
  const second = guidN(ids.secondUser);
  const state = fixture({
    sessionRecords: [
      { Id: 'first', UserId: first, AdditionalUsers: [] },
      { Id: 'second', UserId: second, AdditionalUsers: [] }
    ],
    usersById: new Map([[first, { Id: first }], [second, { Id: second }]]),
    getInfo(changes, user) { return guidN(user.Id) === first ? emptyInfo() : infoFromChanges(changes, user); }
  });
  try {
    state.events.emit('ItemAdded', { Item: item(ids.firstItem) });
    await state.scheduler.runNext();
    await state.notifier.drain();
    assert.deepEqual(state.messages.map(message => message.userIds), [[second]]);
  } finally { await state.notifier.close(); }
});

test('a CollectionFolders-only projection is not treated as an empty notification', async () => {
  const state = fixture({
    getInfo() { return { ...emptyInfo(), CollectionFolders: [guidN(ids.addedParent)] }; }
  });
  try {
    state.events.emit('ItemAdded', { Item: item(ids.firstItem), Parent: folder(ids.addedParent) });
    await state.scheduler.runNext();
    await state.notifier.drain();
    assert.equal(state.messages.length, 1);
    assert.deepEqual(state.messages[0].data, { ...emptyInfo(), CollectionFolders: [guidN(ids.addedParent)] });
  } finally { await state.notifier.close(); }
});

test('close cancels and drops a pending batch, removes listeners, and drains a send already in flight', async () => {
  let release;
  let startedResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const state = fixture({ afterMessage: async () => { startedResolve(); await blocked; } });

  state.events.emit('ItemAdded', { Item: item(ids.firstItem) });
  const sendingTimer = state.scheduler.pending()[0];
  sendingTimer.ran = true;
  const sending = sendingTimer.callback();
  await started;

  state.events.emit('ItemAdded', { Item: item(ids.secondItem) });
  const pendingTimer = state.scheduler.pending()[0];
  assert.ok(pendingTimer);

  let closed = false;
  const closing = state.notifier.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false, 'close waits for the send that already started');
  assert.equal(pendingTimer.cancelled, true, 'close cancels the next fixed window');
  assert.equal(state.events.listenerCount('ItemAdded'), 0);
  assert.equal(state.events.listenerCount('ItemUpdated'), 0);
  assert.equal(state.events.listenerCount('ItemRemoved'), 0);

  release();
  await Promise.all([sending, closing]);
  assert.equal(closed, true);
  assert.equal(state.libraryCalls.length, 1, 'the pending second batch is dropped, not flushed during close');
  assert.equal(state.messages.length, 1);

  const taskCount = state.scheduler.tasks.length;
  state.events.emit('ItemAdded', { Item: item(ids.thirdItem) });
  assert.equal(state.scheduler.tasks.length, taskCount, 'closed notifiers ignore later events');
  await state.notifier.close();
});
