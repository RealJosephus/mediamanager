import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { beforeSaveFileMetadata, updateFileMetadataForSave } from '../../src/metadata/file-before-save.js';
import { requiresMetadataChildren, updateMetadataFromChildren } from '../../src/metadata/children-metadata.js';
import { beforeSaveTvMetadata } from '../../src/metadata/tv-before-save.js';
import { createPresentationUniqueKey } from '../../src/library/presentation-key.js';
import { dateText, MIN_DATE } from '../../src/library/records.js';
import { nativeDate } from '../../src/sessions/user-data.js';
import { setupChildrenFixture } from './children-fixture.js';
import { createNativeItemCohort } from '../../src/library/native-item-cohort.js';
import { metadataChildSequence } from '../../src/library/metadata-child-sequence.js';

const root = new URL('./fixtures/file-before-save/', import.meta.url);
const input = JSON.parse(await readFile(new URL('input.json', root), 'utf8'));
const native = JSON.parse(await readFile(new URL('native.json', root), 'utf8'));
const expectedFor = scenario => native.results.find(result => result.name === scenario.name);
const typeOf = item => item.Type.split('.').at(-1);
const folderTypes = ['Folder', 'Series', 'Season', 'MusicAlbum', 'MusicArtist', 'PhotoAlbum', 'CollectionFolder'];
const runtimeItem = definition => ({ ProviderIds: {}, Genres: [], Studios: [], Artists: [], AlbumArtists: [], LockedFields: [],
  ...structuredClone(definition), Type: typeOf(definition), IsFolder: folderTypes.includes(typeOf(definition)), IsFileProtocol: Boolean(definition.Path) });
const project = item => ({ Name: item.Name, Path: item.Path, DateModified: dateText(item.DateModified ?? MIN_DATE),
  DateCreated: dateText(item.DateCreated ?? MIN_DATE), Size: Number(item.Size), PresentationUniqueKey: item.PresentationUniqueKey });
const fileInfo = file => ({ exists: file.Exists, kind: file.IsDirectory ? 'directory' : 'file', size: BigInt(file.Length ?? 0),
  modified: file.LastWriteTimeUtc ?? MIN_DATE, created: file.CreationTimeUtc ?? MIN_DATE });
const ioError = message => Object.assign(new Error(message), { name: 'IOException' });
const configurationFor = (scenario, calls) => Object.defineProperty({}, 'UseFileCreationTimeForDateAdded', { get() {
  const enabled = scenario.creationEnabled ?? true;
  calls.push({ phase: 'configuration', enabled }); return enabled;
} });

test('file BeforeSave recording seals actual typed services, None refreshes and ManagedFileSystem directory times', async () => {
  const provenance = JSON.parse(await readFile(new URL('provenance.json', root), 'utf8'));
  for (const [key, filename] of Object.entries({ input: 'input.json', native: 'native.json', oracle: 'Program.cs', project: 'Oracle.csproj' })) {
    assert.equal(createHash('sha256').update(await readFile(new URL(filename, root))).digest('hex'), provenance.files[key].sha256);
  }
  assert.equal(createHash('sha256').update(await readFile(new URL('../Directory.Build.props', import.meta.url))).digest('hex'), provenance.files.buildProperties.sha256);
  assert.equal(native.inputSha256, provenance.files.input.sha256);
  assert.equal(native.candidateVerified, false); assert.equal(provenance.candidateVerified, false);
  assert.equal(input.length, 70); assert.equal(native.results.length, input.length);
  assert.equal(native.managedDirectory.Exists, true); assert.equal(native.managedDirectory.IsDirectory, true);
  assert.equal(dateText(native.managedDirectory.LastWriteTimeUtc), MIN_DATE);
  assert.equal(dateText(native.managedDirectory.CreationTimeUtc), MIN_DATE);
  for (const field of ['DateCreated', 'DateModified', 'DateLastRefreshed', 'DateLastSaved']) {
    assert.equal(dateText(native.mappedNullDates[field]), MIN_DATE); assert.equal(native.savedNullDates[field], null);
  }
});

