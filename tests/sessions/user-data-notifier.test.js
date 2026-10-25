import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { UserDataChangeNotifier, userDataChangeDelayMs, userDataChangeMaxBatchSize } from '../../src/sessions/user-data-notifier.js';
import { guidN } from '../../src/sessions/user-data.js';

const ids = {
  firstUser: '10000000-0000-0000-0000-000000000001', secondUser: '10000000-0000-0000-0000-000000000002',
  item: '20000000-0000-0000-0000-000000000001', other: '20000000-0000-0000-0000-000000000002',
  third: '20000000-0000-0000-0000-000000000003', fourth: '20000000-0000-0000-0000-000000000004',
  parent: '30000000-0000-0000-0000-000000000001', missingOwner: '30000000-0000-0000-0000-000000000002'
};

class FakeScheduler {
  tasks = [];
  schedule = (callback, delay) => {
    const task = { callback, delay, cancelled: false, ran: false, unref() { this.unrefed = true; } };
    this.tasks.push(task);
    return task;
  };
  cancel = task => { task.cancelled = true; };
  pending() { return this.tasks.filter(task => !task.cancelled && !task.ran); }
  async runNext() {
    const task = this.pending()[0];
    assert.ok(task, 'expected a pending timer');
    task.ran = true;
    await task.callback();
  }
}

function fixture({ maxBatchSize, afterMessage } = {}) {
  const userData = new EventEmitter();
  const reads = [];
  userData.get = async (userId, itemId) => {
    reads.push([guidN(userId), guidN(itemId)]);
    if (guidN(itemId) === guidN(ids.missingOwner)) throw Object.assign(new Error('missing owner'), { status: 404 });
    return { ItemId: guidN(itemId), Key: guidN(itemId), IsFavorite: false, PlaybackPositionTicks: 0n };
  };
  const messages = [];
  const sessions = { async sendMessageToUserSessions(userIds, messageType, data) {
    const message = { userIds, messageType, data: typeof data === 'function' ? await data() : data };
    messages.push(message);
    await afterMessage?.(message);
  } };
  const scheduler = new FakeScheduler();
  const errors = [];
  const notifier = new UserDataChangeNotifier({ userData, sessions, delayMs: 500,
    ...(maxBatchSize === undefined ? {} : { maxBatchSize }),
    schedule: scheduler.schedule, cancel: scheduler.cancel, onError: error => errors.push(error) });
  notifier.start();
  return { userData, reads, messages, sessions, scheduler, errors, notifier };
}

test('user data notifier uses a fixed window, batches per user, includes one owner or parent level and ignores playback progress', async () => {
  assert.equal(userDataChangeDelayMs, 500);
  assert.equal(userDataChangeMaxBatchSize, 2000);
  const state = fixture();
  try {
    state.userData.emit('UserDataSaved', { UserId: ids.firstUser, SaveReason: 'PlaybackProgress', Item: { Id: ids.item, ParentId: ids.parent } });
    assert.equal(state.scheduler.pending().length, 0);

    state.userData.emit('UserDataSaved', { UserId: ids.firstUser, SaveReason: 'UpdateUserRating',
      Item: { Id: ids.item, OwnerId: ids.missingOwner, ParentId: ids.parent } });
    const firstWindow = state.scheduler.pending()[0];
    state.userData.emit('UserDataSaved', { UserId: ids.firstUser, SaveReason: 'PlaybackStart', Item: { Id: ids.other, ParentId: ids.parent } });
    state.userData.emit('UserDataSaved', { UserId: ids.secondUser, SaveReason: 'TogglePlayed', Item: { Id: ids.third } });

    assert.equal(state.scheduler.tasks.length, 1, 'later changes neither cancel nor replace the first timer');
    assert.equal(state.scheduler.pending()[0], firstWindow);
    assert.deepEqual(state.scheduler.pending().map(task => task.delay), [500], 'later changes do not extend the first-change window');
    await state.scheduler.runNext();
    await state.notifier.drain();

    assert.deepEqual(state.messages.map(message => message.userIds), [[guidN(ids.firstUser)], [guidN(ids.secondUser)]]);
    assert.deepEqual(state.messages.map(message => message.messageType), ['UserDataChanged', 'UserDataChanged']);
    assert.equal(state.messages[0].data.UserId, guidN(ids.firstUser));
    assert.deepEqual(state.messages[0].data.UserDataList.map(dto => dto.ItemId).toSorted(), [ids.item, ids.parent, ids.other].map(guidN).toSorted());
    assert.deepEqual(state.messages[1].data.UserDataList.map(dto => dto.ItemId), [guidN(ids.third)]);
    assert.ok(state.reads.some(([, itemId]) => itemId === guidN(ids.missingOwner)), 'owner is resolved before the parent fallback');
    assert.deepEqual(state.errors, []);
  } finally { await state.notifier.close(); }
  assert.equal(state.userData.listenerCount('UserDataSaved'), 0);
});

