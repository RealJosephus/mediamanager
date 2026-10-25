import { testFileSystem } from '../storage/plugin-files.js';
import { openMetadataRelations, trackMetadataContexts, closeMetadataFixture } from '../metadata/relations-fixture.js';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { tableDefinition, quoteIdentifier } from '../../src/database/model.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { LibraryService } from '../../src/library/library-service.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { idKey } from '../../src/library/records.js';
import { seedPostgresRuntime } from './postgres-seed.js';

export const fixtureBytes = await readFile(new URL('./fixtures/instant-mix/native.json', import.meta.url));
export const fixture = JSON.parse(fixtureBytes);
export const fixtureSha256 = createHash('sha256').update(fixtureBytes).digest('hex');
export const id = value => `ab210000-0000-0000-0000-${String(value).padStart(12, '0')}`;
export const cases = fixture.observations;

function blank(name) {
  return Object.fromEntries(tableDefinition(name).columns.filter(column => !column.generated).map(column => {
    const type = column.clrType.replace('?', '');
    return [column.name, column.nullable ? null : type === 'DateTime' ? '2026-10-01 00:00:00'
      : type === 'bool' ? false : column.type === 'TEXT' ? '' : type === 'long' || type === 'uint' ? 0n : 0];
  }));
}

const nativeType = type => type === 'Playlist' ? 'MediaBrowser.Controller.Playlists.Playlist' : `MediaBrowser.Controller.Entities.${({
  Audio: 'Audio.Audio', MusicAlbum: 'Audio.MusicAlbum', MusicArtist: 'Audio.MusicArtist', MusicGenre: 'Audio.MusicGenre',
  Series: 'TV.Series', Episode: 'TV.Episode', BoxSet: 'Movies.BoxSet', Movie: 'Movies.Movie',
})[type] ?? type}`;

function item(Id, type, values = {}) {
  const Name = values.Name ?? type;
  return {
    ...blank('BaseItems'), Id, Type: nativeType(type), Name, CleanName: Name.toLowerCase(),
    SortName: Name.toLowerCase(), Data: '{}',
    IsFolder: ['Folder', 'CollectionFolder', 'UserRootFolder', 'AggregateFolder', 'Series', 'BoxSet', 'UserView', 'MusicAlbum', 'Playlist'].includes(type),
    IsSeries: type === 'Series',
    MediaType: ['Audio', 'AudioBook'].includes(type) ? 'Audio'
      : ['Movie', 'Episode'].includes(type) ? 'Video' : 'Unknown',
    ...values,
  };
}

