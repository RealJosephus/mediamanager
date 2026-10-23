import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DomainStore } from '../../src/database/domain-store.js';
import { LibraryService } from '../../src/library/library-service.js';
import { LibraryScanHost } from '../../src/library/library-scan-host.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { setFolderChildren } from '../../src/library/folder-cache.js';
import { observeNativeItemLinkOwnership } from '../../src/library/native-item-entity.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString,
  postgresTestRow } from '../database/postgres-fixture.js';

export const requiredValidationServices = ['postgres'];

const rootId = '46b20000-0000-0000-0000-000000000001';
const childId = '46b20000-0000-0000-0000-000000000002';
const rootPath = '/cached-resource-cycle/root';
const childPath = '/cached-resource-cycle/child';

async function beforeDeadline(operation, message) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 15000);
    })]);
  } finally { clearTimeout(timer); }
}

for (const selected of [false, true]) test(`postgres: formal host shutdown drains mutually cached folders${selected ? ' after both directory selections' : ' with raw branches only'}`, {
  skip: !postgresTestConnectionString, timeout: 60000,
}, async t => {
  let database, linkedChildren, library, manager, host, root, child, closing, primary;
  const observers = [], counts = new Map();
  let phase = 'setup';
  try {
    database = await createPostgresTestDatabase(null, 'cached_cycle', { max: 1 });
    linkedChildren = new PostgresLinkedChildrenStore({ database });
    await linkedChildren.initialize();
    await database.insertBatch('BaseItems', [
      postgresTestRow('BaseItems', { Id: rootId, Type: 'MediaBrowser.Controller.Entities.UserRootFolder',
        IsFolder: true, Name: 'Cycle root', Path: rootPath, Data: '{}' }),
      postgresTestRow('BaseItems', { Id: childId, ParentId: rootId, Type: 'MediaBrowser.Controller.Entities.Folder',
        IsFolder: true, Name: 'Cycle child', Path: childPath, Data: '{}' }),
    ]);
    const store = new DomainStore(database);
    library = new LibraryService({ store, linkedChildren, serverId: 'cached-resource-cycle',
      configuration: { CacheSize: 8 },
      userRoot: { Id: rootId, Type: 'MediaBrowser.Controller.Entities.UserRootFolder', Path: rootPath } });
    manager = new ItemCreationService({ store, library, linkedChildren,
      loadContext: async () => { throw new Error('Metadata refresh is outside this cache lifecycle.'); } });
    library.itemCreation = manager;
    host = new LibraryScanHost({ store, library, itemCreation: manager,
      metadataScanner: {}, topLevelValidation: {} });
    root = await host.getUserRootFolder();
    child = await manager.getItemById(childId);
    for (const item of [root, child]) observers.push(observeNativeItemLinkOwnership(item,
      event => counts.set(item.Id, event.count)));
    // The native mutable Children contract permits an exact object to occur in
    // another Folder's cached graph. Both reads use the formal directory host.
    setFolderChildren(root, [child]);
    setFolderChildren(child, [root]);
    assert.equal(await host.withCachedChildren(root, children =>
      children.firstByPath(selected ? child.Path : '/missing/first')), selected ? child : null);
    assert.equal(await host.withCachedChildren(child, children =>
      children.firstByPath(selected ? root.Path : '/missing/second')), selected ? root : null);

    // This is the runtime's actual service order. A retained cache edge must
    // not prevent the SQL owner from closing after every public owner leaves.
    closing = (async () => {
      phase = 'scan host'; await host.close();
      phase = 'item manager'; await manager.close();
      phase = 'library'; await library.close();
      phase = 'linked children'; await linkedChildren.close();
      phase = 'closed';
    })();
    await beforeDeadline(closing, 'The formal host lifecycle did not drain its cached Folder graph.');
    assert.equal((await database.client.query('SELECT to_regnamespace($1) AS namespace',
      [linkedChildren.schemaName])).rows[0].namespace, null);
  } catch (error) {
    primary = error;
    t.diagnostic(JSON.stringify({ phase, actualOwnerCounts: Object.fromEntries(counts) }));
    throw error;
  } finally {
    const failures = [];
    // Repair only the isolated fixture after the attempted formal close has
    // already passed or failed. A failed close remains the original test error.
    for (const item of [root, child]) if (item) {
      try { setFolderChildren(item, null); } catch (error) { failures.push(error); }
    }
    for (const observer of observers) observer.release();
    for (const action of [() => host?.close(), () => manager?.close(), () => library?.close(),
      () => linkedChildren?.flushOwnedReleases(), () => closing ?? linkedChildren?.close()]) {
      try { await beforeDeadline(Promise.resolve().then(action), 'The isolated cache graph could not finish cleanup.'); }
      catch (error) { failures.push(error); }
    }
    try { await dropPostgresTestDatabase(database); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError([...(primary ? [primary] : []), ...failures],
      'Cached Folder graph fixture cleanup failed.');
  }
});

// This function becomes the main module of an isolated --expose-gc process.
// Every database operation remains an actual max=1 PostgreSQL consumer.
async function scopedGcScenario() {
  const id = value => `46b50000-0000-0000-0000-${String(value).padStart(12, '0')}`;
  const type = value => 'MediaBrowser.Controller.Entities.' + value;
  const folder = (value, kind = 'Folder') => Object.assign(newNativeItemEntity(type(kind)), {
    Id: id(value), Name: 'Private folder ' + value, Path: '/private-children/' + value,
  });
  const turn = () => new Promise(resolve => setImmediate(resolve));
  const gcWindow = async () => {
    // WeakRef targets remain alive until the current job ends. Collect only
    // across real event-loop turns, then observe the actual remaining targets.
    for (let pass = 0; pass < 8; pass++) { await turn(); global.gc(); }
    await turn();
  };
  let database, linkedChildren, library, manager, parent, owner, retained, closing, running, primary;
  const entered = Promise.withResolvers(), resume = Promise.withResolvers(), references = [];
  let phase = 'setup', selectedSlot, targetReference, grandReference, greatReference;
  let residentAfterPaging, privateEntities, privateExternalRoots, closed = false;
  const owners = [];
  try {
    assert.equal(typeof global.gc, 'function');
    for (const observe of [observeFolderChildrenAssignment, observeFolderChildrenInvalidation, observeFolderChildIdsInvalidation]) {
      const probe = folder(2000, 'AggregateFolder');
      let notifications = 0;
      const old = observe(probe, () => {}); old.release();
      const current = observe(probe, () => { notifications++; });
      old.release(); setFolderChildren(probe, null);
      assert.equal(notifications, 1, 'A late old unsubscribe must preserve the current observer generation.');
      current.release();
    }
    database = await createPostgresTestDatabase(null, 'cached_gc', { max: 1 });
    linkedChildren = new PostgresLinkedChildrenStore({ database });
    await linkedChildren.initialize();
    const row = (value, ParentId, kind = 'Folder') => postgresTestRow('BaseItems', {
      Id: id(value), ParentId, Type: type(kind), IsFolder: true,
      Name: 'Stored folder ' + value, SortName: String(value).padStart(6, '0'),
      Path: '/private-children/' + value, Data: '{}',
    });
    await database.insertBatch('BaseItems', [row(1, null),
      ...Array.from({ length: 257 }, (_, index) => row(index + 2, id(1))),
      row(1000, null, 'UserRootFolder'), row(1001, id(1000))]);
    const store = new DomainStore(database);
    library = new LibraryService({ store, linkedChildren, serverId: 'cached-private-gc', configuration: { CacheSize: 8 } });
    manager = new ItemCreationService({ store, library, linkedChildren,
      loadContext: async () => { throw new Error('Metadata is outside this private cache lifecycle.'); } });
    library.itemCreation = manager;
    parent = await manager.getItemById(id(1)); owner = manager.retainItem(parent); owners.push(owner);
    phase = 'read-only cold cursor';
    await store.run(async session => {
      assert.equal((await session.client.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
      await withPostgresCachedFolderChildren({ session, library, item: parent }, async source => {
        retained = source.retain();
        for (let after = 0n;;) {
          const next = await source.withPage({ after, retainItems: true }, page => {
            for (const entry of page.entries) references.push(new WeakRef(entry.item));
            selectedSlot = page.entries.at(-1)?.slot ?? selectedSlot;
            return page.entries.length ? page.after : null;
          });
          if (next === null) break;
          after = next;
        }
      });
      assert.equal((await session.client.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
    }, { readOnly: true });
    assert.equal(references.length, 257);
    await linkedChildren.resourceGraph.collect();
    await gcWindow();
    residentAfterPaging = references.filter(reference => reference.deref()).length;
    assert.ok(residentAfterPaging > 0 && residentAfterPaging <= 128,
      `A 257-item cold scan retained ${residentAfterPaging} exact materialized objects.`);

    phase = 'private Children and ID resources';
    await retained.withSlot(selectedSlot, async child => {
      targetReference = new WeakRef(child);
      let grand = folder(1000, 'UserRootFolder'), great = folder(1002);
      grandReference = new WeakRef(grand); greatReference = new WeakRef(great);
      setFolderChildren(child, [grand]);
      // Populate this root's private IDs, then release its SQL Children. The
      // parent child has still never built its own SQL Children resource.
      await store.run(session => withPostgresCachedFolderChildren({ session, library, item: grand }, async source => {
        await source.withPage({}, page => assert.deepEqual(page.entries.map(entry => entry.item.Id), [id(1001)]));
      }));
      releaseCachedFolderChildren(grand);
      setFolderChildren(grand, [great]); setFolderChildren(great, []);
      privateEntities = [child, grand, great].map(item => linkedChildren.resourceGraph.entity(item).id);
      grand = null; great = null;
    });
    await linkedChildren.resourceGraph.collect();
    privateExternalRoots = await linkedChildren.withSession(async session => Number((await session.client.query(
      `SELECT count(*) AS count FROM ${linkedChildren.resourceGraph.tables.roots} WHERE entity_id=ANY($1::uuid[])`,
      [privateEntities])).rows[0].count));
    assert.equal(privateExternalRoots, 0, 'Internal private Children and ID resources must not create external entity roots.');
    const assertPrivate = async () => {
      const child = targetReference.deref(), grand = grandReference.deref(), great = greatReference.deref();
      assert.ok(child && grand && great, 'Reachable private state must preserve exact, unmaterialized descendants.');
      assert.equal(cachedFolderChildrenSnapshot(child)?.[0], grand);
      assert.equal(cachedFolderChildrenSnapshot(grand)?.[0], great);
      assert.deepEqual(cachedFolderChildrenSnapshot(great), []);
      const ids = postgresFolderChildIds(grand);
      assert.ok(ids, 'Ordinary owner zero must preserve a reachable root\'s original SQL child IDs.');
      assert.equal(await ids.empty(), false);
      const plan = ids.plan();
      const captured = await store.run(async session => (await session.client.query({
        text: `SELECT source."Id" FROM (${plan.text}) source ORDER BY source."Ordinal"`, values: plan.values,
      })).rows.map(row => decodeNativeTextBytes(row.Id)));
      assert.deepEqual(captured, [id(1001)]);
    };
    // These 256 page insertions evict the last slot from the bounded cache.
    // Its private state, rather than its previous selection, must preserve it.
    for (const after of [0n, 128n]) await retained.withPage({ after, limit: 128, retainItems: true }, () => {});
    await linkedChildren.resourceGraph.collect(); await gcWindow(); await assertPrivate();

    phase = 'replace parent while retaining old view';
    setFolderChildren(parent, []);
    await store.run(session => withPostgresCachedFolderChildren({ session, library, item: parent },
      source => source.withPage({}, page => assert.equal(page.entries.length, 0))));
    await linkedChildren.resourceGraph.collect(); await gcWindow(); await assertPrivate();
    owner.release(); await manager.close(); await library.close();
    phase = 'shutdown with admitted old view';
    closing = linkedChildren.close(); closing.then(() => { closed = true; }, () => {});
    await linkedChildren.resourceGraph.flush(); assert.equal(closed, false);
    assert.throws(() => linkedChildren.resourceGraph.entity({}), /not accepting new owners/u);
    running = retained.withSlot(selectedSlot, async child => {
      assert.equal(child, targetReference.deref());
      // Building the child's first SQL Children resource during shutdown is
      // admitted by this existing view, including its max=1 relation work.
      await store.run(session => withPostgresCachedFolderChildren({ session, library, item: child }, async source => {
        await source.withPage({ retainItems: true }, async page => {
          assert.equal(page.entries.length, 1); assert.equal(page.entries[0].item, grandReference.deref());
          entered.resolve(); await resume.promise;
          await assertPrivate(); assert.equal(closed, false);
        });
      }));
    });
    running.catch(() => {});
    await retained.release(); retained = null;
    await beforeDeadline(Promise.race([entered.promise, running]), 'The admitted old view could not build a child cache during shutdown.');
    await linkedChildren.resourceGraph.flush(); assert.equal(closed, false);
    assert.throws(() => linkedChildren.resourceGraph.entity({}), /not accepting new owners/u);
    assert.throws(() => acquireNativeItemLinkOwner(targetReference.deref()), /not accepting new owners/u);
    resume.resolve(); await beforeDeadline(running, 'The admitted private child consumer did not finish.');
    await beforeDeadline(closing, 'The formal SQL owner did not drain the last admitted private child graph.');
    phase = 'closed'; assert.equal(closed, true);
    assert.equal((await database.client.query('SELECT to_regnamespace($1) AS namespace', [linkedChildren.schemaName])).rows[0].namespace, null);
    await gcWindow();
    return { coldItems: references.length, residentAfterPaging, privateExternalRoots,
      privateTargetsAfterClose: [targetReference, grandReference, greatReference].filter(reference => reference.deref()).length,
      phase };
  } catch (error) {
    primary = error;
    const diagnostic = { phase, residentAfterPaging, owners: {} };
    try {
      for (const [name, reference] of [['child', targetReference], ['grand', grandReference], ['great', greatReference]]) {
        const item = reference?.deref();
        if (!item) { diagnostic.owners[name] = null; continue; }
        let count = 0;
        const observer = observeNativeItemLinkOwnership(item, event => { count = event.count; });
        observer.release(); diagnostic.owners[name] = count;
      }
    } catch (observationError) { diagnostic.ownerObservationError = observationError.message; }
    const describeError = (value, depth = 0) => {
      if (!(value instanceof Error)) return { type: typeof value, value: String(value) };
      const detail = { name: value.name, message: value.message, stack: value.stack };
      for (const key of ['code', 'schema', 'table', 'constraint']) if (value[key] !== undefined) detail[key] = value[key];
      if (depth < 2) {
        if (value.cause !== undefined) detail.cause = describeError(value.cause, depth + 1);
        if (Array.isArray(value.errors)) {
          detail.errorCount = value.errors.length;
          detail.errors = value.errors.slice(0, 4).map(error => describeError(error, depth + 1));
        }
      }
      return detail;
    };
    if (closing && phase === 'shutdown with admitted old view' && linkedChildren?.resourceGraph) {
      let graphTimer;
      try {
        diagnostic.graphClose = await Promise.race([
          linkedChildren.resourceGraph.close().then(() => ({ state: 'fulfilled' }),
            failure => ({ state: 'rejected', error: describeError(failure) })),
          new Promise(resolve => { graphTimer = setTimeout(() => resolve({ state: 'pending' }), 25); }),
        ]);
      } catch (observationError) { diagnostic.graphCloseObservationError = describeError(observationError); }
      finally { clearTimeout(graphTimer); }
    }
    let timer;
    try {
      const observeTables = async () => {
        if (!database || !linkedChildren) return;
        // Failure-only reads use the primary pool, independently of a blocked
        // max=1 relation owner. Each query and this observation have a deadline.
        await database.withConnection(async session => {
          const query = (text, values = []) => session.client.query({ text, values, query_timeout: 2000 });
          const schema = '"' + linkedChildren.schemaName + '"';
          const tables = [
            ...Object.entries(linkedChildren.resourceGraph?.tables ?? {}).map(([name, table]) => ({ name, table })),
            ...['sets', 'pins', 'item_states', 'item_cohorts', 'folder_child_ids'].map(name => ({
              name, table: schema + '."' + name + '"', scope: name !== 'sets',
            })),
          ];
          const present = (await query('SELECT name,to_regclass(name)::text AS relation FROM unnest($1::text[]) source(name)',
            [tables.map(value => value.table)])).rows;
          diagnostic.tables = {};
          for (const value of tables) {
            const exists = present.find(row => row.name === value.table)?.relation != null;
            const state = diagnostic.tables[value.name] = { exists };
            if (!exists) continue;
            const row = (await query(`SELECT count(*) AS rows${value.scope ? ',count(DISTINCT scope_id) AS scopes' : ''}
              FROM ${value.table}`)).rows[0];
            state.rows = Number(row.rows);
            if (value.scope) state.scopes = Number(row.scopes);
            if (value.name === 'roots') diagnostic.rootSample = (await query(
              `SELECT token,entity_id,resource_id FROM ${value.table} ORDER BY token LIMIT 8`)).rows;
          }
          const processIds = [...new Set([database, linkedChildren.relationDatabase]
            .flatMap(owner => owner.pool?._clients ?? []).map(client => client.processID)
            .filter(pid => Number.isInteger(pid) && pid > 0))].slice(0, 8);
          diagnostic.connectionActivity = (await query(`SELECT pid,application_name,state,wait_event_type,wait_event,
            left(query,400) AS query FROM pg_stat_activity
            WHERE datname=current_database() AND usename=current_user AND pid<>pg_backend_pid()
              AND (pid=ANY($3::integer[]) OR position($1 in query)>0 OR position($2 in query)>0)
            ORDER BY pid LIMIT 8`, [database.schemaName, linkedChildren.schemaName, processIds])).rows;
        });
      };
      await Promise.race([observeTables(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Failure-only resource observation exceeded 4000 ms.')), 4000);
      })]);
    } catch (observationError) { diagnostic.observationError = observationError.message; }
    finally { clearTimeout(timer); }
    console.error(JSON.stringify(diagnostic));
    throw error;
  } finally {
    resume.resolve();
    const failures = [];
    for (const action of [() => running, () => retained?.release(), ...owners.map(value => () => value.release()),
      () => manager?.close(), () => library?.close(), () => closing ?? linkedChildren?.close()]) {
      try { await beforeDeadline(Promise.resolve().then(action), 'The isolated private Children fixture could not drain.'); }
      catch (error) { if (error !== primary) failures.push(error); }
    }
    try { await dropPostgresTestDatabase(database); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError([...(primary ? [primary] : []), ...failures],
      'Private Children fixture cleanup failed.', primary ? { cause: primary } : undefined);
  }
}

test('postgres: read-only cold snapshots bound materialization and admitted old views preserve private descendants through shutdown', {
  skip: !postgresTestConnectionString, timeout: 180000,
}, async t => {
  const modules = [
    ['{ DomainStore }', '../../src/database/domain-store.js'],
    ['{ LibraryService }', '../../src/library/library-service.js'],
    ['{ ItemCreationService }', '../../src/library/item-creation-service.js'],
    ['{ PostgresLinkedChildrenStore }', '../../src/library/postgres-linked-children.js'],
    ['{ withPostgresCachedFolderChildren }', '../../src/library/postgres-cached-folder-children.js'],
    ['{ cachedFolderChildrenSnapshot, releaseCachedFolderChildren, setFolderChildren, observeFolderChildrenAssignment, observeFolderChildrenInvalidation, observeFolderChildIdsInvalidation }', '../../src/library/folder-cache.js'],
    ['{ postgresFolderChildIds }', '../../src/library/postgres-folder-child-ids.js'],
    ['{ newNativeItemEntity, acquireNativeItemLinkOwner, observeNativeItemLinkOwnership }', '../../src/library/native-item-entity.js'],
    ['{ decodeNativeTextBytes }', '../../src/database/native-text.js'],
    ['{ createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow }', '../database/postgres-fixture.js'],
  ];
  const script = ["import assert from 'node:assert/strict';",
    ...modules.map(([names, path]) => `import ${names} from ${JSON.stringify(new URL(path, import.meta.url).href)};`),
    beforeDeadline.toString(), `(${scopedGcScenario.toString()})().then(result => console.log(JSON.stringify(result)), error => { console.error(error); process.exitCode = 1; });`,
  ].join('\n');
  const environment = { ...process.env };
  for (const key of ['NODE_TEST_CONTEXT', 'MEDIAMANAGER_TEST_REGISTRATION_OUTPUT',
    'MEDIAMANAGER_TEST_REGISTRATION_ROOT', 'MEDIAMANAGER_TEST_REGISTRATION_SELECTED']) delete environment[key];
  const child = spawn(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], {
    env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
  let timer;
  try {
    const result = await new Promise((resolve, reject) => {
      timer = setTimeout(() => { child.kill(); reject(new Error('The isolated private Children process exceeded its deadline.')); }, 150000);
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
    });
    if (stderr) t.diagnostic(stderr);
    assert.equal(result.code, 0, `The private Children process failed (${result.signal ?? 'exit'}): ${stderr}`);
    const receipt = JSON.parse(stdout.trim());
    assert.equal(receipt.coldItems, 257); assert.ok(receipt.residentAfterPaging <= 128);
    assert.equal(receipt.privateExternalRoots, 0);
    assert.equal(receipt.phase, 'closed'); t.diagnostic(JSON.stringify(receipt));
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill(); }
});
