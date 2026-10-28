import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { LiveTvTimersService } from '../../src/library/live-tv-timers-service.js';
import { indexLiveTvDocument, liveTvStateKey } from '../../src/library/live-tv-state.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const indexed = (kind, bytes) => ({ ...indexLiveTvDocument(kind, bytes), sourceHex: bytes.toString('hex'), sourceSha256: hash(bytes) });

function fixture({ timers, seriesTimers, failRename, beforeRename, corruptHash, sendFailure,
  commitUnknown = false, failRecovery = false } = {}) {
  const timerBytes = Buffer.from(timers), seriesBytes = Buffer.from(seriesTimers);
  let state = JSON.stringify({ timers: indexed('timers', timerBytes), seriesTimers: indexed('seriesTimers', seriesBytes) });
  if (corruptHash) {
    const document = JSON.parse(state); document[corruptHash].sourceSha256 = '0'.repeat(64); state = JSON.stringify(document);
  }
  const files = new Map([
    [path.join('C:\\state', 'livetv', 'timers.json'), timerBytes],
    [path.join('C:\\state', 'livetv', 'seriestimers.json'), seriesBytes],
  ]);
  const fileSystem = {
    async mkdir() {},
    async readFile(filename) {
      if (!files.has(filename)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return Buffer.from(files.get(filename));
    },
    async open(filename, flags) {
      assert.equal(flags, 'wx');
      if (files.has(filename)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      files.set(filename, Buffer.alloc(0));
      return { async writeFile(bytes) { files.set(filename, Buffer.from(bytes)); }, async close() {} };
    },
    async rename(source, target) {
      await beforeRename?.(source, target);
      if (failRename?.(source, target)) throw new Error('Controlled publication failure.');
      const bytes = files.get(source); files.set(target, bytes); files.delete(source);
    },
    async rm(filename) { files.delete(filename); },
  };
  let commitFailurePending = commitUnknown, serializedWrites = 0;
  const database = { controlSchema: 'timer_control', async transaction(operation) {
    const before = state;
    try {
      const result = await operation(this);
      if (commitFailurePending) {
        commitFailurePending = false;
        throw Object.assign(new Error('Controlled unknown commit outcome.'), { commitOutcomeUnknown: true });
      }
      return result;
    }
    catch (error) { if (!error?.commitOutcomeUnknown) state = before; throw error; }
  }, client: { async query(plan) {
    if (plan.text.startsWith('SELECT value')) return { rows: [{ value: state }] };
    if (plan.text.startsWith('UPDATE')) { assert.equal(plan.values[0], liveTvStateKey); state = plan.values[1]; return { rows: [] }; }
    throw new Error('Unexpected mutation SQL.');
  } } };
  const messages = [], notificationAttempts = [], errors = [];
  const service = new LiveTvTimersService({
    store: { serializeWrites: operation => {
      serializedWrites += 1;
      if (failRecovery && serializedWrites === 2) throw new Error('Controlled authoritative recovery failure.');
      return operation(database);
    } }, serverId: 'mutation-test', dataPath: 'C:\\state', stateFileSystem: fileSystem,
    loadProgramDtos: async () => new Map(), users: { getLiveTvUserIds: async () => ['allowed-user'] },
    sessions: { async sendMessageToUserSessions(userIds, type, data) {
      notificationAttempts.push({ userIds, type, data });
      if (sendFailure) throw Object.assign(new Error('Controlled notification failure.'), { code: 'controlled-notification-failure' });
      messages.push({ userIds, type, data });
    } },
    onError: error => errors.push(error),
  });
  return { service, files, messages, notificationAttempts, errors, get state() { return JSON.parse(state); }, timerFile: path.join('C:\\state', 'livetv', 'timers.json'),
    seriesFile: path.join('C:\\state', 'livetv', 'seriestimers.json') };
}

test('timer cancellation serializes linked state, removes unlinked state and publishes only non-repeated events', async () => {
  const source = '[{"Id":"linked","SeriesTimerId":"series","Status":"New","Opaque":9007199254740993123456789},'
    + '{"Id":"loose","SeriesTimerId":"  ","Status":"New","Unknown":{"x":"kept"}},'
    + '{"Id":"prelinked","SeriesTimerId":"series","Status":"Cancelled","IsManual":false},'
    + '{"Id":"already","SeriesTimerId":"","Status":"Cancelled","Unknown":"removed"},'
    + '{"Id":"completed","SeriesTimerId":"series","Status":"Completed"}]';
  const current = fixture({ timers: source, seriesTimers: '[]' });
  const linked = current.state.timers.rows[0].internalId, loose = current.state.timers.rows[1].internalId,
    prelinked = current.state.timers.rows[2].internalId, already = current.state.timers.rows[3].internalId,
    completed = current.state.timers.rows[4].internalId;
  assert.equal(await current.service.cancelTimer(linked.toUpperCase()), true);
  assert.equal(await current.service.cancelTimer(linked), true, 'an already-cancelled linked timer remains a successful idempotent mutation');
  assert.equal(await current.service.cancelTimer(prelinked), true, 'a pre-cancelled linked timer still becomes manual without an event');
  assert.equal(await current.service.cancelTimer(already), true, 'a pre-cancelled unlinked timer is still deleted without an event');
  assert.equal(await current.service.cancelTimer(loose), true);
  assert.equal(await current.service.cancelTimer(completed), false, 'a completed timer is outside the cancellation resource');
  assert.equal(await current.service.cancelTimer('not-a-guid'), false);
  await current.service.close();
  const bytes = current.files.get(current.timerFile), text = bytes.toString();
  assert.match(text, /"Opaque":9007199254740993123456789/u, 'opaque integers retain their exact source token');
  assert.deepEqual(JSON.parse(text).map(value => ({ Id: value.Id, Status: value.Status, IsManual: value.IsManual })),
    [{ Id: 'linked', Status: 'Cancelled', IsManual: true }, { Id: 'prelinked', Status: 'Cancelled', IsManual: true },
      { Id: 'completed', Status: 'Completed', IsManual: undefined }]);
  assert.equal(current.state.timers.sourceHex, bytes.toString('hex'));
  assert.equal(current.state.timers.sourceSha256, hash(bytes));
  assert.equal(current.state.timers.rows.length, 3);
  assert.deepEqual(current.messages, [
    { userIds: ['allowed-user'], type: 'TimerCancelled', data: { Id: 'linked' } },
    { userIds: ['allowed-user'], type: 'TimerCancelled', data: { Id: 'loose' } },
  ]);
  assert.deepEqual(current.errors, []);
  await assert.rejects(current.service.cancelTimer(linked), { status: 503 });
});

test('series cancellation removes every OIC child including completed and cancelled rows before its final event', async () => {
  const current = fixture({
    timers: '[{"Id":"new","SeriesTimerId":"SERIES-a","Status":"New"},{"Id":"done","SeriesTimerId":"series-A","Status":"Completed"},'
      + '{"Id":"cancelled","SeriesTimerId":"series-a","Status":"Cancelled"},{"Id":"error","SeriesTimerId":"series-A","Status":"Error"},'
      + '{"Id":"other","SeriesTimerId":"other","Status":"New"}]',
    seriesTimers: '[{"Id":"series-A","Name":"Target","Unknown":"opaque"},{"Id":"other","Name":"Other"}]',
  });
  const requested = current.state.seriesTimers.rows[0].internalId.toUpperCase();
  assert.equal(await current.service.cancelSeriesTimer(requested), true);
  await current.service.close();
  assert.deepEqual(JSON.parse(current.files.get(current.timerFile)), [{ Id: 'other', SeriesTimerId: 'other', Status: 'New' }]);
  assert.deepEqual(JSON.parse(current.files.get(current.seriesFile)), [{ Id: 'other', Name: 'Other' }]);
  assert.deepEqual(current.messages, [
    { userIds: ['allowed-user'], type: 'TimerCancelled', data: { Id: 'new' } },
    { userIds: ['allowed-user'], type: 'TimerCancelled', data: { Id: 'done' } },
    { userIds: ['allowed-user'], type: 'TimerCancelled', data: { Id: 'error' } },
    { userIds: ['allowed-user'], type: 'SeriesTimerCancelled', data: { Id: requested } },
  ]);
  for (const [kind, filename] of [['timers', current.timerFile], ['seriesTimers', current.seriesFile]]) {
    const bytes = current.files.get(filename);
    assert.equal(current.state[kind].sourceHex, bytes.toString('hex'));
    assert.equal(current.state[kind].sourceSha256, hash(bytes));
  }
});

test('a failed two-file publication rolls PostgreSQL and the already-published file back without notifications', async () => {
  let publications = 0;
  const current = fixture({ timers: '[{"Id":"child","SeriesTimerId":"series","Status":"New"}]',
    seriesTimers: '[{"Id":"series"}]', failRename: source => source.includes('.tmp') && ++publications === 2 });
  const stateBefore = JSON.stringify(current.state), timerBefore = Buffer.from(current.files.get(current.timerFile)),
    seriesBefore = Buffer.from(current.files.get(current.seriesFile));
  await assert.rejects(current.service.cancelSeriesTimer(current.state.seriesTimers.rows[0].internalId), /Controlled publication failure/u);
  await current.service.close();
  assert.equal(JSON.stringify(current.state), stateBefore);
  assert.deepEqual(current.files.get(current.timerFile), timerBefore);
  assert.deepEqual(current.files.get(current.seriesFile), seriesBefore);
  assert.deepEqual(current.messages, []);
});

test('an unknown commit outcome reconciles from PostgreSQL and reports success only for the committed plan', async () => {
  const current = fixture({ timers: '[{"Id":"timer","SeriesTimerId":"series","Status":"New"}]',
    seriesTimers: '[]', commitUnknown: true });
  const requested = current.state.timers.rows[0].internalId;
  assert.equal(await current.service.cancelTimer(requested), true);
  await current.service.close();
  assert.deepEqual(JSON.parse(current.files.get(current.timerFile)),
    [{ Id: 'timer', SeriesTimerId: 'series', Status: 'Cancelled', IsManual: true }]);
  assert.equal(current.state.timers.sourceHex, current.files.get(current.timerFile).toString('hex'));
  assert.deepEqual(current.messages, [
    { userIds: ['allowed-user'], type: 'TimerCancelled', data: { Id: 'timer' } },
  ]);
});

test('a failed authoritative reconciliation poisons queued mutations and close with the same fatal error', async () => {
  let publications = 0;
  const current = fixture({
    timers: '[{"Id":"first","SeriesTimerId":"series","Status":"New"},{"Id":"second","SeriesTimerId":"series","Status":"New"}]',
    seriesTimers: '[]', failRename: source => source.includes('.tmp') && ++publications === 1, failRecovery: true,
  });
  const first = current.service.cancelTimer(current.state.timers.rows[0].internalId);
  const queued = current.service.cancelTimer(current.state.timers.rows[1].internalId);
  const firstError = await first.catch(error => error), queuedError = await queued.catch(error => error);
  assert.match(firstError.message, /could not restore its PostgreSQL-owned files/u);
  assert.deepEqual({ status: queuedError.status, message: queuedError.message },
    { status: firstError.status, message: firstError.message });
  const laterError = await current.service.cancelTimer(current.state.timers.rows[1].internalId).catch(error => error);
  assert.deepEqual({ status: laterError.status, message: laterError.message },
    { status: firstError.status, message: firstError.message });
  const closeError = await current.service.close().catch(error => error);
  assert.deepEqual({ status: closeError.status, message: closeError.message },
    { status: firstError.status, message: firstError.message });
  assert.deepEqual(current.messages, []);
});

test('a corrupt PostgreSQL source digest fails before any native file or event side effect', async () => {
  const current = fixture({ timers: '[{"Id":"timer","Status":"New"}]', seriesTimers: '[]', corruptHash: 'timers' });
  const stateBefore = JSON.stringify(current.state), timerBefore = Buffer.from(current.files.get(current.timerFile)),
    seriesBefore = Buffer.from(current.files.get(current.seriesFile));
  const fatal = await current.service.cancelTimer(current.state.timers.rows[0].internalId).catch(error => error);
  assert.match(fatal.message, /could not restore its PostgreSQL-owned files/u);
  const closeError = await current.service.close().catch(error => error);
  assert.deepEqual({ status: closeError.status, message: closeError.message },
    { status: fatal.status, message: fatal.message });
  assert.equal(JSON.stringify(current.state), stateBefore);
  assert.deepEqual(current.files.get(current.timerFile), timerBefore);
  assert.deepEqual(current.files.get(current.seriesFile), seriesBefore);
  assert.equal(current.files.size, 2, 'the digest fault cannot leave a staged file behind');
  assert.deepEqual(current.messages, []);
});

test('notification failure is diagnostic and cannot roll a successful cancellation back', async () => {
  const current = fixture({ timers: '[{"Id":"timer","Status":"New"}]', seriesTimers: '[]', sendFailure: true });
  assert.equal(await current.service.cancelTimer(current.state.timers.rows[0].internalId), true);
  await current.service.close();
  assert.deepEqual(JSON.parse(current.files.get(current.timerFile)), []);
  assert.equal(current.state.timers.rows.length, 0);
  assert.deepEqual(current.messages, []);
  assert.deepEqual(current.notificationAttempts, [{ userIds: ['allowed-user'], type: 'TimerCancelled', data: { Id: 'timer' } }]);
  for (const error of current.errors) assert.deepEqual({ code: error.code, message: error.message },
    { code: 'controlled-notification-failure', message: 'Controlled notification failure.' });
});

test('close freezes mutation admission and drains the already-admitted serialized publication', async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let blocked = false;
  const current = fixture({
    timers: '[{"Id":"first","SeriesTimerId":"series","Status":"New"},{"Id":"second","SeriesTimerId":"series","Status":"New"}]',
    seriesTimers: '[]',
    beforeRename: async (source, target) => {
      if (!blocked && source.includes('.tmp') && target.endsWith('timers.json')) {
        blocked = true; entered.resolve(); await release.promise;
      }
    },
  });
  const first = current.service.cancelTimer(current.state.timers.rows[0].internalId);
  await entered.promise;
  const closing = current.service.close();
  await assert.rejects(current.service.cancelTimer(current.state.timers.rows[1].internalId), { status: 503 });
  release.resolve();
  assert.equal(await first, true);
  await closing;
  assert.deepEqual(JSON.parse(current.files.get(current.timerFile)).map(value => [value.Id, value.Status]),
    [['first', 'Cancelled'], ['second', 'New']]);
});
