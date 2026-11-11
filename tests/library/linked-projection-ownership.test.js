import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { createPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { errorObservation } from '../helpers/error-observation.js';

export const requiredValidationServices = ['postgres'];
const parentId = '49600000-0000-0000-0000-000000000001', childId = '49600000-0000-0000-0000-000000000002';

test('SQL XML projections and cursor snapshots release undelivered results after real PostgreSQL cleanup failures', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 60000,
}, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'linked-projection-ownership-'));
  for (const mode of ['xml-writer-admission', 'xml-materialized-release', 'xml-temporary-drop', 'snapshot-cursor-close']) await t.test(mode, async t => {
    const database = await createPostgresTestDatabase(t, 'projection_owner');
    const links = new PostgresLinkedChildrenStore({ database }); await links.initialize();
    let source, recovered, backendFailure, failedPid, temporary, injected = false;
    t.after(async () => {
      if (source) await links.release(source); if (recovered) await links.release(recovered);
      await links.flushReleases(); await links.close();
    });
    await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: childId, Type: 'MediaBrowser.Controller.Entities.Audio.Audio',
      Name: 'Owned audio', SortName: 'Owned audio', Path: 'Z:\\Media\\song.mp3', Data: '{}' }));
    source = await links.withSession(async session => {
      const writer = await links.createWriter({ session, parentId });
      await writer.append({ ItemId: childId, Type: 0 }); await writer.append({ ItemId: childId, Type: 0 }); return writer.finish();
    });
    const counts = async () => {
      const result = {};
      for (const [name, table] of [['sets', links.sets], ['rows', links.rows], ['pins', links.pins]]) result[name] = Number((await database.client.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);
      return result;
    };
    const before = await counts(); assert.deepEqual(before, { sets: 1, rows: 2, pins: 0 });
    const observe = async session => {
      const query = session.client.query.bind(session.client);
      failedPid = (await query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      session.client.query = async (statement, ...args) => {
        const sql = typeof statement === 'string' ? statement : statement.text;
        if (mode === 'xml-temporary-drop' && sql.startsWith('CREATE TEMP TABLE "mm_xml_items_')) {
          temporary = /^CREATE TEMP TABLE ("[^"]+")/u.exec(sql)[1];
          const result = await query(statement, ...args);
          await query(`CREATE TEMP VIEW owned_xml_dependency AS SELECT * FROM ${temporary}`); return result;
        }
        try {
          if (!injected && mode === 'xml-writer-admission' && sql.startsWith('CREATE TEMP TABLE "mm_link_input_')) {
            injected = true; return await query(statement.replace('"Ordinal" bigint', '"Ordinal" missing_projection_type'), ...args);
          }
          if (!injected && mode === 'xml-materialized-release' && sql.startsWith(`DELETE FROM ${links.sets}`)) {
            injected = true; return await query(statement.replace('WHERE id=$1', 'WHERE missing_projection_id=$1'), ...args);
          }
          if (!injected && mode === 'snapshot-cursor-close' && sql.startsWith('CLOSE "mm_link_read_')) {
            injected = true;
            await query(statement, ...args); // The first real CLOSE succeeds.
            return await query(statement, ...args); // PostgreSQL rejects a second CLOSE.
          }
          return await query(statement, ...args);
        } catch (error) { backendFailure = error; throw error; }
      };
    };
    let failed;
    if (mode === 'snapshot-cursor-close') failed = database.transaction(async session => {
      await observe(session); return links.createFromSnapshot({ session, parentId, plan: links.plan(source) });
    }, { readOnly: true });
    else failed = links.withSession(async session => { await observe(session); return links.xmlPaths(source, { session, parentId }); });
    const outcome = await failed.then(value => { recovered = value.paths ?? value; return { value }; }, error => ({ error }));
    assert.ok(Object.hasOwn(outcome, 'error'), 'The actual PostgreSQL failure prevents projection delivery.');
    assert.equal(outcome.error, backendFailure);
    assert.equal(backendFailure.code, { 'xml-writer-admission': '42704', 'xml-materialized-release': '42703',
      'xml-temporary-drop': '2BP01', 'snapshot-cursor-close': '34000' }[mode]);
    await links.flushReleases();
    assert.deepEqual(await counts(), before);
    assert.deepEqual((await links.page(source)).map(row => row.ItemId), [childId, childId]);
    if (mode === 'xml-temporary-drop') {
      assert.equal(Number((await database.client.query('SELECT count(*) AS count FROM pg_stat_activity WHERE pid=$1', [failedPid])).rows[0].count), 0);
      assert.equal(Number((await database.client.query('SELECT count(*) AS count FROM pg_class WHERE relname=$1', [temporary.slice(1, -1)])).rows[0].count), 0);
    }
    const projection = await links.xmlPaths(source, { parentId }); recovered = projection.paths;
    assert.equal(projection.manualCount, 2n);
    assert.deepEqual((await links.page(recovered)).map(row => row.Path), ['Z:\\Media\\song.mp3', 'Z:\\Media\\song.mp3']);
    await links.release(recovered); recovered = undefined; await links.release(source); source = undefined;
    const afterRecovery = await counts(); assert.deepEqual(afterRecovery, { sets: 0, rows: 0, pins: 0 });
    await fs.writeFile(path.join(root, mode + '.json'), JSON.stringify({ mode, failedPid, failure: errorObservation(backendFailure),
      afterFailure: before, afterRecovery, sourceOrderUnchanged: true, recoveredCount: 2 }, null, 2) + '\n');
  });
});
