import assert from 'node:assert/strict';
import { refreshLibraryTaskId } from '../../src/tasks/refresh-library-task.js';
import { errorObservation } from './error-observation.js';

export async function prepareCollectionFixture(runtime, report) {
  const tasks = runtime.tasks;
  const queueScheduled = tasks.queueScheduled;
  const scheduled = [];
  const scanAdmitted = Promise.withResolvers();
  tasks.queueScheduled = function (id, ...args) {
    const record = { id, status: 'admitted' };
    report.scheduledScans.push(record);
    let completion;
    try { completion = queueScheduled.call(this, id, ...args); }
    catch (error) { record.status = 'failed'; record.error = errorObservation(error); throw error; }
    const observed = completion.then(result => {
      record.status = 'completed'; record.result = result; return result;
    }, error => {
      record.status = 'failed'; record.error = errorObservation(error); throw error;
    });
    scheduled.push(observed);
    // Setup may fail before joining the observer; the task manager still owns the scan.
    void observed.catch(() => {});
    if (id === refreshLibraryTaskId) scanAdmitted.resolve();
    return completion;
  };

  let timer;
  try {
    // The first virtual folder schedules a full scan outside Collection's queue.
    // Complete it before creating any members that could race its refreshes.
    assert.ok(await runtime.collections.getCollectionsFolder(true));
    await Promise.race([scanAdmitted.promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('The initial Collections library scan was not admitted.')), 15000);
    })]);
    for (const completion of scheduled) {
      assert.equal((await completion).Status, 'Completed', 'The real fixture setup scan must finish before member mutations.');
    }
    report.setup.push('initial-scans-completed');
    await runtime.collections.monitor.close(); report.setup.push('monitor-closed');
    await tasks.close(); report.setup.push('scheduled-tasks-closed');
  } finally {
    clearTimeout(timer);
    tasks.queueScheduled = queueScheduled;
  }

  const drain = async stage => {
    const record = { stage, status: 'running' }; report.drains.push(record);
    await runtime.collections.drainForItem(); record.collection = 'completed';
    await runtime.metadata.drain(); record.metadata = 'completed';
    await runtime.metadata.saver.drain(); record.saver = 'completed';
    record.queuedRefreshes = [...runtime.metadata.getRefreshQueue()];
    assert.deepEqual(record.queuedRefreshes, []);
    record.status = 'completed';
  };
  await drain('setup-producers-closed');
  return drain;
}
