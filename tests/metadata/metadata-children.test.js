import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setupChildrenFixture } from './children-fixture.js';
import { createMetadataChildren } from '../../src/library/metadata-children.js';
import { idKey } from '../../src/library/records.js';
import { setFolderChildren } from '../../src/library/folder-cache.js';
import { EMPTY_NATIVE_LINKS } from '../../src/library/postgres-linked-children.js';
import { publishNativeItemLinks } from '../../src/library/native-item-entity.js';

const root = new URL('./fixtures/metadata-children/', import.meta.url);
const input = JSON.parse(await readFile(new URL('input.json', root), 'utf8'));
const native = JSON.parse(await readFile(new URL('native.json', root), 'utf8'));

test('metadata children oracle seals native selectors and explicit query-result controls', async () => {
  const provenance = JSON.parse(await readFile(new URL('provenance.json', root), 'utf8'));
  for (const [key, filename] of Object.entries({ input: 'input.json', native: 'native.json', oracle: 'Program.cs', project: 'Oracle.csproj' })) {
    assert.equal(createHash('sha256').update(await readFile(new URL(filename, root))).digest('hex'), provenance.files[key].sha256);
  }
  assert.equal(createHash('sha256').update(await readFile(new URL('../Directory.Build.props', import.meta.url))).digest('hex'), provenance.files.buildProperties.sha256);
  assert.equal(native.inputSha256, provenance.files.input.sha256);
  assert.equal(native.candidateVerified, false); assert.equal(provenance.candidateVerified, false);
  assert.equal(input.length, 15); assert.equal(native.results.length, input.length);
});

for (const dialect of ['postgres']) {
  const options = {};
  test(`${dialect}: native metadata child selection, TV getters/filter/order and authority match 15 controls`, options, async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    for (const scenario of input) await t.test(scenario.name, async () => {
      const Id = await fixture.seed(scenario), loaded = await fixture.loadContext(Id), target = loaded.item;
      const keyFor = item => scenario.items.find(entry => idKey(entry.Id) === idKey(item.Id)).key;
      const expected = native.results.find(result => result.name === scenario.name);
      const source = createMetadataChildren(fixture);
      const collect = async sequence => { try { const result=[]; for await (const page of sequence.pages()) { assert.ok(page.length<=128); for(const item of page)result.push(keyFor(item)); } return result; } finally { await sequence.close(); } };
      assert.deepEqual(await collect(await source.children(target)), expected.children);

      assert.deepEqual(await collect(await loaded.metadataChildren(loaded.item)), expected.children, 'the production context uses the authoritative selector');
      if (target.Type === 'MusicAlbum') assert.deepEqual(await collect(await loaded.context.tracks()), expected.children);
      if (expected.queries.length && target.Type === 'Season') {
        const query = expected.queries[0];
        assert.equal(query.SeriesPresentationUniqueKey, scenario.displaySpecials === false ? null : scenario.items.find(item => item.type === 'Series').PresentationUniqueKey);
        assert.equal(query.AncestorWithPresentationUniqueKey, scenario.displaySpecials === false ? target.PresentationUniqueKey : null);
        assert.deepEqual(query.IncludeItemTypes, ['Episode']); assert.equal(query.IsMissing, null);
      }
      if (expected.queries.length && target.Type === 'MusicArtist') {
        const query = expected.queries[0];
        assert.deepEqual(query.IncludeItemTypes, ['Audio', 'MusicVideo', 'MusicAlbum']); assert.equal(query.IsFolder, false);
        assert.equal(query.Recursive, true); assert.deepEqual(query.ArtistIds.map(idKey), [idKey(Id)]);
      }
    });
  });
}

const cleanupScenario = { target: 'box', items: [
  { key: 'box', type: 'BoxSet', Id: 'fc170000-0000-0000-0000-000000000001', Path: 'Z:\\ChildSelection\\Cleanup', links: ['movie'] },
  { key: 'movie', type: 'Movie', Id: 'fc170000-0000-0000-0000-000000000002', Path: 'Z:\\ChildSelection\\Cleanup\\Movie.mkv' },
] };

