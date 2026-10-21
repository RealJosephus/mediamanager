import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setupChildrenFixture, useIdentityPathReversalControl } from '../../../metadata/children-fixture.js';
import { testFileSystem } from '../../../storage/plugin-files.js';
import { LiveTvService } from '../../../../src/library/live-tv-service.js';
import { LiveTvGuideService } from '../../../../src/library/live-tv-guide-service.js';
import { LiveTvGuideImages } from '../../../../src/library/live-tv-guide-images.js';
import { ItemDeletionService } from '../../../../src/library/item-deletion-service.js';
import { ExternalDataManager } from '../../../../src/library/external-data.js';
import { LinkedChildReferenceService } from '../../../../src/library/linked-child-reference-service.js';
import { MetadataImageAssets } from '../../../../src/metadata/image-assets.js';
import { newNativeItemEntity } from '../../../../src/library/native-item-entity.js';
import { guideChannelId } from '../../../../src/library/live-tv-guide-channel.js';
import { guideProgramId } from '../../../../src/library/live-tv-guide-program.js';
import { idKey, dateTicks, MIN_DATE } from '../../../../src/library/records.js';
import { quoteIdentifier as q } from '../../../../src/database/model.js';

export const channelType = 'MediaBrowser.Controller.LiveTv.LiveTvChannel';
export const programType = 'MediaBrowser.Controller.LiveTv.LiveTvProgram';
const futureStart = '2500-01-01T00:00:00.0000000Z', futureEnd = '2500-01-01T01:00:00.0000000Z';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const errorType = error => error?.nativeException ?? (error?.name === 'AbortError' ? 'OperationCanceledException' : error?.name);
export const sortedProgress = values => values.map(value => Math.round(value * 1e10) / 1e10).sort((left, right) => left - right);
const channelInfo = source => ({ Id: source.Id, Name: source.Id, Number: source.Id, ChannelType: 'TV',
  Tags: null, ImagePath: null, ImageUrl: null, ...source });
const programInfo = source => ({ Id: source.Id, Name: source.Id, ShowId: null, SeriesId: null,
  StartDate: futureStart, EndDate: futureEnd, Audio: null, CommunityRating: null, EpisodeTitle: null,
  IsSeries: false, IsLive: false, IsPremiere: false, IsNews: false, IsSports: false, IsKids: false, IsRepeat: false, IsMovie: false,
  IsHD: null, Genres: [], OfficialRating: null, Overview: null, ProductionYear: null, OriginalAirDate: null,
  EpisodeNumber: null, SeasonNumber: null, ImagePath: null, ImageUrl: null, ThumbImageUrl: null, LogoImageUrl: null,
  BackdropImageUrl: null, ProviderIds: {}, SeriesProviderIds: {}, Etag: 'ordinary', ...structuredClone(source) });
export function programsFor(service, external) {
  const value = service.programs?.[external] ?? {};
  return [...Array.from({ length: value.prefixCount ?? 0 }, (_, index) => programInfo({ Id: external + '-prefix-' + index })),
    ...(value.items ?? []).map(programInfo)];
}
const ticks = value => value == null ? null : String(dateTicks(value));
function project(item, parentId) {
  const isProgram = item.Type === 'LiveTvProgram';
  return { Id: idKey(item.Id), Type: item.Type, Name: item.Name, ParentId: idKey(item.ParentId) === idKey(parentId) ? '$PARENT' : idKey(item.ParentId),
    ChannelId: idKey(item.ChannelId), ExternalId: item.ExternalId ?? null,
    ServiceName: item.ServiceName ?? null, Number: item.Number ?? null, ChannelType: item.ChannelType ?? null,
    Tags: [...item.Tags], Genres: [...item.Genres], Width: item.Width, Height: item.Height,
    IsMovie: item.IsMovie, IsSeries: item.IsSeries, IsNews: item.IsNews, IsSports: item.IsSports, IsKids: item.IsKids,
    IsVirtualItem: item.IsVirtualItem, ProviderIds: { ...item.ProviderIds }, ShowId: item.ShowId ?? null,
    SeriesName: item.SeriesName ?? null, EpisodeTitle: item.EpisodeTitle ?? null,
    StartDate: isProgram ? ticks(item.StartDate) : null, EndDate: ticks(item.EndDate),
    RunTimeTicks: item.RunTimeTicks == null ? null : String(item.RunTimeTicks),
    Images: item.ImageInfos.map(image => ({ Path: image.Path, Type: image.Type })) };
}
const failure = message => Object.assign(new Error(message), { nativeException: 'InvalidOperationException' });

