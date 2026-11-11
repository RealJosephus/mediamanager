import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { newNativeItemEntity, publishNativeItemLinks, releaseNativeItemLinks } from '../../src/library/native-item-entity.js';
import { refreshCollectionFolderLocations, collectionFolderNativeType, physicalFolderNativeType } from '../../src/library/top-level-folder-validation.js';
import { createPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { errorObservation } from '../helpers/error-observation.js';

export const requiredValidationServices = ['postgres'];
const collectionId = '49800000-0000-0000-0000-000000000001';
const physicalId = '49800000-0000-0000-0000-000000000002';
const childId = '49800000-0000-0000-0000-000000000003';
const previousId = '49800000-0000-0000-0000-000000000004';
const falsy = [['false', false], ['zero', 0], ['empty', ''], ['null', null], ['undefined', undefined]];

test('CollectionFolder real SQL imports preserve falsy failures, published state and temporary ownership', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 180000,
}, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'top-level-link-ownership-'));
  const database = await createPostgresTestDatabase(t, 'top_link_owner');
  const links = new PostgresLinkedChildrenStore({ database }); await links.initialize();
  t.after(() => links.close());
  for (const [Id, Type] of [[physicalId, physicalFolderNativeType], [childId, 'MediaBrowser.Controller.Entities.Movies.Movie']]) {
    await database.insert('BaseItems', postgresTestRow('BaseItems', { Id, Type, IsFolder: Id === physicalId, Data: '{}' }));
  }
  for (const SortOrder of [0, 1]) await database.insert('LinkedChildren', { ParentId: physicalId, ChildId: childId, ChildType: 0, SortOrder });
  const counts = async () => {
    const value = {};
    for (const [name, table] of [['sets', links.sets], ['rows', links.rows], ['pins', links.pins]]) {
      value[name] = Number((await database.client.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);
    }
    return value;
  };
  const cases = [
    ...['append-read', 'append-release', 'compare-read', 'published-release'].flatMap(phase =>
      falsy.map(([name, reason]) => ({ name: `${phase}-${name}`, phase, reason }))),
    { name: 'finish-publication-and-drop', phase: 'finish', dependent: true },
    { name: 'null-source-and-drop', phase: 'null-source', dependent: true },
  ];
  for (const sample of cases) await t.test(sample.name, async t => {
    const collection = newNativeItemEntity(collectionFolderNativeType); collection.Id = collectionId;
    const physical = newNativeItemEntity(physicalFolderNativeType); physical.Id = physicalId;
    collection.PhysicalLocationsList = ['collection', 'physical']; collection.PhysicalFolderIds = [physicalId];
    const originalWithSession = links.withSession.bind(links), originalLoad = links.load.bind(links);
    const originalCreateWriter = links.createWriter.bind(links);
    let sourceHandle, candidate, failure, publicationFailure, dropFailure, temporary, backendPid;
    let injected = false, drops = 0, aborts = 0;
    const candidates = new Set();
    t.after(async () => {
      links.withSession = originalWithSession; links.load = originalLoad; links.createWriter = originalCreateWriter;
      releaseNativeItemLinks(collection); releaseNativeItemLinks(physical);
      for (const handle of candidates) await links.release(handle);
      if (sourceHandle) await links.release(sourceHandle);
      await links.flushReleases();
    });
    publishNativeItemLinks(collection, await originalWithSession(async session => {
      const writer = await originalCreateWriter({ session, parentId: collectionId });
      await writer.append({ ItemId: previousId, Type: 0 }); return writer.finish();
    }));
    const previous = collection.LinkedChildren;
    if (sample.phase === 'null-source') publishNativeItemLinks(physical, null);
    links.load = async (...args) => {
      const handle = await originalLoad(...args);
      if (args[1] === physicalId) sourceHandle = handle;
      return handle;
    };
    links.createWriter = async options => {
      const writer = await originalCreateWriter(options);
      return { append: row => writer.append(row), abort: () => { aborts++; return writer.abort(); },
        async finish() { candidate = await writer.finish(); candidates.add(candidate); return candidate; } };
    };
    links.withSession = operation => originalWithSession(async session => {
      const query = session.client.query.bind(session.client);
      backendPid = (await query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      session.client.query = async (statement, ...args) => {
        const sql = typeof statement === 'string' ? statement : statement.text;
        const values = typeof statement === 'string' ? args[0] : statement.values;
        if (sql.startsWith('CREATE TEMP TABLE "mm_link_input_')) {
          temporary = /^CREATE TEMP TABLE ("[^"]+")/u.exec(sql)[1];
          const result = await query(statement, ...args);
          if (sample.dependent) await query(`CREATE TEMP VIEW collection_member_dependency AS SELECT * FROM ${temporary}`);
          return result;
        }
        if (sample.phase === 'finish' && sql.startsWith('WITH owned AS')) {
          injected = true;
          try { return await query({ ...statement, text: sql.replace('source."Ordinal"', 'source."AbsentOrdinal"') }, ...args); }
          catch (error) { publicationFailure = error; throw error; }
        }
        if (temporary && sql === `DROP TABLE ${temporary}`) {
          drops++;
          try { return await query(statement, ...args); }
          catch (error) { dropFailure = error; throw error; }
        }
        const result = await query(statement, ...args);
        const isPage = sql.startsWith('SELECT * FROM (');
        const isRelease = sql.startsWith(`DELETE FROM ${links.sets} source WHERE id=$1`);
        const selected = sample.phase === 'append-read' && isPage && values?.[0] === sourceHandle?.entry.id
          || sample.phase === 'append-release' && isRelease && values?.[0] === sourceHandle?.entry.id
          || sample.phase === 'compare-read' && isPage && values?.[0] === candidate?.entry.id
          || sample.phase === 'published-release' && isRelease && values?.[0] === previous.entry.id;
        if (!injected && selected) { injected = true; throw sample.reason; }
        return result;
      };
      try { return await operation(session); }
      finally { session.client.query = query; }
    });
    const loaded = { item: collection, linkedChildren: links,
      async rootFolderResolveArgs(setLocations) { assert.equal(setLocations, true); return { files: [] }; },
      async physicalFolders(enableCache) { assert.equal(enableCache, false); return [physical]; } };
    await assert.rejects(refreshCollectionFolderLocations(loaded), error => { failure = error; return true; });
    links.withSession = originalWithSession; links.load = originalLoad; links.createWriter = originalCreateWriter;
    if (sample.phase === 'finish') {
      assert.equal(publicationFailure.code, '42703'); assert.equal(dropFailure.code, '2BP01');
      assert.deepEqual(failure.errors, [publicationFailure, dropFailure]);
      assert.equal(failure.cause, publicationFailure); assert.equal(failure.code, '42703');
      assert.equal(aborts, 0, 'The caller does not replay cleanup after finish took ownership.');
    } else if (sample.phase === 'null-source') {
      assert.equal(failure.errors.length, 2); assert.ok(failure.errors[0] instanceof TypeError);
      assert.equal(failure.errors[0].status, 500); assert.equal(failure.errors[1], dropFailure);
      assert.equal(dropFailure.code, '2BP01'); assert.equal(failure.cause, failure.errors[0]);
      assert.equal(failure.status, 500); assert.equal(aborts, 1);
    } else {
      assert.equal(injected, true, 'The requested actual SELECT or DELETE completed before the rejected response.');
      if (sample.phase === 'published-release') assert.deepEqual(failure.errors, [sample.reason]);
      else assert.equal(failure, sample.reason);
      assert.equal(aborts, sample.phase.startsWith('append-') ? 1 : 0);
    }
    assert.equal(drops, 1);
    assert.equal(physical.LinkedChildrenLoaded, sample.phase === 'null-source');
    if (sample.phase === 'published-release') {
      assert.equal(collection.LinkedChildren, candidate);
      assert.deepEqual((await links.page(collection.LinkedChildren)).map(row => row.ItemId), [childId, childId]);
    } else {
      assert.equal(collection.LinkedChildren, previous, 'An unsuccessful import cannot publish a partial replacement.');
      assert.deepEqual((await links.page(collection.LinkedChildren)).map(row => row.ItemId), [previousId]);
    }
    assert.equal(Number((await database.client.query('SELECT count(*) AS count FROM pg_class WHERE relname=$1',
      [temporary.slice(1, -1)])).rows[0].count), 0);
    if (sample.dependent) assert.equal(Number((await database.client.query(
      'SELECT count(*) AS count FROM pg_stat_activity WHERE pid=$1', [backendPid])).rows[0].count), 0);
    await links.flushReleases();
    const afterFailure = await counts();
    assert.deepEqual(afterFailure, { sets: 1, rows: sample.phase === 'published-release' ? 2 : 1, pins: 0 });
    const recoverySource = newNativeItemEntity(physicalFolderNativeType); recoverySource.Id = physicalId;
    loaded.physicalFolders = async () => [recoverySource];
    await refreshCollectionFolderLocations(loaded);
    assert.deepEqual((await links.page(collection.LinkedChildren)).map(row => row.ItemId), [childId, childId]);
    releaseNativeItemLinks(collection); await links.flushReleases();
    assert.deepEqual(await counts(), { sets: 0, rows: 0, pins: 0 });
    await fs.writeFile(path.join(root, sample.name + '.json'), JSON.stringify({ sample: sample.name,
      failure: errorObservation(failure), injected, aborts, drops, afterFailure, recoveredIds: [childId, childId] }, null, 2) + '\n');
  });
});