test('postgres: physical metadata child publication retains an existing BoxSet member sequence', async t => {
  const fixture = await setupChildrenFixture(t);
  const ids = { root: 'fc230000-0000-0000-0000-000000000001', box: 'fc230000-0000-0000-0000-000000000002',
    first: 'fc230000-0000-0000-0000-000000000003', second: 'fc230000-0000-0000-0000-000000000004' };
  await fixture.seed({ target: 'root', items: [
    { key: 'root', type: 'Folder', Id: ids.root, Path: 'Z:\\ChildSelection\\Publication' },
    { key: 'box', type: 'BoxSet', Id: ids.box, Path: 'Z:\\ChildSelection\\Publication\\Box', parent: 'root', links: ['first', 'second'] },
    { key: 'first', type: 'Movie', Id: ids.first, Path: 'Z:\\ChildSelection\\First.mkv' },
    { key: 'second', type: 'Movie', Id: ids.second, Path: 'Z:\\ChildSelection\\Second.mkv' },
  ] });
  const before = await fixture.database.rows('LinkedChildren');
  const beforeTemp = await fixture.store.run(tempRelations);
  const parent = await fixture.library.itemCreation.getItemById(ids.root);
  const source = createMetadataChildren(fixture), physical = await source.physical(parent);
  let primary, failed = false;
  try {
    let boxes = 0;
    for await (const page of physical.pages()) for (const child of page) {
      assert.equal(idKey(child.Id), idKey(ids.box)); boxes++;
      fixture.library.itemCreation.registerItem(child);
      const cached = await fixture.library.itemCreation.getItemById(ids.box);
      const collect = async () => {
        const members = await source.children(cached);
        let primary, failed = false;
        try {
          const actual = [];
          for await (const values of members.pages()) for (const member of values) actual.push({
            id: idKey(member.Id), name: member.Name, path: member.Path, type: member.NativeType,
          });
          return actual;
        } catch (reason) { primary = reason; failed = true; throw reason; }
        finally {
          try { await members.close(); }
          catch (cleanup) {
            if (failed) throw new AggregateError([primary, cleanup], 'Metadata member read and cleanup failed.', { cause: primary });
            throw cleanup;
          }
        }
      };
      const expected = [
        { id: idKey(ids.first), name: 'first', path: 'Z:\\ChildSelection\\First.mkv', type: 'MediaBrowser.Controller.Entities.Movies.Movie' },
        { id: idKey(ids.second), name: 'second', path: 'Z:\\ChildSelection\\Second.mkv', type: 'MediaBrowser.Controller.Entities.Movies.Movie' },
      ];
      assert.deepEqual(await collect(), expected);
      publishNativeItemLinks(cached, EMPTY_NATIVE_LINKS);
      assert.deepEqual(await collect(), []);
      publishNativeItemLinks(cached, null);
      await assert.rejects(collect(), reason => { assert.equal(reason.status, 500); return true; });
      publishNativeItemLinks(cached, EMPTY_NATIVE_LINKS);
      assert.deepEqual(await collect(), []);
      await fixture.store.run(async session => {
        publishNativeItemLinks(cached, await fixture.linkedChildren.load(session, cached.Id));
      });
      assert.deepEqual(await collect(), expected);
    }
    assert.equal(boxes, 1);
  } catch (reason) { primary = reason; failed = true; throw reason; }
  finally {
    try { await physical.close(); }
    catch (cleanup) {
      if (failed) throw new AggregateError([primary, cleanup], 'Physical metadata read and cleanup failed.', { cause: primary });
      throw cleanup;
    }
  }
  assert.deepEqual(await fixture.database.rows('LinkedChildren'), before);
  assert.deepEqual(await fixture.store.run(tempRelations), beforeTemp);
});

