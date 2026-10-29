import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput, filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { describeFile } from '../../tools/validation/inventory.js';
import { startProductionInstance } from '../../src/main.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { transferDatabase, exportCurrentSqlite } from '../../src/migration/database-transfer.js';
import { runNativeCompleteLibraryScan } from '../../src/migration/complete-library-verifier.js';
import { dateText } from '../../src/library/records.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { declareFileTestResource } from '../helpers/file-test-resource.js';
import { assertRemoved, completeSnapshot, databaseFilename, idKey, installStoppedExport, itemSnapshot,
  portAvailable, removeSyntheticPreparation, sha, stoppedDatabase, unusedPort } from '../helpers/library-exchange-state.js';
import { startOwnedMediaProxy } from '../helpers/library-exchange-media-proxy.js';
import { assets, configureStorage, declaredMedia, input, inputBytes, libraryOptions,
  materializePhase, observeSourceFiles, restoreEmptyInstance, saveEmptyInstance, sidecarFiles, sourceFiles } from './fixtures/owned-mixed-library-exchange/scenario.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES
  && process.env.MEDIAMANAGER_JELLYFIN_DLL;
const mediaLease = declareFileTestResource('native-media-5244', { enabled: Boolean(enabled) });
const discovery = declareFileTestResource('hdhomerun-discovery-65001', { enabled: Boolean(enabled) });
const dateFields = new Set(['DateCreated', 'DateLastMediaAdded', 'DateLastRefreshed', 'DateLastSaved', 'PremiereDate',
  'EndDate', 'StartDate', 'LastPlayedDate']);
const dtoProjection = (value, kind = 'item') => Array.isArray(value) ? value.map(item => dtoProjection(item, kind))
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if ((kind === 'item' && dateFields.has(key) || kind === 'user-data' && key === 'LastPlayedDate') && typeof item === 'string') {
      return [key, dateText(item)];
    }
    if (kind === 'item' && key === 'UserData') return [key, dtoProjection(item, 'user-data')];
    if (kind === 'item' && key === 'MediaSources') return [key, dtoProjection(item, 'source')];
    if (kind === 'result' && key === 'Items') return [key, dtoProjection(item, 'item')];
    if (kind === 'result' && ['ThemeSongsResult', 'ThemeVideosResult', 'SoundtrackSongsResult'].includes(key)) return [key, dtoProjection(item, 'result')];
    // ProviderIds, image tags, streams and other dictionaries retain their
    // complete values, even when a business key happens to name a date field.
    return [key, item];
  })) : value;
const decodedImage = async bytes => {
  const { data, info } = await sharp(bytes, { failOn: 'warning' }).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, channels: info.channels, bytes: data.length, sha256: sha(data), base64: data.toString('base64') };
};
const failureObservation = (value, seen = new Set()) => {
  try {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : { valueType: 'number', value: String(value) };
    if (typeof value !== 'object') return { valueType: typeof value, ...(typeof value === 'bigint' ? { value: value.toString() } : {}) };
    if (seen.has(value)) return { circular: true };
    seen.add(value);
    try {
      if (Array.isArray(value)) return Array.from(value, item => failureObservation(item, seen));
      const result = {}, keys = new Set(Object.getOwnPropertyNames(value));
      if (value instanceof Error) for (const key of ['name', 'code', 'status', 'statusCode', 'message', 'stack', 'cause', 'errors']) {
        if (key in value) keys.add(key);
      }
      for (const key of keys) {
        try { result[key] = failureObservation(value[key], seen); }
        catch { result[key] = { unavailable: true }; }
      }
      return result;
    } finally { seen.delete(value); }
  } catch { return { unavailable: true }; }
};

