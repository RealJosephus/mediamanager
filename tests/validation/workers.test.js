import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { analyzeJavaScriptDependencies, caseFoldedEntryMap, resolveLocalImport } from '../../tools/validation/inventory.js';

test('worker discovery binds fixed module entries and their static WASM assets', () => {
  const result = analyzeJavaScriptDependencies(`
    import { Worker as Thread } from 'node:worker_threads';
    const start = workerData => new Thread(new URL('./archive-worker.js', import.meta.url), { workerData, trackUnmanagedFds: true });
    const wasm = new URL('archive-codec.wasm', import.meta.url);
  `);
  assert.deepEqual(result.importSpecifiers, [
    { kind: 'asset', specifier: 'archive-codec.wasm' },
    { kind: 'module', specifier: './archive-worker.js' },
  ].sort((a, b) => a.specifier.localeCompare(b.specifier) || a.kind.localeCompare(b.kind)));
  assert.deepEqual(result.unresolvedImports, []); assert.deepEqual(result.unresolvedExecutables, []);
  const worker = analyzeJavaScriptDependencies("import { parentPort, workerData } from 'node:worker_threads'; parentPort.postMessage(workerData);");
  assert.deepEqual(worker.unresolvedImports, []); assert.deepEqual(worker.unresolvedExecutables, []);
});

test('worker discovery rejects dynamic entries, forwarded constructors and execution options', () => {
  for (const expression of [
    "new Worker(entry)",
    "new Worker(new URL(entry, import.meta.url))",
    "new Worker(new URL('https://example.com/worker.js', import.meta.url))",
    "new Worker(new URL('/outside.js', import.meta.url))",
    "new Worker(new URL('./worker.js', differentBase))",
    "new Worker(new URL('./worker.js', import.meta.url), options)",
    "new Worker(new URL('./worker.js', import.meta.url), { eval: true })",
    "new Worker(new URL('./worker.js', import.meta.url), { execArgv: ['--import=unbound.js'] })",
    "new Worker(new URL('./worker.js', import.meta.url), { env: process.env })",
    "new Worker(new URL('./worker.js', import.meta.url), { ...options })",
    "const launch = Worker; new launch(new URL('./worker.js', import.meta.url))",
    "const box = { Worker }; new box.Worker(new URL('./worker.js', import.meta.url))",
    "export { Worker }",
  ]) {
    const result = analyzeJavaScriptDependencies("import { Worker } from 'node:worker_threads'; " + expression);
    assert.ok(result.unresolvedImports.length || result.unresolvedExecutables.length, expression);
  }
  for (const source of [
    "import threads from 'node:worker_threads'; new threads.Worker('./worker.js')",
    "import * as threads from 'node:worker_threads'; new threads.Worker('./worker.js')",
    "const { Worker: Thread } = await import('node:worker_threads'); new Thread('./worker.js')",
    "const { Worker: Thread } = require('node:worker_threads'); new Thread('./worker.js')",
    "export { Worker } from 'node:worker_threads'",
    "import { Worker } from 'node:worker_threads'; const URL=class {}; new Worker(new URL('./worker.js',import.meta.url))",
    "import { Worker } from 'node:worker_threads'; function start(URL){ new Worker(new URL('./worker.js',import.meta.url)) }",
    "import { Worker } from 'node:worker_threads'; function start({ factory: URL }){ new Worker(new URL('./worker.js',import.meta.url)) }",
    "import { Worker } from 'node:worker_threads'; globalThis.URL=class {}; new Worker(new URL('./worker.js',import.meta.url))",
    "import { Worker } from 'node:worker_threads'; import.meta.url='file:///outside.js'; new Worker(new URL('./worker.js',import.meta.url))",
    "import { Worker } from 'node:worker_threads'; const meta=import.meta; meta.url='file:///outside.js'; new Worker(new URL('./worker.js',import.meta.url))",
    "import { Worker } from 'node:worker_threads'; Object.assign(import.meta,{url:'file:///outside.js'}); new Worker(new URL('./worker.js',import.meta.url))",
    "const URL=class {}; new URL('codec.wasm',import.meta.url)",
    "new URL('codec.wasm',differentBase)",
  ]) {
    const result = analyzeJavaScriptDependencies(source);
    assert.ok(result.unresolvedImports.length || result.unresolvedExecutables.length, source);
  }
});

test('worker and WASM resolution rejects missing, external and linked input targets', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'validation-workers-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('validation-workers-'));
    await rm(directory, { recursive: true });
  });
  const repository = path.join(directory, 'repository'), source = path.join(repository, 'src'), outside = path.join(directory, 'outside');
  await mkdir(source, { recursive: true }); await mkdir(outside);
  await writeFile(path.join(source, 'main.js'), ''); await writeFile(path.join(source, 'worker.js'), '');
  await writeFile(path.join(source, 'codec.wasm'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  await writeFile(path.join(outside, 'codec.wasm'), Buffer.from([0]));
  const options = { repository, rootRealPath: await realpath(repository), knownEntries: caseFoldedEntryMap(['src/main.js', 'src/worker.js']) };
  const importer = path.join(source, 'main.js');
  assert.deepEqual(await resolveLocalImport(importer, { kind: 'module', specifier: './worker.js' }, options), { imported: 'src/worker.js' });
  assert.deepEqual(await resolveLocalImport(importer, { kind: 'asset', specifier: 'codec.wasm' }, options), { importedFile: 'src/codec.wasm' });
  assert.deepEqual(await resolveLocalImport(importer, { kind: 'asset', specifier: './missing.wasm' }, options), { error: 'local-target-not-found' });
  assert.deepEqual(await resolveLocalImport(importer, { kind: 'asset', specifier: '../../outside/codec.wasm' }, options), { error: 'local-target-outside-repository' });
  await symlink(outside, path.join(source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await resolveLocalImport(importer, { kind: 'asset', specifier: './linked/codec.wasm' }, options), { error: 'local-target-symbolic-link' });
});