for (const scenario of input.filter(entry => entry.mode === 'beforeSave')) test(`native file BeforeSave: ${scenario.name}`, async t => {
  const expected = expectedFor(scenario), calls = [], item = runtimeItem(scenario.item);
  const loaded = { item, context: {}, metadataConfiguration: configurationFor(scenario, calls), libraryOptions: { EnableAutomaticSeriesGrouping: false },
    fileSystemMetadata: async () => { calls.push({ phase: 'file' }); if (scenario.fileError) throw ioError('Injected stat failure'); return fileInfo(scenario.file); } };
  let updateType = scenario.currentUpdateType;
  let exception = null;
  try {
    if (requiresMetadataChildren(item, scenario.full, updateType)) {
      // The actual native recorder assigns Folder.Children = []. Keep that
      // controlled empty selection in the real SQL-owned typed sequence.
      const fixture = await setupChildrenFixture(t);
      const cohort = await createNativeItemCohort({ linkedChildren: fixture.linkedChildren });
      const children = metadataChildSequence(cohort, fixture.linkedChildren, fixture.store);
      try { updateType = await updateMetadataFromChildren(item, children, scenario.full, updateType, { defaultCountry: 'US' }); }
      finally { await children.close(); }
    }
    const key = createPresentationUniqueKey(item, loaded);
    if (key !== item.PresentationUniqueKey) { item.PresentationUniqueKey = key; updateType |= 2; }
    updateType |= await beforeSaveFileMetadata(item, loaded, { invalidateExternalData: async current => {
      calls.push({ phase: 'external', cancellable: false, item: project(current) });
      if (scenario.cleanupError) throw ioError('Injected cleanup failure');
    } });
    updateType |= beforeSaveTvMetadata(item, loaded);
  } catch (error) { exception = error.name; updateType = null; }
  const expectedCalls = expected.calls.map(call => call.item ? { ...call, item: project(call.item) } : call);
  assert.equal(exception, expected.exception);
  assert.equal(updateType, expected.updateType);
  assert.deepEqual(project(item), project(expected.item));
  assert.deepEqual(calls, expectedCalls);
});

