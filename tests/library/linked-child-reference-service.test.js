import test from 'node:test';
import assert from 'node:assert/strict';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { LinkedChildReferenceService } from '../../src/library/linked-child-reference-service.js';
import { idKey } from '../../src/library/records.js';
import { MetadataUpdateHost } from '../../src/metadata/update-host.js';
import { setupChildrenFixture } from '../metadata/children-fixture.js';

const FROM = '99A00000-0000-0000-0000-000000000001';
const TO = '99A00000-0000-0000-0000-000000000002';
const FOLDER_A = '99A00000-0000-0000-0000-000000000010';
const FOLDER_B = '99A00000-0000-0000-0000-000000000011';
const NON_FOLDER = '99A00000-0000-0000-0000-000000000012';
const failureValues = error => ({ code: error?.code ?? null, message: error?.message ?? null, status: error?.status ?? null });
const assertFailureValues = (t, actual, expected) => {
  t.diagnostic(JSON.stringify({ failureDiagnostic: { ...failureValues(actual), stack: actual?.stack } }));
  assert.deepEqual(failureValues(actual), failureValues(expected));
  return true;
};

const item = (key, type, Id, filename) => ({ key, type, Id, Name: key,
  Path: `Z:\\ChildSelection\\${filename}` });

async function fixtureFor(t, dialect, controls = {}) {
  const fixture = await setupChildrenFixture(t, dialect);
  await fixture.seed({ target: 'from', items: [
    item('from', 'Movie', FROM, 'from.mkv'),
    item('to', 'Movie', TO, 'to.mkv'),
    item('folder-a', 'Folder', FOLDER_A, 'folder-a'),
    item('folder-b', 'Folder', FOLDER_B, 'folder-b'),
    item('non-folder', 'Movie', NON_FOLDER, 'non-folder.mkv')
  ] });
  const calls = [], saverSnapshots = [], errors = [];
  const authoritativeLoad = fixture.loadContext;
  const loadContext = async (...args) => {
    const loaded = await authoritativeLoad(...args);
    loaded.libraryOptions = { ...loaded.libraryOptions, MetadataSavers: ['Linked fixture'] };
    return loaded;
  };
  fixture.registry.register({ id: 'linked-fixture', name: 'Linked fixture', providers: [{
    id: 'linked-fixture-saver', name: 'Linked fixture', kind: 'saver', itemTypes: ['Folder'],
    isEnabledFor: (_item, reason) => reason === 16,
    validateSave: async current => {
      calls.push(['validate', idKey(current.Id)]);
      await controls.validateSave?.(current);
    },
    save: async (current, context) => {
      calls.push(['saver', idKey(current.Id)]);
      saverSnapshots.push(await snapshot(fixture,current, link=>({id:idKey(link.ItemId),type:Number(link.Type)})));
      await controls.save?.(current, context);
    }
  }] });
  const images = { async updateImages(loaded, _values, options) {
    calls.push(['images', idKey(loaded.item.Id)]);
    await controls.updateImages?.(loaded, options);
  } };
  const creator = new ItemCreationService({ store: fixture.store, library: fixture.library, linkedChildren: fixture.linkedChildren, loadContext });
  fixture.library.itemCreation=creator;
  const liveItems = controls.missingLiveIds ?? new Set();
  const itemCreation = {
    getItemById: id => liveItems.has(idKey(id)) ? Promise.resolve(null) : creator.getItemById(id),
    getCachedItemById: id => liveItems.has(idKey(id)) ? null : creator.getCachedItemById(id),
    retainItem: item => creator.retainItem(item),
    linkedChildren:fixture.linkedChildren, close:()=>creator.close(),
    withItem:(id,operation)=>liveItems.has(idKey(id))?operation(null):creator.withItem(id,operation),
    registerItem: value => creator.registerItem(value)
  };
  fixture.library.itemCreation = itemCreation;
  const updates = new MetadataUpdateHost({ registry: fixture.registry, store: fixture.store, images,
    library: fixture.library, logger: { error: error => errors.push(error) } });
  const service = new LinkedChildReferenceService({ store: fixture.store, itemCreation, loadContext, updates });
  return { ...fixture, calls, saverSnapshots, errors, creator, itemCreation, updates, service };
}

function databaseTest(name, run) {
  for (const dialect of ['postgres']) test(`${dialect}: ${name}`, {
    skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
  }, t => run(t, dialect));
}

