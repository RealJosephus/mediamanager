import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseTapSummary, progressForwarder, validationPhase } from '../../tools/validation/run.js';
import { progressLineLimit, progressPrefix, testProgress } from '../../tools/validation/tap-registration-reporter.js';
import { observeFileFailures } from '../../tools/validation/test-launcher.js';

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

test('only confirmed native selected file failures produce one bounded parent annotation', async () => {
  const nativeFileStates = JSON.parse(await readFile(new URL('./fixtures/progress/native-file-states.json', import.meta.url), 'utf8'));
  const root = path.resolve('progress-root'), filename = 'tests/进度 %,colon:.test.js';
  const environment = { GITHUB_ACTIONS: 'true', MEDIAMANAGER_TEST_REGISTRATION_ROOT: root };
  const source = new EventEmitter(), emitted = [], forwarded = [];
  const stop = observeFileFailures(source, [filename], { environment, write: line => emitted.push(line) });
  const data = Object.freeze({ file: path.join(root, filename), name: path.join(root, filename), nesting: 0, line: 1, column: 1,
    details: Object.freeze({ passed: false, duration_ms: 2.3, error: new Error('PRIVATE_BODY token=PRIVATE_TOKEN DB=PRIVATE_DB') }) });
  const observe = value => source.emit('test:complete', value);
  for (const value of [
    { ...data, nesting: 1 }, { ...data, line: 2 }, { ...data, column: 2 }, { ...data, name: 'PRIVATE_TITLE' },
    { ...data, file: path.join(root, 'unselected.test.js') },
    { ...data, details: {} }, { ...data, details: { passed: true } }, { ...data, details: { passed: 0 } },
  ]) observe(value);
  for (const state of nativeFileStates.states) observe({ ...data, ...state });
  source.emit('test:fail', data);
  source.emit('test:stderr', { ...data, message: '::error::PRIVATE_BODY' });
  assert.deepEqual(emitted, []);
  observe(data); observe(data);
  stop(); observe(data);
  assert.equal(source.listenerCount('test:complete'), 0);
  assert.equal(emitted.length, 2);
  assert.deepEqual(JSON.parse(emitted[0].slice(progressPrefix.length)), {
    event: 'failed', kind: 'file', file: filename, line: 1, column: 1, durationMs: 2, passed: false,
  });
  const forward = progressForwarder({ environment, selected: [filename], write: line => forwarded.push(line) });
  const unconfirmed = { event: 'failed', kind: 'file', file: filename, line: 1, column: 1 };
  forward(Buffer.from(progressPrefix + JSON.stringify(unconfirmed) + '\n'));
  assert.equal(forwarded.filter(line => line.startsWith('::error ')).length, 0);
  for (const line of emitted) for (const byte of Buffer.from(line)) forward(Buffer.from([byte]));
  assert.deepEqual(forwarded.filter(line => line.startsWith('::error ')), [
    '::error file=tests/进度 %25%2Ccolon%3A.test.js::Selected test file failed (selected-file-failed).\n',
  ]);
  assert.equal((emitted.join('') + forwarded.join('')).includes('PRIVATE_'), false);
  assert.equal(data.details.passed, false);
  assert.match(data.details.error.message, /PRIVATE_BODY/u);
});

test('file annotations reject unsafe paths and unconfirmed states without changing progress', () => {
  const unsafe = ['', '../escape.test.js', '/absolute.test.js', 'C:/absolute.test.js', 'C:relative.test.js',
    '\\\\host\\share\\file.test.js', 'tests/back\\slash.test.js', 'tests/../escape.test.js', 'tests/./file.test.js',
    'tests//file.test.js', 'tests/line\n::error::injected.test.js', 'tests/line\r.test.js', 'tests/nul\u0000.test.js', 'tests/del\u007f.test.js',
    'tests/next\u0085.test.js', 'tests/line\u2028.test.js', 'tests/paragraph\u2029.test.js', 'tests/' + 'x'.repeat(1100) + '.test.js'];
  const safe = 'tests/safe.test.js', received = [];
  const forward = progressForwarder({ environment: { GITHUB_ACTIONS: 'true' }, selected: [...unsafe, safe], write: line => received.push(line) });
  const record = { event: 'failed', kind: 'file', file: safe, line: 1, column: 1, passed: false };
  const send = value => forward(Buffer.from(progressPrefix + JSON.stringify(value) + '\n'));
  for (const file of unsafe) send({ ...record, file });
  for (const value of [
    { ...record, file: 'tests/unselected.test.js' }, { ...record, kind: 'test' }, { ...record, event: 'start' },
    { ...record, event: 'passed' }, { ...record, event: 'skipped' }, { ...record, event: 'todo' },
    { ...record, line: 0 }, { ...record, column: 2 }, { ...record, passed: true }, { ...record, passed: null },
  ]) send(value);
  assert.equal(received.filter(line => line.startsWith('::error ')).length, 0);
  send({ ...record, message: 'PRIVATE_BODY', name: 'PRIVATE_TITLE', token: 'PRIVATE_TOKEN' });
  assert.deepEqual(received.filter(line => line.startsWith('::error ')), [
    '::error file=tests/safe.test.js::Selected test file failed (selected-file-failed).\n',
  ]);
  assert.equal(received.join('').includes('PRIVATE_'), false);
  const quiet = [];
  progressForwarder({ environment: {}, selected: [safe], write: line => quiet.push(line) })(Buffer.from(progressPrefix + JSON.stringify(record) + '\n'));
  assert.deepEqual(quiet, []);
});

