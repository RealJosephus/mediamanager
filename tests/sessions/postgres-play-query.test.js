import { nativeTextSql } from '../../src/database/native-text-sql.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import { createRuntime } from '../../src/runtime.js';
import { expandPostgresPlayItems, queryPostgresRelationalPlayPage,
  queryPostgresInstantMix, queryPostgresInstantMixGenres } from '../../src/library/playback-items.js';

const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;

function blank(name) {
  return Object.fromEntries(tableDefinition(name).columns.map(column => [column.name,
    column.clrType.replace('?', '') === 'DateTime' ? '2026-10-01 00:00:00'
      : column.nullable ? null : column.clrType === 'bool' ? false
        : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));
}

function item(Id, Type, values = {}) {
  const name = values.Name ?? Type.split('.').at(-1);
  return {
    ...blank('BaseItems'),
    Id,
    Type: `MediaBrowser.Controller.Entities.${Type}`,
    Name: name,
    CleanName: name.toLowerCase(),
    SortName: name.toLowerCase(),
    Data: '{}',
    MediaType: values.MediaType ?? 'Unknown',
    IsFolder: false,
    ...values,
  };
}

async function dropSchemas(schema) {
  const cleanup = await PostgresDatabase.open({ connectionString, schema });
  try {
    await cleanup.client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await cleanup.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
  } finally { await cleanup.close(); }
}

test('postgres: playback planning releases navigation on success, failure and nested mixes', async () => {
  const schema = `play_owner_${randomUUID().replaceAll('-', '').slice(0, 18)}`;
  const database = await PostgresDatabase.open({ connectionString, schema, create: true });
  const programDataPath = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-play-query-'));
  let runtime;
  try {
    runtime = await createRuntime({ database, programDataPath, serverId: 'playback-planning-owner',
      configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true } });
    const user = { Id: '71100000000000000000000000000001', Policy: { EnableAllFolders: true } };
    const audioIds = ['71100000000000000000000000000002', '71100000000000000000000000000003'];
    for (const Id of audioIds) await database.insert('BaseItems', item(Id, 'Audio.Audio', { MediaType: 'Audio' }));
    const frames = [];
    const load = runtime.library.load.bind(runtime.library);
    runtime.library.load = async (...args) => {
      const state = await load(...args);
      const frame = { disposed: 0 };
      frames.push(frame);
      const dispose = state.dispose.bind(state);
      state.dispose = async options => {
        frame.disposed++;
        assert.equal(options.session, args[0], 'release uses the already held primary session');
        return dispose(options);
      };
      return state;
    };
    const check = async operation => {
      const start = frames.length;
      await runtime.store.run(operation);
      assert.ok(frames.length > start, 'the operation loaded real PostgreSQL navigation');
      assert.ok(frames.slice(start).every(frame => frame.disposed === 1),
        'every navigation frame is released once before the operation returns');
    };
    await check(async db => {
      const planning = {};
      await queryPostgresRelationalPlayPage(db, runtime.library, { limit: 1 },
        { mode: 'direct', roots: [audioIds[0]] }, user, planning);
      assert.deepEqual(planning, {});
      await assert.rejects(queryPostgresRelationalPlayPage(db, runtime.library, { limit: 1 },
        { mode: 'invalid', roots: [audioIds[0]] }, user, planning), /scope mode/u);
      assert.deepEqual(planning, {});
    });
    await check(db => queryPostgresInstantMixGenres(db, runtime.library, [], user));
    await check(db => queryPostgresInstantMix(db, runtime.library,
      { Id: audioIds[0], Type: 'MusicGenre' }, user));
    await check(async db => {
      const start = frames.length;
      await expandPostgresPlayItems(db, runtime.library, audioIds, { user, mixing: true });
      assert.equal(frames.length - start, 1, 'nested mixes share one outer navigation owner');
    });
    await check(async db => {
      const originalLoad = runtime.library.load;
      const cleanupFailure = new Error('navigation cleanup failure');
      runtime.library.load = async (...args) => {
        const state = await originalLoad(...args);
        const dispose = state.dispose.bind(state);
        state.dispose = async options => { await dispose(options); throw cleanupFailure; };
        return state;
      };
      try {
        await assert.rejects(queryPostgresRelationalPlayPage(db, runtime.library, { limit: 1 },
          { mode: 'invalid', roots: [audioIds[0]] }, user), error => error instanceof AggregateError
            && /scope mode/u.test(error.errors[0].message) && error.errors[1] === cleanupFailure);
      } finally { runtime.library.load = originalLoad; }
    });
  } finally {
    await runtime?.close();
    await dropSchemas(schema);
    assert.equal(path.dirname(path.resolve(programDataPath)), path.resolve(os.tmpdir()));
    await rm(programDataPath, { recursive: true, force: true });
  }
});

