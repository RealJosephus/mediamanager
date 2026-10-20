import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { createApplication } from '../../src/http/application.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { setupChildrenFixture } from '../metadata/children-fixture.js';
import { dateTicks } from '../../src/library/records.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';

const fixtureUrl = new URL('./fixtures/item-detail-refresh/input.json', import.meta.url);
const inputBytes = await readFile(fixtureUrl), inputs = JSON.parse(inputBytes);
const id = '981f0000000000000000000000000001', userId = '981f0000000000000000000000000002';
const optionsOnly = ({ MetadataRefreshMode, ImageRefreshMode, ForceSave }) => ({ MetadataRefreshMode, ImageRefreshMode, ForceSave });
export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];

test('item detail HTTP refresh matches the actual native controller admission, completion and cancellation', {
  skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 180000,
}, async () => {
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

  let current, item, phases, reported, started, failed;
  const results = [];
  const metadata = {
    async refresh(reference, options) {
      assert.equal(reference, id);
      phases.push({ phase: 'refresh', options: optionsOnly(options), cancellable: options.signal instanceof AbortSignal });
      started.resolve();
      try {
        if (current.behavior === 'failure') throw new Error('Controlled provider failure.');
        if (current.behavior === 'cancel') throw new DOMException('Controlled provider cancellation.', 'AbortError');
        if (['timeout', 'request-cancel'].includes(current.behavior)) await delay(30000, undefined, { signal: options.signal });
        item.Overview = 'Refreshed details';
        phases.push({ phase: 'completed' });
      } catch (error) {
        if (error.name === 'AbortError') phases.push({ phase: 'cancelled' });
        throw error;
      }
    },
    queue(reference, options, priority) {
      assert.equal(reference, id);
      assert.equal(options.signal, undefined);
      phases.push({ phase: 'queued', options: optionsOnly(options), priority });
      return Promise.resolve();
    },
  };
  const application = await createApplication({ configuration: { IsStartupWizardCompleted: true, UICulture: 'en-US' },
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
    onError(error) { reported.push(error); failed.resolve(error); },
  });
  await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${application.server.address().port}`;
  try {
    for (const [index, input] of inputs.entries()) {
      current = input; phases = []; reported = []; started = Promise.withResolvers(); failed = Promise.withResolvers();
      item = { Id: id, Type: input.type, Overview: input.overview ?? null,
        DateLastRefreshed: input.minimumDate ? '0001-01-01T00:00:00.0000000Z' : new Date(Date.now() - input.ageSeconds * 1000).toISOString(),
        ImageInfos: input.primary ? [{ Type: 'Primary', Path: 'controlled-primary.jpg' }] : [] };
      const abort = new AbortController(), before = performance.now();
      const response = fetch(origin + (index % 2 ? `/Users/${userId}/Items/${id}` : `/Items/${id}`), { signal: abort.signal });
      let error = null, responseOverview = null;
      if (input.behavior === 'request-cancel') {
        await started.promise;
        abort.abort();
        await assert.rejects(response, error => error.name === 'AbortError');
        assert.equal((await failed.promise).name, 'AbortError');
        error = 'cancelled';
      } else {
        const actual = await response;
        if (input.behavior === 'failure') {
          assert.equal(actual.status, 500);
          assert.equal(await actual.text(), 'Error processing request.');
          assert.equal(reported[0]?.message, 'Controlled provider failure.');
          error = 'provider failure';
        } else {
          assert.equal(actual.status, 200, input.name);
          responseOverview = (await actual.json()).Overview ?? null;
          assert.deepEqual(reported, []);
        }
      }
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
    application.server.closeAllConnections();
    await new Promise((resolve, reject) => application.server.close(error => error ? reject(error) : resolve()));
    await writeFile(path.join(output, 'node.json'), JSON.stringify({ results, scope: native.scope }, null, 2) + '\n', { flag: 'wx' });
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
  const application = await createApplication({ configuration: { IsStartupWizardCompleted: true, UICulture: 'en-US' },
    library: fixture.library, metadata: fixture.host, users: { getUser: async () => user },
    authentication: { authenticate: async () => ({ IsAuthenticated: true, IsAdministrator: true, UserId: userId }), authorize() {} },
    onError: error => errors.push(error) });
  await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${application.server.address().port}`;
  const userData = await fixture.database.rows('UserData');
  const before = dateTicks(new Date().toISOString());
  try {
    const response = await fetch(`${origin}/Items/${id}`);
    assert.equal(response.status, 200, errors.map(error => error.stack).join('\n'));
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
    assert.deepEqual(errors, []);
  } finally {
    application.server.closeAllConnections();
    await new Promise((resolve, reject) => application.server.close(error => error ? reject(error) : resolve()));
  }
});
