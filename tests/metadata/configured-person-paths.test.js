import { defaultNfoConfiguration } from '../../plugins/nfo/configuration.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'node:http';
import { inspect } from 'node:util';
import { readFile } from 'node:fs/promises';
import { ServerConfigurationStore } from '../../src/core/server-configuration-store.js';
import { readConfigurationDocument } from '../../src/core/configuration-xml.js';
import { child, readXml, textOf } from '../../src/core/xml.js';
import { decodeNativeText } from '../../src/core/native-text.js';
import { nativePersonIdentity } from '../../src/library/identity.js';
import { createVirtualPathExpander } from '../../src/library/options.js';
import { LibraryService } from '../../src/library/library-service.js';
import { loadLiveItemContext } from '../../src/library/live-item-repository.js';
import { PeopleMetadataLifecycleHost } from '../../src/metadata/people-lifecycle.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';
import { createNfoPlugin } from '../../plugins/nfo/plugin.js';
import { MIN_DATE } from '../../src/library/records.js';
import { postgresTestRow } from '../database/postgres-fixture.js';
import { testFileSystem } from '../storage/plugin-files.js';
import { setupChildrenFixture } from './children-fixture.js';

export const requiredValidationServices = ['postgres'];
const options = { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 30000 };
const parentId = 'd9430000-0000-0000-0000-000000000001';
const parentPath = path.join('%MetadataPath%', 'media', 'movie.mkv');
const personType = 'MediaBrowser.Controller.Entities.Person';
const imageBytes = await readFile(new URL('../images/fixtures/processor/single.png', import.meta.url));
const row = (Id, Type, values = {}) => postgresTestRow('BaseItems', {
  Id, Type, Name: 'Configured paths', SortName: 'configured paths', CleanName: 'configured paths',
  Data: '{}', MediaType: 'Unknown', UnratedType: 'Other', Tags: '', Studios: '', Genres: '', ProductionLocations: '',
  DateLastRefreshed: '2026-10-04T12:00:00.0000000Z', ...values,
});

async function deadline(work) {
  let timer;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Configured Person operation did not settle.')), 15000);
    })]);
  } finally { clearTimeout(timer); }
}

function failureValue(error) {
  if (error == null || typeof error !== 'object') return error;
  return Object.fromEntries(['message', 'code', 'status', 'statusCode', 'storageCode', 'cause', 'errors', 'details']
    .filter(key => key in error).map(key => [key, key === 'errors' ? error.errors.map(failureValue)
      : key === 'cause' ? failureValue(error.cause) : error[key]]));
}

