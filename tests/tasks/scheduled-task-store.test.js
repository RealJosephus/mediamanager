import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { parseLosslessJson } from '../../src/core/json.js';
import { ScheduledTaskFileStore, scheduledTaskFilename } from '../../src/tasks/scheduled-task-store.js';
import { refreshLibraryTaskId } from '../../src/tasks/index.js';

test('scheduled task files use native instance paths and atomic lossless JSON', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mediamanager-scheduled-task-'));
  const programDataPath = path.join(root, 'data');
  const store = new ScheduledTaskFileStore({ taskId: refreshLibraryTaskId, programDataPath });
  try {
    assert.equal(scheduledTaskFilename(refreshLibraryTaskId), '7738148f-fcd0-7979-c7ce-b148e06b3aed.js');
    assert.equal(store.configurationPath,
      path.join(root, 'config', 'ScheduledTasks', '7738148f-fcd0-7979-c7ce-b148e06b3aed.js'));
    assert.equal(store.historyPath,
      path.join(root, 'data', 'data', 'ScheduledTasks', '7738148f-fcd0-7979-c7ce-b148e06b3aed.js'));

    const triggers = [{ Type: 'IntervalTrigger', IntervalTicks: 432000000000n, MaxRuntimeTicks: 9007199254740993n }];
    await store.saveTriggers(triggers);
    const persistedTriggers = [{ Type: 'IntervalTrigger', IntervalTicks: 432000000000n, MaxRuntimeTicks: 9007199254740993n }];
    assert.deepEqual(await store.loadTriggers(), persistedTriggers);
    assert.deepEqual(parseLosslessJson(await readFile(store.configurationPath, 'utf8')),
      [{ Type: 'IntervalTrigger', IntervalTicks: 432000000000, MaxRuntimeTicks: 9007199254740993n }]);

    const result = {
      StartTimeUtc: '2026-10-04T00:00:00Z', EndTimeUtc: '2026-10-04T00:00:01Z', Status: 'Completed',
      Name: 'Scan Media Library', Key: 'RefreshLibrary', Id: refreshLibraryTaskId
    };
    await store.saveHistory(result);
    assert.deepEqual(await store.loadHistory(), result);
    assert.deepEqual(await readdir(path.dirname(store.configurationPath)), [path.basename(store.configurationPath)]);
    assert.deepEqual(await readdir(path.dirname(store.historyPath)), [path.basename(store.historyPath)]);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('scheduled task writes are serialized and the latest complete document wins', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mediamanager-scheduled-task-order-'));
  const store = new ScheduledTaskFileStore({ taskId: refreshLibraryTaskId, programDataPath: path.join(root, 'data') });
  try {
    const first = store.saveTriggers([{ Type: 'StartupTrigger' }]);
    const second = store.saveTriggers([{ Type: 'IntervalTrigger', IntervalTicks: 10n }]);
    await Promise.all([first, second]);
    assert.deepEqual(await store.loadTriggers(), [{ Type: 'IntervalTrigger', IntervalTicks: 10n }]);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('persisted trigger binding retains native integer token and enum string semantics', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mediamanager-scheduled-task-binding-'));
  const store = new ScheduledTaskFileStore({ taskId: refreshLibraryTaskId, programDataPath: path.join(root, 'data') });
  try {
    await mkdir(path.dirname(store.configurationPath), { recursive: true });
    for (const source of [
      '[{"Type":"IntervalTrigger","IntervalTicks":1.0}]',
      '[{"Type":"IntervalTrigger","IntervalTicks":1e0}]',
      '[{"Type":2.0,"IntervalTicks":1}]',
      '[{"Type":"WeeklyTrigger","TimeOfDayTicks":1,"DayOfWeek":1.0}]'
    ]) {
      await writeFile(store.configurationPath, source);
      await assert.rejects(store.loadTriggers(), /could not be converted/u);
    }
    await writeFile(store.configurationPath,
      '[{"Type":"+2","IntervalTicks":"+1"},{"Type":" 1 ","TimeOfDayTicks":"+2","DayOfWeek":" Tuesday "}]');
    assert.deepEqual(await store.loadTriggers(), [
      { Type: 'IntervalTrigger', IntervalTicks: 1n },
      { Type: 'WeeklyTrigger', TimeOfDayTicks: 2n, DayOfWeek: 'Tuesday' }
    ]);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('missing configuration uses defaults while an empty trigger file fails closed and empty history is absent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mediamanager-scheduled-task-empty-'));
  const store = new ScheduledTaskFileStore({ taskId: refreshLibraryTaskId, programDataPath: path.join(root, 'data') });
  try {
    assert.equal(await store.loadTriggers(), null);
    assert.equal(await store.loadHistory(), null);
    await mkdir(path.dirname(store.configurationPath), { recursive: true });
    await mkdir(path.dirname(store.historyPath), { recursive: true });
    await writeFile(store.configurationPath, '');
    await writeFile(store.historyPath, '');
    await assert.rejects(store.loadTriggers(), /Scheduled task file is empty/u);
    assert.equal(await store.loadHistory(), null);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('oversized native task documents are rejected before parsing or replacement', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mediamanager-scheduled-task-limit-'));
  const store = new ScheduledTaskFileStore({ taskId: refreshLibraryTaskId, programDataPath: path.join(root, 'data') });
  try {
    await mkdir(path.dirname(store.configurationPath), { recursive: true });
    await writeFile(store.configurationPath, Buffer.alloc(1024 * 1024 + 1, 0x20));
    await assert.rejects(store.loadTriggers(), /exceeds 1048576 bytes/u);
    await assert.rejects(store.saveTriggers([{ Type: 'StartupTrigger', Padding: 'x'.repeat(1024 * 1024) }]),
      /exceeds 1048576 bytes/u);
    assert.equal((await readdir(path.dirname(store.configurationPath))).some(name => name.endsWith('.tmp')), false);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('scheduled task persistence rejects a linked configuration directory before writing outside the instance', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mediamanager-scheduled-task-contained-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'mediamanager-scheduled-task-outside-'));
  const programDataPath = path.join(root, 'data');
  await mkdir(path.join(root, 'config'), { recursive: true });
  await mkdir(path.join(programDataPath, 'data'), { recursive: true });
  await symlink(outside, path.join(root, 'config', 'ScheduledTasks'), process.platform === 'win32' ? 'junction' : 'dir');
  const store = new ScheduledTaskFileStore({ taskId: refreshLibraryTaskId, programDataPath });
  try {
    await assert.rejects(store.saveTriggers([{ Type: 'StartupTrigger' }]),
      error => error.code === 'unsafe-scheduled-task-path');
    await assert.rejects(readFile(path.join(outside, scheduledTaskFilename(refreshLibraryTaskId))),
      error => error.code === 'ENOENT');
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('store close is idempotent, drains accepted writes and rejects every later operation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mediamanager-scheduled-task-close-'));
  const store = new ScheduledTaskFileStore({ taskId: refreshLibraryTaskId, programDataPath: path.join(root, 'data') });
  try {
    const accepted = store.saveTriggers([{ Type: 'StartupTrigger' }]);
    const closing = store.close();
    assert.equal(store.close(), closing);
    await Promise.all([accepted, closing]);
    assert.deepEqual(parseLosslessJson(await readFile(store.configurationPath, 'utf8')), [{ Type: 'StartupTrigger' }]);
    await assert.rejects(store.saveTriggers([]), error => error.code === 'closed');
    await assert.rejects(store.saveHistory({}), error => error.code === 'closed');
    await assert.rejects(store.loadTriggers(), error => error.code === 'closed');
    await assert.rejects(store.loadHistory(), error => error.code === 'closed');
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
