import { testFileSystem } from '../storage/plugin-files.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { DomainStore } from '../../src/database/domain-store.js';
import { UserViewService } from '../../src/library/user-view-service.js';

const fixtureRoot = new URL('./fixtures/user-view-refresh-queue/', import.meta.url);
const nativeBytes = await readFile(new URL('native.json', fixtureRoot));
const native = JSON.parse(nativeBytes);
const provenance = JSON.parse(await readFile(new URL('provenance.json', fixtureRoot), 'utf8'));
const gate = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const selected = native.results.filter(value => value.calls != null);
const project = value => ({
  name: value.name, calls: value.calls, peakConcurrentServices: value.peakConcurrentServices,
  services: value.events.filter(event => event.kind.startsWith('service-')),
  cancellationObserved: value.events.some(event => event.kind === 'token-cancelled'),
  ...(value.disposal ? { finishedAtDisposeReturn: value.disposal.finishedAtDisposeReturn } : {}),
});

test('UserView refresh queue fixtures retain actual DLL controls and raw source identities', async () => {
  assert.equal(native.actualFrozenProviderManager, true);
  assert.equal(native.actualFrozenUserView, true);
  assert.equal(native.actualFrozenUserViewMetadataService, true);
  assert.equal(native.results.length, 11);
  assert.equal(selected.length, 5);
  assert.equal(sha256(nativeBytes), provenance.native.sha256);
  assert.equal(sha256(await readFile(new URL('Program.cs', fixtureRoot))), provenance.program.sha256);
  assert.equal(sha256(await readFile(new URL('Oracle.csproj', fixtureRoot))), provenance.project.sha256);
  assert.deepEqual(native.assemblies, provenance.assemblies);
  assert.equal(new Set(native.assemblies.map(value => value.sha256)).size, 3);
  const disposal = selected.find(value => value.disposal);
  assert.equal(disposal.disposal.finishedAtDisposeReturn, false);
  assert.equal(disposal.disposal.cancellationObserved, true);
  assert.equal(provenance.phaseAcceptance, false);
});

for (const control of selected) test(`actual DLL queue control: ${control.name}`, { timeout: 10000 }, async t => {
  const events = [], errors = [], refreshFailures = [], started = gate(), release = gate();
  const providerCancellation = new AbortController();
  let activeSignal;
  let calls = 0, active = 0, peakConcurrentServices = 0, finished = false, finishedAtDisposeReturn;
  const items = Object.fromEntries(['A', 'B', 'C', ...Array.from({ length: 9 }, (_, index) => String(index + 1))].map((name, index) =>
    [name, { Id: `99520000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`, Name: name }]));
  const names = new Map(Object.values(items).map(item => [item.Id, item.Name]));
  const database = { dialect: 'postgres', withConnection: operation => operation(database), close: async () => {} };
  const library = { store: new DomainStore(database), options: {}, clock: () => new Date(),
    onError(error) { errors.push({ name: error.name, code: error.code, message: error.message, stack: error.stack });
      events.push({ kind: 'logged-error', Message: error.message }); } };
  const metadata = { async refresh(itemId, { signal }) {
    const Name = names.get(itemId), call = ++calls;
    activeSignal = signal;
    peakConcurrentServices = Math.max(peakConcurrentServices, ++active);
    events.push({ kind: 'service-start', Name, call, IsCancellationRequested: signal.aborted });
    try {
      if (call === 1) {
        const cancelled = () => events.push({ kind: 'token-cancelled', Name });
        signal.addEventListener('abort', cancelled, { once: true });
        started.resolve();
        try { await release.promise; } finally { signal.removeEventListener('abort', cancelled); }
      }
      if (call === 1 && control.name === 'failure-then-next-item') throw Object.assign(
        new Error('Controlled service failure'), { code: 'controlled-user-view-service-failure' });
      if (call === 1 && control.name === 'provider-own-cancellation-then-next-item') {
        providerCancellation.abort(Object.assign(new Error('Controlled provider cancellation'),
          { code: 'controlled-user-view-provider-cancellation' }));
        providerCancellation.signal.throwIfAborted();
      }
      signal.throwIfAborted();
      if (control.name !== 'normal-priority-distinct-id-order') events.push({ kind: 'service-success', Name, call });
    } catch (error) {
      refreshFailures.push({ Name, call, code: error.code, message: error.message, signalAborted: signal.aborted });
      throw error;
    } finally { active--; events.push({ kind: 'service-finish', Name, call }); if (call === 1) finished = true; }
  } };
  const views = new UserViewService({fileSystem: testFileSystem,  library, metadata, updates: {}, images: {} });
  t.after(async () => { release.resolve(); await views.close(); });
  const first = control.name === 'normal-priority-distinct-id-order' ? items['1'] : items.A;
  views.queueRefresh(first);
  await started.promise;
  if (control.name === 'duplicate-id-while-running') { views.queueRefresh(first); views.queueRefresh(first); }
  else if (control.name === 'normal-priority-distinct-id-order') {
    for (let index = 2; index <= 9; index++) views.queueRefresh(items[index]);
  } else views.queueRefresh(items.B);
  if (control.disposal) {
    assert.equal(views.dispose(), undefined, 'disposal returns synchronously while the service is blocked');
    finishedAtDisposeReturn = finished;
    views.dispose();
    views.queueRefresh(items.C);
  }
  release.resolve();
  await views.drain();
  const candidate = { name: control.name, calls, peakConcurrentServices, events, refreshFailures, errors,
    providerCancellation: { aborted: providerCancellation.signal.aborted,
      ...(providerCancellation.signal.aborted ? { code: providerCancellation.signal.reason.code,
        message: providerCancellation.signal.reason.message } : {}) },
    ...(control.disposal ? { disposal: { finishedAtDisposeReturn } } : {}) };
  assert.deepEqual(project(candidate), project(control));
  const controlledFailure = control.name === 'failure-then-next-item'
    ? { code: 'controlled-user-view-service-failure', message: 'Controlled service failure' }
    : control.name === 'provider-own-cancellation-then-next-item'
      ? { code: 'controlled-user-view-provider-cancellation', message: 'Controlled provider cancellation' } : null;
  if (controlledFailure) {
    assert.deepEqual(refreshFailures, [{ Name: 'A', call: 1, ...controlledFailure, signalAborted: false }]);
    for (const error of errors) assert.deepEqual({ code: error.code, message: error.message }, controlledFailure);
    if (control.name === 'provider-own-cancellation-then-next-item') {
      assert.equal(providerCancellation.signal.aborted, true);
      assert.deepEqual({ code: providerCancellation.signal.reason.code,
        message: providerCancellation.signal.reason.message }, controlledFailure);
    }
  } else {
    assert.deepEqual(errors, []);
    assert.deepEqual(refreshFailures, control.disposal ? [{ Name: 'A', call: 1,
      code: activeSignal.reason.code, message: activeSignal.reason.message, signalAborted: true }] : []);
  }
  if (process.env.MEDIAMANAGER_USER_VIEW_REFRESH_QUEUE_EVIDENCE) await writeFile(
    path.join(process.env.MEDIAMANAGER_USER_VIEW_REFRESH_QUEUE_EVIDENCE, control.name + '.json'),
    JSON.stringify({ native: control, candidate, projectionEqual: true, phaseAcceptance: false }, null, 2), { flag: 'wx' });
});
