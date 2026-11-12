import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { DomainStore } from '../../src/database/domain-store.js';
import { LibraryService } from '../../src/library/library-service.js';
import { PlaylistService } from '../../src/library/playlist-service.js';
import { initializeLibraryRoot } from '../../src/library/root-initialization.js';
import { idKey } from '../../src/library/records.js';
import { nativeGuid } from '../../src/users/native.js';
import { createPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
import { attachStateDeletion, createStateRelations, closeStateDeletion } from './deletion-fixture.js';
import { testFileSystem } from '../storage/plugin-files.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { errorObservation } from '../helpers/error-observation.js';

export const requiredValidationServices = ['postgres'];
const firstId = '49900000-0000-0000-0000-000000000001';
const secondId = '49900000-0000-0000-0000-000000000002';
const owner = { Id: '49900000-0000-0000-0000-000000000003', MaxParentalRatingScore: null, MaxParentalRatingSubScore: null,
  Policy: { IsAdministrator: false, EnableAllFolders: true, EnabledFolders: [], BlockedMediaFolders: [],
    BlockedTags: [], AllowedTags: [], BlockUnratedItems: [], EnableContentDeletionFromFolders: [] } };
const falsy = [['false', false], ['zero', 0], ['empty', ''], ['null', null], ['undefined', undefined]];
const failures = error => error instanceof AggregateError ? error.errors.flatMap(failures) : [error];
const containsFailure = (error, expected) => error === expected
  || error instanceof AggregateError && error.errors.some(value => containsFailure(value, expected));

test('actual PlaylistService expansion and move preserve SQL writer primary failures and release every operation owner', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 180000,
}, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'playlist-writer-ownership-'));
  const programDataPath = path.join(root, 'program'), dataPath = path.join(root, 'data'), spoolRoot = path.join(root, 'spool');
  const database = await createPostgresTestDatabase(t, 'playlist_writer'), store = new DomainStore(database);
  const linkedChildren = await createStateRelations(database, spoolRoot);
  const options = { fileSystem: testFileSystem, store, linkedChildren, spoolRoot, programDataPath, dataPath,
    serverId: 'playlist-writer-ownership', configuration: {} };
  const library = new LibraryService(options);
  const itemCreation = attachStateDeletion({ store, library, linkedChildren, spoolRoot });
  const backgroundErrors = [], services = [];
  const service = () => {
    const value = new PlaylistService({ ...options, library, onError: error => backgroundErrors.push(error) });
    services.push(value); return value;
  };
  t.after(async () => {
    for (const playlists of services) await playlists.close();
    await closeStateDeletion({ itemCreation, library, linkedChildren });
    await store.close();
  });
  await initializeLibraryRoot({ fileSystem: testFileSystem, store, programDataPath, dataPath, configuration: {} });
  for (const [Id, Name] of [[firstId, 'first'], [secondId, 'second']]) await database.insert('BaseItems', postgresTestRow('BaseItems', {
    Id, Type: 'MediaBrowser.Controller.Entities.Movies.Movie', Name, CleanName: Name, SortName: Name,
    Path: path.join(root, Name + '.mkv'), IsFolder: false, IsMovie: true, MediaType: 'Video', UnratedType: 'Movie', Data: '{}',
  }));
  const initial = service();
  const playlist = await initial.create({ name: 'Stable duplicates', ids: [firstId, secondId, firstId], user: owner });
  await initial.close();
  assert.deepEqual(backgroundErrors, []);
  const playlistId = nativeGuid(playlist.Id);
  const playlistRow = (await database.rows('BaseItems', { where: { Id: playlistId } }))[0];
  const sidecar = path.join(playlistRow.Path, 'playlist.xml'), beforeXml = await fs.readFile(sidecar);
  const beforeRows = await database.rows('LinkedChildren', { where: { ParentId: playlistId }, orderBy: [{ column: 'SortOrder', direction: 'ASC' }] });
  const expectedIds = [firstId, secondId, firstId].map(idKey);
  const counts = async () => {
    await linkedChildren.flushOwnedReleases(); await linkedChildren.flushReleases();
    const value = {};
    for (const [name, table] of [['sets', linkedChildren.sets], ['rows', linkedChildren.rows], ['pins', linkedChildren.pins],
      ...['item_states', 'item_cohorts', 'folder_child_ids'].map(name => [name, `"${linkedChildren.schemaName}".${name}`])]) {
      value[name] = Number((await database.client.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);
    }
    return value;
  };
  const baseline = await counts();
  const samples = ['expand', 'move'].flatMap(operation => [
    ...falsy.map(([name, reason]) => ({ name: `${operation}-read-${name}`, operation, reason, phase: 'read' })),
    { name: `${operation}-finish`, operation, phase: 'finish' },
  ]);
  for (const sample of samples) await t.test(sample.name, async t => {
    const playlists = service(), originalCreateWriter = linkedChildren.createWriter.bind(linkedChildren);
    let temporary, backendPid, primary, dropFailure, finishFailure, failure, restoreQuery;
    let targeted = false, injected = false, drops = 0, aborts = 0, inputRows = 0;
    t.after(async () => {
      linkedChildren.createWriter = originalCreateWriter; restoreQuery?.(); await playlists.close();
    });
    linkedChildren.createWriter = async options => {
      if (targeted || (sample.operation === 'expand' ? options.parentId != null : !options.session.inTransaction)) {
        return originalCreateWriter(options);
      }
      targeted = true;
      const session = options.session, query = session.client.query.bind(session.client);
      restoreQuery = () => { session.client.query = query; };
      backendPid = (await query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      session.client.query = async (statement, ...args) => {
        const sql = typeof statement === 'string' ? statement : statement.text;
        if (sql.startsWith('CREATE TEMP TABLE "mm_link_input_')) {
          temporary = /^CREATE TEMP TABLE ("[^"]+")/u.exec(sql)[1];
          const value = await query(statement, ...args);
          await query(`CREATE TEMP VIEW playlist_member_dependency AS SELECT * FROM ${temporary}`);
          return value;
        }
        if (sql === `DROP TABLE ${temporary}`) {
          drops++;
          try { return await query(statement, ...args); }
          catch (error) { dropFailure = error; throw error; }
        }
        const publication = sample.operation === 'expand' ? sql.startsWith('WITH owned AS')
          : sql.startsWith('DECLARE ') && sql.includes(temporary);
        if (sample.phase === 'finish' && publication) {
          injected = true;
          const changed = sql.replace(sample.operation === 'expand' ? 'source."Ordinal"' : '"Ordinal"', '"AbsentOrdinal"');
          try { return await query(typeof statement === 'string' ? changed : { ...statement, text: changed }, ...args); }
          catch (error) { primary = error; throw error; }
        }
        const value = await query(statement, ...args);
        if (sql.startsWith(`INSERT INTO ${temporary}`)) inputRows += value.rowCount;
        const reading = sample.operation === 'expand' ? sql.startsWith('SELECT ') && sql.includes('"BaseItems"')
          : sql.startsWith('WITH RECURSIVE selected AS');
        if (sample.phase === 'read' && !injected && reading) { injected = true; primary = sample.reason; throw primary; }
        return value;
      };
      const writer = await originalCreateWriter(options);
      return { append: row => writer.append(row), abort: () => { aborts++; return writer.abort(); },
        async finish() {
          try { return await writer.finish(); }
          catch (error) { finishFailure = error; throw error; }
        } };
    };
    const operation = sample.operation === 'expand' ? playlists.add(playlist.Id, [secondId], { user: owner })
      : playlists.move(playlist.Id, idKey(secondId), 2, { user: owner });
    await assert.rejects(operation, error => { failure = error; return true; });
    linkedChildren.createWriter = originalCreateWriter; restoreQuery?.();
    assert.equal(targeted, true); assert.equal(injected, true); assert.equal(drops, 1);
    assert.equal(dropFailure.code, sample.phase === 'finish' && sample.operation === 'move' ? '25P02' : '2BP01');
    const leaves = failures(failure);
    assert.deepEqual(leaves.slice(0, 2), [primary, dropFailure]);
    assert.equal(leaves.filter(value => value === primary).length, 1);
    assert.equal(leaves.filter(value => value === dropFailure).length, 1);
    if (sample.phase === 'finish') {
      assert.equal(primary.code, '42703'); assert.equal(containsFailure(failure, finishFailure), true);
      assert.deepEqual(finishFailure.errors, [primary, dropFailure]); assert.equal(finishFailure.cause, primary);
      assert.equal(finishFailure.code, primary.code); assert.equal(aborts, 0);
      assert.equal(inputRows, sample.operation === 'expand' ? 1 : 3);
    } else { assert.equal(primary, sample.reason); assert.equal(aborts, 1); }
    assert.equal(Number((await database.client.query('SELECT count(*) AS count FROM pg_stat_activity WHERE pid=$1', [backendPid])).rows[0].count), 0);
    assert.equal(Number((await database.client.query('SELECT count(*) AS count FROM pg_class WHERE relname=$1',
      [temporary.slice(1, -1)])).rows[0].count), 0);
    assert.deepEqual(await database.rows('LinkedChildren', { where: { ParentId: playlistId }, orderBy: [{ column: 'SortOrder', direction: 'ASC' }] }), beforeRows);
    assert.deepEqual(await fs.readFile(sidecar), beforeXml);
    assert.deepEqual((await playlists.get(playlist.Id, { user: owner })).ItemIds, expectedIds);
    const afterFailure = await counts(); assert.deepEqual(afterFailure, baseline);
    // A complete subsequent move importer can read and finish the same real
    // duplicate sequence; its selected entry already occupies index zero.
    await playlists.move(playlist.Id, idKey(firstId), 0, { user: owner });
    assert.deepEqual((await playlists.get(playlist.Id, { user: owner })).ItemIds, expectedIds);
    await playlists.close();
    assert.deepEqual(await counts(), baseline); assert.deepEqual(backgroundErrors, []);
    await fs.writeFile(path.join(root, sample.name + '.json'), JSON.stringify({ sample: sample.name,
      failure: errorObservation(failure), inputRows, aborts, drops, afterFailure, recoveredIds: expectedIds }, null, 2) + '\n');
  });
});
