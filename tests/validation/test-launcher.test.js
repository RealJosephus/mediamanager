import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseTapSummary, prepareTestExecutionEnvironment, progressForwarder } from '../../tools/validation/run.js';

const launcher = fileURLToPath(new URL('../../tools/validation/test-launcher.js', import.meta.url));

test('independent executions retain both fixed-name fixture outputs and the same protected input', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mm-execution-output-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const inputRoot = path.join(directory, 'input'), jobOutput = path.join(directory, 'results');
  await mkdir(inputRoot); await mkdir(jobOutput);
  const inputBytes = Buffer.from('unchanged protected input\n');
  await writeFile(path.join(inputRoot, 'input.bin'), inputBytes, { flag: 'wx' });
  const originalEnvironment = { ...process.env, GITHUB_ACTIONS: 'false',
    MEDIAMANAGER_VALIDATION_INPUT_ROOT: inputRoot, MEDIAMANAGER_VALIDATION_OUTPUT_ROOT: jobOutput };
  const filename = path.join(directory, 'fixed-output.test.mjs');
  await writeFile(filename, `import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validationOutputRoot } from ${JSON.stringify(new URL('../../tools/validation/paths.js', import.meta.url).href)};
import { writeHttpEndpointEvidence } from ${JSON.stringify(new URL('../library/http-endpoint-evidence.js', import.meta.url).href)};
test('exclusive configuration directory and HTTP evidence retain the complete observation', async () => {
  const root = validationOutputRoot(), input = await readFile(path.join(process.env.MEDIAMANAGER_VALIDATION_INPUT_ROOT, 'input.bin'));
  assert.equal(input.toString(), 'unchanged protected input\\n');
  const configuration = path.join(root, 'configuration-runtime');
  await mkdir(configuration);
  await writeFile(path.join(configuration, 'input.bin'), input, { flag: 'wx' });
  const state = { bytes: [...input], output: root };
  await writeHttpEndpointEvidence(path.join(root, 'memory-sort-full', 'main'), 'postgres',
    { caseStages: [{ before: state, after: state }] }, { equal: true });
});
`);
  const selected = path.relative(fileURLToPath(new URL('../../', import.meta.url)), filename).replaceAll('\\', '/');
  const outputs = [];
  for (const index of [1, 2]) {
    const output = path.join(jobOutput, `strict-full-${index}`); await mkdir(output);
    const selectionFile = path.join(output, 'test-selection.json');
    const bytes = JSON.stringify({ files: [filename], concurrency: 1 });
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await writeFile(selectionFile, bytes, { flag: 'wx' });
    const environment = await prepareTestExecutionEnvironment(originalEnvironment, output, sha256);
    delete environment.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [launcher, selectionFile, sha256], {
      env: environment, windowsHide: true, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.deepEqual(parseTapSummary(result.stdout), { tests: 1, suites: 0, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
    assert.deepEqual(JSON.parse(await readFile(path.join(output, 'test-registrations.json'), 'utf8')),
      { schemaVersion: 1, files: [{ path: selected, registrations: 1 }], missing: [] });
    outputs.push(environment.MEDIAMANAGER_VALIDATION_OUTPUT_ROOT);
  }
  assert.notEqual(outputs[0], outputs[1]);
  for (const output of outputs) {
    assert.deepEqual(await readFile(path.join(output, 'configuration-runtime', 'input.bin')), inputBytes);
    assert.deepEqual(JSON.parse(await readFile(path.join(output, 'memory-sort-full', 'main', 'postgres.json'), 'utf8')),
      { caseStages: [{ before: { stateIndex: 0 }, after: { stateIndex: 0 } }], endpointStates: [{ bytes: [...inputBytes], output }] });
    assert.deepEqual(JSON.parse(await readFile(path.join(output, 'memory-sort-full', 'main', 'postgres-comparison.json'), 'utf8')), { equal: true });
  }
  await assert.rejects(access(path.join(jobOutput, 'configuration-runtime')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(jobOutput, 'memory-sort-full')), { code: 'ENOENT' });
  assert.equal(originalEnvironment.MEDIAMANAGER_VALIDATION_OUTPUT_ROOT, jobOutput);
  assert.equal(originalEnvironment.MEDIAMANAGER_VALIDATION_INPUT_ROOT, inputRoot);
  assert.deepEqual(await readFile(path.join(inputRoot, 'input.bin')), inputBytes);
});

test('the real isolated runner executes a complete selection longer than the Windows command line', { timeout: 120000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mm-selection-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'receipts'));
  const files = Array.from({ length: 240 }, (_, index) => `selected ${String(index).padStart(3, '0')} ${'x'.repeat(140)}.test.mjs`);
  assert.ok(files.join(' ').length > 32767);
  for (const filename of files) {
    await writeFile(path.join(directory, filename), `import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
test('selected file executes in its own global context', async () => {
  assert.equal(globalThis.selectionContext, undefined);
  globalThis.selectionContext = true;
  await writeFile(new URL('./receipts/' + ${JSON.stringify(filename)} + '.json', import.meta.url), JSON.stringify({ executed: true }), { flag: 'wx' });
});
`);
  }
  const selectionFile = path.join(directory, 'selection.json');
  const selectionBytes = JSON.stringify({ files, concurrency: 4 });
  const selectionSha256 = createHash('sha256').update(selectionBytes).digest('hex');
  await writeFile(selectionFile, selectionBytes);
  const registrationFile = path.join(directory, 'registrations.json');
  const environment = { ...process.env, GITHUB_ACTIONS: 'false',
    MEDIAMANAGER_TEST_REGISTRATION_ROOT: directory, MEDIAMANAGER_TEST_REGISTRATION_OUTPUT: registrationFile,
    MEDIAMANAGER_TEST_SELECTION_FILE: selectionFile, MEDIAMANAGER_TEST_SELECTION_SHA256: selectionSha256 };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [launcher, selectionFile, selectionSha256], {
    cwd: directory, env: environment, windowsHide: true, encoding: 'utf8', timeout: 100000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.deepEqual(parseTapSummary(result.stdout), {
    tests: files.length, suites: 0, pass: files.length, fail: 0, cancelled: 0, skipped: 0, todo: 0,
  });
  const registration = JSON.parse(await readFile(registrationFile, 'utf8'));
  assert.deepEqual(registration.missing, []);
  assert.deepEqual(registration.files, files.map(filename => ({ path: filename, registrations: 1 })));
  assert.deepEqual((await readdir(path.join(directory, 'receipts'))).sort(), files.map(filename => filename + '.json').sort());
  for (const filename of files) assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'receipts', filename + '.json'), 'utf8')), { executed: true });
});