test('user data notifier advances a full batch immediately and cancels pending work on close', async () => {
  const state = fixture({ maxBatchSize: 3 });
  for (const itemId of [ids.item, ids.other]) state.userData.emit('UserDataSaved', { UserId: ids.firstUser, SaveReason: 'TogglePlayed', Item: { Id: itemId } });
  state.userData.emit('UserDataSaved', { UserId: ids.secondUser, SaveReason: 'TogglePlayed', Item: { Id: ids.third } });
  assert.deepEqual(state.scheduler.tasks.map(task => [task.delay, task.cancelled]), [[500, true]]);
  assert.equal(state.scheduler.pending().length, 0, 'a full batch rotates synchronously instead of repeatedly postponing a zero-delay timer');
  await state.notifier.drain();
  assert.deepEqual(state.messages.map(message => message.data.UserDataList.map(dto => dto.ItemId)),
    [[ids.item, ids.other].map(guidN), [guidN(ids.third)]]);

  state.userData.emit('UserDataSaved', { UserId: ids.firstUser, SaveReason: 'TogglePlayed', Item: { Id: ids.fourth } });
  assert.deepEqual(state.scheduler.pending().map(task => task.delay), [500]);
  await state.notifier.close();
  assert.equal(state.scheduler.pending().length, 0);
  assert.equal(state.messages.length, 2);
});

test('user data notifier uses the default global 2000-item threshold without counting duplicate ids', async () => {
  const state = fixture();
  const generatedId = index => {
    const value = (index + 1).toString(16).padStart(32, '0');
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
  };
  try {
    for (let index = 0; index < 1999; index++) {
      state.userData.emit('UserDataSaved', { UserId: ids.firstUser, SaveReason: 'TogglePlayed', Item: { Id: generatedId(index) } });
    }
    const window = state.scheduler.pending()[0];
    assert.equal(state.scheduler.tasks.length, 1);
    assert.equal(window.delay, 500);

    state.userData.emit('UserDataSaved', { UserId: ids.firstUser, SaveReason: 'TogglePlayed', Item: { Id: generatedId(0) } });
    assert.equal(state.scheduler.tasks.length, 1, 'a duplicate item does not advance the threshold');
    assert.equal(window.cancelled, false);

    state.userData.emit('UserDataSaved', { UserId: ids.secondUser, SaveReason: 'TogglePlayed', Item: { Id: generatedId(1999) } });
    assert.equal(window.cancelled, true);
    assert.equal(state.scheduler.pending().length, 0);
    await state.notifier.drain();

    assert.deepEqual(state.messages.map(message => [message.data.UserId, message.data.UserDataList.length]),
      [[guidN(ids.firstUser), 1999], [guidN(ids.secondUser), 1]]);
    assert.equal(state.scheduler.pending().length, 0, 'the cancelled 500ms timer cannot send the batch twice');
  } finally { await state.notifier.close(); }
});

test('synchronous streams rotate every full batch instead of growing behind a deferred immediate timer', async () => {
  const state = fixture({ maxBatchSize: 3 });
  try {
    for (let index = 0; index < 10; index++) {
      const value = (index + 1).toString(16).padStart(32, '0');
      state.userData.emit('UserDataSaved', { UserId: ids.firstUser, SaveReason: 'TogglePlayed', Item: { Id: value } });
    }
    await state.notifier.drain();
    assert.deepEqual(state.messages.map(message => message.data.UserDataList.length), [3, 3, 3]);
    assert.deepEqual(state.scheduler.pending().map(task => task.delay), [500]);
    await state.scheduler.runNext();
    assert.deepEqual(state.messages.map(message => message.data.UserDataList.length), [3, 3, 3, 1]);
  } finally { await state.notifier.close(); }
});

