import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseTapSummary, progressForwarder, validationPhase } from '../../tools/validation/run.js';
import { progressLineLimit, progressPrefix, testProgress } from '../../tools/validation/tap-registration-reporter.js';

test('CI progress observes immediate top-level execution without forwarding names or diagnostic bodies', () => {
  const root = path.resolve('progress-root'), filename = 'tests/example.test.js';
  const selected = new Set([filename]);
  const data = { file: path.join(root, filename), name: 'private test title', line: 12, column: 3, nesting: 0 };
  assert.deepEqual(testProgress({ type: 'test:dequeue', data }, root, selected),
    { event: 'start', kind: 'test', file: filename, line: 12, column: 3 });
  assert.deepEqual(testProgress({ type: 'test:complete', data: { ...data,
    details: { passed: false, duration_ms: 10.2, error: new Error('private failure') } } }, root, selected),
  { event: 'failed', kind: 'test', file: filename, line: 12, column: 3, durationMs: 10 });
  for (const type of ['test:start', 'test:pass', 'test:fail', 'test:stdout', 'test:stderr', 'test:diagnostic']) {
    assert.equal(testProgress({ type, data: { ...data, message: 'private body' } }, root, selected), null);
  }
  assert.equal(testProgress({ type: 'test:dequeue', data: { ...data, nesting: 1 } }, root, selected), null);
  assert.equal(testProgress({ type: 'test:dequeue', data: { ...data, file: path.join(root, 'other.test.js') } }, root, selected), null);
  assert.equal(testProgress({ type: 'test:dequeue', data: { ...data, name: data.file, line: 1, column: 1 } }, root, selected).kind, 'file');
});

test('CI stderr forwarding recovers from oversized lines and UTF-8 chunk boundaries without leaking raw stderr', () => {
  const filename = 'tests/进度.test.js', received = [];
  const record = { event: 'start', kind: 'test', file: filename, line: 2, column: 1 };
  const line = progressPrefix + JSON.stringify(record) + '\n';
  const forward = progressForwarder({ environment: { GITHUB_ACTIONS: 'true' }, selected: [filename], write: value => received.push(value) });
  forward(Buffer.from('private stderr\n' + progressPrefix + '{invalid json}\n'));
  forward(Buffer.from('x'.repeat(progressLineLimit)));
  for (let index = 0; index < 100; index++) forward(Buffer.from('x'.repeat(progressLineLimit)));
  forward(Buffer.from(line)); // The prefix is still part of the oversized line.
  for (const byte of Buffer.from(line)) forward(Buffer.from([byte]));
  forward(Buffer.from(progressPrefix + JSON.stringify({ ...record, file: 'tests/other.test.js' }) + '\n'));
  forward(Buffer.from(progressPrefix + JSON.stringify({ ...record, message: 'private body' }) + '\n'));
  assert.deepEqual(received, [line, line]);
  const quiet = progressForwarder({ environment: {}, selected: [filename], write: value => received.push(value) });
  quiet(Buffer.from(line));
  assert.deepEqual(received, [line, line]);
});

test('CI phase diagnostics retain operation values and errors and remain silent outside Actions', async () => {
  const received = [], environment = { GITHUB_ACTIONS: 'true' }, write = value => received.push(value);
  const result = {};
  assert.equal(await validationPhase('prepare inputs', async () => result, { environment, write }), result);
  const error = new Error('private operation failure');
  await assert.rejects(validationPhase('audit inputs', async () => { throw error; }, { environment, write }), value => value === error);
  assert.equal(received.length, 4);
  assert.match(received[0], /prepare inputs: started/u);
  assert.match(received[1], /prepare inputs: completed/u);
  assert.match(received[2], /audit inputs: started/u);
  assert.match(received[3], /audit inputs: failed/u);
  assert.equal(received.join('').includes(error.message), false);
  assert.equal(await validationPhase('quiet', async () => result, { environment: {}, write }), result);
  assert.equal(received.length, 4);
});

test('real reporter progress preserves failing TAP and registration with the Actions switch on or off', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-progress-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const filename = path.join(temporary, 'sample.test.mjs');
  await writeFile(filename, `import test from 'node:test';
test('PRIVATE_TITLE', async t => {
  console.error('PRIVATE_DIAGNOSTIC');
  await t.test('PRIVATE_NESTED_TITLE', () => {});
});
test('PRIVATE_FAILURE_TITLE', () => { throw new Error('PRIVATE_FAILURE_BODY'); });
`);
  const reporter = new URL('../../tools/validation/tap-registration-reporter.js', import.meta.url).href;
  const results = [];
  for (const enabled of ['false', 'true']) {
    const output = path.join(temporary, `registration-${enabled}.json`);
    const environment = { ...process.env, GITHUB_ACTIONS: enabled,
      MEDIAMANAGER_TEST_REGISTRATION_OUTPUT: output, MEDIAMANAGER_TEST_REGISTRATION_ROOT: temporary,
      MEDIAMANAGER_TEST_REGISTRATION_SELECTED: JSON.stringify(['sample.test.mjs']) };
    delete environment.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', `--test-reporter=${reporter}`, filename],
      { cwd: fileURLToPath(new URL('../../', import.meta.url)), env: environment, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    const counts = parseTapSummary(result.stdout);
    assert.deepEqual(counts, { tests: 3, suites: 0, pass: 2, fail: 1, cancelled: 0, skipped: 0, todo: 0 });
    assert.ok(result.stdout.includes('PRIVATE_DIAGNOSTIC'));
    assert.ok(result.stdout.includes('PRIVATE_FAILURE_BODY'));
    assert.equal(result.stdout.includes(progressPrefix), false);
    assert.equal(result.stderr.includes('PRIVATE_'), false);
    const registration = JSON.parse(await readFile(output, 'utf8'));
    assert.deepEqual(registration, { schemaVersion: 1, files: [{ path: 'sample.test.mjs', registrations: 3 }], missing: [] });
    const progress = result.stderr.split('\n').filter(line => line.startsWith(progressPrefix)).map(line => JSON.parse(line.slice(progressPrefix.length)));
    if (enabled === 'true') {
      assert.equal(progress.filter(entry => entry.kind === 'test' && entry.event === 'start').length, 2);
      assert.equal(progress.filter(entry => entry.kind === 'test' && entry.event === 'passed').length, 1);
      assert.equal(progress.filter(entry => entry.kind === 'test' && entry.event === 'failed').length, 1);
    } else assert.deepEqual(progress, []);
    results.push({ counts, registration });
  }
  assert.deepEqual(results[0], results[1]);
});
