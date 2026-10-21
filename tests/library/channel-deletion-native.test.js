import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { stringifyNativeJson, parseLosslessJson } from '../../src/core/json.js';
import { idKey } from '../../src/library/records.js';
import { makeInput, targetId, missingId } from './fixtures/channel-deletion/input.js';
import { hash, comparable, errorRecord, openScenario, observe, removeOwned, within } from './fixtures/channel-deletion/scenario.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES;

test('actual Channel CanDelete, DTO overloads and LibraryManager external deletion match the SDK host and PostgreSQL lifecycle', {
  skip: !enabled, timeout: 900000,
}, async t => {
  const input = makeInput(), bytes = Buffer.from(JSON.stringify(input));
  const output = path.join(validationOutputRoot(), 'channel-deletion-' + randomUUID()), privateRoot = path.join(output, 'private'); await mkdir(privateRoot, { recursive: true });
  const inputFile = path.join(output, 'input.json'); await writeFile(inputFile, bytes);
  const report = { comparisons: [], differences: [], hardFailures: [], requestDiagnostics: [], componentAcceptance: false, phaseAcceptance: false, releaseAcceptance: false, cleanup: {},
    boundary: { native: ['ChannelManager', 'BaseItem virtual permission', 'DtoService list/detail', 'LibraryController direct action', 'LibraryManager.DeleteItem', 'EF SQLite persistence', 'owned metadata/source bytes'],
      node: ['PluginHost/SDK', 'PostgreSQL', 'ItemCreationService', 'ItemDeletionService', 'ExternalDataManager', 'real HTTP DELETE'],
      controlled: ['external provider methods', 'external-data directory declaration', 'user-data read dependencies', 'active-recording DTO association'],
      excluded: ['full native MVC host', 'external catalog fetching', 'recording', 'encoding', 'live stream execution', 'production SQLite import'] } };
  let current, failure;
  const compare = (name, actual, expected) => { try { assert.deepEqual(actual, expected, name); } catch (error) { report.differences.push({ name, actual, expected, error: errorRecord(error) }); } };
  const runCase = (name, operation) => t.test(name, { timeout: 180000 }, async () => { try { await operation(); } catch (error) { report.hardFailures.push({ name, error: errorRecord(error) }); throw error; } });
  try {
    current = await currentNativeReference(); report.preparation = current.preparation;
    report.sourceBindings = await current.sourceBindings(['src/Jellyfin.LiveTv/Channels/ChannelManager.cs', 'MediaBrowser.Controller/Channels/ISupportsDelete.cs',
      'MediaBrowser.Controller/Entities/BaseItem.cs', 'MediaBrowser.Controller/Entities/Video.cs', 'MediaBrowser.Controller/Entities/Folder.cs',
      'MediaBrowser.Controller/Channels/Channel.cs', 'MediaBrowser.Controller/Playlists/Playlist.cs', 'MediaBrowser.Controller/Entities/Movies/BoxSet.cs',
      'Emby.Server.Implementations/Dto/DtoService.cs', 'Emby.Server.Implementations/Library/LibraryManager.cs', 'Jellyfin.Api/Controllers/LibraryController.cs',
      'Jellyfin.Server.Implementations/Item/ItemPersistenceService.cs', 'Jellyfin.Server.Implementations/Item/BaseItemRepository.cs',
      'Jellyfin.Server.Implementations/Item/BaseItemMapper.cs', 'src/Jellyfin.Database/Jellyfin.Database.Implementations/ModelConfiguration/BaseItemConfiguration.cs',
      'MediaBrowser.Controller/Library/DeleteOptions.cs', 'Jellyfin.Api/Controllers/LiveTvController.cs', 'MediaBrowser.Controller/Entities/SourceType.cs']);
    const receipt = await recordOracle({ project: 'tests/library/fixtures/channel-deletion/Oracle.csproj', output: path.join(output, 'native'),
      args: [inputFile, '{output}/native.json', path.join(privateRoot, 'native')] }); assert.equal(receipt.passed, true);
    const nativeBytes = await readFile(path.join(output, 'native/native.json')), native = parseLosslessJson(nativeBytes.toString());
    assert.equal(native.inputSha256, hash(bytes)); assert.equal(receipt.outputs.find(value => path.basename(value.filename) === 'native.json').sha256, hash(nativeBytes));
    for (const field of ['actualChannelManager', 'actualLibraryManagerDeletion', 'actualDtoService', 'actualEfPersistence', 'nativeLibraryControllerExecuted']) assert.equal(native[field], true, field);
    assert.equal(native.mediaExecutionStarted, false);
    for (const assembly of [...native.assemblies, native.sqliteNative]) assert.equal(hash(await readFile(assembly.filename)), assembly.sha256);
    for (const [index, sample] of input.permissions.entries()) await runCase(sample.name, async () => {
      const expected = native.results[index]; assert.equal(expected.name, sample.name); assert.equal(expected.lane, 'permissions');
      assert.equal(expected.beforeRows.filter(row => row.Type === 'PLACEHOLDER').length, 1, 'The actual EF seed is retained in the PostgreSQL input.');
      for (const stage of ['direct', 'precomputed', 'projected', 'projectedDetail']) {
        const status = stage.startsWith('projected') ? sample.dtoFailure ?? sample.failure : sample.failure;
        if (status) assert.equal(expected[stage].failure?.status, status, sample.name + ': actual native ' + stage);
        else assert.equal(expected[stage].failure, undefined, sample.name + ': actual native ' + stage + ' must succeed: ' + stringifyNativeJson(expected[stage]));
      }
      const fixture = await openScenario(sample, expected, path.join(privateRoot, 'node-permission-' + index));
      try {
        compare(sample.name + ': actual dynamic source type', fixture.target.SourceType, expected.sourceType);
        if (sample.active) { assert.equal(expected.sourceType, 'LiveTV'); assert.equal(expected.calls.length, 0); }
        const actual = await fixture.permissions();
        for (const stage of ['direct', 'precomputed', 'projected', 'projectedDetail']) compare(sample.name + ': ' + stage, comparable(actual[stage]), comparable(expected[stage]));
        compare(sample.name + ': actual provider evaluation order/input', fixture.calls, expected.calls);
        compare(sample.name + ': no deletion side effects', await fixture.state(), expected.after);
        if (sample.type === 'Playlist') {
          assert.equal(expected.direct.value, true); assert.equal(expected.precomputed.value, false);
          assert.equal(expected.projected.value.CanDelete, false); assert.equal(expected.projectedDetail.value.CanDelete, true);
        }
        if (sample.warmName) {
          assert.equal(expected.targetWasCached, true); assert.equal(fixture.items.getCachedItemById(targetId), fixture.target);
          assert.ok(fixture.calls.every(value => value.kind !== 'canDelete' || value.Name === sample.warmName));
          assert.equal((await fixture.database.rows('BaseItems', { where: { Id: fixture.target.Id } }))[0].Name, 'Stored target');
        }
        await fixture.released(); assert.deepEqual(fixture.diagnostics, [], stringifyNativeJson(fixture.diagnostics.map(errorRecord)));
        report.comparisons.push({ name: sample.name, expected, actual, calls: fixture.calls });
      } finally { await fixture.close(); }
    });
    for (const [index, sample] of input.deletions.entries()) await runCase(sample.name, async () => {
      const expected = native.results[input.permissions.length + index]; assert.equal(expected.name, sample.name); assert.equal(expected.lane, 'deletions');
      assert.equal(expected.beforeRows.filter(row => row.Type === 'PLACEHOLDER').length, 1);
      if (sample.failure) assert.equal(expected.action.failure?.status, sample.failure);
      else assert.equal(expected.action.failure, undefined, 'Every declared native success must pass actual metadata and EF deletion: ' + stringifyNativeJson(expected.action));
      if (sample.controller && !sample.failure) assert.equal(expected.action.value.status, sample.actionStatus ?? 204, sample.name + ': declared native action status');
      const fixture = await openScenario(sample, expected, path.join(privateRoot, 'node-delete-' + index));
      try {
        let actual, wire;
        if (sample.controller) {
          const route = sample.batch ? '/Items?Ids=' + targetId + ',' + missingId : (sample.recordingController ? '/LiveTv/Recordings/' : '/Items/') + targetId;
          wire = await fixture.http(async (base, errors) => {
            const response = await fetch(base + route, { method: 'DELETE' }), body = await response.text();
            return { status: response.status, body, errors: [...errors] };
          });
          report.requestDiagnostics.push({ name: sample.name, method: 'DELETE', route, wire, native: expected.action,
            providerFailures: fixture.providerFailures, providerConsumerCalls: fixture.providerConsumerCalls });
          if (sample.failure) {
            assert.equal(wire.status, expected.action.failure.status); assert.equal(wire.errors.length, 1);
            assert.equal(wire.errors[0].type, expected.action.failure.type); assert.equal(wire.errors[0].Message, expected.action.failure.Message);
            assert.equal(fixture.providerFailures.length, 1);
            const producer = fixture.providerFailures[0], providerFile = fileURLToPath(producer.entryUrl), relative = path.relative(fixture.providerDirectory, providerFile).split(path.sep);
            assert.equal(relative.length, 2); assert.match(relative[0], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u); assert.equal(relative[1], 'index.js');
            assert.equal(hash(await readFile(providerFile)), fixture.providerSourceHash);
            assert.deepEqual(wire.errors[0], producer.error, 'The wire diagnostic must be the exact owned provider failure, including its original stack.');
            assert.ok(producer.error.StackTrace.includes(producer.entryUrl + ':' + fixture.providerErrorLine + ':'), 'The actual exported provider throw point is required.');
            const consumerUrl = new URL('../../src/library/item-deletion-service.js', import.meta.url), source = await readFile(consumerUrl, 'utf8');
            const consumerLine = source.split(/\r?\n/u).findIndex(line => line.includes('await channelAccess.deleteItem(item)')) + 1;
            assert.ok(consumerLine > 0); assert.equal(fixture.providerConsumerCalls.length, 1); assert.equal(producer.consumerIndex, 0);
            const consumer = fixture.providerConsumerCalls[producer.consumerIndex];
            assert.equal(consumer.id, targetId); assert.equal(consumer.externalId, sample.externalId);
            assert.ok(consumer.StackTrace.includes(consumerUrl.href + ':' + consumerLine + ':'), 'The synchronous call must originate at the actual deletion consumer await.');
            assert.ok(expected.action.failure.StackTrace.includes('LibraryManager.DeleteItem')); assert.ok(expected.action.failure.StackTrace.includes('LibraryController.cs'));
            actual = { failure: wire.errors[0] };
          } else { assert.deepEqual(wire.errors, []); actual = { value: { status: wire.status } }; }
        } else actual = await observe(() => fixture.deleteDirect());
        compare(sample.name + ': actual action result', comparable(actual), comparable(expected.action));
        await fixture.drainEvents();
        const calls = values => values.map(value => value.kind === 'delete' ? { kind: value.kind, name: value.name, externalId: value.externalId } : value);
        compare(sample.name + ': provider, metadata, persistence and event prefix', calls(fixture.calls), calls(expected.calls));
        for (const value of expected.calls.filter(value => value.kind === 'delete')) assert.equal(value.canBeCanceled, false);
        for (const value of fixture.calls.filter(value => value.kind === 'delete')) { assert.equal(value.pluginSignal, true); assert.equal(value.signalAborted, false); }
        if (sample.recordingController) { assert.equal(expected.calls.some(value => value.kind === 'canDelete'), false); assert.equal(fixture.calls.some(value => value.kind === 'canDelete'), false); }
        compare(sample.name + ': physical/persisted/cache state', await fixture.state(), expected.after);
        compare(sample.name + ': parent cache invalidation', fixture.parentState(), { parentChildrenInvalidated: expected.parentChildrenInvalidated, parentUserDataInvalidated: expected.parentUserDataInvalidated });
        assert.equal(expected.after.source, true, 'External media deletion must not delete local source bytes.');
        const retained = Boolean(sample.failure || sample.retained);
        assert.equal(expected.after.row, retained);
        assert.equal(expected.after.internalMetadata, retained);
        assert.equal(expected.after.externalMetadata, retained);
        if (!retained) { assert.equal(expected.calls.at(-1).kind, 'event'); assert.equal(expected.calls.at(-1).state.row, false); assert.equal(expected.calls.at(-1).state.cached, false); }
        if (sample.retained) assert.deepEqual(fixture.calls.map(value => value.kind), ['canDelete']);
        const rows = (await fixture.database.rows('BaseItems')).map(row => ({ Id: idKey(row.Id), Name: row.Name, ParentId: row.ParentId ? idKey(row.ParentId) : null })).sort((a, b) => a.Id.localeCompare(b.Id));
        compare(sample.name + ': final SQL rows', rows, expected.rows.map(row => ({ ...row, Id: idKey(row.Id), ParentId: row.ParentId ? idKey(row.ParentId) : null })).sort((a, b) => a.Id.localeCompare(b.Id)));
        await fixture.released(); assert.deepEqual(fixture.diagnostics, [], stringifyNativeJson(fixture.diagnostics.map(errorRecord)));
        report.comparisons.push({ name: sample.name, expected, actual, wire, calls: fixture.calls, rows });
      } finally { await fixture.close(); }
    });
    await runCase('explicitly disabled provider deletion does not acquire a closed Channel owner', async () => {
      const index = input.deletions.findIndex(value => value.deleteFromExternalProvider === false), sample = input.deletions[index];
      const expected = native.results[input.permissions.length + index];
      const fixture = await openScenario(sample, expected, path.join(privateRoot, 'node-disabled-provider'));
      try {
        await fixture.channels.close(); fixture.metadata.cancel();
        compare(sample.name + ': closed inventory bypass', comparable(await observe(() => fixture.deleteDirect())), comparable(expected.action));
        await fixture.drainEvents();
        assert.deepEqual(fixture.calls.map(value => value.kind), ['external', 'persist', 'event']);
        assert.deepEqual(await fixture.state(), expected.after); await fixture.released(); assert.deepEqual(fixture.diagnostics, []);
      } finally { await fixture.close(); }
    });
    await runCase('selected CanDelete Items DTO keeps its admitted provider after close and metadata cancellation', async () => {
      const entered = Promise.withResolvers(), proceed = Promise.withResolvers();
      let fixture, pending, closing, providerSignal;
      try {
        fixture = await openScenario(input.permissions[0], native.results[0], path.join(privateRoot, 'node-held-dto'), {
          permission: async (_item, options) => { providerSignal = options.signal; entered.resolve(); await proceed.promise; },
        });
        let admissions = 0; const admit = fixture.channels.admitOperation.bind(fixture.channels);
        fixture.channels.admitOperation = (...args) => { admissions++; return admit(...args); };
        pending = fixture.http(async (base, errors) => {
          const response = await fetch(base + '/Items?ids=' + targetId + '&fields=CanDelete&enableImages=false&enableUserData=false');
          return { status: response.status, json: await response.json(), errors };
        }, { userRequest: true });
        void pending.catch(() => {});
        await within(entered.promise, 'selected CanDelete actual Items DTO'); assert.equal(admissions, 1);
        let closed = false; closing = fixture.channels.close().then(() => { closed = true; }); fixture.metadata.cancel();
        await assert.rejects(fixture.channels.canDelete(fixture.target), { status: 503 }); assert.equal(admissions, 2);
        assert.equal(closed, false); assert.equal(providerSignal.aborted, false);
        proceed.resolve(); const wire = await within(pending, 'admitted Items DTO'); await within(closing, 'Items DTO channel release');
        assert.equal(wire.status, 200); assert.equal(wire.json.TotalRecordCount, 1); assert.equal(wire.json.Items.length, 1);
        assert.equal(wire.json.Items[0].Id, targetId); assert.equal(wire.json.Items[0].CanDelete, true); assert.deepEqual(wire.errors, []);
        assert.deepEqual(fixture.calls.map(value => value.kind), ['canDelete']); assert.equal(closed, true);
        assert.deepEqual(await fixture.state(), native.results[0].after); await fixture.released(); assert.deepEqual(fixture.diagnostics, []);
        report.comparisons.push({ name: 'held selected CanDelete DTO', admissions, wire, calls: fixture.calls, closed });
      } finally { proceed.resolve(); await Promise.allSettled([pending, closing]); await fixture?.close(); }
    });
    for (const abortRequest of [false, true]) await runCase('production HTTP permission and deletion share shutdown ownership: abort=' + abortRequest, async () => {
      const entered = Promise.withResolvers(), proceed = Promise.withResolvers(), aborted = new AbortController();
      let fixture, pending, closing, providerSignal;
      try {
        const sample = input.permissions[0], expected = native.results[0];
        fixture = await openScenario(sample, expected, path.join(privateRoot, 'node-held-' + abortRequest), {
          permission: async (_item, options) => { providerSignal = options.signal; entered.resolve(); await proceed.promise; },
        });
        let admissions = 0; const admit = fixture.channels.admitOperation.bind(fixture.channels);
        fixture.channels.admitOperation = (...args) => { admissions++; return admit(...args); };
        pending = fixture.http(async base => {
          try { const response = await fetch(base + '/Items/' + targetId, { method: 'DELETE', signal: aborted.signal }); await response.text(); return { status: response.status }; }
          catch (error) { if (!abortRequest || error.name !== 'AbortError') throw error; return { aborted: true }; }
        }, { userRequest: true });
        void pending.catch(() => {});
        await within(entered.promise, 'real HTTP provider permission'); assert.equal(admissions, 1);
        if (abortRequest) aborted.abort();
        let closed = false; closing = fixture.channels.close().then(() => { closed = true; }); fixture.metadata.cancel();
        await assert.rejects(fixture.channels.canDelete(fixture.target), { status: 503 }); assert.equal(admissions, 2);
        assert.equal(closed, false); assert.equal(providerSignal.aborted, false, 'Transport/metadata cancellation is not provider deletion cancellation.');
        proceed.resolve(); const wire = await within(pending, 'HTTP owner and request drain'); await within(closing, 'channel operation drain');
        assert.deepEqual(wire, abortRequest ? { aborted: true } : { status: 204 });
        assert.deepEqual(fixture.calls.map(value => value.kind), ['canDelete', 'delete', 'external', 'persist', 'event']);
        assert.deepEqual(await fixture.state(), { source: true, internalMetadata: false, externalMetadata: false, row: false, cached: false });
        assert.equal(closed, true); await fixture.released(); assert.deepEqual(fixture.diagnostics, []);
        report.comparisons.push({ name: 'held HTTP abort=' + abortRequest, admissions, wire, calls: fixture.calls, closed });
      } finally { proceed.resolve(); await Promise.allSettled([pending, closing]); await fixture?.close(); }
    });
    assert.deepEqual(report.hardFailures, [], stringifyNativeJson(report.hardFailures)); assert.deepEqual(report.differences, [], stringifyNativeJson(report.differences)); report.componentAcceptance = true;
  } catch (error) { failure = error; throw error; }
  finally {
    report.failure = failure ? errorRecord(failure) : null;
    const cleanup = [];
    try { await current?.finish(); report.cleanup.referenceVerified = true; } catch (error) { cleanup.push(error); }
    try { await removeOwned(output, privateRoot); report.cleanup.private = true; } catch (error) { cleanup.push(error); }
    if (cleanup.length) { report.componentAcceptance = false; report.cleanup.errors = cleanup.map(errorRecord); }
    try { await writeFile(path.join(output, 'comparison.json'), JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? JSON.rawJSON(value.toString()) : value, 2)); } catch (error) { cleanup.push(error); }
    if (cleanup.length) throw new AggregateError(failure ? [failure, ...cleanup] : cleanup, failure?.message ?? 'Channel deletion component cleanup failed.', failure ? { cause: failure } : undefined);
  }
});