test('file-failure observer and parent writer failures cannot replace native events or outcomes', () => {
  const root = path.resolve('progress-root'), filename = 'failure.test.js';
  const environment = { GITHUB_ACTIONS: 'true', MEDIAMANAGER_TEST_REGISTRATION_ROOT: root };
  const source = new EventEmitter(), original = [];
  const stop = observeFileFailures(source, [filename], { environment, write: () => { throw new Error('unavailable observer output'); } });
  source.on('test:complete', data => original.push(data));
  const data = { file: path.join(root, filename), name: path.join(root, filename), nesting: 0, line: 1, column: 1,
    details: { passed: false } };
  assert.doesNotThrow(() => source.emit('test:complete', data));
  assert.deepEqual(original, [data]);
  const forward = progressForwarder({ environment, selected: [filename], write: () => { throw new Error('unavailable parent output'); } });
  assert.doesNotThrow(() => forward(Buffer.from(progressPrefix + JSON.stringify({
    event: 'failed', kind: 'file', file: filename, line: 1, column: 1, passed: false,
  }) + '\n')));
  stop();
  const quiet = [];
  const stopQuiet = observeFileFailures(source, [filename], { environment: { ...environment, GITHUB_ACTIONS: 'false' }, write: line => quiet.push(line) });
  source.emit('test:complete', data); stopQuiet();
  assert.deepEqual(quiet, []);
});

