import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { SplashscreenPostScanTask } from '../../src/library/splashscreen-post-scan-task.js';
import { LibraryScanLifecycle } from '../../src/library/library-scan-lifecycle.js';

const fixture = new URL('./fixtures/splashscreen-task/', import.meta.url);
const [bytes, inputBytes, proofBytes] = await Promise.all(['native.json', 'input.json', 'provenance.json']
  .map(filename => readFile(new URL(filename, fixture))));
const native = JSON.parse(bytes), input = JSON.parse(inputBytes), proof = JSON.parse(proofBytes);
const hash = value => createHash('sha256').update(value).digest('hex');

test('splashscreen task fixtures bind 14 actual task observations and independent inputs', async () => {
  assert.equal(hash(bytes), proof.nativeSha256); assert.equal(hash(inputBytes), proof.inputSha256);
  assert.equal(native.inputSha256, proof.inputSha256); assert.equal(native.actualPostScanTask, true);
  assert.equal(native.repositoryControlled, true); assert.equal(native.imageEncoderControlled, true);
  assert.equal(native.mediaOpened, false); assert.equal(native.portOpened, false);
  assert.equal(native.results.length, 14); assert.deepEqual(native.results.map(row => row.sample.Name), input.map(row => row.Name));
  assert.equal(proof.build.status, 0); assert.equal(proof.process.status, 0);
  for (const source of proof.oracleSources) assert.equal(hash(await readFile(source.name === 'Directory.Build.props'
    ? new URL('../Directory.Build.props', import.meta.url) : new URL(source.name, fixture))), source.sha256);
});

test('splashscreen encoder failures retain the scan lifecycle continuation and inherited-value update', async t => {
  const failure = Object.assign(new Error('Controlled encoder failure'), { code: 'controlled-splashscreen-encoder' }),
    calls = [], logs = [];
  const task = new SplashscreenPostScanTask({ library: { async getSplashscreenImagePaths() { return ['image.png']; } },
    imageGenerator: { async createSplashscreen() { calls.push('encoder'); throw failure; } } });
  const required = ['getAggregateFolder', 'getUserRootFolder', 'clearIgnoreRuleCache', 'invalidateChildren',
    'refreshMetadata', 'validateChildren', 'withChildren', 'collectionDirectoryExists'];
  const host = Object.fromEntries(required.map(name => [name, async () => {}]));
  host.updateInheritedValues = async () => calls.push('inherited');
  const lifecycle = new LibraryScanLifecycle({ host, monitor: { start() {}, stop() {} },
    postScanTasks: [task, { name: 'following', async run() { calls.push('following'); } }],
    logger: { error: (error, message) => logs.push({ error, message }) } });
  await lifecycle.runPostScanTasks();
  assert.deepEqual(calls, ['encoder', 'following', 'inherited']);
  for (const { error } of logs) assert.deepEqual({ code: error.code, message: error.message },
    { code: failure.code, message: failure.message });
  t.diagnostic(JSON.stringify({ calls, logs: logs.map(({ error, message }) => ({ message,
    error: { name: error.name, code: error.code, message: error.message, stack: error.stack } })) }));
});

for (const row of native.results) test(`splashscreen task: ${row.sample.Name}`, async t => {
  const sample = input.find(value => value.Name === row.sample.Name), calls = [], logs = [], progress = [];
  const signal = AbortSignal.abort(new Error('Controlled cancellation'));
  const library = { async getSplashscreenImagePaths(imageType) {
    calls.push({ action: 'query', imageType });
    if (sample.FailQuery === imageType) throw new Error(`Controlled ${imageType} query failure`);
    const items = sample[imageType === 'Primary' ? 'Posters' : imageType === 'Thumb' ? 'Thumbs' : 'Backdrops'] ?? [];
    return items.map(images => images[0]).filter(value => value != null && value !== '');
  } };
  const task = new SplashscreenPostScanTask({ library, imageGenerator: {
    async createSplashscreen(posters, backdrops) {
      calls.push({ action: 'splashscreen', posters, backdrops });
      if (sample.FailEncoder) throw new Error('Controlled splashscreen failure');
    },
  }, logger: Object.fromEntries(['debug', 'warn', 'error'].map(level => [level,
    message => logs.push({ level, message: message?.message ?? message })])) });
  let failure = null;
  try { await task.run({ signal: sample.CancelInitial ? signal : new AbortController().signal,
    reportProgress: value => { progress.push(value); if (sample.FailProgress) throw new Error('Controlled progress failure'); } }); }
  catch (error) { failure = error; }
  t.diagnostic(JSON.stringify({ name: sample.Name, calls, logs, nativeLogs: row.logs, progress,
    failure: failure && { name: failure.name, code: failure.code, message: failure.message, stack: failure.stack } }));
  assert.deepEqual(calls, row.calls.map(call => call.action === 'query' ? { action: call.action, imageType: call.imageType } : call));
  assert.deepEqual(progress, row.progress);
  assert.equal(Boolean(failure), Boolean(row.failure));
  assert.equal(failure?.message ?? null, row.failure?.Message ?? null);
  for (const log of logs.filter(value => value.level !== 'debug')) {
    assert.ok(failure, 'Successful maintenance must not report an unexpected error.');
    assert.equal(log.message, failure.message);
  }
});