test('postgres: explicit Playlist Children overrides its empty cold loader and an empty cache excludes stored rows', async t => {
  const fixture = await setupChildrenFixture(t);
  const parentId = 'fc180000-0000-0000-0000-000000000001', childId = 'fc180000-0000-0000-0000-000000000002';
  await fixture.seed({ target: 'playlist', items: [
    { key: 'playlist', type: 'Playlist', Id: parentId, Path: 'Z:\\ChildSelection\\Cached.m3u' },
    { key: 'child', type: 'Movie', Id: childId, Path: 'Z:\\ChildSelection\\Cached.mkv', parent: 'playlist' },
  ] });
  await fixture.database.update('BaseItems', { Id: parentId }, { Type: 'MediaBrowser.Controller.Playlists.Playlist', IsFolder: true });
  const parent = await fixture.library.itemCreation.getItemById(parentId), child = await fixture.library.itemCreation.getItemById(childId);
  const source = createMetadataChildren(fixture);
  const collect = async () => {
    const sequence = await source.recursive(parent, { includeLinkedChildren: false });
    try { const ids = []; for await (const page of sequence.pages()) for (const item of page) ids.push(item.Id); return ids; }
    finally { await sequence.close(); }
  };
  assert.deepEqual(await collect(), [], 'the cold native Playlist loader excludes physical ParentId rows');
  setFolderChildren(parent, [child]);
  assert.deepEqual(await collect(), [childId], 'explicit Children must precede the subclass cold loader');
  setFolderChildren(parent, []);
  assert.deepEqual(await collect(), [], 'an explicitly captured empty Children value remains authoritative');
});

test('postgres: cached physical recursion preserves exact nested Children order and excludes uncached persisted siblings', async t => {
  const fixture = await setupChildrenFixture(t);
  const Id = 'fc190000-0000-0000-0000-000000000001', playlistId = 'fc190000-0000-0000-0000-000000000002',
    childId = 'fc190000-0000-0000-0000-000000000003', siblingId = 'fc190000-0000-0000-0000-000000000004';
  await fixture.seed({ target: 'root', items: [
    { key: 'root', type: 'Folder', Id, Path: 'Z:\\ChildSelection\\Cached' },
    { key: 'playlist', type: 'Playlist', Id: playlistId, Path: 'Z:\\ChildSelection\\Cached\\List.m3u', parent: 'root' },
    { key: 'child', type: 'Movie', Id: childId, Path: 'Z:\\ChildSelection\\Detached.mkv' },
    { key: 'sibling', type: 'Movie', Id: siblingId, Path: 'Z:\\ChildSelection\\Cached\\Sibling.mkv', parent: 'root' },
  ] });
  await fixture.database.update('BaseItems', { Id: playlistId }, { Type: 'MediaBrowser.Controller.Playlists.Playlist', IsFolder: true });
  const creator = fixture.library.itemCreation, parent = await creator.getItemById(Id), playlist = await creator.getItemById(playlistId),
    child = await creator.getItemById(childId);
  child.Name = 'Exact cached child';
  setFolderChildren(parent, [playlist]); setFolderChildren(playlist, [child]);
  const source = createMetadataChildren(fixture);
  for (const recursive of [false, true]) {
    const sequence = recursive ? await source.recursive(parent, { includeLinkedChildren: false }) : await source.physical(parent);
    try {
      const observed = [];
      for await (const page of sequence.pages()) for (const item of page) observed.push({ Id: item.Id, Name: item.Name });
      assert.deepEqual(observed, recursive ? [{ Id: playlistId, Name: 'playlist' }, { Id: childId, Name: 'Exact cached child' }]
        : [{ Id: playlistId, Name: 'playlist' }]);
    } finally { await sequence.close(); }
  }
});
const tempRelations = async session => (await session.client.query(`SELECT relname FROM pg_class
  WHERE relnamespace=pg_my_temp_schema() AND relkind='r' ORDER BY relname`)).rows.map(row => row.relname);
