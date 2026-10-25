import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { dependencyOrder } from '../../src/database/model.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { recordUserDataBinding, normalizeUserDataBinding } from '../sessions/user-data-binding-scenario.js';
import { runtimeDateFixture } from '../sessions/runtime-date-fixture.js';

test('UserData HTTP native comparison retains standard-runtime date differences on PostgreSQL', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async () => {
  const dateDifferences = runtimeDateFixture();
  const fixtures = new URL('../sessions/fixtures/user-data-binding/', import.meta.url);
  const seed = JSON.parse(await readFile(new URL('seed.json', fixtures), 'utf8'), (_key, value) => value?.$integer ? BigInt(value.$integer) : value);
  const schema = `ud_${randomUUID().replaceAll('-', '')}`;
  let runtime, database;
  const errors = [];
  try {
    database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
    await database.transaction(async db => {
      await db.client.query('SET CONSTRAINTS ALL DEFERRED');
      for (const table of dependencyOrder()) for (const row of seed[table.name] ?? []) await db.insert(table.name, row);
    });
    runtime = await createTestRuntime({ database, configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true }, serverId: 'user-data-binding-test', onError: error => errors.push({ status: error.status, message: error.message }) });

    const actual = await recordUserDataBinding(`http://127.0.0.1:${runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port}`);
    const expected = parseLosslessJson(await readFile(new URL('http-reference.json', fixtures), 'utf8'));
    const normalizedExpected = normalizeUserDataBinding(expected), normalizedActual = normalizeUserDataBinding(actual);
    const differences = [];
    for (let index = 0; index < normalizedExpected.length; index++) {
      try { assert.deepEqual(normalizedActual[index], normalizedExpected[index]); }
      catch { differences.push({ name: normalizedExpected[index].name, expected: normalizedExpected[index], actual: normalizedActual[index] }); }
    }
    const finalRows = await runtime.store.run(db => db.rows('UserData'));
    if (process.env.MEDIAMANAGER_USER_DATA_EVIDENCE) await writeFile(`${process.env.MEDIAMANAGER_USER_DATA_EVIDENCE}/postgres.json`, JSON.stringify({ compatible: differences.length === 0, actual, differences, errors, finalRows }, (_key, value) => typeof value === 'bigint' ? JSON.rawJSON(value.toString()) : value, 2), { flag: 'wx' });
    assert.equal(actual.records.length, expected.records.length);
    const reviewed = Object.entries(dateDifferences.userDataDto).filter(([, entry]) => entry.reference.LastPlayedDate.utcTicks !== entry.candidate.LastPlayedDate.utcTicks);
    assert.deepEqual(differences.map(entry => entry.name), reviewed.map(([name]) => name));
    for (const [name, entry] of reviewed) {
      const difference = differences.find(value => value.name === name);
      const expected = structuredClone(difference.expected);
      for (const response of [expected.response, expected.state]) {
        assert.equal(response.body.LastPlayedDate, entry.reference.LastPlayedDate.stored.replace(' ', 'T') + '.0000000Z');
        response.body.LastPlayedDate = entry.candidate.LastPlayedDate.stored.replace(' ', 'T') + '.0000000Z';
      }
      assert.deepEqual(difference.actual, expected, `${name}: only the documented date difference is allowed`);
    }
  } finally {
    if (database) {
      await database.client.query(`DROP SCHEMA "${schema}" CASCADE`);
      await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    }
    if (runtime) await runtime.close(); else await database?.close();
  }
});