async function addLink(fixture, ParentId, SortOrder, ChildId, ChildType = 0) {
  await fixture.database.insert('LinkedChildren', { ParentId, SortOrder, ChildId, ChildType });
}

async function links(fixture, parentId) {
  return (await fixture.database.rows('LinkedChildren', { where: { ParentId: parentId },
    orderBy: [{ column: 'SortOrder', direction: 'ASC' }] }))
    .map(link => ({ id: idKey(link.ChildId), type: Number(link.ChildType), order: Number(link.SortOrder) }));
}

databaseTest('linked references update a source-only row before the live parent saver and image lifecycle', async (t, dialect) => {
  const value = await fixtureFor(t, dialect, { save: async current => {
    assert.deepEqual(await links(value, current.Id), [{ id: idKey(TO), type: 0, order: 0 }]);
  } });
  await addLink(value, FOLDER_A, 0, FROM);
  const [beforeParent] = await value.database.rows('BaseItems', { where: { Id: FOLDER_A } });
  let updateEvents = 0;
  value.updates.on('ItemUpdated', () => { updateEvents += 1; });
  assert.equal(await value.service.reroute(FROM, TO), undefined);
  assert.deepEqual(await links(value, FOLDER_A), [{ id: idKey(TO), type: 0, order: 0 }]);
  assert.deepEqual((await value.database.rows('BaseItems', { where: { Id: FOLDER_A } }))[0], beforeParent);
  assert.equal(updateEvents, 0);
  assert.deepEqual(value.calls, [['validate', idKey(FOLDER_A)], ['saver', idKey(FOLDER_A)], ['images', idKey(FOLDER_A)]]);
  assert.deepEqual(value.saverSnapshots, [[{ id: idKey(TO), type: 0 }]]);
});

databaseTest('linked reference update and delete statements share one serialized writer boundary', async (t, dialect) => {
  const value = await fixtureFor(t, dialect);
  await addLink(value, FOLDER_A, 0, FROM);
  const serializeWrites = value.store.serializeWrites.bind(value.store);
  let boundaries=0,active=0,updates=0,deletes=0;
  value.store.serializeWrites=(operation,options)=>serializeWrites(async database=>{
    boundaries++;active++;const original=database.client.query;
    database.client.query=async(...args)=>{const text=typeof args[0]==='string'?args[0]:args[0].text;
      if(/^UPDATE .*\."LinkedChildren" SET/u.test(text)){assert.equal(active,1);updates++;}
      if(/^DELETE FROM .*\."LinkedChildren" WHERE/u.test(text)){assert.equal(active,1);deletes++;}
      return original(...args);
    };
    try{return await operation(database);}finally{database.client.query=original;active--;}
  },options);

  await value.service.reroute(FROM, TO);

  assert.equal(boundaries, 1);
  assert.equal(updates, 1);
  assert.equal(deletes, 1);
});

databaseTest('an existing target deletes source rows in DB but preserves the native duplicate live saver frame', async (t, dialect) => {
  const value = await fixtureFor(t, dialect);
  await addLink(value, FOLDER_A, 0, TO);
  await addLink(value, FOLDER_A, 1, FROM);
  const live = await value.creator.getItemById(FOLDER_A);
  assert.deepEqual(await snapshot(value,live,link=>idKey(link.ItemId)), [idKey(TO), idKey(FROM)]);
  await value.service.reroute(FROM, TO);
  assert.deepEqual(await links(value, FOLDER_A), [{ id: idKey(TO), type: 0, order: 0 }]);
  assert.deepEqual(await snapshot(value,live,link=>idKey(link.ItemId)), [idKey(TO), idKey(TO)]);
  assert.deepEqual(value.saverSnapshots, [[{ id: idKey(TO), type: 0 }, { id: idKey(TO), type: 0 }]]);
});

databaseTest('duplicate source rows remain duplicate targets when no target existed before rerouting', async (t, dialect) => {
  const value = await fixtureFor(t, dialect);
  await addLink(value, FOLDER_A, 0, FROM);
  await addLink(value, FOLDER_A, 1, FROM);
  const live = await value.creator.getItemById(FOLDER_A);
  await value.service.reroute(FROM, TO);
  assert.deepEqual(await links(value, FOLDER_A), [
    { id: idKey(TO), type: 0, order: 0 }, { id: idKey(TO), type: 0, order: 1 }
  ]);
  assert.deepEqual(await snapshot(value,live,link=>idKey(link.ItemId)), [idKey(TO), idKey(TO)]);
});