test('a later full batch can send while an earlier batch is still in flight', async () => {
  const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
  };
  const gates = [deferred(), deferred()];
  const started = [];
  const completed = [];
  const state = fixture({ maxBatchSize: 1, afterMessage: async message => {
    const index = started.length;
    started.push(message.data.UserDataList[0].ItemId);
    await gates[index].promise;
    completed.push(index);
  } });
  try {
    state.userData.emit('UserDataSaved', { UserId: ids.firstUser, SaveReason: 'TogglePlayed', Item: { Id: ids.item } });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(started, [guidN(ids.item)]);

    state.userData.emit('UserDataSaved', { UserId: ids.firstUser, SaveReason: 'TogglePlayed', Item: { Id: ids.other } });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(started, [guidN(ids.item), guidN(ids.other)], 'the second batch is not serialized behind the first send');
    assert.deepEqual(completed, []);

    gates[1].resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(completed, [1], 'the later batch may complete before the earlier batch');
    gates[0].resolve();
    await state.notifier.drain();
    assert.deepEqual(completed, [1, 0]);
  } finally {
    gates[0].resolve();
    gates[1].resolve();
    await state.notifier.close();
  }
});

test('user data notifier retains the item and related-item snapshots selected when the event is raised', async () => {
  const userData = new EventEmitter();
  const scheduler = new FakeScheduler();
  const item = { Id: ids.item, OwnerId: ids.missingOwner, ParentId: ids.parent };
  const parent = { Id: ids.parent, Name: 'Event-time parent' };
  const captured = [{ id: item.Id, item }, { id: parent.Id, item: parent }];
  let projected;
  userData.getChangeReferences = value => {
    assert.equal(value, item);
    return captured;
  };
  userData.getMany = async (_userId, references) => {
    projected = [...references];
    return projected.map(reference => ({ ItemId: guidN(reference.item.Id), Key: guidN(reference.item.Id) }));
  };
  const messages = [];
  const notifier = new UserDataChangeNotifier({ userData, sessions: {
    async sendMessageToUserSessions(_userIds, _messageType, data) { messages.push(await data()); }
  }, schedule: scheduler.schedule, cancel: scheduler.cancel });
  notifier.start();
  try {
    userData.emit('UserDataSaved', { UserId: ids.firstUser, SaveReason: 'UpdateUserRating', Item: item });
    assert.equal(projected, undefined, 'DTO values remain lazy until the fixed window is flushed');
    item.OwnerId = ids.other;
    await scheduler.runNext();
    await notifier.drain();
    assert.deepEqual(projected, captured, 'later hierarchy changes cannot replace the event-time parent selection');
    assert.deepEqual(messages[0].UserDataList.map(dto => dto.ItemId), [guidN(ids.item), guidN(ids.parent)]);
  } finally { await notifier.close(); }
});

test('closing cancels pending work but waits for a batch that already started sending', async () => {
  const userData = new EventEmitter();
  const scheduler = new FakeScheduler();
  let release;
  let startedResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  userData.getMany = async () => { startedResolve(); await blocked; return []; };
  const notifier = new UserDataChangeNotifier({ userData, sessions: {
    async sendMessageToUserSessions(_userIds, _messageType, data) { await data(); }
  }, schedule: scheduler.schedule, cancel: scheduler.cancel });
  notifier.start();
  userData.emit('UserDataSaved', { UserId: ids.firstUser, SaveReason: 'TogglePlayed', Item: { Id: ids.item } });
  const task = scheduler.pending()[0];
  task.ran = true;
  const sending = task.callback();
  await started;
  let closed = false;
  const closing = notifier.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  await Promise.all([sending, closing]);
  assert.equal(closed, true);
  assert.equal(userData.listenerCount('UserDataSaved'), 0);
});
