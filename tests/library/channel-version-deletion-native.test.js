import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';
import { idKey } from '../../src/library/records.js';
import { makeInput, primaryId, alternateIds } from './fixtures/channel-version-deletion/input.js';
import { hash, comparable, errorRecord, observe, openScenario, projectRows, projectLinks, removeOwned, within } from './fixtures/channel-version-deletion/scenario.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES;

test('actual ordinary Video deletion reaches external SQL versions with one admitted provider operation', {
  skip: !enabled, timeout: 900000,
}, async t => {
  const input = makeInput(), bytes = Buffer.from(JSON.stringify(input));
  const output = path.join(validationOutputRoot(), 'channel-version-deletion-' + randomUUID()), privateRoot = path.join(output, 'private'); await mkdir(privateRoot, { recursive: true });
  const inputFile = path.join(output, 'input.json'); await writeFile(inputFile, bytes);
  const report = { comparisons: [], differences: [], hardFailures: [], componentAcceptance: false, phaseAcceptance: false, releaseAcceptance: false, cleanup: {},
    boundary: { native: ['actual LibraryManager.DeleteItem recursion', 'actual ChannelManager and ISupportsDelete', 'actual repository and EF SQLite', 'real owned source/metadata bytes'],
      node: ['real PostgreSQL version links and persistence', 'typed live entities', 'PluginHost/SDK provider callbacks', 'ItemDeletionService', 'mapped metadata/source I/O', 'held shutdown owners'],
      controlled: ['external provider deletion', 'external-data marker directory', 'read-only streams and unsupported segment association'],
      excluded: ['native full HTTP host', 'production SQLite migration/import', 'catalog fetch', 'recording', 'encoding', 'live stream execution'] } };
  let current, failure;
  const compare = (name, actual, expected) => { try { assert.deepEqual(actual, expected, name); } catch (error) { report.differences.push({ name, actual, expected, error: errorRecord(error) }); } };
  const runCase = (name, operation) => t.test(name, { timeout: 180000 }, async () => { try { await operation(); } catch (error) { report.hardFailures.push({ name, error: errorRecord(error) }); throw error; } });
  try {
    current = await currentNativeReference(); report.preparation = current.preparation;
    report.sourceBindings = await current.sourceBindings(['Emby.Server.Implementations/Library/LibraryManager.cs', 'src/Jellyfin.LiveTv/Channels/ChannelManager.cs',
      'Emby.Server.Implementations/Library/MediaSourceManager.cs', 'Emby.Server.Implementations/IO/ManagedFileSystem.cs',
      'MediaBrowser.Controller/Channels/ISupportsDelete.cs', 'MediaBrowser.Controller/Entities/Video.cs', 'MediaBrowser.Controller/Entities/BaseItem.cs',
      'MediaBrowser.Controller/Library/DeleteOptions.cs', 'Jellyfin.Server.Implementations/Item/LinkedChildrenService.cs',
      'Jellyfin.Server.Implementations/Item/ItemPersistenceService.cs', 'Jellyfin.Server.Implementations/Item/BaseItemRepository.cs',
      'Jellyfin.Server.Implementations/Item/BaseItemMapper.cs']);
    const receipt = await recordOracle({ project: 'tests/library/fixtures/channel-version-deletion/Oracle.csproj', output: path.join(output, 'native'),
      args: [inputFile, '{output}/native.json', path.join(privateRoot, 'native')] }); assert.equal(receipt.passed, true);
    const nativeBytes = await readFile(path.join(output, 'native/native.json')), native = parseLosslessJson(nativeBytes.toString());
    assert.equal(native.inputSha256, hash(bytes)); assert.equal(receipt.outputs.find(value => path.basename(value.filename) === 'native.json').sha256, hash(nativeBytes));
    for (const field of ['actualLibraryManager', 'actualChannelManager', 'actualEfPersistence', 'controlledExternalProvider']) assert.equal(native[field], true, field);
    assert.equal(native.mediaExecutionStarted, false); assert.equal(native.sqliteNative.explicitResolver, true);
    for (const assembly of [...native.assemblies, native.sqliteNative]) assert.equal(hash(await readFile(assembly.filename)), assembly.sha256);
    assert.equal(native.results.length, input.cases.length);
    for (const [index, sample] of input.cases.entries()) await runCase(sample.name, async () => {
      const expected = native.results[index]; assert.equal(expected.name, sample.name); assert.equal(expected.warmIdentity, true);
      assert.equal(expected.beforeRows.filter(row => row.Type === 'PLACEHOLDER').length, 1);
      assert.equal(expected.before[0].id, primaryId); assert.equal(expected.before[0].primaryVersionId, null); assert.equal(expected.before[0].ownerId, '0'.repeat(32));
      assert.equal(projectLinks(expected.beforeLinks).filter(link => link.ParentId === primaryId).length, sample.count);
      if (sample.clearWarmVersions) { assert.equal(expected.before[0].linkedCount, 0); assert.equal(expected.before[0].localCount, 0); }
      if (sample.failure) assert.equal(expected.action.failure?.status, sample.failure, 'The exact native controlled provider failure is required.');
      else assert.equal(expected.action.failure, undefined, 'Actual native metadata/SQL deletion must succeed: ' + stringifyNativeJson(expected.action));
      const nativeProviders = expected.calls.filter(value => value.kind === 'provider');
      assert.deepEqual(nativeProviders.map(value => value.externalId), sample.survivor ? [] : alternateIds.slice(0, sample.count).map((_, at) => 'owned-external-' + at));
      assert.ok(nativeProviders.every(value => value.canBeCanceled === false));
      if (!sample.outerProvider && !sample.survivor) assert.ok(nativeProviders.length > 0, 'Fresh recursive native DeleteOptions restores the provider default.');
      if (sample.failure) {
        const prefix = sample.failAt === 1 ? ['provider', 'external', 'persist', 'event', 'provider'] : ['provider'];
        assert.deepEqual(expected.calls.map(value => value.kind), prefix);
        assert.equal(expected.after[0].row, true); assert.equal(expected.after[0].internalMetadata, true); assert.equal(expected.after[0].externalMetadata, true);
        assert.equal(expected.after[1].row, sample.failAt !== 1); assert.equal(expected.after.at(-1).row, true);
      } else {
        assert.equal(expected.after[0].row, false); assert.equal(expected.after[0].internalMetadata, false); assert.equal(expected.after[0].externalMetadata, false);
        assert.equal(expected.after[1].row, sample.survivor === true);
        assert.equal(expected.after[1].primaryVersionId, null); assert.equal(expected.after[1].ownerId, '0'.repeat(32));
      }
      const fixture = await openScenario(sample, expected, path.join(privateRoot, 'node-' + index));
      try {
        assert.equal(fixture.primary.SourceType, 'Library'); assert.ok(fixture.tracked.slice(1).every(item => item.SourceType === 'Channel'));
        assert.ok(fixture.tracked.every(item => fixture.items.getCachedItemById(item.Id) === item));
        compare(sample.name + ': initial exact live frame', await fixture.state(), expected.before);
        const actual = await observe(() => fixture.operation()); await fixture.drainEvents();
        compare(sample.name + ': actual action result', comparable(actual), comparable(expected.action));
        const calls = values => values.map(value => value.kind === 'provider' ? { kind: value.kind, externalId: value.externalId, state: value.state } : value);
        compare(sample.name + ': actual provider/metadata/SQL/event prefix', calls(fixture.calls), calls(expected.calls));
        for (const value of fixture.calls.filter(value => value.kind === 'provider')) { assert.equal(value.pluginSignal, true); assert.equal(value.signalAborted, false); }
        compare(sample.name + ': final live/cache/file frame', await fixture.state(), expected.after);
        compare(sample.name + ': final SQL rows', await fixture.rows(), projectRows(expected.rows));
        compare(sample.name + ': final SQL version relationships', await fixture.savedLinks(), projectLinks(expected.links));
        compare(sample.name + ': parent cache invalidation', fixture.parentState(), { parentChildrenInvalidated: expected.parentChildrenInvalidated, parentUserDataInvalidated: expected.parentUserDataInvalidated });
        assert.deepEqual(await readFile(fixture.primary.Path), Buffer.from([1, 3, 5, 7]));
        if (sample.survivor) assert.deepEqual(await readFile(fixture.tracked[1].Path), Buffer.from([2, 4, 6, 8]));
        await fixture.released(); assert.deepEqual(fixture.diagnostics, [], stringifyNativeJson(fixture.diagnostics.map(errorRecord)));
        report.comparisons.push({ name: sample.name, expected, actual, calls: fixture.calls, after: await fixture.state() });
      } finally { await fixture.close(); }
    });
    for (const outerProvider of [false, true]) await runCase('primary Video reserves provider dependency before metadata await: outer=' + outerProvider, async () => {
      const sample = { ...input.cases[3], outerProvider }, expected = native.results[3];
      const entered = Promise.withResolvers(), proceed = Promise.withResolvers(); let armed = false, held = false, fixture, pending, closing;
      try {
        fixture = await openScenario(sample, expected, path.join(privateRoot, 'node-held-' + outerProvider), {
          beforeContext: async reference => { if (armed && !held && idKey(reference) === primaryId) { held = true; entered.resolve(); await proceed.promise; } },
        });
        let admissions = 0; const admit = fixture.channels.admitOperation.bind(fixture.channels); fixture.channels.admitOperation = (...args) => { admissions++; return admit(...args); };
        armed = true; pending = fixture.operation(); void pending.catch(() => {});
        await within(entered.promise, 'primary metadata context after synchronous admission'); assert.equal(admissions, 1);
        let closed = false; closing = fixture.channels.close().then(() => { closed = true; }); fixture.metadata.cancel();
        await assert.rejects(fixture.channels.deleteItem(fixture.tracked[1]), { status: 503 }); assert.equal(admissions, 2); assert.equal(closed, false);
        proceed.resolve(); assert.deepEqual(await within(pending, 'recursive SQL/provider deletion'), { DeleteFileLocation: false, DeleteFromExternalProvider: outerProvider });
        await within(closing, 'provider owner drain'); await fixture.drainEvents(); assert.equal(closed, true); assert.equal(admissions, 2);
        assert.deepEqual(fixture.calls.map(value => value.kind), ['provider', 'external', 'persist', 'event', 'external', 'persist', 'event']);
        assert.ok(fixture.calls.filter(value => value.kind === 'provider').every(value => value.signalAborted === false));
        assert.ok((await fixture.state()).every(value => !value.row && !value.internalMetadata && !value.externalMetadata));
        await fixture.released(); assert.deepEqual(fixture.diagnostics, []);
        report.comparisons.push({ name: 'held primary outer=' + outerProvider, admissions, closed, calls: fixture.calls });
      } finally { proceed.resolve(); await Promise.allSettled([pending, closing]); await fixture?.close(); }
    });
    assert.deepEqual(report.hardFailures, [], stringifyNativeJson(report.hardFailures)); assert.deepEqual(report.differences, [], stringifyNativeJson(report.differences)); report.componentAcceptance = true;
  } catch (error) { failure = error; throw error; }
  finally {
    report.failure = failure ? errorRecord(failure) : null; const cleanup = [];
    try { await current?.finish(); report.cleanup.referenceVerified = true; } catch (error) { cleanup.push(error); }
    try { await removeOwned(output, privateRoot); report.cleanup.private = true; } catch (error) { cleanup.push(error); }
    if (cleanup.length) { report.componentAcceptance = false; report.cleanup.errors = cleanup.map(errorRecord); }
    try { await writeFile(path.join(output, 'comparison.json'), JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? JSON.rawJSON(value.toString()) : value, 2)); } catch (error) { cleanup.push(error); }
    if (cleanup.length) throw new AggregateError(failure ? [failure, ...cleanup] : cleanup, failure?.message ?? 'Version deletion component cleanup failed.', failure ? { cause: failure } : undefined);
  }
});