test('one owned mixed TV/music/version/part/STRM/Book/Photo graph survives cold PostgreSQL and actual Native continuation', {
  skip: !enabled, timeout: 900000,
}, async t => mediaLease.run(() => discovery.run(async () => {
  const destination = path.join(validationOutputRoot(), 'owned-mixed-library-exchange-' + randomUUID());
  const output = await createPrivateFilterOutput(destination), secrets = new Set([process.env.MEDIAMANAGER_TEST_POSTGRES]);
  output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
  await mkdir(output.root);
  const root = await realpath(output.root), instanceRoot = path.join(root, 'instance'), media = declaredMedia(root);
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`, identities = {}, bodies = new Map(), edited = new Map();
  const report = { schemaVersion: 1, inputSha256: sha(inputBytes), requests: [], scans: [], snapshots: {},
    graphs: {}, graphPrefixes: {}, nativeOwnedRelationships: {}, libraryConfigurations: [], cleanup: [], errors: [], scope: input.scope,
    jointTopologyVerified: false, completeLibraryVerified: false, fullInstanceVerified: false,
    productionScaleVerified: false, phaseAcceptance: false, releaseAcceptance: false };
  let current, native, runtime, database, returnedDatabase, sqlite, proxy, token, failed = false, failure, safeToRemove = true;
  let saveLocalMetadata = false, phase = 'prepare', postDeleteState;
  const setPhase = value => { phase = value; if (proxy) proxy.report.phase = value; };
  const definitions = [...media.directories, ...media.files.filter(file => !file.sourceOnly)];
  const selectedDefinitions = () => postDeleteState
    ? [...definitions.filter(item => !postDeleteState.families.has(item.family)), ...postDeleteState.items] : definitions;
  const itemPresent = item => item.nativePostDelete || !item.asset && !item.text || present.has(item.key);
  const relationship = row => {
    const data = JSON.parse(row.Data ?? '{}');
    return { id: idKey(row.Id), type: row.Type, path: row.Path,
      parentId: row.ParentId == null ? null : idKey(row.ParentId), ownerId: row.OwnerId == null ? null : idKey(row.OwnerId),
      primaryVersionId: row.PrimaryVersionId == null ? null : idKey(row.PrimaryVersionId), extraType: row.ExtraType,
      additionalParts: data.AdditionalParts, localAlternateVersions: data.LocalAlternateVersions,
      linkedAlternateVersions: data.LinkedAlternateVersions };
  };
  const allInitial = media.files.filter(file => file.phase === 'initial').map(file => file.key);
  const present = new Set(allInitial);
  const bind = (definition, id) => {
    assert.ok(typeof id === 'string', definition.key + ' needs an actual item identity.');
    const value = idKey(id);
    if (identities[definition.key]) assert.equal(value, identities[definition.key], definition.key + ' retains its identity.');
    else identities[definition.key] = value;
  };
  const request = async (route, { method = 'GET', body, binary = false, range, cleanup = false } = {}) => {
    if (!cleanup) t.signal.throwIfAborted();
    const itemId = /\/(?:Items|Videos|UserFavoriteItems|UserPlayedItems)\/([a-f0-9-]{32,36})(?:[/?]|$)/iu.exec(route)?.[1];
    const observed = { phase, route, method, completed: false, ...(itemId ? { itemId: idKey(itemId) } : {}),
      ...(range ? { range } : {}), ...(body === undefined ? {} : { body }) };
    report.requests.push(observed);
    try {
      const response = await fetch(origin + route, { method,
        signal: cleanup ? AbortSignal.timeout(30000) : AbortSignal.any([t.signal, AbortSignal.timeout(30000)]),
        headers: { Authorization: `MediaBrowser Token="${token}"`, Accept: binary ? '*/*' : 'application/json',
          ...(range ? { Range: range } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const bytes = Buffer.from(await response.arrayBuffer()), digest = sha(bytes);
      const result = { status: response.status, headers: Object.fromEntries(response.headers), bytes: bytes.length, sha256: digest };
      const retainBody = () => {
        const bodyFile = 'http-body-' + digest + '.json';
        if (!bodies.has(bodyFile)) bodies.set(bodyFile, bytes);
        result.bodyFile = bodyFile;
      };
      if (binary) retainBody();
      else {
        result.bodyText = bytes.toString('utf8');
        if (bytes.length) { try { result.bodyJson = JSON.parse(result.bodyText); } catch { retainBody(); } }
      }
      observed.response = result; observed.completed = true;
      return { ...result, data: bytes };
    } catch (error) { observed.error = failureObservation(error); throw error; }
  };
  const idle = async () => {
    const deadline = performance.now() + 120000;
    for (;;) {
      const response = await request('/ScheduledTasks'); assert.equal(response.status, 200);
      if (response.bodyJson.every(task => !['Running', 'Cancelling'].includes(task.State))) return response.bodyJson;
      assert.ok(performance.now() < deadline, 'Actual task owners must drain before the exchange boundary.');
      await delay(100, undefined, { signal: t.signal });
    }
  };
  const scan = async label => {
    setPhase(label);
    await idle();
    const result = await runNativeCompleteLibraryScan({ baseUrl: origin, accessToken: token, signal: t.signal,
      scanTimeoutMs: 180000, pollIntervalMs: 100 });
    const observed = await request('/ScheduledTasks/' + result.taskId); assert.equal(observed.status, 200);
    report.scans.push({ label, result, observed: observed.bodyJson }); await idle();
  };
  const stopNative = async label => {
    if (!native) return;
    const result = await native.stop(async () => (await request('/System/Shutdown', { method: 'POST', cleanup: true })).status,
      () => portAvailable(port));
    report.cleanup.push({ label, ...result }); safeToRemove &&= result.pidGone;
    if (result.pidGone) native = undefined;
    assert.ok(result.cleanShutdown && result.pidGone && result.portAvailable, label);
  };
  const stopNode = async label => {
    if (!runtime) return;
    const listeners = runtime.networkHost.listeners;
    await runtime.close(); runtime = undefined;
    assert.ok(listeners.every(listener => !listener.server.listening)); assert.equal(await portAvailable(port), true);
    report.cleanup.push({ label, runtimeClosed: true, portAvailable: true });
  };
  const startNode = async target => {
    t.signal.throwIfAborted();
    runtime = await startProductionInstance({ environment: { ...process.env, MEDIAMANAGER_INSTANCE: instanceRoot,
      MEDIAMANAGER_POSTGRES: process.env.MEDIAMANAGER_TEST_POSTGRES, MEDIAMANAGER_POSTGRES_SCHEMA: target.schemaName,
      MEDIAMANAGER_STORAGE: path.join(root, 'storage.json') }, onError: error => report.errors.push(failureObservation(error)) });
    assert.ok(runtime.networkHost.listeners.some(listener => listener.scheme === 'http' && listener.port === port)); await idle();
  };
  const withSqlite = async (filename, operation) => {
    await stoppedDatabase(filename);
    sqlite = new SqliteDatabase(filename, { readOnly: true, requireMigrationHistory: true });
    try { return await operation(sqlite); } finally { sqlite.close(); sqlite = undefined; }
  };
  const observeLibraries = async phase => {
    const response = await request('/Library/VirtualFolders'); assert.equal(response.status, 200);
    report.libraryConfigurations.push({ phase, libraries: response.bodyJson });
    for (const library of media.libraries) {
      const actual = response.bodyJson.filter(value => value.Name === library.name); assert.equal(actual.length, 1);
      assert.equal(actual[0].CollectionType ?? null, library.type);
      assert.deepEqual(actual[0].Locations, [library.filename]);
      assert.deepEqual(actual[0].LibraryOptions.PathInfos.map(info => info.Path), [library.filename]);
      for (const [key, value] of Object.entries(input.libraryOptions)) {
        if (['SaveLocalMetadata', 'MetadataSavers'].includes(key)) continue;
        assert.deepEqual(actual[0].LibraryOptions[key], value, library.key + ' ' + key);
      }
      assert.equal(actual[0].LibraryOptions.SaveLocalMetadata, saveLocalMetadata && ['mixed', 'movies', 'music'].includes(library.key));
      assert.deepEqual(actual[0].LibraryOptions.MetadataSavers, saveLocalMetadata && ['mixed', 'movies', 'music'].includes(library.key) ? ['Nfo'] : []);
    }
    return response.bodyJson;
  };
  const assertGraph = async (target, phase) => {
    const rows = await target.rows('BaseItems'), active = selectedDefinitions().filter(item => item.type && itemPresent(item));
    // Preserve the actual full values before any topology assertion can fail.
    // Successful graph comparisons below still retain their complete relation
    // order and raw native Data, including fields unknown to this fixture.
    report.graphPrefixes[phase] = { rows };
    report.graphPrefixes[phase].itemsAndRelations = await itemSnapshot(target, rows.map(row => row.Id));
    report.graphPrefixes[phase].complete = await completeSnapshot(target);
    for (const item of active) {
      if (item.nativePostDelete) {
        const row = rows.find(value => idKey(value.Id) === identities[item.key]);
        assert.ok(row, item.key + ' actual stopped Native item');
        assert.deepEqual(relationship(row), relationship(item.nativeRow), item.key + ' exact post-delete Native relationship');
        continue;
      }
      if (item.untypedAlternatePart) {
        assert.equal(rows.some(row => row.Path === item.filename), false, item.key + ' retains the actual Native untyped owned-row boundary');
        const owner = rows.find(row => row.Path === definitions.find(value => value.key === item.owner).filename);
        assert.ok(owner); assert.ok(!owner.ParentId || /^0{32}$/u.test(idKey(owner.ParentId)), item.owner + ' has no physical parent after native type coercion');
        continue;
      }
      const matches = rows.filter(row => row.Path === item.filename); assert.equal(matches.length, 1, item.key + ' actual typed row');
      const row = matches[0]; bind(item, row.Id);
      assert.equal(row.Type.split('.').at(-1), item.type, item.key);
      if (item.parent) assert.equal(idKey(row.ParentId), identities[item.parent], item.key + ' physical parent');
      if (item.owner) assert.equal(idKey(row.OwnerId), identities[item.owner], item.key + ' actual owner');
      if (item.ownedExtra) {
        const owner = rows.find(value => value.Id && row.OwnerId && idKey(value.Id) === idKey(row.OwnerId));
        assert.ok(owner, item.key + ' has an actual persisted owner');
        const declaration = definitions.find(value => value.filename === owner.Path);
        assert.equal(declaration?.family, item.family, item.key + ' owner is an actual member of its declared physical family');
        const relation = { itemId: idKey(row.Id), path: row.Path, ownerId: idKey(row.OwnerId), ownerPath: owner.Path,
          parentId: row.ParentId == null ? null : idKey(row.ParentId),
          primaryVersionId: row.PrimaryVersionId == null ? null : idKey(row.PrimaryVersionId), extraType: row.ExtraType };
        if (phase === 'native-baseline') report.nativeOwnedRelationships[item.key] = relation;
        else {
          assert.ok(report.nativeOwnedRelationships[item.key], 'The actual Native baseline supplies the owned relationship.');
          assert.deepEqual(relation, report.nativeOwnedRelationships[item.key], item.key + ' exact actual Native Path/ownership relationship');
        }
      }
      if (item.primaryVersion) assert.equal(idKey(row.PrimaryVersionId), identities[item.primaryVersion]);
      if (item.type === 'Episode') {
        assert.equal(idKey(row.SeriesId), identities.series); assert.equal(idKey(row.SeasonId), identities.season);
        assert.equal(row.IndexNumber, item.number); assert.equal(row.ParentIndexNumber, 1);
      }
      if (item.asset === 'audio' || item.asset === 'video') {
        assert.ok(BigInt(row.RunTimeTicks) > 0n, item.key + ' has actual probe duration.');
        const streams = await target.rows('MediaStreamInfos', { where: { ItemId: row.Id } });
        assert.ok(streams.some(stream => stream.StreamType === (item.asset === 'audio' ? 0 : 1)), item.key + ' actual media stream');
      }
      const data = JSON.parse(row.Data ?? '{}');
      if (item.shortcut) { assert.equal(data.IsShortcut, true); assert.equal(data.ShortcutPath, item.text.trim()); }
      const parts = active.filter(part => part.owner === item.key && part.type === 'Video');
      if (parts.length) assert.deepEqual(data.AdditionalParts, parts.map(part => part.filename));
      const versions = active.filter(version => version.primaryVersion === item.key);
      if (versions.length === 1) assert.deepEqual(data.LocalAlternateVersions, versions.map(version => version.filename));
      else if (versions.length) {
        assert.equal(data.LocalAlternateVersions.length, versions.length);
        for (const version of versions) assert.ok(data.LocalAlternateVersions.includes(version.filename));
      }
    }
    for (const item of media.files.filter(item => !item.sourceOnly && !present.has(item.key)
      && !postDeleteState?.families.has(item.family))) {
      assert.equal(rows.some(row => row.Path === item.filename), false, item.key + ' deleted/undeclared row');
      if (identities[item.key]) assertRemoved(await itemSnapshot(target, [identities[item.key]]), identities[item.key]);
    }
    if (postDeleteState) {
      const expected = postDeleteState.rows.map(relationship);
      const actual = rows.filter(row => postDeleteState.roots.some(root => row.Path === root || row.Path?.startsWith(root + path.sep))).map(relationship);
      assert.deepEqual(actual, expected, 'The complete actual Native post-delete family rows and order are retained.');
      assert.deepEqual(await itemSnapshot(target, postDeleteState.removedIds), postDeleteState.removedItems,
        'Removed identities retain the exact actual Native post-delete relation state.');
    }
    const snapshot = await itemSnapshot(target, active.filter(item => !item.untypedAlternatePart).map(item => identities[item.key]));
    report.graphs[phase] = snapshot; return snapshot;
  };
  const discover = async () => {
    const observed = { parts: {}, ownedMedia: {} };
    const response = await request('/Items?Recursive=true&Fields=Path,MediaSources,MediaStreams&IncludeItemTypes=Movie,Video,Trailer,Series,Season,Episode,MusicArtist,MusicAlbum,Audio,Book,Photo,PhotoAlbum');
    assert.equal(response.status, 200);
    const candidates = [...response.bodyJson.Items];
    for (const dto of response.bodyJson.Items) for (const source of dto.MediaSources ?? []) {
      candidates.push({ Id: source.Id, Path: source.Path });
    }
    for (const item of selectedDefinitions().filter(item => !item.nativePostDelete && !item.owner && !item.ownedExtra && itemPresent(item))) {
      const actual = candidates.filter(candidate => candidate.Path === item.filename); assert.ok(actual.length, item.key + ' public discovery');
      bind(item, actual[0].Id);
    }
    for (const item of selectedDefinitions().filter(item => !item.nativePostDelete && item.primaryVersion && present.has(item.key))) {
      if (!identities[item.key]) {
        const owner = await request('/Items/' + identities[item.primaryVersion] + '?Fields=MediaSources'); assert.equal(owner.status, 200);
        const source = owner.bodyJson.MediaSources.find(value => value.Path === item.filename); assert.ok(source, item.key + ' actual alternate source');
        bind(item, source.Id);
      }
    }
    for (const item of selectedDefinitions().filter(item => !item.nativePostDelete && item.type === 'Movie' && present.has(item.key))) {
      const children = definitions.filter(part => part.type === 'Video' && part.owner === item.key && present.has(part.key));
      if (!children.length) continue;
      const response = await request('/Videos/' + identities[item.key] + '/AdditionalParts'); assert.equal(response.status, 200);
      observed.parts[item.key] = response.bodyJson;
      for (const part of children) {
        if (part.untypedAlternatePart) {
          assert.equal(response.bodyJson.Items.some(value => value.Path === part.filename), false, part.key + ' is not a public owned item in the actual untyped branch');
          continue;
        }
        const actual = response.bodyJson.Items.filter(value => value.Path === part.filename); assert.equal(actual.length, 1); bind(part, actual[0].Id);
      }
    }
    for (const family of input.ownedFamilies.filter(family => !postDeleteState && present.has(family.primary))) {
      const trailerRelation = report.nativeOwnedRelationships[family.trailer], themeRelation = report.nativeOwnedRelationships[family.theme];
      assert.ok(trailerRelation && themeRelation, 'Owned HTTP consumers require the actual Native ownership baseline.');
      // Keep the primary's real empty responses when the actual untyped Video
      // part owns these extras. Also consume each exact owner from Native;
      // neither side may choose a convenient owner or omit the negative route.
      const owners = [...new Set([identities[family.primary], trailerRelation.ownerId, themeRelation.ownerId])];
      observed.ownedMedia[family.primary] = [];
      for (const ownerId of owners) {
        const trailers = await request('/Items/' + ownerId + '/LocalTrailers'); assert.equal(trailers.status, 200);
        const themes = await request('/Items/' + ownerId + '/ThemeMedia'); assert.equal(themes.status, 200);
        assert.deepEqual(trailers.bodyJson.map(item => idKey(item.Id)), trailerRelation.ownerId === ownerId ? [trailerRelation.itemId] : []);
        assert.deepEqual(themes.bodyJson.ThemeSongsResult.Items.map(item => idKey(item.Id)), themeRelation.ownerId === ownerId ? [themeRelation.itemId] : []);
        if (trailerRelation.ownerId === ownerId) {
          const trailer = trailers.bodyJson.find(value => value.Path === trailerRelation.path);
          assert.ok(trailer); bind(definitions.find(item => item.key === family.trailer), trailer.Id);
        }
        if (themeRelation.ownerId === ownerId) {
          const theme = themes.bodyJson.ThemeSongsResult.Items.find(value => value.Path === themeRelation.path);
          assert.ok(theme); bind(definitions.find(item => item.key === family.theme), theme.Id);
        }
        observed.ownedMedia[family.primary].push({ ownerId, trailers: dtoProjection(trailers.bodyJson), themes: dtoProjection(themes.bodyJson, 'result') });
      }
    }
    if (postDeleteState) {
      const rowFor = dto => {
        const row = postDeleteState.allRows.find(row => idKey(row.Id) === idKey(dto.Id));
        assert.ok(row, 'Every post-delete public item has a stopped actual Native row.');
        assert.equal(dto.Type, row.Type.split('.').at(-1));
        assert.equal(dto.Path, row.Path);
        return row;
      };
      const videos = postDeleteState.items.filter(item => ['Movie', 'Video', 'Trailer'].includes(item.type));
      for (const item of videos) {
        const response = await request('/Videos/' + identities[item.key] + '/AdditionalParts'); assert.equal(response.status, 200);
        for (const dto of response.bodyJson.Items) rowFor(dto);
        observed.parts[item.key] = response.bodyJson;
      }
      const owners = [...new Set([...videos.map(item => identities[item.key]), ...postDeleteState.rows
        .filter(row => row.OwnerId && postDeleteState.allRows.some(owner => idKey(owner.Id) === idKey(row.OwnerId)))
        .map(row => idKey(row.OwnerId))])];
      observed.ownedMedia.nativePostDelete = [];
      for (const ownerId of owners) {
        const trailers = await request('/Items/' + ownerId + '/LocalTrailers'); assert.equal(trailers.status, 200);
        const themes = await request('/Items/' + ownerId + '/ThemeMedia'); assert.equal(themes.status, 200);
        for (const dto of trailers.bodyJson) rowFor(dto);
        for (const value of Object.values(themes.bodyJson)) for (const dto of value?.Items ?? []) rowFor(dto);
        observed.ownedMedia.nativePostDelete.push({ ownerId, trailers: dtoProjection(trailers.bodyJson), themes: dtoProjection(themes.bodyJson, 'result') });
      }
    }
    return observed;
  };
  const observe = async phase => {
    setPhase(phase);
    await observeLibraries(phase); const discovered = await discover();
    const result = { additionalParts: Object.fromEntries(Object.entries(discovered.parts).map(([key, value]) => [key, dtoProjection(value, 'result')])),
      ownedMedia: discovered.ownedMedia };
    if (postDeleteState) {
      result.previousFamilyIdentities = {};
      for (const old of postDeleteState.previousIdentities) {
        const expected = postDeleteState.allRows.find(row => idKey(row.Id) === old.id);
        const response = await request('/Items/' + old.id);
        assert.equal(response.status, expected ? 200 : 404, old.key + ' actual post-delete old identity');
        if (expected) {
          assert.equal(idKey(response.bodyJson.Id), old.id); assert.equal(response.bodyJson.Path, expected.Path);
          assert.equal(response.bodyJson.Type, expected.Type.split('.').at(-1));
        }
        result.previousFamilyIdentities[old.key] = { id: old.id, status: response.status };
      }
    }
    for (const item of selectedDefinitions()) {
      if (!itemPresent(item)) {
        if (identities[item.key]) assert.equal((await request('/Items/' + identities[item.key])).status, 404);
        continue;
      }
      if (item.untypedAlternatePart) {
        result[item.key] = { declaredPath: item.filename, persistedOwnedItem: false,
          additionalParts: dtoProjection(discovered.parts[item.owner], 'result') };
        continue;
      }
      const detail = await request('/Items/' + identities[item.key] + '?Fields=Path,MediaSources,MediaStreams,Overview,Genres,Tags,ProviderIds');
      assert.equal(detail.status, 200, item.key); assert.equal(detail.bodyJson.Type, item.type); assert.equal(detail.bodyJson.Path, item.filename);
      assert.equal(idKey(detail.bodyJson.Id), identities[item.key]);
      if (item.name) assert.equal(detail.bodyJson.Name, item.name);
      const fields = { ...(item.overview === undefined ? {} : { Overview: item.overview }), ...edited.get(item.key) };
      for (const [field, value] of Object.entries(fields)) assert.deepEqual(detail.bodyJson[field], value, item.key + ' actual saved ' + field);
      if (item.type === 'Book') { assert.equal(detail.bodyJson.Name, ' Rich title '); assert.equal(detail.bodyJson.ProviderIds.ISBN, '978-123'); }
      const observed = { dto: dtoProjection(detail.bodyJson) };
      if (item.nativePostDelete && (item.asset || item.text) && !item.sourceFilePresent) observed.sourceFileAbsent = true;
      if ((item.asset || item.text) && (!item.nativePostDelete || item.sourceFilePresent)) {
        const original = await request('/Items/' + identities[item.key] + '/File', { binary: true });
        assert.equal(original.status, 200); assert.deepEqual(original.data, item.bytes);
        const partial = await request('/Items/' + identities[item.key] + '/File', { binary: true, range: 'bytes=1-15' });
        assert.equal(partial.status, 206); assert.deepEqual(partial.data, item.bytes.subarray(1, 16));
        assert.equal(partial.headers['content-range'], `bytes 1-15/${item.bytes.length}`);
        observed.original = { bytes: original.bytes, sha256: original.sha256 };
        if (['Book', 'Photo'].includes(item.type)) {
          const image = await request('/Items/' + identities[item.key] + '/Images/Primary?format=Png', { binary: true });
          assert.equal(image.status, 200); assert.equal(image.headers['content-type']?.split(';')[0], 'image/png');
          if (item.type === 'Book') {
            assert.equal(image.bytes, input.bookCover.bytes); assert.equal(image.sha256, input.bookCover.sha256);
            observed.image = { bytes: image.bytes, sha256: image.sha256 };
          } else {
            observed.image = await decodedImage(image.data); assert.deepEqual(observed.image, await decodedImage(assets.photo));
            assert.equal(observed.image.width, input.photoPixels.width); assert.equal(observed.image.height, input.photoPixels.height);
          }
        }
        if (item.shortcut) {
          const playback = await request('/Items/' + identities[item.key] + '/PlaybackInfo?UserId=' + current.userId); assert.equal(playback.status, 200);
          const source = playback.bodyJson.MediaSources.find(value => value.Path === item.text.trim()); assert.ok(source); assert.equal(source.Protocol, 'Http');
          const stream = await request('/Videos/' + identities[item.key] + '/stream?Static=true&MediaSourceId=' + encodeURIComponent(source.Id), { binary: true });
          assert.equal(stream.status, 200); assert.deepEqual(stream.data, media.files.find(file => file.key === item.shortcut).bytes);
          observed.shortcut = { source: dtoProjection(source, 'source'), bytes: stream.bytes, sha256: stream.sha256 };
        }
      }
      result[item.key] = observed;
    }
    return result;
  };
  const readTransferDtos = async (observation, label) => {
    const afterMediaPhase = phase, firstRequest = report.requests.length;
    setPhase(label);
    const discovered = await discover();
    const result = { ...observation,
      additionalParts: Object.fromEntries(Object.entries(discovered.parts).map(([key, value]) => [key, dtoProjection(value, 'result')])),
      ownedMedia: discovered.ownedMedia };
    for (const item of selectedDefinitions()) {
      if (observation[item.key]?.persistedOwnedItem === false) {
        result[item.key] = { ...observation[item.key], additionalParts: dtoProjection(discovered.parts[item.owner], 'result') };
      }
      if (!observation[item.key]?.dto) continue;
      const response = await request('/Items/' + identities[item.key] + '?Fields=Path,MediaSources,MediaStreams,Overview,Genres,Tags,ProviderIds');
      assert.equal(response.status, 200, item.key + ' transfer DTO readback');
      assert.equal(idKey(response.bodyJson.Id), identities[item.key]);
      assert.equal(response.bodyJson.Type, item.type); assert.equal(response.bodyJson.Path, item.filename);
      result[item.key] = { ...observation[item.key], dto: dtoProjection(response.bodyJson) };
    }
    (report.transferBoundaries ??= {})[label] = { afterMediaPhase, dtoOnly: true, firstRequest, endRequest: report.requests.length,
      sourceBindings: report.sourceBindings.filter(binding => binding.path.replaceAll('\\', '/').endsWith('/Library/MediaSourceManager.cs')
        || binding.path.replaceAll('\\', '/').endsWith('/Helpers/MediaInfoHelper.cs')) };
    return result;
  };
  const edit = async (key, fields, expected = fields) => {
    const existing = await request('/Items/' + identities[key]); assert.equal(existing.status, 200);
    assert.equal((await request('/Items/' + identities[key], { method: 'POST', body: { ...existing.bodyJson, ...fields } })).status, 204);
    edited.set(key, { ...edited.get(key), ...expected });
  };
  try {
    current = await currentNativeReference(); token = current.accessToken; output.addSecret(token); secrets.add(token);
    report.input = current.preparation;
    report.sourceBindings = await current.sourceBindings(['Jellyfin.Api/Controllers/LibraryController.cs', 'Jellyfin.Api/Controllers/UserLibraryController.cs',
      'Jellyfin.Api/Controllers/ItemUpdateController.cs',
      'Jellyfin.Api/Controllers/LibraryStructureController.cs', 'Jellyfin.Api/Controllers/VideosController.cs',
      'Jellyfin.Api/Helpers/MediaInfoHelper.cs', 'Emby.Server.Implementations/Library/MediaSourceManager.cs',
      'Emby.Server.Implementations/Library/LibraryManager.cs', 'Emby.Server.Implementations/Library/Resolvers/Movies/MovieResolver.cs',
      'MediaBrowser.Providers/MediaInfo/AudioFileProber.cs', 'MediaBrowser.Providers/MediaInfo/FFProbeVideoInfo.cs',
      'MediaBrowser.Providers/Music/AlbumMetadataService.cs', 'MediaBrowser.Controller/Entities/Video.cs', 'MediaBrowser.Controller/Entities/BaseItem.cs',
      'MediaBrowser.Providers/Books/OpenPackagingFormat/EpubProvider.cs', 'Emby.Photos/PhotoProvider.cs']);
    report.assetInputs = Object.entries(assets).map(([kind, bytes]) => ({ kind, bytes: bytes.length, sha256: sha(bytes), base64: bytes.toString('base64') }));
    await cp(current.sourceRoot, instanceRoot, { recursive: true, force: false, errorOnExist: true });
    await current.prepareClone(instanceRoot, port); report.syntheticPreparation = removeSyntheticPreparation(instanceRoot);
    for (const library of media.libraries) await mkdir(library.filename, { recursive: true });
    proxy = await startOwnedMediaProxy(media.files); report.proxy = proxy.report;
    native = current.start({ referenceRoot: instanceRoot, outputRoot: root, label: 'native-empty-owned', origin }); await native.ready();
    for (const task of await idle()) assert.equal((await request('/ScheduledTasks/' + task.Id + '/Triggers', { method: 'POST', body: [] })).status, 204);
    const administrator = await request('/Users/' + current.userId); assert.equal(administrator.status, 200);
    assert.equal((await request('/Users/' + current.userId + '/Policy', { method: 'POST',
      body: { ...administrator.bodyJson.Policy, EnableContentDeletion: true } })).status, 204);
    for (const library of media.libraries) assert.equal((await request('/Library/VirtualFolders?name=' + encodeURIComponent(library.name)
      + (library.type === null ? '' : '&collectionType=' + library.type) + '&refreshLibrary=false', { method: 'POST',
      body: { LibraryOptions: libraryOptions(library) } })).status, 204);
    await scan('native-empty-owned'); await observeLibraries('native-empty'); await stopNative('native-empty-owned');
    const baseline = path.join(root, 'native-empty.db'); await stoppedDatabase(databaseFilename(instanceRoot)); await copyFile(databaseFilename(instanceRoot), baseline);
    report.binding = { serverId: current.preparation.nativeServerId, originIdentityDigest: sha(await readFile(baseline)) };
    const storage = await configureStorage(root); report.mountContract = storage.mountContract;
    database = await createPostgresTestDatabase(null, 'owned_exchange');
    await withSqlite(baseline, async source => {
      report.snapshots.nativeEmpty = await completeSnapshot(source);
      report.imported = await transferDatabase(source, database, { instanceBinding: report.binding, portableMountContract: report.mountContract });
    });
    assert.deepEqual(await completeSnapshot(database), report.snapshots.nativeEmpty);
    const savedEmpty = await saveEmptyInstance(root, instanceRoot);
    report.savedEmptyConfiguration = await describeFile(path.join(savedEmpty, 'config'));
    assert.equal(report.savedEmptyConfiguration.available, true);
    await materializePhase(media, 'initial');
    const initialSidecars = await sidecarFiles(media);
    native = current.start({ referenceRoot: instanceRoot, outputRoot: root, label: 'native-owned-baseline', origin }); await native.ready();
    await scan('native-owned-baseline'); await stopNative('native-after-baseline-scan');
    await withSqlite(databaseFilename(instanceRoot), async source => {
      report.snapshots.nativeBaseline = await completeSnapshot(source); await assertGraph(source, 'native-baseline');
    });
    native = current.start({ referenceRoot: instanceRoot, outputRoot: root, label: 'native-baseline-http', origin }); await native.ready(); await idle();
    report.nativeBaselineFirst = await observe('native-baseline-first-http');
    await scan('native-owned-baseline-repeat'); report.nativeBaseline = await observe('native-baseline-repeat-http');
    await stopNative('native-after-baseline-http');
    await withSqlite(databaseFilename(instanceRoot), async source => {
      report.snapshots.nativeBaselineRepeated = await completeSnapshot(source); await assertGraph(source, 'native-baseline-repeat');
    });
    report.nativeBaselineFiles = await sourceFiles(media, [...present]);
    assert.deepEqual(await sidecarFiles(media), initialSidecars, 'Native baseline leaves the frozen media sidecars unchanged for Node.');
    report.restoredEmpty = await restoreEmptyInstance(root, instanceRoot, savedEmpty);
    report.restoredEmpty.configuration = await describeFile(path.join(instanceRoot, 'config'));
    assert.deepEqual(report.restoredEmpty.configuration.entries, report.savedEmptyConfiguration.entries,
      'Node consumes the complete saved configuration bytes, including unknown configuration members.');
    await withSqlite(databaseFilename(instanceRoot), async source => assert.deepEqual(await completeSnapshot(source), report.snapshots.nativeEmpty));
    assert.deepEqual(await completeSnapshot(database), report.snapshots.nativeEmpty, 'Node starts from the unscanned original empty PostgreSQL import.');
    await startNode(database); await scan('node-owned-first-scan');
    await assertGraph(database, 'node-first-scan'); report.nodeScanned = await observe('node-first-scan'); report.initialFiles = await sourceFiles(media, [...present]);
    const configured = await observeLibraries('before-savers');
    for (const library of media.libraries.filter(library => ['mixed', 'movies', 'music'].includes(library.key))) {
      const actual = configured.find(value => value.Name === library.name);
      assert.equal((await request('/Library/VirtualFolders/LibraryOptions', { method: 'POST',
        body: { Id: actual.ItemId, LibraryOptions: { ...actual.LibraryOptions, SaveLocalMetadata: true, MetadataSavers: ['Nfo'] } } })).status, 204);
    }
    saveLocalMetadata = true;
    await materializePhase(media, 'node'); present.add('nodeTrack'); await scan('node-add-original-flac');
    await assertGraph(database, 'node-added'); setPhase('node-metadata-and-user-edits');
    await edit('episode1', input.mutations.nodeEpisode); await edit('album', input.mutations.nodeAlbum);
    const trackEdit = input.mutations.nodeTrack;
    const trackArtistIds = new Map(); report.trackEditArtistBindings = [];
    for (const name of new Set([...trackEdit.ArtistItems, ...trackEdit.AlbumArtists].map(artist => artist.Name))) {
      const rows = await database.rows('BaseItems', { where: { Name: name, Type: 'MediaBrowser.Controller.Entities.Audio.MusicArtist' } });
      report.trackEditArtistBindings.push({ name, rows });
      assert.equal(rows.length, 1, 'The declared edit artist binds one actual SQL Name/Type row.');
      assert.equal(idKey(rows[0].Id), identities.artist, 'The edit keeps the actual scanned artist identity.');
      trackArtistIds.set(name, idKey(rows[0].Id));
    }
    await edit('track1', trackEdit, { ...trackEdit,
      Artists: trackEdit.ArtistItems.map(artist => artist.Name),
      ArtistItems: trackEdit.ArtistItems.map(artist => ({ ...artist, Id: trackArtistIds.get(artist.Name) })),
      AlbumArtists: trackEdit.AlbumArtists.map(artist => ({ ...artist, Id: trackArtistIds.get(artist.Name) })) });
    assert.equal((await request('/UserFavoriteItems/' + identities[input.mutations.favorite], { method: 'POST' })).status, 200);
    assert.equal((await request('/UserPlayedItems/' + identities[input.mutations.played], { method: 'POST' })).status, 200);
    for (const key of input.mutations.nodeDelete) {
      assert.equal((await request('/Items/' + identities[key], { method: 'DELETE' })).status, 204); present.delete(key);
    }
    await scan('node-owned-after-delete'); await assertGraph(database, 'node-changed');
    report.nodeChanged = await observe('node-changed'); report.nodeFiles = await sourceFiles(media, [...present]); report.nodeSidecars = await sidecarFiles(media);
    assert.equal(report.nodeChanged.retainedBook.dto.UserData.IsFavorite, true); assert.equal(report.nodeChanged.episode1.dto.UserData.Played, true);
    assert.equal(report.nodeChanged.episode1.dto.ProviderIds.JointUnknown, input.mutations.nodeEpisode.ProviderIds.JointUnknown);
    await stopNode('node-before-cold'); const beforeCold = await itemSnapshot(database, Object.values(identities));
    const schema = database.schemaName; await database.close(); database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema });
    await startNode(database); report.nodeCold = await observe('node-cold'); assert.deepEqual(report.nodeCold, report.nodeChanged);
    assert.deepEqual(await itemSnapshot(database, Object.values(identities)), beforeCold); await stopNode('node-after-cold');
    report.snapshots.nodeClosed = await completeSnapshot(database);
    const exported = path.join(root, 'node-export.db'); report.exported = await exportCurrentSqlite(database, exported); assert.equal(report.exported.verified, true);
    await withSqlite(exported, async source => assert.deepEqual(await completeSnapshot(source), report.snapshots.nodeClosed));
    await installStoppedExport({ root, instanceRoot, exported });
    native = current.start({ referenceRoot: instanceRoot, outputRoot: root, label: 'native-owned-continuation', origin }); await native.ready(); await idle();
    report.nativeImported = await observe('native-imported'); assert.deepEqual(report.nativeImported, report.nodeCold);
    await materializePhase(media, 'native'); for (const file of media.files.filter(file => file.phase === 'native')) present.add(file.key);
    await scan('native-owned-joint-additions'); report.nativeContinued = await observe('native-continued');
    for (const file of media.files.filter(file => present.has(file.key) && !file.sourceOnly && !file.untypedAlternatePart)) {
      assert.ok(proxy.report.requests.some(observation => observation.phase === 'native-continued'
        && observation.filename === file.filename && observation.method === 'GET' && observation.completed && observation.bodyBytes > 0),
      file.key + ' was read by the real Native through its declared source.');
    }
    report.nativeAddedTransfer = await readTransferDtos(report.nativeContinued, 'native-added-transfer-dtos');
    await stopNative('native-after-joint-additions');
    returnedDatabase = await createPostgresTestDatabase(null, 'owned_added');
    await withSqlite(databaseFilename(instanceRoot), async source => {
      report.snapshots.nativeAdded = await completeSnapshot(source); await assertGraph(source, 'native-added');
      report.transferBoundaries['native-added-transfer-dtos'].storedRows = report.graphPrefixes['native-added'].rows;
      report.addedImport = await transferDatabase(source, returnedDatabase, { instanceBinding: report.binding, portableMountContract: report.mountContract });
    });
    assert.deepEqual(await completeSnapshot(returnedDatabase), report.snapshots.nativeAdded);
    await assertGraph(returnedDatabase, 'node-added-import'); assert.deepEqual(report.graphs['node-added-import'], report.graphs['native-added']);
    await startNode(returnedDatabase); report.nodeNativeAdded = await observe('node-native-additions');
    assert.deepEqual(report.nodeNativeAdded, report.nativeAddedTransfer); await stopNode('node-after-native-additions');
    await dropPostgresTestDatabase(returnedDatabase); report.cleanup.push({ schema: returnedDatabase.schemaName, removed: true }); returnedDatabase = undefined;
    native = current.start({ referenceRoot: instanceRoot, outputRoot: root, label: 'native-owned-deletion', origin }); await native.ready(); await idle();
    await edit('episode1', { ...input.mutations.nativeEpisode, ProviderIds: report.nativeContinued.episode1.dto.ProviderIds });
    for (const deletion of input.mutations.nativeDeletePrimaries) {
      assert.equal((await request('/Items/' + identities[deletion.primary], { method: 'DELETE' })).status, 204);
    }
    await scan('native-after-owned-primary-delete');
    await stopNative('native-after-owned-primary-delete');
    // A primary deletion can promote an existing alternate or the following
    // scan can resolve another physical file to a new type/identity. Freeze the
    // stopped actual Native rows and remaining original files before any HTTP
    // assertion; the initial family tuple applies only before this mutation.
    const families = new Set(input.mutations.nativeDeletePrimaries.map(deletion => deletion.family));
    const roots = input.mutations.nativeDeletePrimaries.map(deletion => path.dirname(definitions.find(item => item.key === deletion.primary).filename));
    const previousIdentities = definitions.filter(item => families.has(item.family) && identities[item.key])
      .map(item => ({ key: item.key, id: identities[item.key], path: item.filename }));
    const physicalFiles = await observeSourceFiles(media);
    await withSqlite(databaseFilename(instanceRoot), async source => {
      const allRows = await source.rows('BaseItems'), rows = allRows.filter(row => roots.some(root => row.Path === root || row.Path?.startsWith(root + path.sep)));
      const removedIds = previousIdentities.filter(old => !allRows.some(row => idKey(row.Id) === old.id)).map(old => old.id);
      const removedItems = await itemSnapshot(source, removedIds);
      report.postDeleteBoundary = { stoppedBeforePublicRead: true, roots, previousIdentities, allRows, rows,
        complete: await completeSnapshot(source), itemsAndRelations: await itemSnapshot(source, rows.map(row => row.Id)),
        physicalFiles, removedIds, removedItems };
      for (const deletion of input.mutations.nativeDeletePrimaries) {
        assert.ok(removedIds.includes(identities[deletion.primary]), deletion.primary + ' was actually deleted by Native.');
        assert.equal(physicalFiles.find(file => file.key === deletion.primary).absent, true, deletion.primary + ' original source was deleted.');
      }
      for (const file of physicalFiles) {
        const declaration = media.files.find(item => item.key === file.key);
        if (!families.has(declaration.family)) assert.equal(!file.absent, present.has(file.key), file.key + ' is outside the two deleted-primary families.');
        if (file.absent) present.delete(file.key); else present.add(file.key);
      }
      const items = rows.map(row => {
        const original = definitions.find(item => item.filename === row.Path);
        const key = 'native-post-delete-' + idKey(row.Id);
        const item = { ...original, key, filename: row.Path, type: row.Type.split('.').at(-1), nativeRow: row,
          nativePostDelete: true, sourceFilePresent: original ? !physicalFiles.find(file => file.key === original.key)?.absent : false,
          owner: undefined, primaryVersion: undefined, parent: undefined, ownedExtra: false, untypedAlternatePart: false };
        bind(item, row.Id); return item;
      });
      postDeleteState = { families, roots, allRows, rows, previousIdentities, removedIds, removedItems, items };
      await assertGraph(source, 'native-post-delete-stopped');
    });
    native = current.start({ referenceRoot: instanceRoot, outputRoot: root, label: 'native-owned-post-delete-cold', origin });
    await native.ready(); await idle(); report.nativeFinal = await observe('native-final-cold');
    report.nativeFinalTransfer = await readTransferDtos(report.nativeFinal, 'native-final-transfer-dtos');
    report.nativeFiles = await sourceFiles(media, [...present]); report.nativeSidecars = await sidecarFiles(media);
    await stopNative('native-owned-continuation');
    const returned = path.join(root, 'native-returned.db'); await stoppedDatabase(databaseFilename(instanceRoot)); await copyFile(databaseFilename(instanceRoot), returned);
    returnedDatabase = await createPostgresTestDatabase(null, 'owned_returned');
    await withSqlite(returned, async source => {
      report.snapshots.nativeReturned = await completeSnapshot(source); await assertGraph(source, 'native-returned');
      report.transferBoundaries['native-final-transfer-dtos'].storedRows = report.graphPrefixes['native-returned'].rows;
      report.reimported = await transferDatabase(source, returnedDatabase, { instanceBinding: report.binding, portableMountContract: report.mountContract });
    });
    assert.deepEqual(await completeSnapshot(returnedDatabase), report.snapshots.nativeReturned);
    await assertGraph(returnedDatabase, 'fresh-postgres'); assert.deepEqual(report.graphs['fresh-postgres'], report.graphs['native-returned']);
    await startNode(returnedDatabase); report.freshNode = await observe('node-reimported'); assert.deepEqual(report.freshNode, report.nativeFinalTransfer);
    assert.equal(report.freshNode.retainedBook.dto.UserData.IsFavorite, true); assert.equal(report.freshNode.episode1.dto.UserData.Played, true);
    assert.equal(report.freshNode.episode1.dto.ProviderIds.JointUnknown, input.mutations.nodeEpisode.ProviderIds.JointUnknown);
    assert.equal(report.freshNode.album.dto.ProviderIds.JointUnknown, input.mutations.nodeAlbum.ProviderIds.JointUnknown);
    await stopNode('node-after-native-continuation'); assert.deepEqual(await sourceFiles(media, [...present]), report.nativeFiles);
    report.jointTopologyVerified = true;
  } catch (error) { failed = true; failure = error; report.failure = failureObservation(error); }
  finally {
    const attempt = async (label, operation) => { try { await operation(); } catch (error) {
      report.cleanup.push({ label, error: failureObservation(error) }); if (!failed) { failed = true; failure = error; }
    } };
    await attempt('native-finally', () => stopNative('native-finally')); await attempt('node-finally', () => stopNode('node-finally'));
    await attempt('sqlite-close', () => { sqlite?.close(); sqlite = undefined; });
    if (!runtime) for (const target of [returnedDatabase, database]) await attempt('postgres-cleanup', async () => {
      await dropPostgresTestDatabase(target); report.cleanup.push({ schema: target?.schemaName, removed: Boolean(target) });
    });
    else { safeToRemove = false; await attempt('returned-close', () => returnedDatabase?.close()); await attempt('database-close', () => database?.close()); }
    await attempt('proxy-close', async () => {
      if (proxy) { await proxy.close(); assert.equal(proxy.report.closed, true); assert.equal(await portAvailable(5244), true); proxy = undefined; }
    });
    await attempt('native-input-finish', () => current?.finish());
    report.identities = identities; report.passed = !failed;
    await attempt('report-publication', async () => {
      for (const [name, bytes] of bodies) await writeFile(path.join(root, name), JSON.stringify({ bytes: bytes.length,
        sha256: sha(bytes), base64: bytes.toString('base64') }) + '\n', { flag: 'wx' });
      await writeFile(path.join(root, 'report.json'), filterEvidenceJson(report, secrets));
      await writeFile(path.join(root, 'provenance.json'), filterEvidenceJson({ inputSha256: sha(inputBytes), nativeInput: current?.preparation,
        sourceBindings: report.sourceBindings, actualNativeBaseline: Boolean(report.nativeBaseline), actualNativeContinuation: Boolean(report.nativeContinued),
        productionColdRead: Boolean(report.nodeCold), freshPostgresRuntime: Boolean(report.freshNode),
        jointTopologyVerified: report.jointTopologyVerified, completeLibraryVerified: false, fullInstanceVerified: false,
        productionScaleVerified: false, phaseAcceptance: false, releaseAcceptance: false }, secrets));
    });
    if (native || runtime || proxy) safeToRemove = false;
    if (safeToRemove) await attempt('private-publication', () => output.publishAndClose());
    else {
      await attempt('retained-private-report', async () => { await mkdir(destination); await writeFile(path.join(destination, 'report.json'),
        filterEvidenceJson({ ...report, privateRootRetained: true }, secrets)); });
      if (!failed) { failed = true; failure = new Error('An owned library runtime did not release its private root.'); }
    }
  }
  if (failed) throw failure;
}, { signal: t.signal }), { signal: t.signal }));
