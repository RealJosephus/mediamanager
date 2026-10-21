import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { LiveTvService } from '../../src/library/live-tv-service.js';
import { LiveTvGuideService } from '../../src/library/live-tv-guide-service.js';
import { ItemDeletionService } from '../../src/library/item-deletion-service.js';
import { ExternalDataManager } from '../../src/library/external-data.js';
import { LinkedChildReferenceService } from '../../src/library/linked-child-reference-service.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { guideChannelId } from '../../src/library/live-tv-guide-channel.js';
import { guideProgramId } from '../../src/library/live-tv-guide-program.js';
import { idKey, dateTicks } from '../../src/library/records.js';
import { quoteIdentifier as q } from '../../src/database/model.js';
import { setupChildrenFixture, useIdentityPathReversalControl } from '../metadata/children-fixture.js';
import { testFileSystem } from '../storage/plugin-files.js';

export const requiredValidationServices = ['postgres'];
const enabled = process.env.MEDIAMANAGER_TEST_POSTGRES;
const channelType = 'MediaBrowser.Controller.LiveTv.LiveTvChannel';
const programType = 'MediaBrowser.Controller.LiveTv.LiveTvProgram';
const channel = id => ({ Id: id, Name: id, Number: id, ChannelType: 'TV', Tags: [], ImagePath: null, ImageUrl: null });
const program = (id, fields = {}) => ({ Id: id, Name: id, ShowId: null, SeriesId: null,
  StartDate: '2500-01-01T00:00:00.0000000Z', EndDate: '2500-01-01T01:00:00.0000000Z', Audio: null,
  CommunityRating: null, EpisodeTitle: null, IsSeries: false, IsLive: false, IsPremiere: false, IsNews: false, IsSports: false,
  IsKids: false, IsRepeat: false, IsMovie: false, IsHD: null, Genres: [], OfficialRating: null, Overview: null,
  ProductionYear: null, OriginalAirDate: null, EpisodeNumber: null, SeasonNumber: null, ImagePath: null, ImageUrl: null,
  ThumbImageUrl: null, LogoImageUrl: null, BackdropImageUrl: null, ProviderIds: {}, SeriesProviderIds: {}, Etag: 'ordinary', ...fields });

async function setup(t) {
  const fixture = await setupChildrenFixture(t); useIdentityPathReversalControl(fixture);
  await fixture.seed({ target: 'root', items: [{ key: 'root', type: 'AggregateFolder', Id: 'a9800000000000000000000000000001', Name: 'Root', Path: null }] });
  const liveTv = new LiveTvService({ configurationDirectoryPath: path.join(fixture.stateRoot, 'config'), fileSystem: testFileSystem });
  const calls = [], errors = [], progress = [], configuration = await liveTv.getConfiguration();
  configuration.GuideDays = 99;
  const updates = fixture.host.updates, itemCreation = fixture.library.itemCreation;
  const linkedChildReferences = new LinkedChildReferenceService({ ...fixture, itemCreation, updates });
  const externalData = new ExternalDataManager({ ...fixture, fileSystem: testFileSystem,
    dataPath: path.join(fixture.stateRoot, 'data'), metadataPath: path.join(fixture.stateRoot, 'metadata') });
  const deletion = new ItemDeletionService({ ...fixture, itemCreation, updates, linkedChildReferences, externalData, now: () => fixture.now });
  const originalDelete = deletion.deleteItem.bind(deletion);
  deletion.deleteItem = async (item, options, parent, notify) => {
    calls.push({ kind: 'delete', id: idKey(item.Id), options: { ...options }, notify });
    return originalDelete(item, options, parent, notify);
  };
  let channels = [], getPrograms = async id => [program(id + '-program')];
  const provider = { name: 'Emby', async getChannels(options) {
    calls.push({ kind: 'channels', cache: options.enableCache }); options.signal.throwIfAborted(); return structuredClone(channels);
  }, async getPrograms(id, start, end, options) {
    calls.push({ kind: 'programs', id, start, end }); options.signal.throwIfAborted(); return getPrograms(id, options);
  } };
  const guide = new LiveTvGuideService({ ...fixture, liveTv, itemCreation, itemDeletion: deletion, updates,
    services: () => [provider], recordingFolders: { async reconcile() { calls.push({ kind: 'folders' }); } },
    sources: { async scanForTunerDeviceChanges({ signal }) { signal.throwIfAborted(); calls.push({ kind: 'scan' }); } },
    metadataScanner: { async refreshLiveItem(item, options) {
      calls.push({ kind: 'metadata', id: idKey(item.Id), forceSave: options.ForceSave });
      return fixture.host.refreshLiveItem(item, options);
    } },
    images: { async preCache(view, maxDate) { calls.push({ kind: 'precache', count: String(await view.count()), maxDate }); } },
    metadataAssets: new MetadataImageAssets({ ...fixture, fileSystem: testFileSystem }),
    now: () => new Date('2500-01-01T12:00:00Z'), onError: error => errors.push(error) });
  t.after(async () => { await guide.close(); await liveTv.close(); });
  return { ...fixture, liveTv, guide, calls, errors, progress, configuration,
    setChannels: value => { channels = value; }, setPrograms: value => { getPrograms = value; },
    refresh: signal => guide.refresh({ signal, reportProgress: value => progress.push(value) }) };
}

