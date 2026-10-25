import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import pg from 'pg';
import { createRuntime } from '../../src/runtime.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { defaultConfiguration, parseConfigurationXml } from '../../src/core/configuration-xml.js';
import { getNewItemId } from '../../src/core/identity.js';
import { nativeGuid } from '../../src/users/native.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { child, readXml, textOf } from '../../src/core/xml.js';
import { defaultLibraryOptions } from '../../src/library/options.js';
import { serializeLibraryOptions } from '../../src/library/library-options-store.js';
import { readUserData } from '../../src/sessions/user-data.js';
import { persistImageMetadata } from '../../src/metadata/persistence.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';
import { parseNfoAsync } from '../../plugins/nfo/parser.js';
import { applyNfoUserDataEntry } from '../../plugins/nfo/user-data-import.js';
import { localStateStorage } from '../helpers/local-state-storage.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString, postgresTestRow } from '../database/postgres-fixture.js';
import { currentNfoConfiguration } from '../metadata/nfo-configuration-current.js';
import { namedNormalise, namedError } from '../core/named-configuration-current.js';
import { configurationJson } from '../core/fixtures/configuration/observations.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const key = 'xbmcmetadata', itemId = '20000000-0000-0000-0000-000000000001', collectionId = '20000000-0000-0000-0000-000000000100';
const folderId = '20000000-0000-0000-0000-000000000101';
const episodeId = '20000000-0000-0000-0000-000000000002';
const users = ['10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002'];
const summary = bytes => {
  const root = readXml(bytes.toString());
  return { premiered: textOf(root, 'premiered') ?? null, aired: textOf(root, 'aired') ?? null,
    playcount: textOf(root, 'playcount') ?? null, watched: textOf(root, 'watched') ?? null,
    position: child(root, 'resume') ? textOf(child(root, 'resume'), 'position') ?? null : null,
    total: child(root, 'resume') ? textOf(child(root, 'resume'), 'total') ?? null : null,
    poster: child(root, 'art') ? textOf(child(root, 'art'), 'poster') ?? null : null };
};
const phasesProjection = (rows, root) => namedNormalise(rows.map(({ bytes, ...row }) => row), root);
const dateProjection = value => value?.replace(/\.0+Z$/u, 'Z') ?? null;

