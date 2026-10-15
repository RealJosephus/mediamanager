import { parentPort, workerData } from 'node:worker_threads';
import { openSync } from 'node:fs';
import { prepareRar4Entry } from '../../../../src/storage/rar-entry.js';

const fd = openSync(workerData.filename, 'r');
parentPort.on('message', ({ ordinal }) => {
  const derived = prepareRar4Entry(fd, workerData.size, ordinal, workerData.filename + '.entry');
  if (!derived) throw new Error('Expected an actual encrypted selected-entry spool.');
  parentPort.postMessage({ notice: 'derived-ready' });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
});
parentPort.postMessage({ id: 0, result: {
  entries: [{ key: 'exe\\test.exe', size: 45056 }, { key: 'jpg\\test.jpg', size: 40372 }], comment: []
} });