export async function setupScenario(t, sample) {
  const fixture = await setupChildrenFixture(t); useIdentityPathReversalControl(fixture);
  await fixture.seed({ target: 'root', items: [{ key: 'root', type: 'AggregateFolder', Id: 'a9a00000000000000000000000000002', Name: 'Root', Path: null }] });
  // Every media identity used here crosses the configured plugin mapping. The
  // image bytes are retained; future programs never initiate image downloads.
  const png = await readFile(new URL('../../../images/fixtures/http/poster.png', import.meta.url));
  await fixture.adapter.mkdir('/selection'); await fixture.adapter.write('/selection/channel.png', png, { overwrite: false });
  const assets = new MetadataImageAssets({ ...fixture, fileSystem: testFileSystem });
  assert.equal(hash(await assets.read('Z:\\ChildSelection\\channel.png')), hash(png));
  const parent = await fixture.library.getInternalLiveTvFolder(), itemCreation = fixture.library.itemCreation;
  const channels = new Map();
  for (const seed of sample.seedChannels ?? []) {
    const item = newNativeItemEntity(channelType);
    Object.assign(item, { Id: guideChannelId(seed.service, seed.id), ParentId: parent.Id, Name: seed.id, ExternalId: seed.id,
      Number: seed.id, ServiceName: seed.service, Tags: seed.Tags ?? [], ProviderIds: { ExternalServiceId: seed.service } });
    await itemCreation.createItems([item], parent, { creationIntent: 'library-save' }); channels.set(seed.service + ':' + seed.id, item);
  }
  for (const seed of sample.seedPrograms ?? []) {
    const channel = channels.get(seed.service + ':' + seed.channel), item = newNativeItemEntity(programType);
    Object.assign(item, { Id: guideProgramId(seed.id), ParentId: channel.Id, ChannelId: channel.Id, ExternalId: seed.id,
      Name: seed.Name ?? seed.id, StartDate: futureStart, EndDate: futureEnd, ProviderIds: { ProgramEtag: 'before' } });
    await itemCreation.createItems([item], channel, { creationIntent: 'library-save' });
    if (seed.duplicateGuid) {
      const row = (await fixture.database.rows('BaseItems', { where: { Id: item.Id } }))[0], text = idKey(item.Id);
      const duplicateId = [text.slice(0, 8), text.slice(8, 12), text.slice(12, 16), text.slice(16, 20), text.slice(20)].join('-').toUpperCase();
      await fixture.database.insert('BaseItems', { ...row, Id: duplicateId, Name: 'second stored spelling', SortName: 'second stored spelling' });
      for (const provider of await fixture.database.rows('BaseItemProviders', { where: { ItemId: item.Id } })) {
        await fixture.database.insert('BaseItemProviders', { ...provider, ItemId: duplicateId });
      }
    }
  }
  const liveTv = new LiveTvService({ configurationDirectoryPath: path.join(fixture.stateRoot, 'config'), fileSystem: testFileSystem });
  const configuration = await liveTv.getConfiguration(); configuration.GuideDays = sample.guideDays ?? null;
  const trace = [], windows = [], progress = [], sqlPages = [], diagnostics = [], contexts = new Set(), temporaryTables = new Set();
  let recording = false, insideMetadata = false, insideSaver = 0, cleanIndex = 0, newPrograms = [], updatedPrograms = [];
  const originalLoader = fixture.loadContext;
  const loadContext = Object.assign(async (...argumentsList) => {
    const loaded = await originalLoader(...argumentsList), dispose = loaded.dispose.bind(loaded);
    contexts.add(loaded); let released = false;
    loaded.dispose = async (...argumentsList) => { if (released) return; released = true; try { await dispose(...argumentsList); } finally { contexts.delete(loaded); } };
    return loaded;
  }, originalLoader);
  loadContext.withContext = async (reference, options, operation) => {
    const loaded = await loadContext(reference, options); try { return await operation(loaded); } finally { await loaded.dispose(); }
  };
  fixture.host.loadContext = itemCreation.loadContext = loadContext;
  const originalRegister = itemCreation.registerItem.bind(itemCreation);
  itemCreation.registerItem = item => {
    if (recording && !insideSaver && item.Type === 'LiveTvProgram') newPrograms.push(project(item, parent.Id));
    return originalRegister(item);
  };
  const originalCreate = itemCreation.createItems.bind(itemCreation);
  itemCreation.createItems = async (items, owner, options) => {
    if (recording) for (const item of items) if (item.Type === 'LiveTvChannel') {
      trace.push({ kind: 'create-channel', item: project(item, parent.Id) });
      if (sample.failChannel === item.ExternalId) throw failure('Controlled channel create failure.');
    }
    return originalCreate(items, owner, options);
  };
  const updates = fixture.host.updates, originalSavers = updates.runMetadataSavers.bind(updates);
  updates.runMetadataSavers = async (loaded, reason, options) => {
    if (recording && !insideMetadata) {
      if (loaded.item.Type === 'LiveTvProgram') updatedPrograms.push(project(loaded.item, parent.Id));
      else if (loaded.item.Type === 'LiveTvChannel') trace.push({ kind: 'update-channel', item: project(loaded.item, parent.Id) });
    }
    insideSaver++;
    try { return await originalSavers(loaded, reason, options); } finally { insideSaver--; }
  };
  const linkedChildReferences = new LinkedChildReferenceService({ ...fixture, itemCreation, updates });
  const externalData = new ExternalDataManager({ ...fixture, fileSystem: testFileSystem, dataPath: path.join(fixture.stateRoot, 'data'), metadataPath: path.join(fixture.stateRoot, 'metadata') });
  const itemDeletion = new ItemDeletionService({ ...fixture, loadContext, itemCreation, updates, linkedChildReferences, externalData, now: () => fixture.now });
  const originalDelete = itemDeletion.deleteItem.bind(itemDeletion);
  itemDeletion.deleteItem = async (item, options, owner, notify) => {
    if (recording) trace.push({ kind: 'delete', Id: idKey(item.Id), DeleteFileLocation: options.DeleteFileLocation, DeleteFromExternalProvider: options.DeleteFromExternalProvider, notify });
    return originalDelete(item, options, owner, notify);
  };
  const nativeError = error => { if (recording) {
    trace.push({ kind: 'error', type: errorType(error) });
    diagnostics.push({ type: errorType(error), message: error?.message, stack: error?.stack });
  } };
  const images = new LiveTvGuideImages({ ...fixture, loadContext, itemCreation, updates, images: fixture.host.images, parallelism: 1,
    isImageDailyLimitActive: () => { if (recording) trace.push({ kind: 'precache' }); return false; },
    runWorker: () => { throw new Error('Future fixture programs must not enter an image download worker.'); }, onError: nativeError });
  const providers = sample.services.map(service => ({ name: service.name,
    async getChannels({ signal, enableCache }) {
      signal.throwIfAborted(); assert.equal(enableCache, false); trace.push({ kind: 'channels', service: service.name });
      if (service.failChannels) throw failure('Controlled channel provider failure.');
      return service.channels.map(channelInfo);
    }, async getPrograms(channel, start, end, { signal }) {
      signal.throwIfAborted(); trace.push({ kind: 'programs', service: service.name, channel });
      const saved = await fixture.database.rows('BaseItems', { where: { Type: channelType } });
      assert.ok(service.channels.filter(value => value.Id !== sample.failChannel).every(value => saved.some(row => idKey(row.Id) === guideChannelId(service.name, value.Id))),
        'The actual SQL repository must contain every channel before the first program request.');
      windows.push({ service: service.name, channel, start, end, allChannelsSaved: true });
      return programsFor(service, channel);
    } }));
  const originalAdmit = liveTv.admitRead.bind(liveTv); let admissions = 0;
  liveTv.admitRead = (...argumentsList) => {
    const owner = originalAdmit(...argumentsList), get = owner.getConfiguration, release = owner.release; admissions++;
    let released = false;
    return { ...owner, getConfiguration: (...argumentsList) => { if (recording) trace.push({ kind: 'configuration' }); return get(...argumentsList); },
      release() { if (released) return; released = true; admissions--; return release(); } };
  };
  const guide = new LiveTvGuideService({ ...fixture, liveTv, services: () => providers, itemCreation, itemDeletion, updates, loadContext,
    now: () => new Date(),
    recordingFolders: { async reconcile() { trace.push({ kind: 'folders' }); } },
    sources: { async scanForTunerDeviceChanges({ signal }) { signal.throwIfAborted(); trace.push({ kind: 'scan' }); } },
    images: { async preCache(view, cutoff) {
      if (newPrograms.length) { trace.push({ kind: 'create-programs', items: newPrograms }); newPrograms = []; }
      if (updatedPrograms.length) { trace.push({ kind: 'update-programs', items: updatedPrograms }); updatedPrograms = []; }
      return images.preCache(view, cutoff);
    } }, metadataAssets: assets, metadataScanner: { async refreshLiveItem(item, options) {
      trace.push({ kind: 'metadata', Id: idKey(item.Id), ForceSave: options.ForceSave }); insideMetadata = true;
      try { return await fixture.host.refreshLiveItem(item, options); } finally { insideMetadata = false; }
    } }, onError: nativeError });
  const originalHostClose = fixture.host.close.bind(fixture.host);
  fixture.host.close = async () => {
    await guide.close(); await images.close(); await liveTv.close(); await originalHostClose();
  };
  t.after(async () => { await guide.close(); await images.close(); await liveTv.close(); });
  fixture.database.queryHook = async (...argumentsList) => {
    const sql = typeof argumentsList[0] === 'string' ? argumentsList[0] : argumentsList[0].text;
    if (recording && sql.startsWith('CREATE TEMP TABLE') && sql.includes('mm_guide_clean_')) trace.push({ kind: 'clean', type: ++cleanIndex % 2 ? 'LiveTvChannel' : 'LiveTvProgram' });
    const result = await fixture.database.client.query(...argumentsList);
    for (const match of sql.matchAll(/CREATE TEMP TABLE\s+"(mm_guide_[A-Za-z0-9_]+)"/gu)) temporaryTables.add(match[1]);
    for (const statement of sql.matchAll(/DROP TABLE(?: IF EXISTS)?\s+([^;]+)/gu)) {
      for (const match of statement[1].matchAll(/"(mm_guide_[A-Za-z0-9_]+)"/gu)) temporaryTables.delete(match[1]);
    }
    if (/guide-(?:capture|occurrence|clean|image-slot)-page/u.test(sql)) { assert.ok(result.rows.length <= 128); sqlPages.push(result.rows.length); }
    return result;
  };
  t.after(() => { fixture.database.queryHook = null; });
  async function assertReleased() {
    await fixture.linkedChildren.flushReleases();
    assert.equal(contexts.size, 0, 'Every admitted metadata context must be disposed.');
    assert.equal(admissions, 0, 'Every named configuration admission must be released.');
    assert.equal(temporaryTables.size, 0, 'Every observed guide TEMP table must have a successful DROP.');
    const counts = (await fixture.database.client.query(`SELECT
      (SELECT count(*) FROM ${q(fixture.linkedChildren.schemaName)}.item_states) AS states,
      (SELECT count(*) FROM ${q(fixture.linkedChildren.schemaName)}.item_cohorts) AS cohorts`)).rows[0];
    assert.equal(BigInt(counts.states), 0n); assert.equal(BigInt(counts.cohorts), 0n);
    await fixture.database.withConnection(async session => {
      const remaining = (await session.client.query("SELECT relname FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND relname LIKE 'mm_guide_%'")).rows;
      assert.deepEqual(remaining, []);
    });
    assert.equal(hash(await assets.read('Z:\\ChildSelection\\channel.png')), hash(png));
    return { metadataContexts: 0, configurationAdmissions: 0, sqlStates: 0, sqlCohorts: 0, temporaryTables: 0, mappedImageSha256: hash(png) };
  }
  async function run() {
    trace.length = windows.length = progress.length = diagnostics.length = 0; newPrograms = []; updatedPrograms = []; cleanIndex = 0;
    const cancellation = new AbortController(); if (sample.preCancelled) cancellation.abort();
    recording = true; let error = null; const before = new Date().toISOString();
    try { await guide.refresh({ signal: cancellation.signal, reportProgress: value => progress.push(value) }); }
    catch (caught) { error = errorType(caught); diagnostics.push({ type: error, message: caught?.message, stack: caught?.stack }); }
    finally { recording = false; }
    const after = new Date().toISOString(), owners = await assertReleased();
    const baseRows = [...await fixture.database.rows('BaseItems', { where: { Type: channelType } }), ...await fixture.database.rows('BaseItems', { where: { Type: programType } })];
    const items = [];
    // Hydrate each stored spelling independently: state.byId intentionally
    // normalizes GUID identity and must not collapse this diagnostic output.
    for (const row of baseRows) {
      const state = await fixture.library.load(fixture.database, null, { baseRows: [row], includeUserData: false, includeLinkGraph: false });
      try { items.push(project(state.items[0], parent.Id)); } finally { await state.dispose(); }
    }
    items.sort((left, right) => left.Id.localeCompare(right.Id) || String(left.Name).localeCompare(String(right.Name)));
    const raw = { BaseItems: baseRows, BaseItemProviders: await fixture.database.rows('BaseItemProviders'), BaseItemImageInfos: await fixture.database.rows('BaseItemImageInfos') };
    return { trace: structuredClone(trace), progress: [...progress], error, diagnostics: [...diagnostics], items, windows: [...windows], clock: { before, after }, owners, raw, sqlPages: [...sqlPages] };
  }
  return { ...fixture, liveTv, guide, images, run, assertReleased };
}

export function verifyWindows(run, guideDays) {
  const days = guideDays == null ? 7 : Math.max(1, Math.min(14, guideDays));
  for (const value of run.windows) {
    assert.equal(value.allChannelsSaved, true);
    assert.equal(dateTicks(value.end) - dateTicks(value.start), BigInt(days) * 864000000000n);
    const start = dateTicks(value.start) + 36000000000n;
    assert.ok(start >= dateTicks(run.clock.before) && start <= dateTicks(run.clock.after), 'The actual provider window starts one hour before a clock instant in this invocation.');
  }
}