databaseTest('DB rerouting filters manual links while native live hydration mutates every matching child type', async (t, dialect) => {
  const value = await fixtureFor(t, dialect);
  await addLink(value, FOLDER_A, 0, FROM, 0);
  await addLink(value, FOLDER_A, 1, FROM, 1);
  const live = await value.creator.getItemById(FOLDER_A);
  await value.service.reroute(FROM, TO);
  assert.deepEqual(await links(value, FOLDER_A), [
    { id: idKey(TO), type: 0, order: 0 }, { id: idKey(FROM), type: 1, order: 1 }
  ]);
  assert.deepEqual(await snapshot(value,live,link=>[idKey(link.ItemId),Number(link.Type)]),
    [[idKey(TO), 0], [idKey(TO), 1]]);
  assert.deepEqual(value.saverSnapshots, [[{ id: idKey(TO), type: 0 }, { id: idKey(TO), type: 1 }]]);
});

databaseTest('nonmanual-only references are a complete no-op', async (t, dialect) => {
  const value = await fixtureFor(t, dialect);
  await addLink(value, FOLDER_A, 0, FROM, 1);
  assert.equal(await value.service.reroute(FROM, TO), undefined);
  assert.deepEqual(await links(value, FOLDER_A), [{ id: idKey(FROM), type: 1, order: 0 }]);
  assert.deepEqual(value.calls, []);
});

databaseTest('each affected parent runs one preflight and one saver/image lifecycle', async (t, dialect) => {
  const value = await fixtureFor(t, dialect);
  await addLink(value, FOLDER_A, 0, FROM);
  await addLink(value, FOLDER_A, 1, FROM);
  await addLink(value, FOLDER_B, 0, FROM);
  assert.equal(await value.service.reroute(FROM, TO), undefined);
  assert.deepEqual(value.calls, [
    ['validate', idKey(FOLDER_A)], ['validate', idKey(FOLDER_B)],
    ['saver', idKey(FOLDER_A)], ['images', idKey(FOLDER_A)],
    ['saver', idKey(FOLDER_B)], ['images', idKey(FOLDER_B)]
  ]);
  assert.deepEqual(await links(value, FOLDER_A), [
    { id: idKey(TO), type: 0, order: 0 }, { id: idKey(TO), type: 0, order: 1 }
  ]);
  assert.deepEqual(await links(value, FOLDER_B), [{ id: idKey(TO), type: 0, order: 0 }]);
});

databaseTest('missing live and non-folder parents retain DB reroutes without saver or image work', async (t, dialect) => {
  const value = await fixtureFor(t, dialect, { missingLiveIds: new Set([idKey(FOLDER_A)]) });
  await addLink(value, FOLDER_A, 0, FROM);
  await addLink(value, NON_FOLDER, 0, FROM);
  assert.equal(await value.service.reroute(FROM, TO), undefined);
  assert.deepEqual(await links(value, FOLDER_A), [{ id: idKey(TO), type: 0, order: 0 }]);
  assert.deepEqual(await links(value, NON_FOLDER), [{ id: idKey(TO), type: 0, order: 0 }]);
  assert.deepEqual(value.calls, [['validate', idKey(FOLDER_A)]]);
});

databaseTest('a saver error is reported and swallowed before images continue', async (t, dialect) => {
  const failure = Object.assign(new Error('Controlled saver failure'), { code: 'controlled-linked-saver-failure' });
  const value = await fixtureFor(t, dialect, { save: async () => { throw failure; } });
  await addLink(value, FOLDER_A, 0, FROM);
  await value.service.reroute(FROM, TO);
  assert.deepEqual(value.calls, [['validate', idKey(FOLDER_A)], ['saver', idKey(FOLDER_A)], ['images', idKey(FOLDER_A)]]);
  t.diagnostic(JSON.stringify({ saverErrorDiagnostics: value.errors.map(error => ({ ...failureValues(error), stack: error?.stack })) }));
  assert.deepEqual(value.errors.filter(error => error?.code !== failure.code || error?.message !== failure.message), []);
  assert.deepEqual(await links(value, FOLDER_A), [{ id: idKey(TO), type: 0, order: 0 }]);
});