async function stale(fixture, externalId = 'stale') {
  const parent = await fixture.library.getInternalLiveTvFolder(), item = newNativeItemEntity(channelType);
  Object.assign(item, { Id: guideChannelId('Emby', externalId), Name: externalId, ParentId: parent.Id, ExternalId: externalId, ServiceName: 'Emby' });
  await fixture.library.itemCreation.createItems([item], parent, { creationIntent: 'library-save' });
  return item;
}

async function assertReleased(fixture) {
  const result = await fixture.database.client.query(`SELECT (SELECT count(*) FROM ${q(fixture.linkedChildren.schemaName)}.item_states) AS states,
    (SELECT count(*) FROM ${q(fixture.linkedChildren.schemaName)}.item_cohorts) AS views`);
  assert.equal(BigInt(result.rows[0].states), 0n); assert.equal(BigInt(result.rows[0].views), 0n);
  await fixture.database.withConnection(async session => {
    const rows = (await session.client.query("SELECT relname FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND relname LIKE 'mm_guide_%'")).rows;
    assert.deepEqual(rows, []);
  });
}

test('guide refresh materializes all channels before programs and uses real saves, channel refresh and retained deletion', { skip: !enabled, timeout: 180000 }, async t => {
  const fixture = await setup(t), removed = await stale(fixture);
  fixture.setChannels([channel('one'), channel('two')]);
  fixture.setPrograms(async id => {
    const saved = await fixture.database.rows('BaseItems', { where: { Type: channelType } });
    assert.ok(saved.some(row => idKey(row.Id) === guideChannelId('Emby', 'one')));
    assert.ok(saved.some(row => idKey(row.Id) === guideChannelId('Emby', 'two')));
    return [program(id + '-program', { IsMovie: id === 'one', IsKids: id === 'two' })];
  });
  await fixture.refresh(); assert.deepEqual(fixture.errors, []);
  assert.deepEqual(fixture.calls.slice(0, 3).map(value => value.kind), ['folders', 'scan', 'channels']);
  const programs = fixture.calls.filter(value => value.kind === 'programs'); assert.deepEqual(programs.map(value => value.id), ['one', 'two']);
  assert.ok(programs.every(value => dateTicks(value.end) - dateTicks(value.start) === 14n * 864000000000n));
  assert.deepEqual(fixture.calls.filter(value => value.kind === 'precache').map(value => value.count), ['1', '1']);
  assert.ok(fixture.calls.filter(value => value.kind === 'metadata').every(value => value.forceSave));
  const rows = await fixture.database.rows('BaseItems');
  assert.equal(rows.some(row => idKey(row.Id) === idKey(removed.Id)), false);
  assert.equal(rows.filter(row => row.Type === channelType).length, 2); assert.equal(rows.filter(row => row.Type === programType).length, 2);
  assert.ok((await fixture.library.itemCreation.getItemById(guideChannelId('Emby', 'two'))).Tags.includes('Kids'));
  assert.deepEqual(fixture.calls.find(value => value.kind === 'delete').options, { DeleteFileLocation: false, DeleteFromExternalProvider: false });
  assert.equal(fixture.calls.find(value => value.kind === 'delete').notify, false); assert.equal(fixture.progress.at(-1), 100);
  assert.equal(rows.some(row => row.Type === 'MediaBrowser.Controller.Entities.UserView'), true);
  fixture.calls.length = 0; fixture.setChannels([channel('one'), channel('two')].map(value => ({ ...value, Tags: null })));
  fixture.setPrograms(async id => [program(id + '-program')]);
  await fixture.refresh(); assert.deepEqual(fixture.errors, []);
  assert.ok((await fixture.library.itemCreation.getItemById(guideChannelId('Emby', 'two'))).Tags.includes('Kids'), 'A non-kids update does not remove the retained Kids tag.');
  await assertReleased(fixture);
});

