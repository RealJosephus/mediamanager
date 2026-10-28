import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { LiveTvService } from '../../src/library/live-tv-service.js';
import { liveTvConfigurationReader } from '../../src/core/live-tv-configuration-store.js';
import { LiveTvTimersService } from '../../src/library/live-tv-timers-service.js';
import { tableDefinition } from '../../src/database/model.js';
import { encodeValue } from '../../src/database/values.js';
import { fixtureRow } from '../database/fixtures.js';

const failureFields = error => ({ message: error?.message, code: error?.code ?? null,
  status: error?.status ?? error?.statusCode ?? null });

const programId = 'a3000000000000000000000000000001';
const channelId = 'a3000000000000000000000000000002';
const source = () => ({ item: { Name: 'Held program', ExternalId: 'held-program', IsRepeat: true,
  StartDate: '2500-01-01T00:00:00.0000001Z', EndDate: '2500-01-01T01:00:00.0000002Z', Overview: 'Held overview' },
dto: { Id: programId, ChannelId: channelId, ChannelName: 'Controlled channel' }, channel: { Id: channelId } });

function emptyImageStore() {
  const queries = [];
  const database = { dialect: 'postgres', schemaName: 'timer_lifecycle', controlSchema: 'timer_control',
    client: { async query(plan) {
      queries.push(plan);
      assert.ok(plan.text.includes('WHERE selected."Id" IS NOT NULL'),
        'Empty image selectors must exclude the repository metadata sentinel in SQL.');
      return { rows: [] };
    } } };
  return { queries, run: operation => operation(database) };
}

test('timer defaults admitted before configuration close finish after held program SQL', { timeout: 10000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const liveTv = new LiveTvService(), store = emptyImageStore();
  const service = new LiveTvTimersService({ store, liveTv, serverId: 'timer-lifecycle', loadProgramDtos: async () => new Map(),
    loadProgram: async () => { entered.resolve(); await release.promise; return source(); } });
  const outcome = Promise.allSettled([service.getNewTimerDefaults(programId)]);
  t.after(async () => { release.resolve(); await outcome; await liveTv.close(); });
  try {
    await entered.promise;
    await liveTv.close();
    await assert.rejects(liveTv.getConfiguration(), { status: 503 });
    assert.equal(store.queries.length, 0, 'Image reads must still wait for the program result.');
  } finally { release.resolve(); }
  try {
    const [result] = await outcome;
    assert.equal(result.status, 'fulfilled', result.reason?.stack);
    const defaults = liveTvConfigurationReader.defaultConfiguration('livetv');
    assert.equal(result.value.Name, 'Held program');
    assert.equal(result.value.ProgramId, programId);
    assert.equal(result.value.ChannelId, channelId);
    assert.equal(result.value.PrePaddingSeconds, Math.max(defaults.PrePaddingSeconds, 0));
    assert.equal(result.value.RecordNewOnly, false);
    assert.equal(result.value.SkipEpisodesInLibrary, false);
    await assert.rejects(service.getNewTimerDefaults(), { status: 503 });
  } finally { await liveTv.close(); }
});

for (const synchronous of [false, true]) for (const programFails of [false, true]) test(
  `timer defaults preserve program-before-configuration errors with ${synchronous ? 'synchronous' : 'asynchronous'} configuration failure and ${programFails ? 'failed' : 'successful'} program`,
  { timeout: 10000 }, async () => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const configurationFailure = new Error('Controlled configuration failure.');
    const programFailure = new Error('Controlled program failure.');
    let programReads = 0;
    const store = emptyImageStore();
    const service = new LiveTvTimersService({ store, serverId: 'timer-lifecycle', loadProgramDtos: async () => new Map(),
      liveTv: { getConfiguration() {
        if (synchronous) throw configurationFailure;
        return Promise.reject(configurationFailure);
      } },
      loadProgram: async () => {
        programReads++; entered.resolve(); await release.promise;
        if (programFails) throw programFailure;
        return source();
      } });
    const outcome = Promise.allSettled([service.getNewTimerDefaults(programId)]);
    try {
      await entered.promise;
      // Let a fast configuration rejection reach the event loop while program
      // SQL is held. node:test also detects any unhandled rejection here.
      await setImmediate();
      assert.equal(programReads, 1, 'The program operation must still execute before a configuration error is returned.');
      assert.equal(store.queries.length, 0);
    } finally { release.resolve(); }
    const [result] = await outcome;
    assert.equal(result.status, 'rejected');
    assert.deepEqual(failureFields(result.reason), failureFields(programFails ? programFailure : configurationFailure));
    assert.equal(store.queries.length, 0);
  });

test('a Series primary image avoids querying or hydrating an unused program fallback', async () => {
  const seriesId = 'a3000000000000000000000000000003', queries = [];
  const columns = tableDefinition('BaseItems').columns;
  const series = { ...fixtureRow(tableDefinition('BaseItems')), Id: seriesId,
    Type: 'MediaBrowser.Controller.Entities.TV.Series', Data: '{}', Name: 'Controlled series' };
  const database = { dialect: 'postgres', schemaName: 'timer_lifecycle', controlSchema: 'timer_control',
    client: { async query(plan) {
      queries.push(plan);
      assert.ok(!plan.text.includes("'programPrimary'::text AS slot"), 'Native must not evaluate the program fallback after a Series primary winner.');
      if (plan.text.includes("'seriesPrimary'::text AS slot")) {
        assert.ok(plan.text.includes('WHERE selected."Id" IS NOT NULL'));
        return { rows: [{ request: 0, slot: 'seriesPrimary', Id: Buffer.from(seriesId) }] };
      }
      if (plan.text.includes('FROM "timer_lifecycle"."BaseItems"')) {
        assert.deepEqual(plan.values, [[seriesId]], 'Only the selected Series image owner is hydrated.');
        return { rows: [Object.fromEntries(columns.map(column => [column.name,
          encodeValue(column, series[column.name], 'postgres')]))] };
      }
      assert.ok(plan.text.includes('BaseItemImageInfos'), 'Only selected image relations may be loaded.');
      return { rows: [] };
    } } };
  const service = new LiveTvTimersService({ store: { run: operation => operation(database) },
    serverId: 'timer-lifecycle', loadProgramDtos: async () => new Map(),
    liveTv: { getConfiguration: async () => ({ PrePaddingSeconds: 0, PostPaddingSeconds: 0 }) } });
  const value = await service.getNewTimerDefaults();
  assert.equal(value.Type, 'SeriesTimer');
  assert.equal(queries.filter(plan => plan.text.includes('AS request')).length, 1);
});
