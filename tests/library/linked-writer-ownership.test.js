import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { errorObservation } from '../helpers/error-observation.js';

export const requiredValidationServices = ['postgres'];
const parentId = '49500000-0000-0000-0000-000000000001', childId = '49500000-0000-0000-0000-000000000002';

test('SQL member writers release undelivered relations and retire connections when real PostgreSQL refuses temporary table cleanup', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 60000,
}, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'linked-writer-ownership-'));
  for (const mode of ['finish', 'publication-failure', 'abort']) await t.test(mode, async t => {
    const database = await createPostgresTestDatabase(t, 'writer_owner');
    const links = new PostgresLinkedChildrenStore({ database }); await links.initialize();
    t.after(() => links.close());
    let backendPid, temporary, rejectedDrop, rejectedPublication, failure;
    await links.withSession(async session => {
      const query = session.client.query.bind(session.client);
      backendPid = (await query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      session.client.query = async (statement, ...args) => {
        const sql = typeof statement === 'string' ? statement : statement.text;
        // The actual writer table has an actual dependent view. PostgreSQL
        // refuses DROP without CASCADE; no mocked rejection replaces that I/O.
        if (sql.startsWith('CREATE TEMP TABLE "mm_link_input_')) {
          temporary = /^CREATE TEMP TABLE ("[^"]+")/u.exec(sql)[1];
          const value = await query(statement, ...args);
          await query(`CREATE TEMP VIEW owned_writer_dependency AS SELECT * FROM ${temporary}`);
          return value;
        }
        if (mode === 'publication-failure' && sql.startsWith('WITH owned AS')) {
          try { return await query({ ...statement, text: sql.replace('source."Ordinal"', 'source."AbsentOrdinal"') }, ...args); }
          catch (error) { rejectedPublication = error; throw error; }
        }
        try { return await query(statement, ...args); }
        catch (error) { if (sql === `DROP TABLE ${temporary}`) rejectedDrop = error; throw error; }
      };
      const writer = await links.createWriter({ session, parentId });
      await writer.append({ ItemId: childId, Type: 0 });
      await writer.append({ ItemId: childId, Type: 0 });
      await assert.rejects(mode === 'abort' ? writer.abort() : writer.finish(), error => { failure = error; return true; });
      assert.equal(rejectedDrop.code, '2BP01');
      if (mode === 'publication-failure') {
        assert.equal(rejectedPublication.code, '42703');
        assert.equal(failure.cause, rejectedPublication); assert.deepEqual(failure.errors, [rejectedPublication, rejectedDrop]);
      } else assert.equal(failure, rejectedDrop);
      await assert.rejects(writer.abort(), error => { assert.equal(error, rejectedDrop); return true; });
    });
    // These reads use an independent physical backend after the failed session
    // exits. They observe actual disconnection and disappearance of its TEMPs.
    assert.equal(Number((await database.client.query('SELECT count(*) AS count FROM pg_stat_activity WHERE pid=$1', [backendPid])).rows[0].count), 0);
    assert.equal(Number((await database.client.query('SELECT count(*) AS count FROM pg_class WHERE relname=$1', [temporary.slice(1, -1)])).rows[0].count), 0);
    await links.flushReleases();
    const counts = async () => {
      const result = {};
      for (const [name, table] of [['sets', links.sets], ['rows', links.rows], ['pins', links.pins]]) result[name] = Number((await database.client.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);
      return result;
    };
    const afterFailure = await counts(); assert.deepEqual(afterFailure, { sets: 0, rows: 0, pins: 0 });
    const recovered = await links.withSession(async session => {
      const writer = await links.createWriter({ session, parentId });
      await writer.append({ ItemId: childId, Type: 0 }); await writer.append({ ItemId: childId, Type: 0 });
      return writer.finish();
    });
    assert.deepEqual((await links.page(recovered)).map(row => row.ItemId), [childId, childId]);
    await links.release(recovered); assert.deepEqual(await counts(), afterFailure);
    await fs.writeFile(path.join(root, mode + '.json'), JSON.stringify({ mode, backendPid, temporary,
      failure: errorObservation(failure), backendEnded: true, temporaryRemoved: true, afterFailure, recoveredIds: [childId, childId] }, null, 2) + '\n');
  });
});