test('a failed channel program batch keeps old global rows and never saves an earlier new program prefix', { skip: !enabled, timeout: 120000 }, async t => {
  const fixture = await setup(t), retained = await stale(fixture);
  fixture.setChannels([channel('broken'), channel('good')]);
  fixture.setPrograms(async id => id === 'broken' ? [program('must-not-save'), program('invalid', { Genres: null })] : [program('good-program')]);
  await fixture.refresh(); assert.equal(fixture.errors.length, 1); assert.equal(fixture.errors[0].nativeException, 'NullReferenceException');
  const rows = await fixture.database.rows('BaseItems');
  assert.ok(rows.some(row => idKey(row.Id) === idKey(retained.Id)));
  assert.equal(rows.some(row => idKey(row.Id) === guideProgramId('must-not-save')), false);
  assert.ok(rows.some(row => idKey(row.Id) === guideProgramId('good-program')));
  assert.deepEqual(fixture.calls.filter(value => value.kind === 'delete'), []); assert.equal(fixture.progress.at(-1), 100);
  await assertReleased(fixture);
});

test('an empty service removes stale channels and repeated empty SQL selections remain valid', { skip: !enabled, timeout: 120000 }, async t => {
  const fixture = await setup(t), removed = await stale(fixture);
  await fixture.refresh(); await fixture.refresh(); assert.deepEqual(fixture.errors, []);
  assert.equal((await fixture.database.rows('BaseItems')).some(row => idKey(row.Id) === idKey(removed.Id)), false);
  assert.deepEqual(await fixture.database.rows('BaseItems', { where: { Type: channelType } }), []);
  assert.deepEqual(await fixture.database.rows('BaseItems', { where: { Type: programType } }), []);
  assert.equal(fixture.progress.at(-1), 100); await assertReleased(fixture);
});

test('already canceled refresh preserves recording-folder coordination before the tuner scan cancellation', { skip: !enabled, timeout: 30000 }, async t => {
  const fixture = await setup(t), caller = new AbortController(); caller.abort();
  await assert.rejects(fixture.refresh(caller.signal), { name: 'AbortError' });
  assert.deepEqual(fixture.calls.map(value => value.kind), ['folders']); await assertReleased(fixture);
});

test('guide close aborts and drains late service work and releases its configuration admission before disposal', { skip: !enabled, timeout: 30000 }, async t => {
  const fixture = await setup(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  let signal, pending;
  fixture.setChannels([channel('held')]);
  fixture.setPrograms(async (_id, options) => { signal = options.signal; entered.resolve(); await release.promise; return [program('late')]; });
  try {
    pending = fixture.refresh(); const settled = Promise.allSettled([pending]);
    await Promise.race([entered.promise, pending.then(() => { throw new Error('Refresh completed before the controlled service boundary.'); })]);
    let drained = false; const closing = fixture.guide.close().then(() => { drained = true; });
    assert.equal(signal.aborted, true); await assert.rejects(fixture.refresh(), { status: 503 });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
    const configurationClosing = fixture.liveTv.close(); release.resolve();
    const [result] = await settled; assert.equal(result.status, 'rejected'); assert.equal(result.reason.name, 'AbortError');
    await closing; await configurationClosing; assert.equal(drained, true);
    assert.deepEqual(await fixture.database.rows('BaseItems', { where: { Type: programType } }), []);
    await assertReleased(fixture);
  } finally { release.resolve(); await Promise.allSettled([pending]); await fixture.guide.close(); }
});
