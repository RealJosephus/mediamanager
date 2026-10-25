import test from 'node:test';
import assert from 'node:assert/strict';
import { CollectionPostScanTask } from '../../src/library/collection-post-scan-task.js';

const unusedSource = Object.fromEntries(['getRootFolder', 'getLibraryOptions', 'rootQuery', 'moviePageQuery', 'boxSetQuery']
  .map(name => [name, () => { throw new Error('Selection must not start.'); }]));

test('Collection task rejects new admission before acquiring a database session', async () => {
  let operations = 0;
  const task = new CollectionPostScanTask({ source: unusedSource, store: { run() { operations++; } },
    collections: { admitPostScanOperation() { throw new Error('Collection management is closing.'); } } });
  await assert.rejects(task.run(), /Collection management is closing/u);
  assert.equal(operations, 0);
});

test('Collection task releases admitted dependencies after a database admission failure', async () => {
  let releases = 0;
  const task = new CollectionPostScanTask({ source: unusedSource, store: { run() { throw new Error('Database store is closing.'); } },
    collections: { admitPostScanOperation: () => ({ release() { releases++; } }) } });
  await assert.rejects(task.run(), /Database store is closing/u);
  assert.equal(releases, 1);
});

test('Collection task retains admission through final progress and temporary relation cleanup', async () => {
  const actions = [];
  let releaseCleanup;
  const cleaning = new Promise(resolve => { releaseCleanup = resolve; });
  let cleanupStarted;
  const started = new Promise(resolve => { cleanupStarted = resolve; });
  const db = { schemaName: 'admission', client: { async query(input) {
    const text = typeof input === 'string' ? input : input.text;
    if (text.startsWith('DROP TABLE IF EXISTS')) { actions.push('cleanup'); cleanupStarted(); await cleaning; }
    return { rows: text.includes('SELECT count(*)') ? [{ Count: '0' }] : [] };
  } } };
  const source = { ...unusedSource, getRootFolder: () => ({ Id: 'bc100000-0000-0000-0000-000000000001' }),
    rootQuery: () => ({ text: 'SELECT 1 AS "Ordinal" WHERE false', values: [] }) };
  const task = new CollectionPostScanTask({ source, store: { run: callback => callback(db) },
    collections: { admitPostScanOperation() { actions.push('admit'); return { release() { actions.push('release'); } }; } } });
  const running = task.run({ reportProgress(value) { assert.equal(value, 100); actions.push('progress'); } });
  await started;
  assert.deepEqual(actions, ['admit', 'progress', 'cleanup']);
  releaseCleanup(); await running;
  assert.deepEqual(actions, ['admit', 'progress', 'cleanup', 'release']);
});