for (const dialect of ['postgres']) {
  const options = {};
  test(`${dialect}: typed BeforeSave file dates and reason flags persist against all native controls`, options, async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    for (const scenario of input.filter(entry => entry.mode === 'beforeSave')) await t.test(scenario.name, async () => {
      const definition = { ...scenario.item, Id: scenario.item.Id.toUpperCase(), key: 'target', type: typeOf(scenario.item) }; delete definition.Type;
      const Id = await fixture.seed({ target: 'target', items: [definition] }), loaded = await fixture.loadContext(Id);
      const original = loaded.snapshot, expected = expectedFor(scenario), item = loaded.item;
      loaded.libraryOptions = { ...loaded.libraryOptions, EnableAutomaticSeriesGrouping: false };
      loaded.metadataConfiguration = { UseFileCreationTimeForDateAdded: scenario.creationEnabled ?? true };
      loaded.fileSystemMetadata = async () => { if (scenario.fileError) throw ioError('Injected stat failure'); return fileInfo(scenario.file); };
      let updateType = scenario.currentUpdateType, exception = null;
      try {
        if (requiresMetadataChildren(item, scenario.full, updateType)) {
          const children = await loaded.metadataChildren(item);
          try { updateType = await updateMetadataFromChildren(item, children, scenario.full, updateType, { defaultCountry: 'US' }); }
          finally { await children.close(); }
        }
        const key = createPresentationUniqueKey(item, loaded);
        if (key !== item.PresentationUniqueKey) { item.PresentationUniqueKey = key; updateType |= 2; }
        updateType |= await beforeSaveFileMetadata(item, loaded, { invalidateExternalData: async (current, { previousDateModified }) => {
          if (scenario.cleanupError) throw ioError('Injected cleanup failure');
          return fixture.host.externalData.invalidateChangedVideo({ ...current, DateModified: previousDateModified }, current.DateModified, { expectedSnapshot: loaded.snapshot, loaded });
        } });
        updateType |= beforeSaveTvMetadata(item, loaded);
      } catch (error) { exception = error.name; updateType = null; }
      assert.equal(exception, expected.exception); assert.equal(updateType, expected.updateType);
      assert.deepEqual(project(item), project(expected.item));
      if (updateType > 1) await fixture.host.updates.update(loaded, { Item: item }, updateType);
      const row = (await fixture.database.rows('BaseItems', { where: { Id } }))[0];
      if (expected.exception || updateType === 1) assert.deepEqual(row, original);
      else assert.deepEqual(project(row), project(expected.item));
    });
  });
  test(`${dialect}: None file refresh saves, timestamps, sizes and failure retention match native service callbacks`, options, async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    fixture.host.supportedItemTypes.push('Audio');
    const originalDelete = fixture.database.delete.bind(fixture.database);
    const originalDeleteWhere = fixture.database.deleteWhere.bind(fixture.database);
    const originalUpdate = fixture.host.updates.update.bind(fixture.host.updates);
    let activeScenario, activeItem, calls, metadata;
    fixture.database.deleteWhere = async (table, where) => {
      if (table === 'KeyframeData' && activeScenario) {
        calls.push({ phase: 'external', cancellable: false, item: project(activeItem) });
        if (activeScenario.cleanupError) throw ioError('Injected cleanup failure');
      }
      return originalDeleteWhere(table, where);
    };
    fixture.host.updates.update = async (loaded, result, reason, updateOptions) => {
      calls.push({ phase: 'save', updateType: reason, item: project(result.Item) });
      return originalUpdate(loaded, result, reason, updateOptions);
    };
    fixture.host.loadContext = Object.assign(async (...args) => {
      const loaded = await fixture.loadContext(...args); activeItem = loaded.item;
      let reads = 0;
      loaded.metadataConfiguration = metadata;
      loaded.fileSystemMetadata = async (...args) => {
        assert.equal(args.length, 0, 'file metadata callbacks receive no request token');
        const first = reads++ === 0;
        calls.push({ phase: first ? 'file' : 'directory' });
        if (first && activeScenario.fileError || !first && activeScenario.directoryError) throw ioError('Injected file lookup failure');
        return fileInfo(activeScenario.file);
      };
      return loaded;
    }, fixture.loadContext);
    for (const scenario of input.filter(entry => entry.mode === 'refresh')) await t.test(scenario.name, async () => {
      activeScenario = null;
      for (const row of await fixture.database.rows('KeyframeData')) await originalDelete('KeyframeData', { ItemId: row.ItemId });
      const definition = { ...scenario.item, Id: scenario.item.Id.toUpperCase(), type: typeOf(scenario.item), key: 'target' }; delete definition.Type;
      const Id = await fixture.seed({ target: 'target', items: [definition] });
      await fixture.database.insert('KeyframeData', { ItemId: Id, TotalDuration: 100000000n, KeyframeTicks: '[0,50000000]' });
      const original = (await fixture.database.rows('BaseItems', { where: { Id } }))[0], expected = expectedFor(scenario);
      calls = []; activeScenario = scenario; metadata = configurationFor(scenario, calls);
      let result, exception = null;
      try { result = await fixture.host.refresh(Id, { MetadataRefreshMode: 'None', ImageRefreshMode: 'None', ForceSave: scenario.force }); }
      catch (error) { exception = error.name; }
      assert.equal(exception, expected.exception);
      assert.equal(result?.UpdateType ?? null, expected.updateType);
      assert.deepEqual(project(activeItem), project(expected.item));
      assert.deepEqual(calls, expected.calls.map(call => call.item ? { ...call, item: project(call.item) } : call));
      const persisted = (await fixture.database.rows('BaseItems', { where: { Id } }))[0];
      if (expected.exception) assert.deepEqual(persisted, original, 'BeforeSave failure commits no item save');
      else assert.deepEqual(project(persisted), project(expected.item));
      const pruned = expected.calls.some(call => call.phase === 'external') && !scenario.cleanupError;
      assert.equal((await fixture.database.rows('KeyframeData', { where: { ItemId: Id } })).length, pruned ? 0 : 1);
    });
    activeScenario = null;
  });
  test(`${dialect}: VFS directories use native minimum file times and retain creation dates`, options, async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const Id = await fixture.seed({ target: 'target', items: [{ key: 'target', type: 'Folder', Id: 'd9888888-8888-8888-8888-888888888888',
      Path: 'Z:\\ChildrenMetadata\\Directory', DateModified: '2026-01-01T00:00:00.0000000Z', DateCreated: '2025-01-01T00:00:00.0000000Z' }] });
    await fixture.adapter.mkdir('/aggregate'); await fixture.adapter.mkdir('/aggregate/Directory');
    const loaded = await fixture.loadContext(Id), info = await loaded.fileSystemMetadata();
    assert.equal(info.exists, true); assert.equal(info.modified, dateText(native.managedDirectory.LastWriteTimeUtc));
    assert.equal(info.created, dateText(native.managedDirectory.CreationTimeUtc));
    assert.equal(await loaded.requiresRefresh(), true);
    const refreshed = await fixture.host.refresh(Id, { MetadataRefreshMode: 'None', ImageRefreshMode: 'None' });
    assert.equal(refreshed.UpdateType, 3);
    const persisted = (await fixture.loadContext(Id)).item;
    assert.equal(persisted.DateModified, MIN_DATE); assert.equal(dateText(persisted.DateCreated), '2025-01-01T00:00:00.0000000Z');
    assert.equal((await fixture.database.rows('BaseItems', { where: { Id } }))[0].DateModified, null);
  });
  test(`${dialect}: a first Audio date save survives provider cancellation`, options, async t => {
    const fixture = await setupChildrenFixture(t, dialect); fixture.host.supportedItemTypes.push('Audio');
    const scenario = input.find(entry => entry.name === 'Audio: None first refresh');
    const definition = { ...scenario.item, Id: scenario.item.Id.toUpperCase(), type: 'Audio', key: 'target' }; delete definition.Type;
    const Id = await fixture.seed({ target: 'target', items: [definition] });
    const cancellation = new DOMException('Injected provider cancellation', 'AbortError');
    fixture.host.loadContext = Object.assign(async (...args) => {
      const loaded = await fixture.loadContext(...args); loaded.fileSystemMetadata = async () => fileInfo(scenario.file); return loaded;
    }, fixture.loadContext);
    fixture.registry.register({ id: 'cancel', name: 'Controlled cancellation', providers: [{ id: 'provider', name: 'Controlled cancellation', kind: 'custom',
      itemTypes: ['Audio'], fetch: async () => { throw cancellation; } }] });
    await assert.rejects(fixture.host.refresh(Id, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' }), error => error === cancellation);
    const persisted = (await fixture.loadContext(Id)).item;
    const firstSave = expectedFor(scenario).calls.find(call => call.phase === 'save');
    assert.deepEqual(project(persisted), project(firstSave.item));
    assert.equal(persisted.DateLastRefreshed, MIN_DATE);
    assert.equal((await fixture.database.rows('BaseItems', { where: { Id } }))[0].DateLastRefreshed, null);
  });
  test(`${dialect}: missing file metadata matches actual ManagedFileSystem extension guesses`, options, async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    for (const entry of native.managedMissing) await t.test(entry.name, async () => {
      const Id = await fixture.seed({ target: 'target', items: [{ key: 'target', type: 'Movie',
        Id: 'D9666666-6666-6666-6666-666666666666', Path: 'Z:\\ChildrenMetadata\\' + entry.name }] });
      const loaded = await fixture.loadContext(Id), info = await loaded.fileSystemMetadata();
      assert.equal(info.exists, entry.Exists); assert.equal(info.kind === 'directory', entry.IsDirectory);
      assert.equal(info.modified, dateText(entry.LastWriteTimeUtc)); assert.equal(info.created, dateText(entry.CreationTimeUtc));
      assert.equal(info.size, BigInt(entry.Length));
    });
  });
  test(`${dialect}: nullable repository dates hydrate and save against the actual native mapper`, options, async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const Id = await fixture.seed({ target: 'target', items: [{ key: 'target', type: 'Movie', Id: 'D9777777-7777-7777-7777-777777777777' }] });
    await fixture.database.update('BaseItems', { Id }, { DateCreated: null, DateModified: null, DateLastRefreshed: null, DateLastSaved: null });
    const loaded = await fixture.loadContext(Id);
    for (const field of Object.keys(native.mappedNullDates)) {
      assert.equal(loaded.item[field], dateText(native.mappedNullDates[field])); assert.equal(loaded.snapshot[field], native.savedNullDates[field]);
    }
    await fixture.host.updates.update(loaded, { Item: loaded.item }, 2);
    const row = (await fixture.database.rows('BaseItems', { where: { Id } }))[0];
    for (const field of ['DateCreated', 'DateModified', 'DateLastRefreshed']) assert.equal(row[field], native.savedNullDates[field]);
    assert.ok(row.DateLastSaved);
  });
  for (const probeChangesDate of [false, true]) test(`${dialect}: probe reload retains hook dates and keys unless it actually changes the date (${probeChangesDate})`, options, async t => {
    const fixture = await setupChildrenFixture(t, dialect), scenario = input.find(entry => entry.name === 'Movie: changed file');
    const definition = { ...scenario.item, Id: scenario.item.Id.toUpperCase(), type: 'Movie', key: 'target', PresentationUniqueKey: 'old key' }; delete definition.Type;
    const Id = await fixture.seed({ target: 'target', items: [definition] });
    const info = fileInfo(scenario.file), newProbeDate = '2026-04-05T06:07:08.0000000Z';
    fixture.host.loadContext = Object.assign(async (...args) => {
      const loaded = await fixture.loadContext(...args); loaded.fileSystemMetadata = async () => info; return loaded;
    }, fixture.loadContext);
    fixture.host.probe = { supportsMetadata: () => true, refreshMetadata: async loaded => {
      assert.equal(loaded.item.DateCreated, dateText(info.created)); assert.equal(loaded.item.PresentationUniqueKey, Id.replaceAll('-', '').toLowerCase());
      // A fresh probe entity serializes an unchanged timestamp into native SQL
      // spelling. That formatting change must not discard the earlier hook.
      await fixture.database.update('BaseItems', { Id }, { Size: 99n,
        DateCreated: nativeDate(probeChangesDate ? newProbeDate : loaded.snapshot.DateCreated) });
      return { changed: true, UpdateType: 2 };
    } };
    await fixture.host.refresh(Id, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' });
    const row = (await fixture.database.rows('BaseItems', { where: { Id } }))[0];
    assert.equal(dateText(row.DateCreated), probeChangesDate ? newProbeDate : dateText(info.created));
    assert.equal(row.PresentationUniqueKey, Id.replaceAll('-', '').toLowerCase());
  });
}

test('final file lookup failures retain metadata and do not receive the caller token', async () => {
  const item = runtimeItem(input[0].item), original = project(item), errors = [];
  await updateFileMetadataForSave(item, { context: {}, fileSystemMetadata: async (...args) => {
    assert.deepEqual(args, []); throw new Error('Injected directory failure');
  } }, { logger: { error: error => errors.push(error.message) } });
  assert.deepEqual(project(item), original); assert.deepEqual(errors, ['Injected directory failure']);
});