test('a changed selection fails before executing any selected file', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mm-selection-drift-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sentinel = path.join(directory, 'executed.json');
  const filename = path.join(directory, 'sample.test.mjs');
  await writeFile(filename, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, '{}');`);
  const selectionFile = path.join(directory, 'selection.json');
  const original = JSON.stringify({ files: [filename], concurrency: 1 });
  const sha256 = createHash('sha256').update(original).digest('hex');
  await writeFile(selectionFile, original + '\n');
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [launcher, selectionFile, sha256], {
    cwd: directory, env: environment, windowsHide: true, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /test selection file changed before execution/u);
  await assert.rejects(access(sentinel), { code: 'ENOENT' });
});

test('a later native file failure is retained while an earlier file still holds ordered TAP', { timeout: 45000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mm-file-diagnostics-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const release = path.join(directory, 'release');
  await writeFile(path.join(directory, 'first.test.mjs'), `import test from 'node:test';
import { access, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
test('first file holds the ordered output', { timeout: 30000 }, async () => {
  await writeFile(new URL('./entered', import.meta.url), 'entered');
  while (true) {
    try { await access(new URL('./release', import.meta.url)); return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await setTimeout(10);
  }
});
`);
  const marker = 'later-file-assertion-is-original';
  await writeFile(path.join(directory, 'second.test.mjs'), `import test from 'node:test';
import assert from 'node:assert/strict';
test('second file fails independently', () => {
  console.log('original later stdout');
  console.error('original later stderr');
  assert.fail(${JSON.stringify(marker)});
});
`);
  const selectionFile = path.join(directory, 'selection.json');
  const bytes = JSON.stringify({ files: ['first.test.mjs', 'second.test.mjs'], concurrency: 2 });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(selectionFile, bytes);
  const root = path.join(directory, 'file-diagnostics');
  const environment = { ...process.env, GITHUB_ACTIONS: 'true',
    MEDIAMANAGER_TEST_REGISTRATION_ROOT: directory,
    MEDIAMANAGER_TEST_REGISTRATION_OUTPUT: path.join(directory, 'registrations.json'),
    MEDIAMANAGER_TEST_SELECTION_FILE: selectionFile, MEDIAMANAGER_TEST_SELECTION_SHA256: sha256,
    MEDIAMANAGER_TEST_FILE_DIAGNOSTICS_ROOT: root };
  delete environment.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [launcher, selectionFile, sha256], {
    cwd: directory, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  const annotations = [];
  const forward = progressForwarder({ environment, selected: ['first.test.mjs', 'second.test.mjs'], write: text => {
    if (text.startsWith('::error ')) annotations.push(text);
  } });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', text => { stdout += text; });
  child.stderr.on('data', text => { stderr += text; forward(Buffer.from(text)); });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
  });
  // Always release the real file process before deleting its private inputs.
  const waitFor = async operation => {
    const deadline = performance.now() + 20000;
    while (true) {
      const value = await operation();
      if (value) return value;
      if (performance.now() >= deadline) throw new Error(`Native diagnostic observation timed out.\n${stderr}\n${stdout}`);
      await delay(20);
    }
  };
  const readIfPresent = async filename => {
    try { return await readFile(filename, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
  };
  let second;
  try {
    await waitFor(() => readIfPresent(path.join(directory, 'entered')));
    const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.files.map(entry => entry.path), ['first.test.mjs', 'second.test.mjs']);
    second = path.join(root, manifest.files[1].directory);
    const original = await waitFor(async () => {
      const text = await readIfPresent(path.join(second, 'events.jsonl'));
      return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line))
        .find(record => record.type === 'test:complete' && record.native.includes('exitCode: 1'));
    });
    assert.match(original.native, /passed: false/u);
    assert.match(original.native, /signal: null/u);
    assert.equal(Number.isFinite(Date.parse(original.at)), true);
    await waitFor(() => annotations.length);
    assert.deepEqual(annotations, ['::error file=second.test.mjs::Selected test file failed (selected-file-failed).\n']);
    assert.equal(stdout.includes(marker), false);
    // Output may arrive independently or remain buffered. Its complete original
    // bytes are checked after release, without requiring temporary absence.
    assert.match(manifest.boundary, /may remain buffered/u);
  } finally {
    await writeFile(release, 'release');
    const outcome = await closed;
    assert.deepEqual(outcome, { code: 1, signal: null }, `${stderr}\n${stdout}`);
  }
  assert.match(stdout, new RegExp(marker, 'u'));
  assert.deepEqual(annotations, ['::error file=second.test.mjs::Selected test file failed (selected-file-failed).\n']);
  assert.equal(stdout.includes('::error'), false);
  assert.equal(stderr.includes('::error'), false);
  assert.equal(await readFile(path.join(second, 'stdout.txt'), 'utf8'), 'original later stdout\n');
  assert.equal(await readFile(path.join(second, 'stderr.txt'), 'utf8'), 'original later stderr\n');
  const events = (await readFile(path.join(second, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(events.some(record => record.type === 'test:fail' && record.native.includes(marker)));
  assert.deepEqual(events.map(record => record.sequence), events.map((_, index) => index + 1));
});

test('an unavailable diagnostic directory preserves the native failure and complete TAP', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mm-file-diagnostics-unavailable-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'failure.test.mjs'), `import test from 'node:test';
import assert from 'node:assert/strict';
test('original failure', () => assert.fail('original failure remains observable'));
`);
  const selectionFile = path.join(directory, 'selection.json');
  const bytes = JSON.stringify({ files: ['failure.test.mjs'], concurrency: 1 });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(selectionFile, bytes);
  const blocked = path.join(directory, 'ordinary-file');
  await writeFile(blocked, 'keep original bytes');
  const environment = { ...process.env, GITHUB_ACTIONS: 'true',
    MEDIAMANAGER_TEST_REGISTRATION_ROOT: directory,
    MEDIAMANAGER_TEST_REGISTRATION_OUTPUT: path.join(directory, 'registrations.json'),
    MEDIAMANAGER_TEST_SELECTION_FILE: selectionFile, MEDIAMANAGER_TEST_SELECTION_SHA256: sha256,
    MEDIAMANAGER_TEST_FILE_DIAGNOSTICS_ROOT: blocked };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [launcher, selectionFile, sha256], {
    cwd: directory, env: environment, windowsHide: true, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /original failure remains observable/u);
  assert.deepEqual(parseTapSummary(result.stdout), {
    tests: 1, suites: 0, pass: 0, fail: 1, cancelled: 0, skipped: 0, todo: 0,
  });
  const annotations = [];
  progressForwarder({ environment, selected: ['failure.test.mjs'], write: text => {
    if (text.startsWith('::error ')) annotations.push(text);
  } })(Buffer.from(result.stderr));
  assert.deepEqual(annotations, ['::error file=failure.test.mjs::Selected test file failed (selected-file-failed).\n']);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'registrations.json'), 'utf8')), {
    schemaVersion: 1, files: [{ path: 'failure.test.mjs', registrations: 1 }], missing: [],
  });
  assert.equal(await readFile(blocked, 'utf8'), 'keep original bytes');
});