function linkFacade(store, admission) {
  return new Proxy(store, { get(target, key) {
    if (key === 'admitScope') return admission;
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

test('postgres: linked selection releases membership TEMP after actual relation admission closes', async t => {
  const fixture = await setupChildrenFixture(t), Id = await fixture.seed(cleanupScenario);
  const loaded = await fixture.loadContext(Id);
  let admitted = 0, closing;
  const facade = linkFacade(fixture.linkedChildren, () => {
    if (++admitted === 2) closing = fixture.linkedChildren.close();
    return fixture.linkedChildren.admitScope();
  });
  try {
    await fixture.store.run(async session => {
      const before = await tempRelations(session);
      await assert.rejects(createMetadataChildren({ ...fixture, linkedChildren: facade }).children(loaded.item),
        /SQL link runtime is not active/u);
      assert.equal(admitted, 2);
      assert.deepEqual(await tempRelations(session), before, 'the completed membership allocation is disposed before returning the admission error');
    });
  } finally { await loaded.dispose(); if (closing) await closing; }
});

for (const failOperation of [false, true]) test('postgres: linked selection releases membership TEMP after a real cohort cleanup SQL error'
  + (failOperation ? ' and preserves the original selection error' : ''), async t => {
  const fixture = await setupChildrenFixture(t), Id = await fixture.seed(cleanupScenario);
  const loaded = await fixture.loadContext(Id);
  let admitted = 0, injected;
  const facade = linkFacade(fixture.linkedChildren, () => {
    const scope = fixture.linkedChildren.admitScope();
    if (++admitted !== 2) return scope;
    return { release: scope.release, run: operation => scope.run(async session => {
      const query = session.client.query, bound = query.bind(session.client);
      let releasing = false;
      session.client.query = async (...args) => {
        const text = typeof args[0] === 'string' ? args[0] : args[0].text;
        if (/^DELETE FROM .*\.item_cohorts /u.test(text)) releasing = true;
        return bound(...args);
      };
      try {
        const result = await operation(session);
        if (releasing && !injected) {
          try { await bound('SELECT 1 / 0'); } catch (error) { injected = error; throw error; }
        }
        return result;
      } finally { session.client.query = query; }
    }) };
  });
  try {
    await fixture.store.run(async session => {
      const before = await tempRelations(session);
      const query = session.client.query, bound = query.bind(session.client);
      let primary;
      session.client.query = async (...args) => {
        const text = typeof args[0] === 'string' ? args[0] : args[0].text;
        if (failOperation && !primary && /^CREATE TEMP TABLE "mm_link_resolution_batch_/u.test(text)) {
          try { await bound("SELECT 'invalid-integer'::integer"); } catch (error) { primary = error; throw error; }
        }
        return bound(...args);
      };
      try {
      await assert.rejects(createMetadataChildren({ ...fixture, linkedChildren: facade }).children(loaded.item), error => {
        assert.equal(injected?.code, '22012', 'the failure comes from the actual PostgreSQL server');
        assert.ok(error instanceof AggregateError);
        assert.ok(error.errors.some(cleanup => cleanup instanceof AggregateError && cleanup.errors.includes(injected)));
        if (failOperation) {
          assert.equal(primary?.code, '22P02');
          assert.equal(error.cause, primary);
          assert.equal(error.errors[0], primary);
        }
        return true;
      });
      assert.equal(admitted, 2);
      assert.deepEqual(await tempRelations(session), before, 'membership disposal still runs after cohort release rejects');
      } finally { session.client.query = query; }
    });
    await fixture.linkedChildren.withSession(async session => {
      for (const table of ['item_states', 'item_cohorts', 'pins']) {
        assert.equal(BigInt((await session.client.query(`SELECT count(*) AS count FROM "${fixture.linkedChildren.schemaName}".${table}`)).rows[0].count), 0n);
      }
    });
  } finally { await loaded.dispose(); }
});

test('postgres: uncached recursive loading uses fresh repository descendants instead of another same-ID cache snapshot', async t => {
  const fixture = await setupChildrenFixture(t);
  const Id = 'fc1a0000-0000-0000-0000-000000000001', nestedId = 'fc1a0000-0000-0000-0000-000000000002',
    physicalId = 'fc1a0000-0000-0000-0000-000000000003', detachedId = 'fc1a0000-0000-0000-0000-000000000004',
    siblingId = 'fc1a0000-0000-0000-0000-000000000005';
  await fixture.seed({ target: 'root', items: [
    { key: 'root', type: 'Folder', Id, Path: 'Z:\\ChildSelection\\Fresh' },
    { key: 'nested', type: 'Folder', Id: nestedId, Path: 'Z:\\ChildSelection\\Fresh\\Nested', parent: 'root' },
    { key: 'physical', type: 'Movie', Id: physicalId, Path: 'Z:\\ChildSelection\\Fresh\\Nested\\Physical.mkv', parent: 'nested' },
    { key: 'detached', type: 'Movie', Id: detachedId, Path: 'Z:\\ChildSelection\\Detached.mkv' },
    { key: 'sibling', type: 'Movie', Id: siblingId, Path: 'Z:\\ChildSelection\\Fresh\\Sibling.mkv', parent: 'root' },
  ] });
  const creator = fixture.library.itemCreation, parent = await creator.getItemById(Id), nested = await creator.getItemById(nestedId),
    detached = await creator.getItemById(detachedId);
  setFolderChildren(nested, [detached]);
  const sequence = await createMetadataChildren(fixture).recursive(parent, { includeLinkedChildren: false });
  try {
    const observed = [];
    for await (const page of sequence.pages()) for (const item of page) observed.push(item.Id);
    assert.deepEqual(observed, [nestedId, physicalId, siblingId], 'Folder.GetCachedChildren loads fresh repository objects for an uncached root');
  } finally { await sequence.close(); }
});

test('postgres: selection retains and releases its completed view when TEMP cleanup reports an actual SQL failure', async t => {
  const fixture = await setupChildrenFixture(t);
  const Id = 'fc1b0000-0000-0000-0000-000000000001';
  await fixture.seed({ target: 'root', items: [
    { key: 'root', type: 'Folder', Id, Path: 'Z:\\ChildSelection\\ViewCleanup' },
    { key: 'child', type: 'Movie', Id: 'fc1b0000-0000-0000-0000-000000000002', Path: 'Z:\\ChildSelection\\ViewCleanup\\Child.mkv', parent: 'root' },
  ] });
  const loaded = await fixture.loadContext(Id);
  let injected;
  try {
    await fixture.store.run(async session => {
      const before = await tempRelations(session), original = session.client.query, bound = original.bind(session.client);
      session.client.query = async (...args) => {
        const text = typeof args[0] === 'string' ? args[0] : args[0].text;
        const result = await bound(...args);
        if (!injected && /^DROP TABLE "mm_metadata_selection_/u.test(text)) {
          try { await bound('SELECT 1 / 0'); } catch (error) { injected = error; throw error; }
        }
        return result;
      };
      try {
        await assert.rejects(createMetadataChildren(fixture).recursive(loaded.item, { includeLinkedChildren: false }), error => {
          assert.equal(injected?.code, '22012');
          assert.ok(error instanceof AggregateError);
          assert.ok(error.errors.includes(injected));
          return true;
        });
      } finally { session.client.query = original; }
      assert.deepEqual(await tempRelations(session), before);
    });
    await fixture.linkedChildren.withSession(async session => {
      for (const table of ['item_states', 'item_cohorts', 'pins']) assert.equal(BigInt((await session.client.query(
        `SELECT count(*) AS count FROM "${fixture.linkedChildren.schemaName}".${table}`)).rows[0].count), 0n);
    });
  } finally { await loaded.dispose(); }
});