test('postgres: remote play expansion preserves commands with bounded PostgreSQL reads', async () => {
  const started = performance.now();
  const phase = name => process.stderr.write('[postgres-play-query-phase] '
    + JSON.stringify({ name, elapsedMs: Math.round(performance.now() - started) }) + '\n');
  const schema = `session_play_${randomUUID().replaceAll('-', '').slice(0, 18)}`;
  const database = await PostgresDatabase.open({ connectionString, schema, create: true });
  const programDataPath = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-play-query-'));
  let runtime;
  let restoreRows;
  try {
    runtime = await createRuntime({
      database,
      programDataPath,
      configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true, DisplaySpecialsWithinSeasons: true },
      serverId: 'session-play-postgres',
    });
    phase('runtime created');
    const ids = {
      userRoot: '71000000-0000-0000-0000-000000000001',
      aggregate: '71000000-0000-0000-0000-000000000002',
      collection: '71000000-0000-0000-0000-000000000003',
      physical: '71000000-0000-0000-0000-000000000004',
      folder: '71000000-0000-0000-0000-000000000005',
      view: '71000000-0000-0000-0000-000000000006',
      genre: '71000000-0000-0000-0000-000000000007',
      boxSet: '71000000-0000-0000-0000-000000000008',
      directView: '71000000-0000-0000-0000-000000000009',
      genreView: '71000000-0000-0000-0000-00000000000a',
      resumeView: '71000000-0000-0000-0000-00000000000b',
      nextUpView: '71000000-0000-0000-0000-00000000000c',
      musicView: '71000000-0000-0000-0000-00000000000d',
      musicGenre: '71000000-0000-0000-0000-00000000000e',
      mixFolder: '71000000-0000-0000-0000-00000000000f',
      latestFolderView: '71000000-0000-0000-0000-000000000010',
      nextCollection: '71000000-0000-0000-0000-000000000041',
      nextPhysical: '71000000-0000-0000-0000-000000000042',
      nextSeries: '71000000-0000-0000-0000-000000000043',
      nextSeason: '71000000-0000-0000-0000-000000000044',
      nextFirst: '71000000-0000-0000-0000-000000000045',
      nextSecond: '71000000-0000-0000-0000-000000000046',
      largeMixFolder: '71000000-0000-0000-0000-000000000047',
      alpha: '71000000-0000-0000-0000-000000000011',
      zulu: '71000000-0000-0000-0000-000000000012',
      owned: '71000000-0000-0000-0000-000000000016',
      alternate: '71000000-0000-0000-0000-000000000017',
      rock: '71000000-0000-0000-0000-000000000013',
      source: '71000000-0000-0000-0000-000000000014',
      peer: '71000000-0000-0000-0000-000000000015',
      series: '71000000-0000-0000-0000-000000000021',
      season0: '71000000-0000-0000-0000-000000000022',
      season1: '71000000-0000-0000-0000-000000000023',
      first: '71000000-0000-0000-0000-000000000024',
      special: '71000000-0000-0000-0000-000000000025',
      second: '71000000-0000-0000-0000-000000000026',
    };

    await database.insert('BaseItems', item(ids.userRoot, 'UserRootFolder', { IsFolder: true }));
    // Bind grouped views to the root declared by this isolated catalogue.
    runtime.library.options.userRoot = { Id: ids.userRoot };
    await database.insert('BaseItems', item(ids.aggregate, 'AggregateFolder', { IsFolder: true }));
    await database.insert('BaseItems', item(ids.physical, 'Folder', {
      IsFolder: true, ParentId: ids.aggregate, Path: 'Z:\\Bounded\\Movies',
    }));
    await database.insert('BaseItems', item(ids.collection, 'CollectionFolder', {
      IsFolder: true, ParentId: ids.userRoot, Name: 'Movies',
      Data: JSON.stringify({ CollectionType: 'movies',
        PhysicalFolderIds: [ids.physical],
        PhysicalLocationsList: ['Z:\\Bounded\\Movies'] }),
    }));
    await database.insert('BaseItems', item(ids.folder, 'Folder', {
      IsFolder: true, ParentId: ids.physical, TopParentId: ids.physical, Path: 'Z:\\Bounded\\Movies\\Folder',
    }));
    for (const [Id, Name] of [[ids.alpha, 'Alpha'], [ids.zulu, 'Zulu']]) {
      await database.insert('BaseItems', item(Id, 'Movies.Movie', {
        Name, MediaType: 'Video', ParentId: ids.folder, TopParentId: ids.physical,
        PresentationUniqueKey: Id.replaceAll('-', ''), Path: `Z:\\Bounded\\Movies\\Folder\\${Name}.mkv`,
      }));
    }
    await database.insert('BaseItems', item(ids.owned, 'Movies.Movie', {
      Name: 'Owned', MediaType: 'Video', ParentId: ids.folder, TopParentId: ids.physical,
      OwnerId: ids.alpha, PresentationUniqueKey: ids.owned.replaceAll('-', ''),
      Path: 'Z:\\Bounded\\Movies\\Folder\\Owned.mkv',
    }));
    await database.insert('BaseItems', item(ids.alternate, 'Movies.Movie', {
      Name: 'Version', MediaType: 'Video', ParentId: ids.folder, TopParentId: ids.physical,
      PrimaryVersionId: ids.alpha, PresentationUniqueKey: ids.alpha.replaceAll('-', ''),
      Path: 'Z:\\Bounded\\Movies\\Folder\\Version.mkv',
    }));
    await database.insert('BaseItems', item(ids.view, 'UserView', {
      IsFolder: true, Name: 'Movies', Data: JSON.stringify({ ViewType: 'movies', DisplayParentId: ids.collection }),
    }));
    for (const [Id, Name, ViewType, DisplayParentId] of [
      [ids.directView, 'Direct', 'unknown', null],
      [ids.genreView, 'Action', 'moviegenre', ids.collection],
      [ids.resumeView, 'Resume', 'movieresume', ids.collection],
      [ids.nextUpView, 'Next up', 'tvnextup', ids.nextCollection],
      [ids.musicView, 'Music', 'music', ids.collection],
      [ids.latestFolderView, 'Folder latest', 'movielatest', ids.folder],
    ]) await database.insert('BaseItems', item(Id, 'UserView', {
      IsFolder: true, Name, Data: JSON.stringify({ ViewType, ...(DisplayParentId ? { DisplayParentId } : {}) }),
    }));
    await database.insert('BaseItems', item(ids.genre, 'Genre', { Name: 'Action' }));
    await database.insert('ItemValues', { ItemValueId: ids.rock, CleanValue: 'action', Type: 2, Value: 'Action' });
    for (const Id of [ids.alpha, ids.zulu]) await database.insert('ItemValuesMap', { ItemValueId: ids.rock, ItemId: Id });
    await database.insert('BaseItems', item(ids.boxSet, 'Movies.BoxSet', { IsFolder: true, Name: 'Pair' }));
    for (const [SortOrder, ChildId] of [ids.zulu, ids.alpha].entries()) {
      await database.insert('LinkedChildren', { ParentId: ids.boxSet, SortOrder, ChildId, ChildType: 0 });
    }
    await database.insert('LinkedChildren', { ParentId: ids.boxSet, SortOrder: 2, ChildId: ids.folder, ChildType: 2 });

    const rockValue = '71000000-0000-0000-0000-000000000031';
    for (const [Id, Name] of [[ids.source, 'Source'], [ids.peer, 'Peer']]) {
      await database.insert('BaseItems', item(Id, 'Audio.Audio', {
        Name, Genres: Id === ids.source ? ' RÖCK!!! ' : 'Rock', MediaType: 'Audio',
        ParentId: ids.physical, TopParentId: ids.physical,
        PresentationUniqueKey: Id.replaceAll('-', ''), Path: `Z:\\Bounded\\${Name}.flac`,
      }));
    }
    await database.insert('BaseItems', item(ids.musicGenre, 'Audio.MusicGenre', {
      Name: 'Rock display', CleanName: 'rock',
    }));
    await database.insert('BaseItems', item(ids.mixFolder, 'Folder', {
      IsFolder: true, Name: 'Mix folder', ParentId: ids.physical, TopParentId: ids.physical,
      Path: 'Z:\\Bounded\\Mix',
    }));
    await database.insert('LinkedChildren', {
      ParentId: ids.mixFolder, SortOrder: 0, ChildId: ids.source, ChildType: 1,
    });
    await database.insert('ItemValues', { ItemValueId: rockValue, CleanValue: 'rock', Type: 2, Value: 'Rock' });
    for (const ItemId of [ids.source, ids.peer]) await database.insert('ItemValuesMap', { ItemValueId: rockValue, ItemId });

    const seriesKey = 'bounded-session-series';
    await database.insert('BaseItems', item(ids.series, 'TV.Series', {
      IsFolder: true, Name: 'Series', ParentId: ids.physical, TopParentId: ids.physical,
      PresentationUniqueKey: seriesKey,
    }));
    for (const [Id, IndexNumber] of [[ids.season0, 0], [ids.season1, 1]]) {
      await database.insert('BaseItems', item(Id, 'TV.Season', {
        IsFolder: true, Name: `Season ${IndexNumber}`, ParentId: ids.series, TopParentId: ids.physical,
        SeriesId: ids.series, SeriesPresentationUniqueKey: seriesKey,
        PresentationUniqueKey: `${seriesKey}-${IndexNumber}`, IndexNumber,
      }));
    }
    const episodeRows = [
      [ids.first, ids.season1, 1, 1, 'First', {}],
      [ids.special, ids.season0, 0, 1, 'Special', { AirsBeforeSeasonNumber: 1, AirsBeforeEpisodeNumber: 2 }],
      [ids.second, ids.season1, 1, 2, 'Second', {}],
    ];
    for (const [Id, ParentId, ParentIndexNumber, IndexNumber, Name, data] of episodeRows) {
      await database.insert('BaseItems', item(Id, 'TV.Episode', {
        Name, MediaType: 'Video', ParentId, SeasonId: ParentId, TopParentId: ids.physical,
        SeriesId: ids.series, SeriesPresentationUniqueKey: seriesKey,
        PresentationUniqueKey: Id.replaceAll('-', ''), ParentIndexNumber, IndexNumber,
        Data: JSON.stringify(data), Path: `Z:\\Bounded\\${Name}.mkv`,
      }));
    }
    await database.insert('BaseItems', item(ids.nextPhysical, 'Folder', {
      IsFolder: true, ParentId: ids.aggregate, Path: 'Z:\\Bounded\\Next',
    }));
    await database.insert('BaseItems', item(ids.nextCollection, 'CollectionFolder', {
      IsFolder: true, ParentId: ids.userRoot, Name: 'Next shows',
      Data: JSON.stringify({ CollectionType: 'tvshows', PhysicalFolderIds: [ids.nextPhysical] }),
    }));
    const nextSeriesKey = 'bounded-next-up-series';
    await database.insert('BaseItems', item(ids.nextSeries, 'TV.Series', {
      IsFolder: true, Name: 'Next series', ParentId: ids.nextPhysical, TopParentId: ids.nextPhysical,
      PresentationUniqueKey: nextSeriesKey,
    }));
    await database.insert('BaseItems', item(ids.nextSeason, 'TV.Season', {
      IsFolder: true, Name: 'Next season', ParentId: ids.nextSeries, TopParentId: ids.nextPhysical,
      SeriesId: ids.nextSeries, SeriesPresentationUniqueKey: nextSeriesKey,
      PresentationUniqueKey: `${nextSeriesKey}-1`, IndexNumber: 1,
    }));
    for (const [Id, Name, IndexNumber] of [[ids.nextFirst, 'Next first', 1], [ids.nextSecond, 'Next second', 2]]) {
      await database.insert('BaseItems', item(Id, 'TV.Episode', {
        Name, MediaType: 'Video', ParentId: ids.nextSeason, SeasonId: ids.nextSeason,
        TopParentId: ids.nextPhysical, SeriesId: ids.nextSeries,
        SeriesPresentationUniqueKey: nextSeriesKey, PresentationUniqueKey: Id.replaceAll('-', ''),
        ParentIndexNumber: 1, IndexNumber, Path: `Z:\\Bounded\\Next\\${Name}.mkv`,
      }));
    }

    const created = await runtime.users.createUser({ Name: 'BoundedPlay', Password: 'bounded-password' });
    await runtime.users.updateConfiguration(created.Id, {
      ...(await runtime.users.getUser(created.Id)).Configuration,
      GroupedFolders: [ids.collection], EnableNextEpisodeAutoPlay: true,
    });
    await runtime.users.updatePolicy(created.Id, {
      ...(await runtime.users.getUser(created.Id)).Policy,
      IsAdministrator: true,
    });
    for (const Id of [ids.alpha, ids.zulu]) {
      await database.insert('AncestorIds', { ItemId: Id, ParentItemId: ids.folder });
      await database.insert('AncestorIds', { ItemId: Id, ParentItemId: ids.physical });
    }
    const storedUserId = (await database.rows('Users', { limit: 1 }))[0].Id;
    const addUserData = (ItemId, changes) => database.insert('UserData', {
      ...blank('UserData'), UserId: storedUserId, ItemId, CustomDataKey: ItemId.replaceAll('-', ''), ...changes,
    });
    await addUserData(ids.alpha, { PlaybackPositionTicks: 1000n, LastPlayedDate: '2026-09-28 12:00:00' });
    await addUserData(ids.zulu, { PlaybackPositionTicks: 1000n, LastPlayedDate: '2026-09-29 12:00:00' });
    await addUserData(ids.first, { Played: true, PlayCount: 1, LastPlayedDate: '2026-09-30 12:00:00' });
    await addUserData(ids.nextFirst, { Played: true, PlayCount: 1, LastPlayedDate: '2026-09-30 13:00:00' });
    const login = await runtime.authentication.login({ Username: 'BoundedPlay', Pw: 'bounded-password' }, {
      Client: 'BoundedPlayTest', Device: 'Device', DeviceId: 'bounded-play-postgres', Version: '1',
    }, { remoteEndPoint: '127.0.0.1' });
    const messages = [];
    runtime.sessions.attachController(login.SessionInfo.Id, {
      isActive: () => true,
      supportsMediaControl: true,
      sendMessage: async (messageType, messageId, data) => messages.push({ messageType, messageId, data }),
    });
    phase('small catalogue and session ready');

      const rows = database.rows.bind(database);
      database.rows = async (name, options, ...rest) => {
        const bounded = options && (Object.keys(options.where ?? {}).length
          || Object.keys(options.whereIn ?? {}).length || options.limit !== undefined);
        if (name === 'BaseItems' && !bounded) throw new Error('Unbounded BaseItems read during PostgreSQL sendPlay');
        return rows(name, options, ...rest);
      };
      restoreRows = () => { database.rows = rows; };

    let playOrdinal = 0;
    const play = async (ItemIds, PlayCommand = 'PlayNow') => {
      const ordinal = ++playOrdinal;
      phase(`play ${ordinal} ${PlayCommand} start`);
      await runtime.sessions.sendPlay(login.SessionInfo.Id, { ItemIds, PlayCommand }, {
        controllingSessionId: login.SessionInfo.Id,
      });
      phase(`play ${ordinal} ${PlayCommand} completed`);
      const message = messages.shift();
      assert.equal(message.messageType, 'Play');
      return message.data.ItemIds;
    };
    const wire = values => values.map(value => value.replaceAll('-', ''));

    // Relational DisplayParentId scoping has to happen before the view's
    // native latest-items limit. These newer out-of-scope movies would fill
    // the global page if membership were intersected after LIMIT.
    for (let index = 0; index < 51; index++) {
      const Id = `75000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`;
      await database.insert('BaseItems', item(Id, 'Movies.Movie', {
        Name: `Outside latest ${String(index).padStart(2, '0')}`, MediaType: 'Video',
        ParentId: ids.nextPhysical, TopParentId: ids.nextPhysical,
        PresentationUniqueKey: Id.replaceAll('-', ''), DateCreated: '2026-10-02 00:00:00',
      }));
    }

    let relationalSql;
    const rootQuery = database.client.query.bind(database.client);
    database.client.query = async (...args) => {
      const result = await rootQuery(...args);
      const statement = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
      if (statement.includes('requested_item_ids AS (')) relationalSql = statement;
      return result;
    };
    let scopedPage, emptyPage, noMatches;
    phase('relational scope pages start');
    try {
      const pageQuery = {
        includeitemtypes: ['Movie'], sortby: ['SortName'], sortorder: ['Ascending'],
        startindex: 1, limit: 2,
      };
      const scope = { mode: 'recursive', roots: [ids.folder], links: 'none', includeTopParent: false };
      scopedPage = await queryPostgresRelationalPlayPage(database, runtime.library, pageQuery, scope, null);
      emptyPage = await queryPostgresRelationalPlayPage(database, runtime.library,
        { ...pageQuery, startindex: 10 }, scope, null);
      noMatches = await queryPostgresRelationalPlayPage(database, runtime.library,
        pageQuery, { ...scope, roots: [ids.mixFolder] }, null);
    } finally { database.client.query = rootQuery; }
    phase('relational scope pages completed');
    assert.deepEqual(scopedPage.rows.map(row => row.Id), [ids.zulu]);
    assert.equal(scopedPage.total, 2);
    assert.equal(scopedPage.startIndex, 1);
    assert.deepEqual(emptyPage.rows, []);
    assert.equal(emptyPage.total, 2, 'an empty page past the end retains the scoped total');
    assert.equal(emptyPage.startIndex, 10);
    assert.deepEqual(noMatches.rows, []);
    assert.equal(noMatches.total, 0);
    const membership = relationalSql.indexOf(`${nativeTextSql(schema).guidLower('i."Id"')} IN (SELECT ${nativeTextSql(schema).guidLower('"Id"')} FROM requested_item_ids)`);
    assert.ok(membership >= 0 && membership < relationalSql.indexOf('ordered_base AS'),
      'relational membership must enter the filtered relation before ordering and pagination');
    assert.ok(relationalSql.indexOf('ordered_base AS') < relationalSql.indexOf('page AS'),
      'the scoped relation must be ordered before LIMIT/OFFSET is applied');

    assert.deepEqual(await play([ids.folder]), wire([ids.alpha, ids.owned, ids.alternate, ids.zulu]));
    assert.deepEqual(await play([ids.genre]), wire([ids.alpha, ids.zulu]));
    assert.deepEqual(await play([ids.boxSet]), wire([ids.alpha, ids.zulu]));
    assert.deepEqual(await play([ids.view]), wire([ids.alpha, ids.zulu]));
    assert.deepEqual(await play([ids.directView]), wire([ids.peer, ids.source]));
    assert.deepEqual(await play([ids.genreView]), wire([ids.alpha, ids.zulu]));
    assert.deepEqual(await play([ids.resumeView]), wire([ids.zulu, ids.alpha]));
    assert.deepEqual(await play([ids.latestFolderView]), wire([ids.zulu, ids.alpha]));
    assert.deepEqual(await play([ids.nextUpView]), wire([ids.nextSecond]));
    const mix = await play([ids.source], 'PlayInstantMix');
    assert.equal(mix[0], wire([ids.source])[0]);
    assert.deepEqual(mix.slice(1), wire([ids.peer]));
    assert.deepEqual((await play([ids.musicGenre], 'PlayInstantMix')).toSorted(), wire([ids.source, ids.peer]).toSorted());
    assert.deepEqual((await play([ids.mixFolder], 'PlayInstantMix')).toSorted(), wire([ids.source, ids.peer]).toSorted());
    assert.deepEqual((await play([ids.musicView], 'PlayInstantMix')).toSorted(), wire([ids.source, ids.peer]).toSorted());
    assert.deepEqual(await play([ids.first]), wire([ids.first, ids.special, ids.second]));

      const countedExpansion = requestIds => database.withConnection(async scoped => {
        let queryCount = 0;
        const query = scoped.client.query;
        scoped.client.query = async function countQuery(...args) {
          queryCount += 1;
          return query.apply(this, args);
        };
        try {
          const items = await expandPostgresPlayItems(scoped, runtime.library, requestIds);
          return { queryCount, itemIds: items.map(entry => entry.Id) };
        } finally { scoped.client.query = query; }
      });
      phase('batched expansion start');
      const singleExpansion = await countedExpansion([ids.folder]);
      const batchedExpansion = await countedExpansion([
        ids.folder, ids.genre, ids.boxSet, ids.folder,
      ]);
      assert.deepEqual(batchedExpansion.itemIds, [
        ...singleExpansion.itemIds,
        ids.alpha, ids.zulu,
        ids.alpha, ids.zulu,
        ...singleExpansion.itemIds,
      ]);
      assert.equal(batchedExpansion.queryCount, singleExpansion.queryCount,
        'ordinary multi-item playback expansion must use a request-bounded SQL statement count');
      phase('batched expansion completed');

      const deepSeriesId = '74000000-0000-0000-0000-000000000001';
      const deepCurrentId = '74000000-0000-0000-0000-000000000002';
      const deepNextId = '74000000-0000-0000-0000-000000000003';
      await database.insert('BaseItems', item(deepSeriesId, 'TV.Series', {
        IsFolder: true, Name: 'Deep series', PresentationUniqueKey: 'deep-series',
      }));
      let deepParentId = deepSeriesId;
      for (let depth = 1; depth <= 70; depth++) {
        const Id = `74000000-0000-0000-0000-${String(depth + 10).padStart(12, '0')}`;
        await database.insert('BaseItems', item(Id, 'Folder', {
          IsFolder: true, Name: `Deep parent ${depth}`, ParentId: deepParentId,
        }));
        deepParentId = Id;
      }
      await database.insert('BaseItems', item(deepCurrentId, 'TV.Episode', {
        Name: 'Deep current', MediaType: 'Video', ParentId: deepParentId,
        SeriesId: null, ParentIndexNumber: 1, IndexNumber: 1,
        SeriesPresentationUniqueKey: 'deep-series', PresentationUniqueKey: 'deep-series-1',
      }));
      await database.insert('BaseItems', item(deepNextId, 'TV.Episode', {
        Name: 'Deep next', MediaType: 'Video', ParentId: deepParentId,
        SeriesId: deepSeriesId, ParentIndexNumber: 1, IndexNumber: 2,
        SeriesPresentationUniqueKey: 'deep-series', PresentationUniqueKey: 'deep-series-2',
      }));
      let resolvedSeriesId;
      const deepExpansion = await expandPostgresPlayItems(database, {
        querySeriesEpisodes: async input => {
          resolvedSeriesId = input.seriesId;
          return { Items: [{ Id: deepCurrentId, Type: 'Episode' }, { Id: deepNextId, Type: 'Episode' }] };
        },
      }, [deepCurrentId], { enableNextEpisodeAutoPlay: true });
      assert.equal(resolvedSeriesId, deepSeriesId,
        'an Episode with no SeriesId must resolve its Series beyond 64 physical parents');
      assert.deepEqual(deepExpansion.map(entry => entry.Id), [deepCurrentId, deepNextId]);

      const cycleA = '74000000-0000-0000-0000-000000000004';
      const cycleB = '74000000-0000-0000-0000-000000000005';
      const cycleEpisode = '74000000-0000-0000-0000-000000000006';
      await database.insert('BaseItems', item(cycleA, 'Folder', { IsFolder: true, Name: 'Cycle A' }));
      await database.insert('BaseItems', item(cycleB, 'Folder', {
        IsFolder: true, Name: 'Cycle B', ParentId: cycleA,
      }));
      await database.update('BaseItems', { Id: cycleA }, { ParentId: cycleB });
      await database.insert('BaseItems', item(cycleEpisode, 'TV.Episode', {
        Name: 'Cycle episode', MediaType: 'Video', ParentId: cycleA,
        SeriesId: null, ParentIndexNumber: 1, IndexNumber: 1,
        SeriesPresentationUniqueKey: 'cycle-series', PresentationUniqueKey: 'cycle-series-1',
      }));
      const cycleExpansion = await expandPostgresPlayItems(database, {
        querySeriesEpisodes: async () => { throw new Error('A cyclic parent graph has no Series'); },
      }, [cycleEpisode], { enableNextEpisodeAutoPlay: true });
      assert.deepEqual(cycleExpansion.map(entry => entry.Id), [cycleEpisode]);
      phase('deep and cyclic series controls completed');

      // A back-edge exercises recursive UNION de-duplication without changing
      // the reachable playable set.
      await database.insert('AncestorIds', { ItemId: ids.folder, ParentItemId: ids.alpha });

      const quotedSchema = `"${schema}"`;
      phase('unrelated 12000-item catalogue seed start');
      await database.client.query(`INSERT INTO ${quotedSchema}."BaseItems"
        ("Id", "IsFolder", "IsInMixedFolder", "IsLocked", "IsMovie", "IsRepeat", "IsSeries", "IsVirtualItem", "Type", "Name", "SortName")
        SELECT convert_to(md5('frontier-parent-' || ordinal::text)::uuid::text, 'UTF8'),
          TRUE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE,
          'MediaBrowser.Controller.Entities.Folder', 'Unrelated parent', 'unrelated parent'
        FROM generate_series(1, 6000) ordinal`);
      await database.client.query(`INSERT INTO ${quotedSchema}."BaseItems"
        ("Id", "ParentId", "IsFolder", "IsInMixedFolder", "IsLocked", "IsMovie", "IsRepeat", "IsSeries", "IsVirtualItem", "Type", "Name", "SortName")
        SELECT convert_to(md5('frontier-child-' || ordinal::text)::uuid::text, 'UTF8'),
          convert_to(md5('frontier-parent-' || ordinal::text)::uuid::text, 'UTF8'),
          FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE,
          'MediaBrowser.Controller.Entities.Audio.Audio', 'Unrelated child', 'unrelated child'
        FROM generate_series(1, 6000) ordinal`);
      await database.client.query(`INSERT INTO ${quotedSchema}."AncestorIds" ("ItemId", "ParentItemId")
        SELECT convert_to(md5('frontier-child-' || ordinal::text)::uuid::text, 'UTF8'),
          convert_to(md5('frontier-parent-' || ordinal::text)::uuid::text, 'UTF8')
        FROM generate_series(1, 6000) ordinal`);
      await database.client.query(`INSERT INTO ${quotedSchema}."LinkedChildren"
        ("ParentId", "SortOrder", "ChildId", "ChildType")
        SELECT convert_to(md5('frontier-parent-' || ordinal::text)::uuid::text, 'UTF8'), 0,
          convert_to(md5('frontier-child-' || ordinal::text)::uuid::text, 'UTF8'), 0
        FROM generate_series(1, 6000) ordinal`);
      phase('unrelated 12000-item catalogue seed completed');

      await database.insert('BaseItems', item(ids.largeMixFolder, 'Folder', {
        IsFolder: true, Name: 'Large mix', ParentId: ids.physical, TopParentId: ids.physical,
        Path: 'Z:\\Bounded\\LargeMix',
      }));
      const descendantCount = 225;
      phase('large mix 225-item seed start');
      for (let index = 0; index < descendantCount; index++) {
        const Id = `72000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`;
        const genreName = `Bounded Genre ${String(index).padStart(3, '0')}`;
        const genreValueId = `73000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`;
        await database.insert('BaseItems', item(Id, 'Audio.Audio', {
          Name: `Large mix ${String(index).padStart(3, '0')}`, Genres: genreName, MediaType: 'Audio',
          ParentId: ids.largeMixFolder, TopParentId: ids.physical,
          PresentationUniqueKey: Id.replaceAll('-', ''), Path: `Z:\\Bounded\\LargeMix\\${index}.flac`,
        }));
        await database.insert('ItemValues', {
          ItemValueId: genreValueId, CleanValue: genreName.toLowerCase(), Type: 2, Value: genreName,
        });
        await database.insert('ItemValuesMap', { ItemValueId: genreValueId, ItemId: Id });
      }
      await database.client.query(`ANALYZE ${quotedSchema}."BaseItems"`);
      await database.client.query(`ANALYZE ${quotedSchema}."AncestorIds"`);
      await database.client.query(`ANALYZE ${quotedSchema}."LinkedChildren"`);
      phase('large catalogue ready');

      let returnedDescendantIds = 0;
      let returnedGenreScalars = 0;
      let maximumGenrePage = 0;
      let sawFolderMixSources = false;
      let maximumRowsReturned = 0;
      let sawRandomLimit = false;
      let sawBoundedOrdinaryExpansion = false;
      let ordinaryExpansionRows = 0;
      const recursiveStatements = [];
      const recursiveSql = new Set();
      const hadOwnWithConnection = Object.hasOwn(database, 'withConnection');
      const originalWithConnection = database.withConnection;
      const instrumentedClients = new WeakSet();
      const observedResults = new WeakSet();
      database.withConnection = function instrumentPlaybackQuery(operation, options) {
        return originalWithConnection.call(this, async session => {
          const client = session.client;
          if (instrumentedClients.has(client)) return operation(session);
          instrumentedClients.add(client);
          const originalQuery = client.query;
          client.query = async function instrumentQuery(...args) {
            const result = await originalQuery.apply(this, args);
            if (observedResults.has(result)) return result;
            observedResults.add(result);
            const request = args[0];
            const sql = typeof request === 'string' ? request : request?.text ?? '';
            const values = typeof request === 'string' ? args[1] : request?.values;
            const rows = Array.isArray(result?.rows) ? result.rows : [];
            maximumRowsReturned = Math.max(maximumRowsReturned, rows.length);
            if (sql.includes('random()') && values?.includes(200)) sawRandomLimit = true;
            const recursive = sql.includes('WITH RECURSIVE closure("Id") AS')
              || sql.includes('folder_closure("RequestKey", "Id") AS');
            if (recursive) recursiveSql.add(sql);
            if (sql.includes('folder_closure("RequestKey", "Id") AS')
              && sql.includes('playable AS MATERIALIZED')) {
              sawBoundedOrdinaryExpansion = true;
              ordinaryExpansionRows = Math.max(ordinaryExpansionRows, rows.length);
            }
            if (recursive && (sql.includes('ORDER BY closure."Id" COLLATE "C"')
              || sql.includes('folder_closure("RequestKey", "Id") AS'))) {
              recursiveStatements.push({ text: sql, values });
            }
            if (recursive && !sql.includes('random()')
              && rows.some(row => Object.hasOwn(row, 'Id'))) returnedDescendantIds += rows.length;
            if (sql.includes('folder-mix-source-edges')) sawFolderMixSources = true;
            if (sql.includes('folder-mix-genre-page')) {
              returnedGenreScalars += rows.length;
              maximumGenrePage = Math.max(maximumGenrePage, rows.length);
            }
            return result;
          };
          try { return await operation(session); }
          finally { client.query = originalQuery; instrumentedClients.delete(client); }
        }, options);
      };
      let largePlay, largeMix;
      const createdGenres = [];
      const genreFailures = [], getMusicGenre = runtime.library.getMusicGenre.bind(runtime.library);
      runtime.library.getMusicGenre = async name => {
        try { return await getMusicGenre(name); }
        catch (error) { genreFailures.push({ name, message: error.message, code: error.code }); throw error; }
      };
      const observeGenre = ({ Item }) => {
        if (Item.Type !== 'MusicGenre') return;
        createdGenres.push(Item.Name);
        if (createdGenres.length % 64 === 0 || createdGenres.length === descendantCount)
          phase(`large mix created ${createdGenres.length} genres`);
      };
      runtime.library.on('ItemAdded', observeGenre);
      try {
        assert.deepEqual(await play([ids.folder]), wire([ids.alpha, ids.owned, ids.alternate, ids.zulu]));
        assert.deepEqual(await play([ids.boxSet]), wire([ids.alpha, ids.zulu]));
        largePlay = await play([ids.largeMixFolder]);
        maximumRowsReturned = 0;
        returnedDescendantIds = 0;
        phase('large mix 225-genre consumer start');
        largeMix = await play([ids.largeMixFolder], 'PlayInstantMix');
        phase('large mix 225-genre consumer completed');
      }
      finally {
        runtime.library.removeListener('ItemAdded', observeGenre);
        if (hadOwnWithConnection) database.withConnection = originalWithConnection;
        else delete database.withConnection;
      }
      assert.equal(largePlay.length, descendantCount);
      assert.equal(new Set(largePlay).size, descendantCount);
      assert.equal(sawBoundedOrdinaryExpansion, true,
        'ordinary Play must intersect recursive membership with its final SQL item plan');
      assert.equal(ordinaryExpansionRows, descendantCount,
        'ordinary Play may return only its final output-sized identifier page to Node');
      assert.equal(largeMix.length, 200);
      assert.deepEqual(genreFailures.slice(0, 3), [], 'The fixture supplies all native lookup prerequisites.');
      assert.equal(returnedGenreScalars, descendantCount, 'The native lookup consumes every scoped genre.');
      assert.ok(largeMix.every(id => id.startsWith('72000000')), 'Mix selectors exclude unrelated audio.');
      assert.equal(returnedDescendantIds, 0, 'InstantMix must not return its relational descendant set to Node');
      assert.ok(maximumGenrePage <= 128, 'Genre lookup receives bounded source pages.');
      assert.equal(createdGenres.length, descendantCount);
      assert.equal(new Set(createdGenres).size, descendantCount);
      assert.equal(sawFolderMixSources, true);
      assert.ok(maximumRowsReturned <= 200, `query returned ${maximumRowsReturned} rows for a max-200 mix`);
      assert.equal(sawRandomLimit, true, 'random Audio selection must carry the SQL limit');
      for (const sql of recursiveSql) {
        assert.doesNotMatch(sql, /WITH RECURSIVE\s+edges/iu,
          'no recursive playback plan may materialize the complete relationship graph');
        assert.match(sql, /FROM (?:folder_)?closure parent(?:\s+JOIN [^\n]+)?\s+CROSS JOIN LATERAL/iu,
          'every recursive playback plan must expand only its current frontier');
      }

      const parentStatement = recursiveStatements.find(statement => statement.text.includes('FROM '
        + `${quotedSchema}."BaseItems" child`));
      const linkedStatement = recursiveStatements.find(statement => statement.text.includes('FROM '
        + `${quotedSchema}."LinkedChildren" linked`));
      assert.ok(parentStatement, 'folder expansion must issue a frontier-recursive parent query');
      assert.ok(linkedStatement, 'box-set expansion must issue a frontier-recursive linked-child query');
      for (const statement of [parentStatement, linkedStatement]) {
        assert.doesNotMatch(statement.text, /WITH RECURSIVE\s+edges/iu,
          'recursive playback must not materialize the complete relationship graph');
        assert.match(statement.text,
          /FROM (?:folder_)?closure parent(?:\s+JOIN [^\n]+)?\s+CROSS JOIN LATERAL/iu,
          'recursive playback must expand only the current frontier');
        assert.ok(statement.text.includes(`${nativeTextSql(schema).guidKey('relation."ParentItemId"')} = ${nativeTextSql(schema).guidKey('parent."Id"')}`));
      }
      assert.ok(parentStatement.text.includes(`${nativeTextSql(schema).guidKey('child."ParentId"')} = ${nativeTextSql(schema).guidKey('parent."Id"')}`));
      assert.ok(linkedStatement.text.includes(`${nativeTextSql(schema).guidKey('linked."ParentId"')} = ${nativeTextSql(schema).guidKey('parent."Id"')}`));

      const usedIndexes = async statement => {
        const explained = await database.client.query({
          text: `EXPLAIN (FORMAT JSON) ${statement.text}`,
          values: statement.values,
        });
        const names = new Set();
        const visit = value => {
          if (Array.isArray(value)) for (const entry of value) visit(entry);
          else if (value && typeof value === 'object') {
            if (typeof value['Index Name'] === 'string') names.add(value['Index Name']);
            for (const entry of Object.values(value)) visit(entry);
          }
        };
        visit(explained.rows[0]?.['QUERY PLAN']);
        return names;
      };
      phase('frontier explain start');
      const parentIndexes = await usedIndexes(parentStatement);
      assert.ok(parentIndexes.has('mm_runtime_baseitems_parent_normalized_sort_idx'),
        `parent frontier did not use its normalized index: ${[...parentIndexes].join(', ')}`);
      assert.ok(parentIndexes.has('mm_runtime_ancestor_parent_item_normalized_idx'),
        `ancestor frontier did not use its normalized index: ${[...parentIndexes].join(', ')}`);
      const linkedIndexes = await usedIndexes(linkedStatement);
      assert.ok(linkedIndexes.has('mm_runtime_linked_children_parent_child_normalized_idx'),
        `linked frontier did not use its normalized index: ${[...linkedIndexes].join(', ')}`);
      phase('frontier explain completed');
  } finally {
    restoreRows?.();
    phase('runtime close start');
    await runtime?.close();
    phase('runtime close completed');
    await dropSchemas(schema);
    const cleanup = path.resolve(programDataPath);
    assert.equal(path.dirname(cleanup), path.resolve(os.tmpdir()));
    assert.ok(path.basename(cleanup).startsWith('mediamanager-play-query-'));
    await rm(cleanup, { recursive: true, force: true });
  }
});