async function setup(t) {
  const fixture = await setupChildrenFixture(t);
  const roots = ['first', 'second', 'third'].map(name => path.join(fixture.stateRoot, name + '-metadata'));
  const applicationPaths = { programDataPath: fixture.stateRoot, defaultMetadataPath: roots[0], metadataPath: roots[0],
    cachePath: path.join(fixture.stateRoot, 'cache') };
  fixture.configuration.MetadataPath = roots[0];
  fixture.configuration.CachePath = applicationPaths.cachePath;
  const configurationStore = new ServerConfigurationStore({ configuration: fixture.configuration, applicationPaths,
    configurationDirectoryPath: path.join(fixture.stateRoot, 'config'), metadataFileSystem: testFileSystem });
  Object.defineProperty(fixture.configurationSource, 'configuration', { get: () => configurationStore.configuration });
  t.after(() => configurationStore.close());
  t.after(async () => { await fixture.host.images.close(); await fixture.host.images.processor.close(); });
  Object.defineProperty(fixture.library.options, 'metadataPath', { configurable: true, get: () => applicationPaths.metadataPath });
  fixture.library.options.expandPath = createVirtualPathExpander(fixture.library.options);
  await configurationStore.initialize();
  fixture.vfs.mount({ path: '/configured-media', instanceId: 'fixture', capabilities: { create: true, replace: true, delete: true } });
  const accessRoots = roots.map((_root, index) => '/configured-media/person-root-' + index);
  const mediaBytes = Buffer.from('Controlled media file; no probe provider is installed.');
  for (const [index, root] of roots.entries()) {
    await testFileSystem.mkdir(root, { recursive: true });
    fixture.identityMap.addPrefix({ identityRoot: path.join(root, 'media'), accessRoot: accessRoots[index],
      style: process.platform === 'win32' ? 'windows' : 'posix', caseSensitive: process.platform !== 'win32',
      returnAccess: 'The configured metadata root contains this controlled media identity.' });
    const directory = '/person-root-' + index;
    await fixture.adapter.mkdir(directory);
    await fixture.adapter.write(directory + '/movie.mkv', mediaBytes);
  }
  const media = await fixture.vfs.stat(accessRoots[0] + '/movie.mkv');
  await fixture.database.insert('BaseItems', row(parentId, 'MediaBrowser.Controller.Entities.Movies.Movie', {
    Name: 'Original parent', Path: parentPath, IsInMixedFolder: true, DateModified: media.modified, DateCreated: media.created,
  }));
  const errors = [], logger = { error: (error, message) => errors.push({ error, message }) };
  t.after(() => t.diagnostic(inspect({ background: errors }, { depth: null })));
  fixture.host.logger = fixture.host.updates.logger = fixture.host.images.logger = logger;
  const changeRoot = async (root, values = {}) => {
    await configurationStore.replaceConfiguration({ ...configurationStore.configuration, ...values, MetadataPath: root });
    assert.equal(readConfigurationDocument(await readFile(configurationStore.filename), 'server').value.MetadataPath, root);
  };
  return { ...fixture, get configuration() { return configurationStore.configuration; }, roots, applicationPaths, configurationStore, changeRoot, errors };
}