test('SQL writer finish and repeated abort join admitted real writes, publication and the same DROP completion', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 90000,
}, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'linked-writer-drain-'));
  const pending = async operation => {
    let settled = false;
    void operation.then(() => { settled = true; }, () => { settled = true; });
    await immediate(); assert.equal(settled, false, 'The writer must join its actual pending SQL resource work.');
  };
  const outcome = operation => operation.then(value => ({ value }), error => ({ error }));
  const reach = (gate, operation) => Promise.race([gate.promise, operation.then(() => { throw new Error('The writer ended before its real SQL barrier.'); })]);
  const drops = [{ name: 'completed' }, { name: 'postgres-rejection', rejected: true, dependent: true },
    ...[['false', false], ['zero', 0], ['empty', ''], ['null', null], ['undefined', undefined]]
      .map(([name, reason]) => ({ name, reason, rejected: true }))];
  for (const operation of ['finish', 'abort']) for (const drop of drops) await t.test(`${operation}/${drop.name}`, async t => {
    const database = await createPostgresTestDatabase(t, 'writer_drain');
    const links = new PostgresLinkedChildrenStore({ database }); await links.initialize();
    const input = Promise.withResolvers(), resumeInput = Promise.withResolvers();
    const published = Promise.withResolvers(), resumePublished = Promise.withResolvers();
    const dropping = Promise.withResolvers(), resumeDrop = Promise.withResolvers();
    let run, recovered, finishingWork, backendPid, temporary, dropFailure, dropCalls = 0, inputObserved = false, publicationObserved = false;
    const observations = [], work = [];
    t.after(async () => {
      input.resolve(); published.resolve(); dropping.resolve();
      resumeInput.resolve(); resumePublished.resolve(); resumeDrop.resolve();
      await Promise.allSettled([run, ...work]);
      const finished = await finishingWork;
      if (finished && Object.hasOwn(finished, 'value')) await links.release(finished.value);
      if (recovered) await links.release(recovered);
      await links.flushReleases(); await links.close();
    });
    run = links.withSession(async session => {
      const query = session.client.query.bind(session.client);
      backendPid = (await query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      session.client.query = async (statement, ...args) => {
        const sql = typeof statement === 'string' ? statement : statement.text;
        if (sql.startsWith('CREATE TEMP TABLE "mm_link_input_')) {
          temporary = /^CREATE TEMP TABLE ("[^"]+")/u.exec(sql)[1];
          const result = await query(statement, ...args);
          if (drop.dependent) await query(`CREATE TEMP VIEW owned_writer_dependency AS SELECT * FROM ${temporary}`);
          return result;
        }
        if (sql === `DROP TABLE ${temporary}`) {
          dropCalls++;
          let result = await query(statement, ...args).then(value => ({ value }), error => ({ error }));
          if (!Object.hasOwn(result, 'error') && Object.hasOwn(drop, 'reason')) result = { error: drop.reason };
          if (Object.hasOwn(result, 'error')) dropFailure = result.error;
          dropping.resolve(); await resumeDrop.promise;
          if (Object.hasOwn(result, 'error')) throw result.error;
          return result.value;
        }
        const result = await query(statement, ...args);
        if (!inputObserved && sql.startsWith(`INSERT INTO ${temporary}`)) {
          inputObserved = true; input.resolve(); await resumeInput.promise;
        }
        if (!publicationObserved && sql.startsWith('WITH owned AS')) {
          publicationObserved = true; published.resolve(); await resumePublished.promise;
        }
        return result;
      };
      const writer = await links.createWriter({ session, parentId });
      let finished, lastAppend, queuedAppend;
      for (let ordinal = 1; ordinal <= 127; ordinal++) await writer.append({ ItemId: childId, Path: String(ordinal), Type: 0 });
      lastAppend = outcome(writer.append({ ItemId: childId, Path: '128', Type: 0 }));
      queuedAppend = outcome(writer.append({ ItemId: childId, Path: '129', Type: 0 }));
      work.push(lastAppend, queuedAppend);
      await reach(input, lastAppend);
      if (operation === 'finish') {
        finished = finishingWork = outcome(writer.finish()); work.push(finished);
      }
      const first = outcome(writer.abort()), second = outcome(writer.abort());
      work.push(first, second);
      await assert.rejects(writer.append({ ItemId: childId, Type: 0 }), /closed/u);
      await assert.rejects(writer.finish(), /closed/u);
      await pending(first); await pending(second);
      await pending(lastAppend); await pending(queuedAppend); if (finished) await pending(finished);
      assert.equal(publicationObserved, false); assert.equal(dropCalls, 0);
      observations.push({ phase: 'input-held', admittedRows: Number(writer.count), dropCalls });
      resumeInput.resolve();
      assert.equal(Object.hasOwn(await lastAppend, 'error'), false); assert.equal(Object.hasOwn(await queuedAppend, 'error'), false);
      if (finished) {
        await reach(published, finished);
        const actualRows = Number((await database.client.query(`SELECT count(*) AS count FROM ${links.rows}`)).rows[0].count);
        assert.equal(actualRows, 129); assert.equal(dropCalls, 0);
        await pending(first); await pending(second); await pending(finished);
        observations.push({ phase: 'publication-held', actualRows, dropCalls });
        resumePublished.resolve();
      }
      await reach(dropping, first);
      await pending(first); await pending(second); if (finished) await pending(finished);
      assert.equal(dropCalls, 1);
      const actualTemporaries = Number((await database.client.query('SELECT count(*) AS count FROM pg_class WHERE relname=$1', [temporary.slice(1, -1)])).rows[0].count);
      assert.equal(actualTemporaries, drop.dependent ? 1 : 0);
      observations.push({ phase: 'drop-held', actualTemporaries, dropCalls });
      resumeDrop.resolve();
      const results = await Promise.all([first, second, ...(finished ? [finished] : [])]);
      if (drop.rejected) {
        if (drop.dependent) assert.equal(dropFailure.code, '2BP01'); else assert.equal(dropFailure, drop.reason);
        for (const result of results) { assert.ok(Object.hasOwn(result, 'error')); assert.equal(result.error, dropFailure); }
        await assert.rejects(writer.abort(), error => { assert.equal(error, dropFailure); return true; });
      } else {
        for (const result of results) assert.equal(Object.hasOwn(result, 'error'), false);
        if (finished) {
          recovered = results.at(-1).value;
          const rows = []; for await (const page of links.pages(recovered, { session })) rows.push(...page);
          assert.equal(rows.length, 129); assert.deepEqual(rows.map(row => row.Path), Array.from({ length: 129 }, (_, index) => String(index + 1)));
          await links.release(recovered, { session }); recovered = undefined;
        }
        await writer.abort();
      }
      assert.equal(dropCalls, 1);
    });
    await run;
    if (drop.rejected) assert.equal(Number((await database.client.query('SELECT count(*) AS count FROM pg_stat_activity WHERE pid=$1', [backendPid])).rows[0].count), 0);
    assert.equal(Number((await database.client.query('SELECT count(*) AS count FROM pg_class WHERE relname=$1', [temporary.slice(1, -1)])).rows[0].count), 0);
    await links.flushReleases();
    const counts = {};
    for (const [name, table] of [['sets', links.sets], ['rows', links.rows], ['pins', links.pins]]) counts[name] = Number((await database.client.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);
    assert.deepEqual(counts, { sets: 0, rows: 0, pins: 0 });
    await fs.writeFile(path.join(root, `${operation}-${drop.name}.json`), JSON.stringify({ operation, drop: drop.name,
      backendPid, dropCalls, observations, failure: drop.rejected ? errorObservation(dropFailure) : null, counts }, null, 2) + '\n');
  });
});
