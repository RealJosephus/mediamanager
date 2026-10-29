import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { inspect } from 'node:util';
import path from 'node:path';
import { createTestApplication } from '../helpers/application.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { setupChildrenFixture } from '../metadata/children-fixture.js';
import { dateTicks } from '../../src/library/records.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';

const fixtureUrl = new URL('./fixtures/item-detail-refresh/input.json', import.meta.url);
const inputBytes = await readFile(fixtureUrl), inputs = JSON.parse(inputBytes);
const id = '981f0000000000000000000000000001', userId = '981f0000000000000000000000000002';
const optionsOnly = ({ MetadataRefreshMode, ImageRefreshMode, ForceSave }) => ({ MetadataRefreshMode, ImageRefreshMode, ForceSave });
const failureValue = error => {
  if (error == null || typeof error !== 'object') return error;
  if (Array.isArray(error)) return error.map(failureValue);
  const keys = new Set([...Object.getOwnPropertyNames(error),
    ...['message', 'code', 'status', 'statusCode', 'errno', 'path', 'syscall', 'signal', 'reason', 'cause', 'errors', 'name', 'stack']
      .filter(key => key in error)]);
  return Object.fromEntries([...keys].filter(key => !(error instanceof Error && ['name', 'stack'].includes(key)))
    .map(key => [key, failureValue(error[key])]));
};
const diagnosticFailure = error => ({ value: failureValue(error), raw: inspect(error, { depth: null, maxArrayLength: null }) });
export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];

