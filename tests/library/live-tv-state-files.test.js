import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stageLiveTvStateFile } from '../../src/database/live-tv-state-files.js';
import { reconcileLiveTvStateFiles } from '../../src/database/live-tv-state-import.js';

async function fixture(t) {
  const dataPath = await fs.mkdtemp(path.join(tmpdir(), 'mm-live-tv-state-files-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(dataPath)), path.resolve(tmpdir()));
    assert.ok(path.basename(dataPath).startsWith('mm-live-tv-state-files-'));
    await fs.rm(dataPath, { recursive: true });
  });
  const directory = path.join(dataPath, 'livetv');
  await fs.mkdir(directory);
  return { dataPath, directory };
}

const source = bytes => ({ sourceHex: bytes.toString('hex'), sourceSha256: createHash('sha256').update(bytes).digest('hex') });

test('exclusive timer staging preserves a file it did not create', async t => {
  const { directory } = await fixture(t), foreignBytes = Buffer.from('foreign timer staging owner');
  let collision;
  const fileSystem = { ...fs, async open(filename, flags) {
    collision = filename;
    await fs.writeFile(filename, foreignBytes, { flag: 'wx' });
    return fs.open(filename, flags);
  } };
  await assert.rejects(stageLiveTvStateFile(directory, 'timers.json', Buffer.from('[]'), fileSystem), { code: 'EEXIST' });
  assert.deepEqual(await fs.readFile(collision), foreignBytes);
  assert.deepEqual(await fs.readdir(directory), [path.basename(collision)]);
});

test('staging waits for actual close before removing its partial file and returning the close failure', async t => {
  const { directory } = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const closeFailure = { operation: 'timer-staging-close' }, bytes = Buffer.from('new timer state');
  let handle, filename, settled = false;
  const fileSystem = { ...fs, async open(name, flags) {
    filename = name; handle = await fs.open(name, flags);
    return { writeFile: value => handle.writeFile(value), async close() {
      entered.resolve(); await release.promise; await handle.close(); throw closeFailure;
    } };
  } };
  const operation = stageLiveTvStateFile(directory, 'timers.json', bytes, fileSystem);
  const observed = operation.then(() => { settled = true; }, failure => { settled = true; throw failure; });
  void observed.catch(() => {});
  try {
    await entered.promise;
    assert.equal(settled, false); assert.deepEqual(await fs.readFile(filename), bytes);
    assert.equal((await handle.stat()).size, bytes.length);
  } finally { release.resolve(); }
  await assert.rejects(observed, failure => failure === closeFailure);
  await assert.rejects(handle.stat(), { code: 'EBADF' });
  assert.deepEqual(await fs.readdir(directory), []);
});

test('state reconciliation retains a falsy publication cause and ordered cleanup failure, then restores from the same source', async t => {
  const { dataPath, directory } = await fixture(t), oldBytes = Buffer.from('[{"Id":"old"}]');
  const timerBytes = Buffer.from('[{"Id":"restored"}]'), seriesBytes = Buffer.from('[]');
  const target = path.join(directory, 'timers.json');
  await fs.writeFile(target, oldBytes);
  await fs.writeFile(path.join(directory, 'seriestimers.json'), seriesBytes);
  const persisted = { timers: source(timerBytes), seriesTimers: source(seriesBytes) };
  const primary = undefined, cleanup = Object.assign(new Error('Controlled timer state cleanup failure.'), { code: 'EIO' });
  const order = [], handles = [];
  const fileSystem = { ...fs, async open(filename, flags) {
    const handle = await fs.open(filename, flags); handles.push(handle);
    return { writeFile: bytes => handle.writeFile(bytes), async close() { await handle.close(); order.push('close'); } };
  }, async rename() { order.push('rename'); throw primary; },
  async rm(filename, options) { await fs.rm(filename, options); order.push('remove'); throw cleanup; } };
  await assert.rejects(reconcileLiveTvStateFiles(persisted, { dataPath, fileSystem }), failure => {
    assert.ok(failure instanceof AggregateError); assert.ok(Object.hasOwn(failure, 'cause'));
    assert.equal(failure.cause, primary); assert.deepEqual(failure.errors, [primary, cleanup]); return true;
  });
  assert.deepEqual(order, ['close', 'rename', 'remove']);
  assert.equal(handles.length, 1); await assert.rejects(handles[0].stat(), { code: 'EBADF' });
  assert.deepEqual(await fs.readFile(target), oldBytes);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['seriestimers.json', 'timers.json']);
  await reconcileLiveTvStateFiles(persisted, { dataPath });
  assert.deepEqual(await fs.readFile(target), timerBytes);
  assert.deepEqual(await fs.readFile(path.join(directory, 'seriestimers.json')), seriesBytes);
});

test('a successfully renamed timer projection does not remove a path whose ownership has ended', async t => {
  const { dataPath, directory } = await fixture(t), timerBytes = Buffer.from('[]'), seriesBytes = Buffer.from('[]');
  const persisted = { timers: source(timerBytes), seriesTimers: source(seriesBytes) };
  let removals = 0;
  await reconcileLiveTvStateFiles(persisted, { dataPath, fileSystem: { ...fs,
    async rm() { removals += 1; throw new Error('A published temporary path has no cleanup owner.'); },
  } });
  assert.equal(removals, 0);
  assert.deepEqual(await fs.readFile(path.join(directory, 'timers.json')), timerBytes);
  assert.deepEqual(await fs.readFile(path.join(directory, 'seriestimers.json')), seriesBytes);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['seriestimers.json', 'timers.json']);
});

test('state reconciliation preserves null and undefined read failures before creating any output', async t => {
  const { dataPath, directory } = await fixture(t), bytes = Buffer.from('[]');
  const target = path.join(directory, 'timers.json');
  await fs.writeFile(target, bytes);
  const persisted = { timers: source(bytes), seriesTimers: source(bytes) };
  for (const reason of [null, undefined]) {
    await assert.rejects(reconcileLiveTvStateFiles(persisted, { dataPath, fileSystem: { ...fs,
      async readFile() { throw reason; },
    } }), failure => Object.is(failure, reason));
    assert.deepEqual(await fs.readFile(target), bytes);
    assert.deepEqual(await fs.readdir(directory), ['timers.json']);
  }
});