test('postgres: canonical NFO HTTP and plugin management share live consumers, real user data, image files and cold state', {
  skip: !postgresTestConnectionString || !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 300000,
}, async t => {
  const capture = await currentNfoConfiguration(), reference = capture.native.consumers[0], repeat = capture.repeat.consumers[0];
  const defaultsWire = capture.native.http.find(row => row.name === 'missing-file-get-does-not-write').response;
  assert.equal(defaultsWire.status, 200);
  assert.deepEqual(capture.repeat.http.find(row => row.name === 'missing-file-get-does-not-write').response.json, defaultsWire.json);
  assert.deepEqual(phasesProjection(repeat.phases, repeat.root), phasesProjection(reference.phases, reference.root));
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'nfo-configuration-runtime-')); assertValidationOutputChild(root);
  const configurationDirectoryPath = path.join(root, 'config'), programDataPath = path.join(root, 'data'), media = path.join(root, 'media');
  const filename = path.join(configurationDirectoryPath, 'xbmcmetadata.xml'), movieFile = path.join(media, 'movie.mkv'), nfoFile = path.join(media, 'movie.nfo');
  const libraryDirectory = path.join(programDataPath, 'root', 'default', 'NFO library'), libraryOptionsFile = path.join(libraryDirectory, 'options.xml');
  const report = { schemaVersion: 1, scope: 'Formal Node runtime/HTTP, one canonical named/plugin configuration owner, actual Local NFO/image IO and PostgreSQL, bounded actual Native parser/saver/ImageSaver comparison and independent cold readers.',
    nativeCapture: capture.output, http: [], phases: [], imports: [], closures: [], errors: [], files: [], phaseAcceptance: false, releaseAcceptance: false,
    exclusions: ['whole Native server boot', 'Native EF persistence behind controlled consumer gateways', 'media execution'] };
  const failures = [], pending = new Set(), releases = new Set();
  let runtime, database, storage, origin, token, loaded, server, connectionPids, relationSchema;
  const releaseAll = () => { for (const release of releases) release(); };
  t.signal.addEventListener('abort', releaseAll);
  const onError = error => report.errors.push(namedError(error));
  const open = async () => {
    connectionPids = new Set([(await database.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid]);
    database.pool.on('connect', client => connectionPids.add(client.processID));
    runtime = await createRuntime({ database, programDataPath, configurationDirectoryPath, serverId: 'nfo-configuration-runtime',
      configuration: { ...defaultConfiguration('server'), IsStartupWizardCompleted: true, ImageSavingConvention: 'Compatible' },
      networkConfiguration: { ...defaultConfiguration('network'), InternalHttpPort: 0, LocalNetworkAddresses: ['127.0.0.1'],
        AutoDiscovery: false, EnablePublishedServerUriByRequest: true },
      vfs: storage.fileSystem.vfs, identityMap: storage.fileSystem.identityMap, onError });
    relationSchema = runtime.linkedChildren.schemaName;
    const relations = runtime.linkedChildren.relationDatabase;
    connectionPids.add((await relations.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    relations.pool.on('connect', client => connectionPids.add(client.processID));
    await runtime.start();
    origin = 'http://127.0.0.1:' + runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port;
  };
  const close = async () => {
    if (!runtime) return;
    const observation = { connectionPids: [...connectionPids], relationSchema }; report.closures.push(observation);
    await runtime.close(); assert.ok(runtime.networkHost.listeners.every(entry => !entry.server.listening));
    try { await database.rows('Users'); assert.fail('A closed runtime must release PostgreSQL reads.'); }
    catch (error) { observation.closedDatabaseFailure = namedError(error); assert.match(error.message, /closed|not open/iu); }
    const audit = new pg.Client({ connectionString: postgresTestConnectionString }); await audit.connect();
    try {
      observation.postgres = { connections: (await audit.query('SELECT pid,state FROM pg_stat_activity WHERE pid=ANY($1::integer[])', [[...connectionPids]])).rows,
        relationSchema: (await audit.query('SELECT to_regnamespace($1)::text AS name', [relationSchema])).rows[0].name };
      assert.deepEqual(observation.postgres, { connections: [], relationSchema: null });
    } finally { await audit.end(); }
    runtime = undefined;
  };
  const call = async (route, body, status = body === undefined ? 200 : 204) => {
    const observation = { index: report.http.length, route, method: body === undefined ? 'GET' : 'POST', requestBody: body === undefined ? null : configurationJson(body) };
    report.http.push(observation);
    const response = await fetch(origin + route, { method: observation.method, signal: t.signal,
      headers: { Accept: 'application/json', 'X-Emby-Token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: observation.requestBody }) });
    const bytes = Buffer.from(await response.arrayBuffer()), text = bytes.toString();
    Object.assign(observation, { status: response.status, headers: Object.fromEntries(response.headers), text, bodyBase64: bytes.toString('base64'),
      value: text && response.headers.get('content-type')?.includes('json') ? parseLosslessJson(text) : null });
    assert.equal(response.status, status, route + ': ' + text); return observation.value;
  };
  const named = (value, status) => call('/System/Configuration/' + key, value, status);
  const nfo = () => runtime.metadata.registry.plugins().find(plugin => plugin.id === 'nfo');
  const activeWork = promise => { pending.add(promise); void promise.catch(() => {}); void promise.finally(() => pending.delete(promise)).catch(() => {}); return promise; };
  const boundary = async (entered, work) => {
    const outcome = await Promise.race([entered.then(() => ({ entered: true })), work.then(() => ({ finished: true }), error => ({ error }))]);
    if (!outcome.entered) { if (outcome.error) throw outcome.error; throw new Error('The real NFO/image I/O finished before its controlled boundary.'); }
  };
  const picture = Buffer.from(capture.input.imageSource.base64, 'base64');
  try {
    await fs.mkdir(media); await fs.mkdir(configurationDirectoryPath);
    const initialXml = '<XbmcMetadataOptions><ReleaseDateFormat>yyyy-MM-dd</ReleaseDateFormat><Future xmlns="urn:nfo:runtime" a="retained">before<Child />after</Future></XbmcMetadataOptions>';
    await fs.writeFile(filename, initialXml);
    await fs.writeFile(movieFile, 'Opaque original media; no media executor is used.'); await fs.writeFile(path.join(media, 'poster.png'), picture);
    storage = await localStateStorage(root); database = await createPostgresTestDatabase(null, 'nfo_runtime');
    for (const [index, Id] of users.entries()) await database.insert('Users', postgresTestRow('Users', { Id, InternalId: BigInt(index + 1),
      Username: 'NFO ' + (index ? 'B' : 'A'), NormalizedUsername: 'NFO ' + (index ? 'B' : 'A'), RowVersion: 0n }));
    const userRootPath = path.join(programDataPath, 'root', 'default'), userRootType = 'MediaBrowser.Controller.Entities.UserRootFolder';
    const userRootId = nativeGuid(getNewItemId(userRootPath, userRootType, { programDataPath, enableCaseSensitiveItemIds: true }));
    const aggregatePath = path.join(programDataPath, 'root'), aggregateType = 'MediaBrowser.Controller.Entities.AggregateFolder';
    const aggregateId = nativeGuid(getNewItemId(aggregatePath, aggregateType, { programDataPath, enableCaseSensitiveItemIds: true }));
    await storage.fileSystem.mkdir(userRootPath, { recursive: true });
    await storage.fileSystem.mkdir(libraryDirectory, { recursive: true });
    const libraryOptionsInput = serializeLibraryOptions({ ...defaultLibraryOptions(), SaveLocalMetadata: true,
      MetadataSavers: ['Nfo'], PathInfos: [{ Path: media }] });
    if (libraryOptionsInput.failure) throw libraryOptionsInput.failure;
    await storage.fileSystem.writeFile(libraryOptionsFile, libraryOptionsInput.bytes);
    await storage.fileSystem.writeFile(path.join(libraryDirectory, 'media.mblink'), media);
    report.libraryInputs = { directory: libraryDirectory, optionsXmlBase64: libraryOptionsInput.bytes.toString('base64'), shortcut: media };
    await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: aggregateId, Type: aggregateType, Name: 'root', Path: aggregatePath, IsFolder: true,
      Data: JSON.stringify({ VirtualChildren: [], PhysicalLocationsList: [] }) }));
    await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: userRootId, Type: userRootType, Name: 'default', Path: userRootPath, IsFolder: true, Data: '{}' }));
    await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: folderId, Type: 'MediaBrowser.Controller.Entities.Folder', ParentId: aggregateId,
      Name: 'Physical NFO media', Path: media, TopParentId: folderId, IsFolder: true, Data: '{}' }));
    await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: collectionId, Type: 'MediaBrowser.Controller.Entities.CollectionFolder', Name: 'NFO library',
      ParentId: userRootId, Path: libraryDirectory, IsFolder: true, Data: JSON.stringify({ PhysicalFolderIds: [folderId], PhysicalLocationsList: [media] }) }));
    await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: itemId, Type: 'MediaBrowser.Controller.Entities.Movies.Movie', ParentId: folderId, TopParentId: folderId, MediaType: 'Video',
      Name: 'Current NFO', Path: movieFile, PremiereDate: '2024-02-29T00:00:00.0000000Z', RunTimeTicks: 900000000n,
      DateCreated: '2025-01-02T03:04:05.0000000Z', DateLastRefreshed: '2026-10-25T00:00:00.0000000Z', Data: '{}' }));
    await database.insert('BaseItemImageInfos', { Id: '20000000-0000-0000-0000-000000000003', ItemId: itemId,
      ImageType: 0, Path: path.join(media, 'poster.png'), Width: 0, Height: 0, DateModified: '2025-01-02T03:04:05.0000000Z', Blurhash: null });
    const episodeFile = path.join(media, 'episode.mkv'); await storage.fileSystem.writeFile(episodeFile, 'Opaque episode identity; no media executor is used.');
    await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: episodeId, Type: 'MediaBrowser.Controller.Entities.TV.Episode', ParentId: folderId,
      TopParentId: folderId, MediaType: 'Video', Name: 'Episode', Path: episodeFile, PremiereDate: '2024-02-29T00:00:00.0000000Z',
      DateCreated: '2025-01-02T03:04:05.0000000Z', DateLastRefreshed: '2026-10-25T00:00:00.0000000Z', Data: '{}' }));
    await open(); token = (await runtime.apiKeys.create('NFO canonical owner')).AccessToken;
    assert.equal(await fs.readFile(filename, 'utf8'), initialXml, 'Startup reads the named document without rewriting it.');
    const configuredLibrary = (await call('/Library/VirtualFolders')).find(folder => folder.ItemId === collectionId.replaceAll('-', ''));
    report.libraryInputs.current = configuredLibrary;
    assert.equal(configuredLibrary.LibraryOptions.SaveLocalMetadata, true);
    assert.deepEqual(configuredLibrary.LibraryOptions.MetadataSavers, ['Nfo']);
    assert.deepEqual(configuredLibrary.Locations, [media]);
    assert.deepEqual(await fs.readFile(libraryOptionsFile), libraryOptionsInput.bytes);
    loaded = await runtime.metadata.loadContext(itemId);
    assert.equal(loaded.saveLocalMetadataEnabled, true);
    for (const [index, user] of users.entries()) await runtime.userData.mutate(user, loaded.item, data => Object.assign(data, {
      PlayCount: index ? 9 : 3, PlaybackPositionTicks: index ? 340000000n : 120000000n, IsFavorite: index === 1, Played: false,
    }), 'UpdateUserData');
    const scenario = capture.input.consumers[0];
    const first = { ...defaultConfiguration(key), ...scenario.before }, after = { ...defaultConfiguration(key), ...scenario.after };
    await named(first); const old = runtime.namedConfiguration.getCurrentConfiguration(key);
    const savePhase = async name => {
      const plugin = nfo(), saver = plugin.providers.find(provider => provider.id === 'MovieNfoSaver');
      const enabledForImageUpdate = await saver.isEnabledFor(loaded.item, ItemUpdateType.ImageUpdate, loaded.context);
      await plugin.save(loaded.item, loaded.context);
      const bytes = await fs.readFile(nfoFile);
      const row = { name, enabledForImageUpdate, configuration: await named(), nfo: summary(bytes), bytes: bytes.toString('base64') };
      report.phases.push(row); return row;
    };
    await savePhase('before');
    let incoming;
    const retain = value => { if (value.key === key) incoming = value.configuration; };
    runtime.namedConfiguration.on('updating', retain);
    await named(after); runtime.namedConfiguration.off('updating', retain); await savePhase('after');
    incoming.ReleaseDateFormat = 'yyyy/MM/dd';
    runtime.namedConfiguration.getCurrentConfiguration(key).SaveImagePathsInNfo = true;
    old.ReleaseDateFormat = 'old only'; old.UserId = null;
    await savePhase('late-incoming-and-current-reverse');
    assert.equal(incoming.SaveImagePathsInNfo, true);
    const episode = await runtime.metadata.loadContext(episodeId);
    try {
      for (const [index, user] of users.entries()) await runtime.userData.mutate(user, episode.item, data => Object.assign(data, {
        PlayCount: index ? 9 : 3, PlaybackPositionTicks: index ? 340000000n : 120000000n, IsFavorite: index === 1, Played: false,
      }), 'UpdateUserData');
      await nfo().save(episode.item, episode.context);
      const bytes = await fs.readFile(path.join(media, 'episode.nfo'));
      report.phases.push({ name: 'episode-current-format', nfo: summary(bytes), bytes: bytes.toString('base64') });
    } finally { await episode.dispose(); }
    assert.deepEqual(phasesProjection(report.phases, root), phasesProjection(reference.phases, reference.root));
    await runtime.namedConfiguration.saveConfiguration(key, incoming);
    const liveXml = await fs.readFile(filename); report.liveXmlBase64 = liveXml.toString('base64');
    assert.match(liveXml.toString(), /urn:nfo:runtime/u); assert.match(liveXml.toString(), /before<Child\s*\/>after/u);

    // Keep the same admitted provider and real Local read active across management save.
    const heldXml = Buffer.from('<movie><title>Held NFO</title><premiered>29/02/2024</premiered></movie>');
    await storage.fileSystem.writeFile(nfoFile, heldXml);
    const vfs = storage.fileSystem.vfs, originalRead = vfs.openRead.bind(vfs), entered = Promise.withResolvers(), release = Promise.withResolvers();
    releases.add(release.resolve); let holding = true;
    vfs.openRead = async (location, options) => {
      const handle = await originalRead(location, options);
      if (!holding || location !== loaded.context.accessPath.replace(/\.[^.]+$/u, '.nfo')) return handle;
      holding = false;
      return { ...handle, stream: (async function* () { for await (const bytes of handle.stream) { entered.resolve(); await release.promise; yield bytes; } })(), close: () => handle.close() };
    };
    const reading = activeWork(nfo().getMetadata(loaded.item, loaded.context));
    try {
      await boundary(entered.promise, reading);
      const managed = await call('/Plugins/nfo/Configuration', { ...after, EnableExtraThumbsDuplication: false }, 200);
      assert.equal(managed.configuration.ReleaseDateFormat, after.ReleaseDateFormat);
      assert.deepEqual(await named(), { ...after, EnableExtraThumbsDuplication: false });
      release.resolve(); const result = await reading; report.retainedRead = result;
      assert.equal(result.Item.Name, 'Held NFO'); assert.equal(dateProjection(result.Item.PremiereDate), '2024-02-29T00:00:00Z');
    } finally { release.resolve(); releases.delete(release.resolve); await Promise.allSettled([reading]); vfs.openRead = originalRead; }

    await named(first);
    const importBytes = Buffer.from(reference.inputBase64, 'base64'); await storage.fileSystem.writeFile(path.join(media, 'import.nfo'), importBytes);
    const parserItem = { ...loaded.item, PremiereDate: null, ProductionYear: null };
    await parseNfoAsync(importBytes.toString(), { type: 'Movie', item: parserItem,
      getConfiguration: () => runtime.namedConfiguration.getCurrentConfiguration(key), onUserDataImport: async entry => {
        await applyNfoUserDataEntry(entry, { getConfiguration: () => runtime.namedConfiguration.getCurrentConfiguration(key), store: runtime.store, userData: runtime.userData });
        const selected = entry.field === 'PlayCount' ? users[0] : users[1];
        const data = await runtime.store.run(db => readUserData(db, selected, parserItem));
        report.imports.push({ userId: selected, PlayCount: data.PlayCount, Played: data.Played, PlaybackPositionTicks: Number(data.PlaybackPositionTicks) });
        if (entry.field === 'PlayCount') await named(after);
      } });
    report.parsed = { premiereDate: parserItem.PremiereDate, ProductionYear: parserItem.ProductionYear };
    assert.deepEqual(report.imports, reference.imports);
    assert.equal(dateProjection(report.parsed.premiereDate), dateProjection(reference.parsed.premiereDate));
    assert.equal(report.parsed.ProductionYear, reference.parsed.ProductionYear);
    report.userValues = [];
    for (const user of users) { const data = await runtime.store.run(db => readUserData(db, user, parserItem));
      report.userValues.push({ userId: user, PlayCount: data.PlayCount, Played: data.Played, PlaybackPositionTicks: Number(data.PlaybackPositionTicks) }); }
    assert.deepEqual(report.userValues, reference.users);

    // Download completes before ImageSaver selects paths; each selected target then remains fixed.
    const downloaded = Promise.withResolvers(), deliver = Promise.withResolvers(), written = Promise.withResolvers(), finishWrite = Promise.withResolvers();
    releases.add(deliver.resolve); releases.add(finishWrite.resolve);
    server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': picture.length }); response.flushHeaders();
      downloaded.resolve(); void deliver.promise.then(() => { if (!response.destroyed) response.end(picture); }); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    await named({ ...after, EnableExtraThumbsDuplication: false });
    const imageVfs = storage.fileSystem.vfs, originalWrite = imageVfs.write;
    const heldTarget = storage.fileSystem.accessPath(path.join(media, 'extrafanart', 'fanart1.png')); let heldWrite = false;
    imageVfs.write = async (target, ...arguments_) => {
      const result = await originalWrite.call(imageVfs, target, ...arguments_);
      if (!heldWrite && target === heldTarget) {
        heldWrite = true; report.imageWriteBarrier = { target, value: result }; written.resolve(); await finishWrite.promise;
      }
      return result;
    };
    const saving = activeWork(runtime.metadata.images.saveRemote(loaded, loaded.context.images,
      { Type: 'Backdrop', Url: 'http://127.0.0.1:' + server.address().port + '/original.png' }, { signal: t.signal, index: 1 }));
    try {
      await boundary(downloaded.promise, saving); await named({ ...after, EnableExtraThumbsDuplication: true }); deliver.resolve();
      await boundary(written.promise, saving); await named(defaultConfiguration(key)); finishWrite.resolve();
      report.savedImages = await saving;
    } finally { deliver.resolve(); finishWrite.resolve(); releases.delete(deliver.resolve); releases.delete(finishWrite.resolve);
      await Promise.allSettled([saving]); imageVfs.write = originalWrite; }
    await persistImageMetadata(runtime.store, loaded, loaded.context.images);
    for (const relative of ['media/extrafanart/fanart1.png', 'media/extrathumbs/thumb1.png']) {
      const bytes = await storage.fileSystem.readFile(path.join(root, relative)); assert.deepEqual(bytes, picture);
      report.files.push({ path: relative, bytes: bytes.toString('base64') });
    }
    assert.deepEqual(report.files, reference.imageFiles);
    report.imageRows = await database.rows('BaseItemImageInfos', { where: { ItemId: itemId } });
    assert.ok(report.imageRows.some(row => row.Path === path.join(media, 'extrafanart', 'fanart1.png') && row.ImageType === 2));
    assert.deepEqual(await named(), defaultsWire.json);
    assert.deepEqual(runtime.namedConfiguration.getCurrentConfiguration(key), reference.configuration);

    const state = JSON.parse(await fs.readFile(path.join(runtime.plugins.directory, 'state.json'), 'utf8'));
    report.pluginState = state.plugins.nfo;
    await runtime.plugins.setEnabled('nfo', false); assert.deepEqual(await named(), defaultsWire.json);
    assert.deepEqual(runtime.namedConfiguration.getCurrentConfiguration(key), reference.configuration);
    await call('/Plugins/nfo/Configuration', { ReleaseDateFormat: 'dd/MM/yyyy', UserId: users[1], SaveImagePathsInNfo: false }, 200);
    const final = await named(); await runtime.plugins.setEnabled('nfo', true);
    await nfo().save(loaded.item, loaded.context); const finalNfo = await fs.readFile(nfoFile); report.finalNfoBase64 = finalNfo.toString('base64');
    assert.equal(summary(finalNfo).premiered, '29/02/2024'); assert.equal(summary(finalNfo).playcount, '9'); assert.equal(summary(finalNfo).position, '34');
    const originalMedia = await storage.fileSystem.readFile(movieFile); assert.equal(originalMedia.toString(), 'Opaque original media; no media executor is used.');
    const userRows = await database.rows('UserData', { where: { ItemId: itemId } }); report.userRows = userRows;
    await loaded.dispose(); loaded = undefined;
    // The real saver host owns its admitted work until after named IO closes.
    const lazyEntered = Promise.withResolvers(), lazyRelease = Promise.withResolvers(), configEntered = Promise.withResolvers(), configRelease = Promise.withResolvers();
    releases.add(lazyRelease.resolve); releases.add(configRelease.resolve);
    const loadForSaver = runtime.metadata.saver.loadContext;
    runtime.metadata.saver.loadContext = async (...args) => {
      const value = await loadForSaver(...args), read = value.context.getUserData;
      value.context.getUserData = async (...values) => { lazyEntered.resolve(); await lazyRelease.promise;
        report.closeCurrent = structuredClone(runtime.namedConfiguration.getCurrentConfiguration(key));
        return read(...values); };
      return value;
    };
    const lateSave = activeWork(runtime.metadata.saver.save({ Id: itemId }, 'MetadataDownload', ['Nfo']));
    await boundary(lazyEntered.promise, lateSave);
    const originalFs = runtime.namedConfiguration.fileSystem; let captureWrite = true;
    runtime.namedConfiguration.fileSystem = { ...originalFs, async open(name, flags, ...args) {
      const file = await originalFs.open(name, flags, ...args);
      return { write: async (...values) => { const result = await file.write(...values);
        if (captureWrite && name === filename) { captureWrite = false; configEntered.resolve(); await configRelease.promise; }
        return result; }, close: () => file.close() };
    } };
    const finalPost = activeWork(call('/Plugins/nfo/Configuration', final, 200));
    await boundary(configEntered.promise, finalPost);
    report.closingWritePrefixBase64 = (await fs.readFile(filename)).toString('base64');
    const closedNamed = Promise.withResolvers(), namedOwner = runtime.namedConfiguration, finishNamed = namedOwner.close.bind(namedOwner);
    namedOwner.close = async () => { await finishNamed(); closedNamed.resolve(); };
    const schema = database.schemaName, closing = activeWork(close());
    configRelease.resolve(); await finalPost;
    await boundary(closedNamed.promise, closing);
    try { await namedOwner.saveConfiguration(key, defaultConfiguration(key)); assert.fail('Named persistence accepted new IO after close.'); }
    catch (error) { report.closedNamedFailure = namedError(error); assert.equal(error.code, 'closed'); assert.equal(error.status, 503); }
    lazyRelease.resolve(); report.closingSaver = await lateSave;
    await closing; releases.delete(lazyRelease.resolve); releases.delete(configRelease.resolve);
    assert.deepEqual(report.closeCurrent, final);
    assert.ok(report.closingSaver.some(outcome => outcome.saver === 'MovieNfoSaver' && outcome.result && !outcome.error));
    assert.deepEqual(await fs.readFile(nfoFile), finalNfo);
    report.coldNative = await capture.consume([{ name: 'runtime-canonical-nfo', root: key, filename }], 'runtime-node-native-cold');
    assert.deepEqual(report.coldNative.native.consumed[0].disk.value, final);
    database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema }); await open();
    const coldLibrary = (await call('/Library/VirtualFolders')).find(folder => folder.ItemId === collectionId.replaceAll('-', ''));
    report.libraryInputs.cold = coldLibrary;
    assert.equal(coldLibrary.LibraryOptions.SaveLocalMetadata, true);
    assert.deepEqual(coldLibrary.LibraryOptions.MetadataSavers, ['Nfo']);
    assert.deepEqual(coldLibrary.Locations, [media]);
    assert.deepEqual(await fs.readFile(libraryOptionsFile), libraryOptionsInput.bytes);
    assert.deepEqual(await named(), final); assert.deepEqual((await call('/Plugins/nfo/Configuration')).configuration, final);
    assert.deepEqual(parseConfigurationXml(await fs.readFile(filename), key), final);
    assert.deepEqual(await database.rows('UserData', { where: { ItemId: itemId } }), userRows);
    assert.deepEqual(await database.rows('BaseItemImageInfos', { where: { ItemId: itemId } }), report.imageRows);
    assert.deepEqual(await fs.readFile(nfoFile), finalNfo); assert.deepEqual(report.errors, []);
  } catch (error) { failures.push(error); }
  finally {
    t.signal.removeEventListener('abort', releaseAll); releaseAll();
    for (const result of await Promise.allSettled([...pending])) if (result.status === 'rejected') failures.push(result.reason);
    try { await loaded?.dispose(); } catch (error) { failures.push(error); }
    try { await close(); } catch (error) { failures.push(error); }
    try { if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } catch (error) { failures.push(error); }
    try { await storage?.close(); } catch (error) { failures.push(error); }
    try { await dropPostgresTestDatabase(database); } catch (error) { failures.push(error); }
    try { assert.deepEqual(report.errors, []); } catch (error) { failures.push(error); }
    report.failures = failures.map(namedError);
    await fs.writeFile(path.join(root, 'comparison.json'), configurationJson(report), { flag: 'wx' });
    t.diagnostic(configurationJson({ report: path.join(root, 'comparison.json'), failures: report.failures }));
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'NFO runtime and resource cleanup failed.', { cause: failures[0] });
});