databaseTest('an image persistence failure propagates after committed DB and live rerouting', async (t, dialect) => {
  const failure = new Error('Controlled image persistence failure');
  const value = await fixtureFor(t, dialect, { updateImages: async () => { throw failure; } });
  await addLink(value, FOLDER_A, 0, FROM);
  const live = await value.creator.getItemById(FOLDER_A);
  await assert.rejects(value.service.reroute(FROM, TO), error => assertFailureValues(t, error, failure));
  assert.deepEqual(value.calls, [['validate', idKey(FOLDER_A)], ['saver', idKey(FOLDER_A)], ['images', idKey(FOLDER_A)]]);
  assert.deepEqual(await links(value, FOLDER_A), [{ id: idKey(TO), type: 0, order: 0 }]);
  assert.deepEqual(await snapshot(value,live,link=>idKey(link.ItemId)), [idKey(TO)]);
});

databaseTest('a later native delete failure retains completed update statements and stops before live savers', async (t, dialect) => {
  const failure = new Error('Controlled linked delete failure');
  const value = await fixtureFor(t, dialect);
  await addLink(value, FOLDER_A, 0, FROM);
  await addLink(value, FOLDER_A, 1, FROM);
  await addLink(value, FOLDER_B, 0, TO);
  await addLink(value, FOLDER_B, 1, FROM);
  const serialize=value.store.serializeWrites.bind(value.store);
  let updateStatements=0,deleteStatements=0;
  value.store.serializeWrites=(operation,options)=>serialize(async database=>{
    const original=database.client.query;
    database.client.query=async(...args)=>{const text=typeof args[0]==='string'?args[0]:args[0].text;
      if(/^UPDATE .*\."LinkedChildren" SET/u.test(text))updateStatements++;
      if(/^DELETE FROM .*\."LinkedChildren" WHERE/u.test(text)){deleteStatements++;throw failure;}
      return original(...args);
    };
    try{return await operation(database);}finally{database.client.query=original;}
  },options);
  await assert.rejects(value.service.reroute(FROM, TO), error => assertFailureValues(t, error, failure));
  assert.equal(updateStatements, 1);
  assert.equal(deleteStatements, 1);
  assert.deepEqual(await links(value, FOLDER_A), [
    { id: idKey(TO), type: 0, order: 0 }, { id: idKey(TO), type: 0, order: 1 }
  ]);
  assert.deepEqual(await links(value, FOLDER_B), [
    { id: idKey(TO), type: 0, order: 0 }, { id: idKey(FROM), type: 0, order: 1 }
  ]);
  assert.deepEqual(value.calls, [['validate', idKey(FOLDER_A)], ['validate', idKey(FOLDER_B)]]);
});

databaseTest('cancellation raised inside a saver is not passed into and does not interrupt the saver/image boundary', async (t, dialect) => {
  const controller = new AbortController(), reason = new Error('Controlled request cancellation');
  const value = await fixtureFor(t, dialect, {
    save: async (_item, context) => { assert.equal(context.signal, undefined); controller.abort(reason); },
    updateImages: async (_loaded, options) => { assert.equal(options.signal, undefined); assertFailureValues(t, controller.signal.reason, reason); }
  });
  await addLink(value, FOLDER_A, 0, FROM);
  await value.service.reroute(FROM, TO);
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(value.calls, [['validate', idKey(FOLDER_A)], ['saver', idKey(FOLDER_A)], ['images', idKey(FOLDER_A)]]);
});

databaseTest('all affected saver writers preflight before DB, live, saver or image side effects', async (t, dialect) => {
  const failure = new Error('Controlled preflight failure');
  const value = await fixtureFor(t, dialect, { validateSave: async current => {
    if (idKey(current.Id) === idKey(FOLDER_B)) throw failure;
  } });
  await addLink(value, FOLDER_A, 0, FROM);
  await addLink(value, FOLDER_B, 0, FROM);
  const first = await value.creator.getItemById(FOLDER_A), second = await value.creator.getItemById(FOLDER_B);
  await assert.rejects(value.service.reroute(FROM, TO), error => assertFailureValues(t, error, failure));
  assert.deepEqual(value.calls, [['validate', idKey(FOLDER_A)], ['validate', idKey(FOLDER_B)]]);
  assert.deepEqual(await links(value, FOLDER_A), [{ id: idKey(FROM), type: 0, order: 0 }]);
  assert.deepEqual(await links(value, FOLDER_B), [{ id: idKey(FROM), type: 0, order: 0 }]);
  assert.deepEqual(await snapshot(value,first,link=>idKey(link.ItemId)), [idKey(FROM)]);
  assert.deepEqual(await snapshot(value,second,link=>idKey(link.ItemId)), [idKey(FROM)]);
});

async function snapshot(fixture,item,projection){const values=[];for await(const page of fixture.linkedChildren.pages(item.LinkedChildren))for(const link of page)values.push(projection(link));return values;}
