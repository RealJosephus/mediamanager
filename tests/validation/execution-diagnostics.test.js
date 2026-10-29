import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { observeExecutionPhase } from '../../tools/validation/execution-diagnostics.js';

async function workspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mediamanager-execution-diagnostics-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('mediamanager-execution-diagnostics-'));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('execution diagnostics retain actual committed results and concurrent phase identities without recording caller secrets', async t => {
  const root = await workspace(t), directory = path.join(root, 'diagnostics');
  const environment = { MEDIAMANAGER_TEST_DIAGNOSTICS_ROOT: directory };
  const stored = path.join(root, 'committed.txt'), result = { status: 23 };
  const secret = 'not-for-execution-journals';
  const completed = await observeExecutionPhase('controlled.consumer', async () => {
    await writeFile(stored, 'committed before returning the business result');
    await Promise.all(['controlled.first', 'controlled.second'].map(stage =>
      observeExecutionPhase(stage, async () => result, { environment, fixture: 'tests/validation/execution-diagnostics.test.js' })));
    return result;
  }, { environment, fixture: 'tests/validation/execution-diagnostics.test.js',
    argv: [secret], token: secret, password: secret, connectionString: secret,
    resultKind: value => value.status === 23 ? 'succeeded' : 'failed' });
  assert.deepEqual(completed, result);
  completed.status = 24; assert.equal(result.status, 24);
  result.status = 25; assert.equal(completed.status, 25);
  assert.equal(await readFile(stored, 'utf8'), 'committed before returning the business result');
  const text = (await Promise.all((await readdir(directory)).map(name => readFile(path.join(directory, name), 'utf8')))).join('');
  assert.equal(text.includes(secret), false);
  const records = text.trim().split('\n').map(line => JSON.parse(line));
  const outer = records.filter(record => record.stage === 'controlled.consumer');
  assert.ok(outer.some(record => record.event === 'started'));
  assert.ok(outer.some(record => record.event === 'completed' && record.resultKind === 'succeeded'));
  const observations = new Map();
  for (const record of records) {
    assert.equal(record.fixture, 'tests/validation/execution-diagnostics.test.js');
    assert.equal(Number.isFinite(Date.parse(record.at)), true);
    assert.equal(Number.isFinite(Date.parse(record.startedAt)), true);
    assert.ok(Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0);
    const identity = record.pid + ':' + record.observation;
    if (observations.has(identity)) assert.equal(observations.get(identity), record.stage);
    observations.set(identity, record.stage);
  }
  for (const stage of ['controlled.first', 'controlled.second']) {
    const phase = records.filter(record => record.stage === stage);
    const beginning = phase.find(record => record.event === 'started'), end = phase.find(record => record.event === 'completed');
    assert.ok(beginning && end); assert.equal(beginning.observation, end.observation);
    assert.ok(end.elapsedMs >= beginning.elapsedMs);
  }
});

test('unwritable or absent diagnostics preserve committed effects, result aliases and failure values', async t => {
  const root = await workspace(t), blocked = path.join(root, 'ordinary-file');
  await writeFile(blocked, 'not a directory');
  const cause = Object.assign(new Error('controlled original cause'), { code: 'controlled-cause' });
  const failure = Object.assign(new Error('controlled business failure', { cause }),
    { code: 'controlled-business', status: 409, errors: [cause, 0] });
  const outcomes = [];
  for (const environment of [{}, { MEDIAMANAGER_TEST_DIAGNOSTICS_ROOT: blocked }]) {
    const result = { original: true };
    const completed = await observeExecutionPhase('controlled.success', async () => {
      outcomes.push('committed success'); return result;
    }, { environment });
    completed.original = false; assert.equal(result.original, false);
    result.original = true; assert.equal(completed.original, true);
    await assert.rejects(observeExecutionPhase('controlled.failure', async () => {
      outcomes.push('committed failure prefix'); throw failure;
    }, { environment }), error => {
      assert.equal(error.message, failure.message); assert.equal(error.code, failure.code); assert.equal(error.status, failure.status);
      assert.equal(error.cause?.message, cause.message); assert.equal(error.cause?.code, cause.code);
      assert.equal(error.errors?.[0]?.message, cause.message); assert.equal(error.errors?.[0]?.code, cause.code);
      assert.equal(error.errors?.[1], 0);
      return true;
    });
  }
  assert.deepEqual(outcomes, ['committed success', 'committed failure prefix', 'committed success', 'committed failure prefix']);
  assert.equal(await readFile(blocked, 'utf8'), 'not a directory');
});