test('postgres: a provider resumed after configuration save creates Person artwork in the current root', options, async t => {
  const fixture = await setup(t), [first, second] = fixture.roots;
  const oldImage = path.join(first, 'library', 'retained.png');
  await testFileSystem.mkdir(path.dirname(oldImage), { recursive: true });
  await testFileSystem.writeFile(oldImage, imageBytes);
  await fixture.database.insert('BaseItemImageInfos', { Id: 'd9430000-0000-0000-0000-000000000002', ItemId: parentId,
    ImageType: 0, Path: path.join('%MetadataPath%', 'library', 'retained.png'), DateModified: MIN_DATE, Width: 1, Height: 1, Blurhash: Buffer.from('retained') });
  const loaded = await fixture.loadContext(parentId);
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'image/png' }); response.end(imageBytes); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/person.png`;
  const entered = Promise.withResolvers(), gate = Promise.withResolvers();
  fixture.registry.register({ id: 'configured-person', name: 'Configured Person', providers: [{
    id: 'configured-person-movie', name: 'Configured Person', kind: 'remote', itemTypes: ['Movie'],
    async getMetadata() {
      entered.resolve(); await gate.promise;
      return { HasMetadata: true, Item: { Type: 'Movie', Name: 'Fetched parent' }, People: [
        { Name: 'Current Actor', Type: 'Actor', Role: 'Lead', ProviderIds: { Tmdb: '42' }, ImageUrl: url },
      ] };
    },
  }] });
  const work = fixture.host.refresh(parentId, { MetadataRefreshMode: 'FullRefresh', ReplaceAllMetadata: true, ImageRefreshMode: 'None' });
  void work.catch(() => {});
  try {
    await deadline(entered.promise);
    await fixture.changeRoot(second);
    assert.equal(loaded.item.Path, path.join(first, 'media', 'movie.mkv'));
    assert.equal(loaded.context.expandPath(parentPath), loaded.item.Path);
    assert.equal(loaded.reversePath(loaded.item.Path), parentPath);
    assert.equal(loaded.context.images[0].Path, oldImage);
    const family = await loaded.loadLibraryState();
    try {
      const parent = family.byId.get(parentId.replaceAll('-', ''));
      assert.equal(parent.Path, path.join(first, 'media', 'movie.mkv'));
      assert.equal(parent.ImageInfos[0].Path, oldImage);
    } finally { await family.dispose(); }
    gate.resolve();
    const result = await deadline(work);
    assert.equal(result.Failures, 0);
    assert.equal(result.Item.Name, 'Fetched parent');
    const identity = nativePersonIdentity('Current Actor', { ...fixture.library.options, configuration: fixture.configuration });
    const person = (await fixture.database.rows('BaseItems', { where: { Id: identity.Id } }))[0];
    assert.equal(person.Path, path.join('%MetadataPath%', 'People', 'C', 'Current Actor'));
    assert.equal(person.Name, 'Current Actor');
    const [image] = await fixture.database.rows('BaseItemImageInfos', { where: { ItemId: identity.Id } });
    assert.equal(image.Path, path.join(identity.Path, 'folder.png'));
    assert.equal(image.Width, 1); assert.equal(image.Height, 1);
    assert.deepEqual(await testFileSystem.readFile(image.Path), imageBytes);
    assert.deepEqual(await testFileSystem.readFile(oldImage), imageBytes);
    await assert.rejects(testFileSystem.stat(path.join(first, 'People', 'C', 'Current Actor')), { code: 'ENOENT' });
    const [credit] = await fixture.database.rows('PeopleBaseItemMap', { where: { ItemId: parentId } });
    const [name] = await fixture.database.rows('Peoples', { where: { Id: credit.PeopleId } });
    assert.equal(name.Name, 'Current Actor'); assert.equal(credit.Role, 'Lead');
    const refreshed = await loaded.loadDraftContext(result.Item);
    try {
      await fixture.host.updates.updatePeople(refreshed, [{ Name: 'Current Actor', Type: 'Actor', Role: 'Lead',
        ProviderIds: { Tmdb: '42' }, ImageUrl: url }]);
      const [current] = refreshed.context.people;
      assert.equal(current.ProviderIds.Tmdb, '42'); assert.equal(current.ImagePath, image.Path);
      assert.equal(refreshed.item.Path, path.join(first, 'media', 'movie.mkv'));
      assert.equal(refreshed.context.images[0].Path, oldImage);
      fixture.registry.register(createNfoPlugin({ vfs: fixture.vfs, fileSystem: testFileSystem, spoolRoot: fixture.spoolRoot,
        getConfiguration: () => ({ ...defaultNfoConfiguration(), SaveImagePathsInNfo: true }) }));
      refreshed.libraryOptions.MetadataSavers = ['Nfo']; refreshed.saveLocalMetadataEnabled = true;
      const saves = await fixture.host.updates.runMetadataSavers(refreshed, ItemUpdateType.MetadataDownload);
      assert.equal(saves[0].error, undefined);
      const handle = await fixture.vfs.openRead('/configured-media/person-root-0/movie.nfo');
      let nfo;
      try { const chunks = []; for await (const chunk of handle.stream) chunks.push(Buffer.from(chunk)); nfo = readXml(decodeNativeText(Buffer.concat(chunks))); }
      finally { await handle.close(); }
      const actor = child(nfo, 'actor');
      assert.equal(textOf(actor, 'name'), 'Current Actor'); assert.equal(textOf(actor, 'role'), 'Lead');
      assert.equal(textOf(actor, 'type'), 'Actor'); assert.equal(textOf(actor, 'thumb'), image.Path);
    } finally { await refreshed.dispose(); }
    const [savedParent] = await fixture.database.rows('BaseItems', { where: { Id: parentId } });
    assert.equal(savedParent.Path, path.join(first, 'media', 'movie.mkv'));
    const coldLibrary = new LibraryService({ ...fixture.library.options, store: fixture.store, linkedChildren: fixture.linkedChildren,
      get configuration() { return fixture.configuration; } });
    try {
      const coldParent = await coldLibrary.getItemRecord(parentId);
      assert.equal(coldParent.Path, path.join(first, 'media', 'movie.mkv'));
    } finally { await coldLibrary.close(); }
  } finally { gate.resolve(); await Promise.allSettled([work]); await loaded.dispose(); }
});

test('postgres: Person repository hydration keeps its selected root across a later configuration save', options, async t => {
  const fixture = await setup(t), [first, second, third] = fixture.roots;
  const creator = fixture.library.itemCreation;
  const parent = await creator.getItemById(parentId);
  const loaded = await loadLiveItemContext(parent, { loadContext: fixture.loadContext, itemCreation: creator });
  await fixture.changeRoot(second, { EnableCaseSensitiveItemIds: false, EnableNormalizedItemByNameIds: true });
  const identity = nativePersonIdentity('Existing Actor', { ...fixture.library.options, configuration: fixture.configuration });
  await testFileSystem.mkdir(identity.Path, { recursive: true });
  const filename = path.join(identity.Path, 'folder.png');
  await testFileSystem.writeFile(filename, imageBytes);
  await fixture.database.insert('BaseItems', row(identity.Id, personType, {
    Name: 'Existing Actor', Path: path.join('%MetadataPath%', 'People', 'E', 'Existing Actor'), Data: null,
  }));
  await fixture.database.insert('BaseItemImageInfos', { Id: 'd9430000-0000-0000-0000-000000000003', ItemId: identity.Id,
    ImageType: 0, Path: path.join('%MetadataPath%', 'People', 'E', 'Existing Actor', 'folder.png'),
    DateModified: MIN_DATE, Width: 1, Height: 1, Blurhash: null });
  const entered = Promise.withResolvers(), gate = Promise.withResolvers();
  const load = fixture.library.load.bind(fixture.library);
  fixture.library.load = async (db, user, settings) => {
    if (settings.baseRows.some(row => row.Id.toLowerCase() === identity.Id.toLowerCase())) { entered.resolve(); await gate.promise; }
    return load(db, user, settings);
  };
  const lifecycle = new PeopleMetadataLifecycleHost({ store: fixture.store, loaded, updates: fixture.host.updates });
  const work = lifecycle.getPerson('Existing Actor');
  void work.catch(() => {});
  let person;
  try {
    await deadline(entered.promise);
    await fixture.changeRoot(third, { EnableCaseSensitiveItemIds: true, EnableNormalizedItemByNameIds: false });
    gate.resolve();
    person = await deadline(work);
    assert.equal(person.item.Path, identity.Path);
    assert.equal(person.context.images[0].Path, filename);
    assert.equal(person.item.ImageInfos[0].Path, filename);
    assert.deepEqual(await person.imageAssets.read(filename), imageBytes);
    person.item.Overview = 'Saved using the selected operation root';
    await lifecycle.createItems(person);
    const [saved] = await fixture.database.rows('BaseItems', { where: { Id: identity.Id } });
    assert.equal(saved.Path, identity.Path);
    assert.equal(saved.Overview, 'Saved using the selected operation root');
    const [savedImage] = await fixture.database.rows('BaseItemImageInfos', { where: { ItemId: identity.Id } });
    assert.equal(savedImage.Path, filename);
    const coldLibrary = new LibraryService({ ...fixture.library.options, store: fixture.store, linkedChildren: fixture.linkedChildren,
      get configuration() { return fixture.configuration; } });
    try {
      const coldPerson = await coldLibrary.getItemRecord(identity.Id);
      assert.equal(coldPerson.Path, identity.Path);
      assert.equal(coldPerson.ImageInfos[0].Path, filename);
      assert.deepEqual(await testFileSystem.readFile(coldPerson.ImageInfos[0].Path), imageBytes);
    } finally { await coldLibrary.close(); }
    assert.equal(loaded.item.Path, path.join(first, 'media', 'movie.mkv'));
    assert.equal(loaded.reversePath(loaded.item.Path), parentPath);
    await assert.rejects(testFileSystem.stat(path.join(third, 'People')), { code: 'ENOENT' });
  } finally {
    gate.resolve(); fixture.library.load = load;
    await Promise.allSettled([work]);
    await person?.dispose(); await loaded.dispose();
  }
});

test('postgres: a real Person directory failure after root change preserves credits and the complete storage error', options, async t => {
  const fixture = await setup(t), [first, second] = fixture.roots;
  const loaded = await fixture.loadContext(parentId);
  await fixture.changeRoot(second);
  const identity = nativePersonIdentity('Blocked Actor', { ...fixture.library.options, configuration: fixture.configuration });
  await testFileSystem.mkdir(path.dirname(identity.Path), { recursive: true });
  const blocked = Buffer.from('A file occupies the selected Person directory.');
  await testFileSystem.writeFile(identity.Path, blocked);
  let expected;
  try { await testFileSystem.mkdir(identity.Path, { recursive: true }); } catch (error) { expected = error; }
  assert.equal(expected.code, 'EEXIST');
  try {
    await fixture.host.updates.updatePeople(loaded, [{ Name: 'Blocked Actor', Type: 'Actor', Role: 'Retained credit' }]);
    assert.equal(fixture.errors[0]?.error.code, 'EEXIST');
    for (const { error } of fixture.errors) assert.deepEqual(failureValue(error), failureValue(expected));
    assert.equal((await fixture.database.rows('BaseItems', { where: { Id: identity.Id } })).length, 0);
    assert.equal((await fixture.database.rows('BaseItemImageInfos', { where: { ItemId: identity.Id } })).length, 0);
    const [credit] = await fixture.database.rows('PeopleBaseItemMap', { where: { ItemId: parentId } });
    assert.equal(credit.Role, 'Retained credit');
    assert.equal(loaded.context.people[0].Name, 'Blocked Actor');
    assert.deepEqual(await testFileSystem.readFile(identity.Path), blocked);
    await assert.rejects(testFileSystem.stat(path.join(first, 'People')), { code: 'ENOENT' });
  } finally { await loaded.dispose(); }
});

test('postgres: Person creation keeps one identity and storage root after its database lookup awaits', options, async t => {
  const fixture = await setup(t), [, second, third] = fixture.roots;
  const loaded = await fixture.loadContext(parentId);
  await fixture.changeRoot(second, { EnableCaseSensitiveItemIds: false, EnableNormalizedItemByNameIds: true });
  const identity = nativePersonIdentity('Mixed Case Actor', { ...fixture.library.options, configuration: fixture.configuration });
  const entered = Promise.withResolvers(), gate = Promise.withResolvers();
  const lookupStore = {
    run: operation => fixture.store.run(database => operation({
      rows: async (...args) => {
        const rows = await database.rows(...args);
        if (args[0] === 'BaseItems' && args[1]?.where?.Id === identity.Id) { entered.resolve(); await gate.promise; }
        return rows;
      },
    })),
    transaction: (...args) => fixture.store.transaction(...args),
  };
  const lifecycle = new PeopleMetadataLifecycleHost({ store: lookupStore, loaded, updates: fixture.host.updates });
  const work = lifecycle.createPerson('Mixed Case Actor');
  void work.catch(() => {});
  let person;
  try {
    await deadline(entered.promise);
    await fixture.changeRoot(third, { EnableCaseSensitiveItemIds: true, EnableNormalizedItemByNameIds: false });
    gate.resolve(); person = await deadline(work);
    assert.equal(person.item.Id.toLowerCase(), identity.Id.toLowerCase());
    assert.equal(person.item.Path, identity.Path);
    const filename = path.join(identity.Path, 'created.png');
    await person.imageAssets.write(filename, imageBytes);
    assert.deepEqual(await testFileSystem.readFile(filename), imageBytes);
    const [saved] = await fixture.database.rows('BaseItems', { where: { Id: identity.Id } });
    assert.equal(saved.Path, path.join('%MetadataPath%', 'People', 'M', 'Mixed Case Actor'));
    const nextIdentity = nativePersonIdentity('Mixed Case Actor', { ...fixture.library.options, configuration: fixture.configuration });
    assert.equal((await fixture.database.rows('BaseItems', { where: { Id: nextIdentity.Id } })).length, 0);
    await assert.rejects(testFileSystem.stat(path.join(third, 'People')), { code: 'ENOENT' });
  } finally { gate.resolve(); await Promise.allSettled([work]); await person?.dispose(); await loaded.dispose(); }
});