test('item detail HTTP refresh matches the actual native controller admission, completion and cancellation', {
  skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 180000,
}, async t => {
  const output = path.join(validationOutputRoot(), 'item-detail-refresh-' + randomUUID());
  await mkdir(output);
  const recording = await recordOracle({ project: 'tests/http/fixtures/item-detail-refresh/Oracle.csproj',
    output: path.join(output, 'native'), args: [fileURLToPath(fixtureUrl), '{output}/native.json'] });
  const native = JSON.parse(await readFile(path.join(output, 'native/native.json'), 'utf8'));
  assert.equal(recording.passed, true);
  assert.equal(native.actualControllerExecution, true);
  assert.equal(native.inputSha256, createHash('sha256').update(inputBytes).digest('hex'));
  assert.equal(native.assemblies.find(value => value.FullName.startsWith('jellyfin,')).sha256, recording.jellyfinDll.sha256);
  assert.deepEqual(native.results.map(value => value.name), inputs.map(value => value.name));

  let current, item, phases, started, refreshSettled, refreshOutcome, activeRequest;
  const results = [], requests = [], unexpectedErrors = [];
  const metadata = {
    async refresh(reference, options) {
      assert.equal(reference, id);
      phases.push({ phase: 'refresh', options: optionsOnly(options), cancellable: options.signal instanceof AbortSignal });
      const observation = { failed: false, finallyReached: false };
      refreshOutcome = activeRequest.refresh = observation;
      started.resolve();
      try {
        if (current.behavior === 'failure') throw new Error('Controlled provider failure.');
        if (current.behavior === 'cancel') throw new DOMException('Controlled provider cancellation.', 'AbortError');
        if (['timeout', 'request-cancel'].includes(current.behavior)) await delay(30000, undefined, { signal: options.signal });
        item.Overview = 'Refreshed details';
        phases.push({ phase: 'completed' });
      } catch (error) {
        observation.failed = true;
        observation.failure = error;
        if (options.signal.aborted || current.behavior === 'cancel') phases.push({ phase: 'cancelled' });
        throw error;
      } finally {
        observation.signalAborted = options.signal.aborted;
        observation.signalReason = options.signal.reason;
        observation.finallyReached = true;
        refreshSettled.resolve(observation);
      }
    },
    queue(reference, options, priority) {
      assert.equal(reference, id);
      assert.equal(options.signal, undefined);
      phases.push({ phase: 'queued', options: optionsOnly(options), priority });
      return Promise.resolve();
    },
  };
  const application = await createTestApplication({ configuration: { IsStartupWizardCompleted: true, UICulture: 'en-US' },
    authentication: { authenticate: async () => ({ IsAuthenticated: true, IsAdministrator: true, UserId: userId }), authorize() {} },
    users: { getUser: async () => ({ Id: userId }) }, metadata,
    library: {
      async getItemRecord(reference) { assert.equal(reference, id); return item; },
      async getItem(reference) {
        assert.equal(reference, id);
        phases.push({ phase: 'dto' });
        return { Id: id, Overview: item.Overview };
      },
    },
    onError(error) { (activeRequest?.errors ?? unexpectedErrors).push(error); },
  });
  await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${application.server.address().port}`;
  try {
    for (const [index, input] of inputs.entries()) {
      current = input; phases = []; started = Promise.withResolvers(); refreshSettled = Promise.withResolvers(); refreshOutcome = undefined;
      item = { Id: id, Type: input.type, Overview: input.overview ?? null,
        DateLastRefreshed: input.minimumDate ? '0001-01-01T00:00:00.0000000Z' : new Date(Date.now() - input.ageSeconds * 1000).toISOString(),
        ImageInfos: input.primary ? [{ Type: 'Primary', Path: 'controlled-primary.jpg' }] : [] };
      const abort = new AbortController(), before = performance.now();
      const receipt = { index: index + 1, name: input.name, method: 'GET',
        route: index % 2 ? `/Users/${userId}/Items/${id}` : `/Items/${id}`, status: null, errors: [] };
      requests.push(receipt); activeRequest = receipt;
      const response = fetch(origin + receipt.route, { signal: abort.signal }).then(actual => {
        receipt.status = actual.status; return { failed: false, response: actual };
      }, failure => { receipt.fetchFailure = diagnosticFailure(failure); return { failed: true, failure }; });
      let error = null, responseOverview = null;
      if (input.behavior === 'request-cancel') {
        await started.promise;
        abort.abort();
        assert.equal((await response).failed, true, 'The actual aborted HTTP fetch rejects.');
        assert.equal(abort.signal.aborted, true);
        await refreshSettled.promise;
        assert.equal(refreshOutcome.failed, true, 'The actual refresh rejects after request cancellation.');
        assert.equal(refreshOutcome.signalAborted, true);
        error = 'cancelled';
      } else {
        const outcome = await response;
        assert.equal(outcome.failed, false, receipt.fetchFailure?.raw);
        const actual = outcome.response;
        if (input.behavior === 'failure') {
          assert.equal(actual.status, 500);
          receipt.body = await actual.text();
          assert.equal(receipt.body, 'Error processing request.');
          await refreshSettled.promise;
          assert.equal(refreshOutcome.failed, true, 'The real provider failure rejects the refresh.');
          assert.equal(refreshOutcome.signalAborted, false);
          error = 'provider failure';
        } else {
          assert.equal(actual.status, 200, input.name);
          receipt.body = await actual.json(); responseOverview = receipt.body.Overview ?? null;
        }
      }
      if (refreshOutcome) {
        await refreshSettled.promise;
        assert.equal(refreshOutcome.finallyReached, true, 'The real refresh finally completes before the next request.');
        if (input.behavior === 'timeout') {
          assert.equal(refreshOutcome.signalAborted, true);
          assert.equal(refreshOutcome.failed, true);
        } else if (input.behavior === 'cancel') {
          assert.equal(refreshOutcome.signalAborted, false, 'Provider cancellation does not abort the request signal.');
          assert.equal(refreshOutcome.failed, true);
        } else if (input.behavior === undefined) {
          assert.equal(refreshOutcome.failed, false);
        }
      }
      await application.drainRequests();
      activeRequest = undefined;
      const result = { name: input.name, phases, error, overview: item.Overview, responseOverview,
        elapsedMilliseconds: performance.now() - before };
      results.push(result);
      const { elapsedMilliseconds: nativeElapsed, ...expected } = native.results[index];
      const { elapsedMilliseconds: candidateElapsed, ...actual } = result;
      assert.deepEqual(actual, expected, input.name);
      if (input.behavior === 'timeout') {
        assert.ok(nativeElapsed >= 2500, 'Native cancellation must wait for its on-demand timeout.');
        assert.ok(candidateElapsed >= 2500, 'Node cancellation must wait for its on-demand timeout.');
      }
    }
  } finally {
    activeRequest = undefined;
    application.beginClose();
    application.server.closeAllConnections();
    await new Promise((resolve, reject) => application.server.close(error => error ? reject(error) : resolve()));
    await application.drainRequests();
    const receipts = requests.map(({ refresh, errors, ...request }) => ({ ...request, errors: errors.map(diagnosticFailure),
      refresh: refresh ? { finallyReached: refresh.finallyReached, signalAborted: refresh.signalAborted,
        signalReason: diagnosticFailure(refresh.signalReason), failureOccurred: refresh.failed,
        ...(refresh.failed ? { failure: diagnosticFailure(refresh.failure) } : {}) } : null }));
    for (const receipt of receipts) t.diagnostic(JSON.stringify({ ...receipt,
      name: 'item-detail-refresh-request', scenario: receipt.name }));
    await writeFile(path.join(output, 'node.json'), JSON.stringify({ results, requests: receipts,
      unexpectedErrors: unexpectedErrors.map(diagnosticFailure), scope: native.scope }, null, 2) + '\n', { flag: 'wx' });
  }
});

test('person detail HTTP refresh persists through the actual metadata host before projecting the response', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 60000,
}, async t => {
  const fixture = await setupChildrenFixture(t);
  const old = '2025-01-01T00:00:00.0000000Z';
  const itemPath = path.join(fixture.stateRoot, 'metadata', 'People', 'r', 'Refresh Person');
  await mkdir(itemPath, { recursive: true });
  await fixture.seed({ target: 'person', items: [{ key: 'person', Id: id, type: 'Person', Name: 'Refresh Person',
    Path: itemPath, DateLastRefreshed: old, Overview: null }] });
  fixture.host.now = fixture.host.updates.now = () => new Date().toISOString();
  const calls = [], errors = [];
  fixture.registry.register({ id: 'detail-refresh-control', name: 'Detail refresh control', providers: [{
    id: 'person-detail', name: 'Person detail', kind: 'custom', itemTypes: ['Person'],
    async fetch(person, { signal }) {
      assert.equal(signal.aborted, false);
      calls.push(person.Id);
      person.Overview = 'Biography from the controlled provider';
      return ItemUpdateType.MetadataImport;
    },
  }] });
  const user = { Id: userId, Policy: { EnableAllFolders: true, EnabledFolders: [], AllowedTags: [], BlockedTags: [],
    BlockUnratedItems: [], EnableContentDeletion: false, EnableContentDeletionFromFolders: [] }, Configuration: {} };
  const application = await createTestApplication({ configuration: { IsStartupWizardCompleted: true, UICulture: 'en-US' },
    library: fixture.library, metadata: fixture.host, users: { getUser: async () => user },
    authentication: { authenticate: async () => ({ IsAuthenticated: true, IsAdministrator: true, UserId: userId }), authorize() {} },
    onError: error => errors.push(error) });
  await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${application.server.address().port}`;
  const userData = await fixture.database.rows('UserData');
  const before = dateTicks(new Date().toISOString());
  try {
    const response = await fetch(`${origin}/Items/${id}`);
    assert.equal(response.status, 200, inspect(errors, { depth: null }));
    const dto = await response.json();
    const stored = (await fixture.database.rows('BaseItems', { where: { Id: id } }))[0];
    assert.equal(dto.Overview, 'Biography from the controlled provider');
    assert.equal(stored.Overview, dto.Overview);
    assert.ok(dateTicks(stored.DateLastRefreshed) >= before);
    assert.ok(dateTicks(stored.DateLastRefreshed) <= dateTicks(new Date().toISOString()));
    assert.ok((await stat(itemPath)).isDirectory());
    assert.equal(calls.length, 1);
    const again = await fetch(`${origin}/Users/${userId}/Items/${id}`);
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), dto);
    assert.equal(calls.length, 1, 'A recent refresh must suppress another provider call.');
    assert.deepEqual(await fixture.database.rows('UserData'), userData);
  } finally {
    application.beginClose();
    application.server.closeAllConnections();
    await new Promise((resolve, reject) => application.server.close(error => error ? reject(error) : resolve()));
    await application.drainRequests();
    t.diagnostic(inspect({ errors }, { depth: null }));
  }
});