test('CI phase diagnostics retain operation values and errors and remain silent outside Actions', async () => {
  const received = [], environment = { GITHUB_ACTIONS: 'true' }, write = value => received.push(value);
  const result = { prepared: ['actual phase result'] };
  assert.deepEqual(await validationPhase('prepare inputs', async () => result, { environment, write }), result);
  const error = new Error('private operation failure');
  await assert.rejects(validationPhase('audit inputs', async () => { throw error; }, { environment, write }), { message: error.message });
  assert.equal(received.length, 4);
  assert.match(received[0], /prepare inputs: started/u);
  assert.match(received[1], /prepare inputs: completed/u);
  assert.match(received[2], /audit inputs: started/u);
  assert.match(received[3], /audit inputs: failed/u);
  assert.equal(received.join('').includes(error.message), false);
  assert.deepEqual(await validationPhase('quiet', async () => result, { environment: {}, write }), result);
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
  const launcher = fileURLToPath(new URL('../../tools/validation/test-launcher.js', import.meta.url));
  const selectionFile = path.join(temporary, 'test-selection.json');
  const selectionBytes = JSON.stringify({ files: [filename], concurrency: 1 });
  const selectionSha256 = createHash('sha256').update(selectionBytes).digest('hex');
  await writeFile(selectionFile, selectionBytes);
  const results = [];
  for (const enabled of ['false', 'true']) {
    const output = path.join(temporary, `registration-${enabled}.json`);
    const environment = { ...process.env, GITHUB_ACTIONS: enabled,
      MEDIAMANAGER_TEST_REGISTRATION_OUTPUT: output, MEDIAMANAGER_TEST_REGISTRATION_ROOT: temporary,
      MEDIAMANAGER_TEST_SELECTION_FILE: selectionFile, MEDIAMANAGER_TEST_SELECTION_SHA256: selectionSha256 };
    delete environment.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [launcher, selectionFile, selectionSha256],
      { cwd: fileURLToPath(new URL('../../', import.meta.url)), env: environment, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    const counts = parseTapSummary(result.stdout);
    assert.deepEqual(counts, { tests: 3, suites: 0, pass: 2, fail: 1, cancelled: 0, skipped: 0, todo: 0 });
    assert.ok(result.stdout.includes('PRIVATE_DIAGNOSTIC'));
    assert.ok(result.stdout.includes('PRIVATE_FAILURE_BODY'));
    assert.equal(result.stdout.includes(progressPrefix), false);
    assert.equal(result.stderr.includes('PRIVATE_'), false);
    assert.equal(result.stderr.includes('::error'), false);
    const registration = JSON.parse(await readFile(output, 'utf8'));
    assert.deepEqual(registration, { schemaVersion: 1, files: [{ path: 'sample.test.mjs', registrations: 3 }], missing: [] });
    const progress = result.stderr.split('\n').filter(line => line.startsWith(progressPrefix)).map(line => JSON.parse(line.slice(progressPrefix.length)));
    const forwarded = [];
    progressForwarder({ environment, selected: ['sample.test.mjs'], write: line => forwarded.push(line) })(Buffer.from(result.stderr));
    if (enabled === 'true') {
      assert.equal(progress.filter(entry => entry.kind === 'test' && entry.event === 'start').length, 2);
      assert.equal(progress.filter(entry => entry.kind === 'test' && entry.event === 'passed').length, 1);
      assert.equal(progress.filter(entry => entry.kind === 'test' && entry.event === 'failed').length, 1);
      assert.equal(progress.filter(entry => entry.kind === 'file' && entry.event === 'failed' && entry.passed === false).length, 1);
      assert.deepEqual(forwarded.filter(line => line.startsWith('::error ')), [
        '::error file=sample.test.mjs::Selected test file failed (selected-file-failed).\n',
      ]);
    } else { assert.deepEqual(progress, []); assert.deepEqual(forwarded, []); }
    results.push({ counts, registration });
  }
  assert.deepEqual(results[0], results[1]);
});

test('an expected failing inner child fixture leaves its successful selected outer file unannotated', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-progress-child-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const launcher = fileURLToPath(new URL('../../tools/validation/test-launcher.js', import.meta.url));
  await writeFile(path.join(temporary, 'inner.test.mjs'), `import test from 'node:test';
test('expected child failure', () => { throw new Error('PRIVATE_EXPECTED_CHILD'); });
`);
  const innerSelection = path.join(temporary, 'inner-selection.json');
  const innerBytes = JSON.stringify({ files: ['inner.test.mjs'], concurrency: 1 });
  const innerSha256 = createHash('sha256').update(innerBytes).digest('hex');
  await writeFile(innerSelection, innerBytes);
  await writeFile(path.join(temporary, 'outer.test.mjs'), `import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import test from 'node:test';
test('expected failing child is handled by the real outer test', () => {
  const environment = { ...process.env,
    MEDIAMANAGER_TEST_REGISTRATION_OUTPUT: ${JSON.stringify(path.join(temporary, 'inner-registrations.json'))},
    MEDIAMANAGER_TEST_SELECTION_FILE: ${JSON.stringify(innerSelection)},
    MEDIAMANAGER_TEST_SELECTION_SHA256: ${JSON.stringify(innerSha256)},
    MEDIAMANAGER_TEST_FILE_DIAGNOSTICS_ROOT: ${JSON.stringify(path.join(temporary, 'inner-diagnostics'))} };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [${JSON.stringify(launcher)}, ${JSON.stringify(innerSelection)}, ${JSON.stringify(innerSha256)}],
    { env: environment, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.ok(result.stdout.includes('PRIVATE_EXPECTED_CHILD'));
  const lines = result.stderr.split('\\n').filter(line => line.startsWith(${JSON.stringify(progressPrefix)}));
  const confirmed = lines.map(line => JSON.parse(line.slice(${progressPrefix.length})))
    .filter(value => value.file === 'inner.test.mjs' && value.kind === 'file' && value.event === 'failed' && value.passed === false);
  assert.equal(confirmed.length, 1);
  assert.equal(result.stderr.includes('::error'), false);
  writeFileSync(${JSON.stringify(path.join(temporary, 'handled-child.json'))}, JSON.stringify({ exitCode: result.status, confirmed: confirmed.length }));
});
`);
  const selectionFile = path.join(temporary, 'outer-selection.json');
  const bytes = JSON.stringify({ files: ['outer.test.mjs'], concurrency: 1 });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(selectionFile, bytes);
  const registrationFile = path.join(temporary, 'outer-registrations.json');
  const environment = { ...process.env, GITHUB_ACTIONS: 'true',
    MEDIAMANAGER_TEST_REGISTRATION_OUTPUT: registrationFile, MEDIAMANAGER_TEST_REGISTRATION_ROOT: temporary,
    MEDIAMANAGER_TEST_SELECTION_FILE: selectionFile, MEDIAMANAGER_TEST_SELECTION_SHA256: sha256,
    MEDIAMANAGER_TEST_FILE_DIAGNOSTICS_ROOT: path.join(temporary, 'outer-diagnostics') };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [launcher, selectionFile, sha256], {
    cwd: temporary, env: environment, encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.deepEqual(parseTapSummary(result.stdout), { tests: 1, suites: 0, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  assert.deepEqual(JSON.parse(await readFile(path.join(temporary, 'handled-child.json'), 'utf8')), { exitCode: 1, confirmed: 1 });
  assert.deepEqual(JSON.parse(await readFile(registrationFile, 'utf8')), {
    schemaVersion: 1, files: [{ path: 'outer.test.mjs', registrations: 1 }], missing: [],
  });
  const received = [];
  progressForwarder({ environment, selected: ['outer.test.mjs'], write: line => received.push(line) })(Buffer.from(result.stderr));
  assert.equal(received.filter(line => line.startsWith('::error ')).length, 0);
  assert.equal(result.stderr.includes('PRIVATE_EXPECTED_CHILD'), false);
  assert.equal(result.stderr.includes('inner.test.mjs'), false);
});