export async function openInstantMixFixture(connectionString) {
  const schema = `instant_mix_${randomUUID().replaceAll('-', '').slice(0, 18)}`;
  let database, store, programDataPath, linkedChildren, library, creator, closePromise;
  let genreLookups = [];
  const contexts = [];
  const closeResources = () => closePromise ??= (async () => {
    const errors = [];
    const attempt = async operation => { try { await operation(); } catch (error) { errors.push(error); } };
    await attempt(() => closeMetadataFixture({ contexts, library, itemCreation: creator, linkedChildren }));
    if (database) await attempt(() => database.client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)}, ${quoteIdentifier(schema + '__mm')} CASCADE`));
    await attempt(() => store ? store.close() : database?.close());
    if (database) await attempt(async () => {
        const cleanup = new pg.Client({ connectionString });
        let verificationFailure, closingFailure;
        try {
          await cleanup.connect();
          assert.deepEqual((await cleanup.query('SELECT schema_name FROM information_schema.schemata WHERE schema_name = ANY($1)',
            [[schema, schema + '__mm']])).rows, []);
        } catch (error) { verificationFailure = error; }
        try { await cleanup.end(); } catch (error) { closingFailure = error; }
        if (verificationFailure && closingFailure) throw new AggregateError([verificationFailure, closingFailure], 'InstantMix schema verification cleanup failed.', { cause: verificationFailure });
        if (verificationFailure) throw verificationFailure;
        if (closingFailure) throw closingFailure;
    });
    if (programDataPath) await attempt(async () => {
        const resolved = path.resolve(programDataPath);
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
        assert.ok(path.basename(resolved).startsWith('mediamanager-instant-mix-'));
        await rm(resolved, { recursive: true, force: true });
    });
    if (errors.length) throw new AggregateError(errors, 'InstantMix fixture resources failed to close.');
  })();
  try {
  database = await PostgresDatabase.open({ connectionString, schema, create: true, max: 3 });
  store = new DomainStore(database);
  programDataPath = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-instant-mix-'));
  const user = { Id: fixture.userId, Username: 'InstantMixUser', Configuration: { GroupedFolders: [] },
    Policy: { EnableAllFolders: true, EnableMediaPlayback: true, IsAdministrator: true },
    EnableNextEpisodeAutoPlay: false };
  await database.insert('Users', { ...blank('Users'), Id: idKey(user.Id), Username: user.Username });
  const spoolRoot = path.join(programDataPath, 'metadata-spool');
  linkedChildren = await openMetadataRelations(database, spoolRoot);
  const qualified = name => `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
  const state = {
    database, store, user, schema, programDataPath,
    get library() { return library; },
    get genreLookups() { return genreLookups; },
    async seed(entry) {
      for (const loader of contexts.splice(0)) await loader.close();
      await creator?.close();
      await library?.close();
      await linkedChildren.flushReleases();
      await database.client.query(`TRUNCATE ${qualified('BaseItems')} CASCADE`);
      library = new LibraryService({fileSystem: testFileSystem,  store, linkedChildren, serverId: 'instant-mix-fixture', programDataPath,
        userRoot: { Id: id(50) },
        dataPath: path.join(programDataPath, 'data'), metadataPath: path.join(programDataPath, 'metadata'),
        configuration: { DisplaySpecialsWithinSeasons: true, EnableGroupingMoviesIntoCollections: false,
          EnableGroupingShowsIntoCollections: false } });
      creator = new ItemCreationService({ store, library, linkedChildren,
        loadContext: trackMetadataContexts(createMetadataContextLoader({fileSystem: testFileSystem,  store, library, linkedChildren, spoolRoot,
          configuration: library.options.configuration }), contexts) });
      library.itemCreation = creator;
      genreLookups = [];
      const getMusicGenre = library.getMusicGenre.bind(library);
      library.getMusicGenre = async name => {
        genreLookups.push(name);
        // The original recorder explicitly injects this individual lookup failure.
        if (name === 'Failure') throw new Error('Controlled genre lookup failure');
        return getMusicGenre(name);
      };
      const roots = [
        item(id(49), 'AggregateFolder', { Name: 'Aggregate' }),
        item(id(50), 'UserRootFolder', { Name: 'User root', Path: path.join(programDataPath, 'root/default') }),
        item(id(51), 'Folder', { Name: 'Selected physical root', ParentId: id(49), Path: 'Z:\\Mix\\Selected' }),
        item(id(52), 'Folder', { Name: 'Audio physical root', ParentId: id(49), Path: 'Z:\\Mix\\Audio' }),
        item(fixture.parentId, 'CollectionFolder', { Name: 'Selected library', ParentId: id(50),
          Path: path.join(programDataPath, 'root/default/Selected'),
          Data: JSON.stringify({ CollectionType: 'tvshows', PhysicalFolderIds: [id(51)], PhysicalLocationsList: ['Z:\\Mix\\Selected'] }) }),
        item(id(53), 'CollectionFolder', { Name: 'Audio library', ParentId: id(50),
          Path: path.join(programDataPath, 'root/default/Audio'),
          Data: JSON.stringify({ CollectionType: 'music', PhysicalFolderIds: [id(52)], PhysicalLocationsList: ['Z:\\Mix\\Audio'] }) }),
      ];
      for (const root of roots) {
        if (root.Path && !root.Path.startsWith('Z:')) await mkdir(root.Path, { recursive: true });
        await database.insert('BaseItems', root);
      }
      const rows = new Map();
      for (const candidate of fixture.candidates) {
        rows.set(candidate.Id, item(candidate.Id, 'Audio', { Name: candidate.Name, Genres: candidate.Genres.join('|'),
          ParentId: id(52), TopParentId: id(52), Path: `Z:\\Mix\\Audio\\${idKey(candidate.Id)}.flac` }));
      }
      for (let index = 0; index < entry.selected.length; index++) {
        const child = entry.selected[index];
        rows.set(child.Id, item(child.Id, child.type, { Name: `${index}-${child.type}`, SortName: String(index).padStart(3, '0'),
          Genres: child.Genres.join('|'), ParentId: id(51), TopParentId: id(51),
          PresentationUniqueKey: idKey(child.Id), Path: `Z:\\Mix\\Selected\\${idKey(child.Id)}.media`,
          ...(child.type === 'Episode' ? { ParentIndexNumber: 1, IndexNumber: 2, SeriesId: id(8),
            SeriesPresentationUniqueKey: 'case-series' } : {}),
        }));
      }
      const genreView = ['moviegenre', 'tvgenre'].includes(entry.viewType);
      rows.set(entry.Id, item(entry.Id, entry.sourceType, { Name: genreView ? 'Drama' : 'Source',
        CleanName: genreView || entry.sourceType === 'MusicGenre' ? 'drama' : 'source',
        Genres: entry.Genres.join('|'),
        ParentId: entry.sourceType === 'UserView' ? null : id(51), TopParentId: entry.sourceType === 'UserView' ? null : id(51),
        Path: entry.sourceType === 'UserView' ? path.join(programDataPath, 'metadata/views', idKey(entry.Id))
          : `Z:\\Mix\\Selected\\${idKey(entry.Id)}.media`,
        Data: entry.sourceType === 'UserView'
          ? JSON.stringify({ ViewType: entry.viewType, DisplayParentId: fixture.parentId }) : '{}',
        PresentationUniqueKey: idKey(entry.Id),
      }));
      if (entry.viewType === 'tvnextup' && entry.selected.length) {
        rows.set(id(8), item(id(8), 'Series', { Name: 'Next Up series', ParentId: id(51), TopParentId: id(51),
          PresentationUniqueKey: 'case-series' }));
        rows.set(id(90), item(id(90), 'Episode', { Name: 'Previous episode', ParentId: id(8), TopParentId: id(51),
          ParentIndexNumber: 1, IndexNumber: 1, SeriesId: id(8), SeriesPresentationUniqueKey: 'case-series',
          PresentationUniqueKey: idKey(id(90)) }));
        rows.get(id(9)).ParentId = id(8);
      }
      await seedPostgresRuntime(database, { BaseItems: [...rows.values()] });
      for (const row of rows.values()) {
        for (const [index, name] of (row.Genres?.split('|').filter(Boolean) ?? []).entries()) {
          const valueId = ({ drama: id(70), '爵士': id(71), novel: id(72) })[name.toLowerCase()] ?? id(73);
          await database.upsert('ItemValues', { ItemValueId: valueId, Type: 2, Value: name, CleanValue: name.toLowerCase() });
          const existing = await database.rows('ItemValuesMap', { where: { ItemId: row.Id, ItemValueId: valueId }, limit: 1 });
          if (!existing.length) await database.insert('ItemValuesMap', { ItemId: row.Id, ItemValueId: valueId });
        }
        if (entry.selected.some(child => child.Id === row.Id) || row.Id === id(90)) {
          await database.insert('UserData', { ...blank('UserData'), ItemId: row.Id, UserId: idKey(user.Id),
            CustomDataKey: row.Id, IsFavorite: true, PlaybackPositionTicks: row.Id === id(90) ? 0n : 100n,
            Played: row.Id === id(90), LastPlayedDate: '2026-10-01 00:00:00' });
        }
      }
      if (entry.viewType === 'moviecollection' && entry.selected.length) {
        await database.insert('LinkedChildren', { ParentId: id(10), ChildId: id(3), ChildType: 0, SortOrder: 0 });
      }
      return library;
    },
    close: closeResources,
  };
  return state;
  } catch (error) {
    try { await closeResources(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], error.message, { cause: error }); }
    throw error;
  }
}

