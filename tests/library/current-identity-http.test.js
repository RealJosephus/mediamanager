import test from 'node:test';
import assert from 'node:assert/strict';
import { declareNativeHttpTestFile } from '../helpers/native-http-test-file.js';
import { currentIdentityScenario, compareCurrentIdentity } from '../helpers/current-identity-scenario.js';

const nativeCallback = declareNativeHttpTestFile({ enabled: Boolean(process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE), port: 19501 });

for (const kind of ['artist', 'studio']) {
  test(`postgres: current native ${kind} concurrent lookup and stable repeat`, {
    skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || !process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE, timeout: 300000,
  }, nativeCallback(async (t, port) => {
    const scenario = await currentIdentityScenario(kind, 'concurrency', { port, signal: t.signal });
    assert.equal(scenario.http.records.length, 9);
    await compareCurrentIdentity(scenario);
  }));

  test(`postgres: current native ${kind} Unicode identities and SortNames`, {
    skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || !process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE, timeout: 300000,
  }, nativeCallback(async (t, port) => {
    const scenario = await currentIdentityScenario(kind, 'unicode', { port, signal: t.signal });
    assert.equal(scenario.http.records.length, 4);
    const byName = new Map(scenario.summary.createdRows.map(row => [row.Name, row.SortName]));
    assert.equal(byName.get('東京'), 'dong jing');
    assert.equal(byName.get('ｶﾞ'), 'ga');
    await compareCurrentIdentity(scenario);
  }));

  test(`postgres: current native ${kind} colliding paths preserve a legal winner in five request schedules`, {
    skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || !process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE, timeout: 900000,
  }, nativeCallback(async (t, port) => {
    const controls = [];
    for (const mode of ['control-first', 'control-second']) controls.push(await currentIdentityScenario(kind, mode, { port, signal: t.signal }));
    assert.deepEqual(controls.map(control => control.summary.createdRows[0].Name), ['Mirror/A', 'Mirror:A']);
    assert.equal(controls[0].summary.createdRows[0].Id, controls[1].summary.createdRows[0].Id);
    for (const mode of ['race', 'race-repeat', 'race-reverse', 'race-eight', 'race-eight-reverse']) {
      const scenario = await currentIdentityScenario(kind, mode, { port, signal: t.signal });
      assert.equal(scenario.http.records.length, mode.includes('eight') ? 10 : 4);
      await compareCurrentIdentity(scenario, controls);
    }
  }));
}