export async function observeInstantMix(state, entry, expand) {
  await state.seed(entry);
  const observation = { name: entry.name, ids: null, status: 200 };
  try {
    observation.ids = (await state.store.run(database => expand(database, state.library, [entry.Id], {
      user: entry.userless ? null : state.user, mixing: true,
    }))).map(item => item.Id);
  } catch (error) {
    observation.status = error.status ?? 500;
    observation.error = { name: error.name, message: error.message, code: error.code ?? null, stack: error.stack };
  }
  observation.genreLookups = [...state.genreLookups];
  return observation;
}

export function assertInstantMix(entry, observation) {
  assert.deepEqual(observation.genreLookups, entry.calls.filter(call => call.method === 'GetMusicGenre').map(call => call.name), entry.name);
  const expectedStatus = entry.failure ? entry.userless && entry.sourceType === 'Folder' ? 400 : 500 : 200;
  assert.equal(observation.status, expectedStatus, entry.name);
  if (entry.failure) assert.equal(observation.ids, null, entry.name);
  else {
    assert.deepEqual(observation.ids.map(idKey).toSorted(), entry.ids.map(idKey).toSorted(), entry.name);
    if (['Audio', 'AudioBook'].includes(entry.sourceType)) assert.equal(idKey(observation.ids[0]), idKey(entry.Id));
    assert.equal(new Set(observation.ids.map(idKey)).size, observation.ids.length);
  }
}

export async function writeInstantMixEvidence(observations, extra = {}) {
  if (!process.env.MEDIAMANAGER_INSTANT_MIX_EVIDENCE) return;
  const root = path.resolve(process.env.MEDIAMANAGER_INSTANT_MIX_EVIDENCE);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'postgres.json'), JSON.stringify({ fixtureSha256, observations,
    dialect: 'postgres', genreLookupSequenceVerified: true, nativeGenreLookupControlled: true,
    genreLifecycleVerified: false, phaseAcceptance: false, ...extra }, null, 2) + '\n', { flag: 'wx' });
}
