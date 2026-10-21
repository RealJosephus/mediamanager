import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
import { quoteIdentifier as q } from '../../src/database/model.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { initializeLiveTvState } from '../../src/database/live-tv-state-import.js';
import { liveTvStateKey } from '../../src/library/live-tv-state.js';
import { LiveTvTimersService } from '../../src/library/live-tv-timers-service.js';
import { idKey, libraryError } from '../../src/library/records.js';
import { md5Guid, lowerInvariant } from '../../src/core/identity.js';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const sourceFile = new URL('./fixtures/live-tv-timers/input.json', import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
const identity = value => md5Guid(lowerInvariant('Emby' + value + '4'));
const wire = value => parseLosslessJson(stringifyNativeJson(value));

test('saved timer SQL, DTOs, complete series evaluation and defaults match actual native components', {
  skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL || !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 240000,
}, async () => {
  const sourceBytes = await readFile(sourceFile), input = JSON.parse(sourceBytes);
  const output = path.join(validationOutputRoot(), 'live-tv-timers-' + randomUUID());
  await mkdir(output);
  input.cases.push({ name: 'multiple-pages', timers: Array.from({ length: 131 }, (_, index) => ({ Id: 'batch-' + index,
    Name: 'Batch ' + index, StartDate: '2500-01-01T00:00:00.0000001Z', EndDate: '2500-01-01T00:00:00.0000002Z' })),
  seriesTimers: Array.from({ length: 131 }, (_, index) => ({ Id: 'series-' + index, Name: 'Series ' + index,
    ...(index === 130 && { Days: null }) })), requests: [
    { name: 'full timer result spans pages', operation: 'timers' },
    { name: 'target cannot skip a later page fault', operation: 'seriesTimer', id: '@series:series-0' },
  ] });
  const inputFile = path.join(output, 'input.json'), inputBytes = Buffer.from(JSON.stringify(input));
  await writeFile(inputFile, inputBytes, { flag: 'wx' });
  let database, store, failure;
  const comparisons = [], cleanup = {};
  try {
    const recording = await recordOracle({ project: 'tests/library/fixtures/live-tv-timers/Oracle.csproj',
      output: path.join(output, 'native'), args: [inputFile, '{output}/native.json'] });
    const nativeBytes = await readFile(path.join(output, 'native/native.json'));
    const native = parseLosslessJson(nativeBytes.toString());
    assert.equal(recording.passed, true);
    assert.equal(native.inputSha256, hash(inputBytes));
    assert.ok(native.actualLiveTvManager && native.actualTimerDtoService && native.actualItemDataProvider);
    assert.equal(native.recordingExecutorsStarted, false);
    assert.ok(native.programDtoAndImageQueryControlled && native.privateInputsRemoved);
    assert.equal(recording.outputs.find(entry => path.basename(entry.filename) === 'native.json').sha256, hash(nativeBytes));
    const channelId = md5Guid('MediaBrowser.Controller.LiveTv.LiveTvChannel' + lowerInvariant('EmbyA4'));
    const programId = md5Guid('MediaBrowser.Controller.LiveTv.LiveTvProgram' + lowerInvariant('EmbyP14'));
    assert.equal(native.bindings['channel-A'], channelId); assert.equal(native.bindings['program-P1'], programId);
    database = await createPostgresTestDatabase(null, 'live_tv_timer_dto');
    store = new DomainStore(database);
    await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: channelId, Name: 'Controlled channel',
      Type: 'MediaBrowser.Controller.LiveTv.LiveTvChannel', ExternalId: 'A' }));
    await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: programId, Name: 'Controlled program',
      Type: 'MediaBrowser.Controller.LiveTv.LiveTvProgram', ExternalId: 'P1', ChannelId: channelId }));
    for (const sample of input.cases) {
      const expected = native.results.find(result => result.name === sample.name);
      const dataPath = path.join(output, 'node-inputs', sample.name), directory = path.join(dataPath, 'livetv');
      await mkdir(directory, { recursive: true });
      for (const [filename, value] of [['timers.json', sample.timers], ['seriestimers.json', sample.seriesTimers]]) {
        await writeFile(path.join(directory, filename), JSON.stringify(value), { flag: 'wx' });
      }
      await database.client.query(`DELETE FROM ${q(database.controlSchema)}.state WHERE key = $1`, [liveTvStateKey]);
      await store.transaction(db => initializeLiveTvState(db, { dataPath }));
      const baseline = await database.getState(liveTvStateKey);
      const service = new LiveTvTimersService({ store, serverId: 'timer-component-server',
        loadProgramDtos: async (_db, ids) => new Map(ids.filter(id => idKey(id) === programId)
          .map(id => [idKey(id), structuredClone(expected.programDtoInput)])),
        liveTv: { getConfiguration: async () => ({ PrePaddingSeconds: -3, PostPaddingSeconds: 12 }) },
        loadProgram: async id => {
          if (id !== programId) throw libraryError(500, 'Unknown controlled program.');
          return { item: { Name: 'Controlled program', ExternalId: 'P1', IsRepeat: false,
            StartDate: '2500-01-01T01:02:03.0000000Z', EndDate: '2500-01-01T02:02:03.0000000Z', Overview: 'Program overview' },
          dto: structuredClone(expected.programDtoInput), channel: { Id: channelId, Name: 'Controlled channel' } };
        },
      });
      const resolve = value => value?.startsWith('@timer:') ? identity(value.slice(7))
        : value?.startsWith('@series:') ? identity(value.slice(8))
          : value === '@channel:A' ? channelId : value === '@program:P1' ? programId : value;
      for (const request of sample.requests) {
        let value, error;
        try {
          const query = Object.fromEntries(Object.entries(request.query ?? {}).map(([key, value]) =>
            [key[0].toLowerCase() + key.slice(1), typeof value === 'string' ? resolve(value) : value]));
          if (request.operation === 'timers') value = await service.getTimers(query);
          else if (request.operation === 'timer') value = await service.getTimer(resolve(request.id));
          else if (request.operation === 'series') value = await service.getSeriesTimers(query);
          else if (request.operation === 'seriesTimer') value = await service.getSeriesTimer(resolve(request.id));
          else if (request.operation === 'defaults') value = await service.getNewTimerDefaults(resolve(request.id));
          else assert.fail('Unknown component request.');
        } catch (caught) { error = caught; }
        const target = expected.observations.find(result => result.name === request.name);
        comparisons.push({ sample: sample.name, name: request.name, error: error?.message, targetError: target.error,
          ...(value !== undefined && { value: wire(value) }) });
        if (target.error) assert.equal(error?.status ?? error?.statusCode, 500, sample.name + ': ' + request.name);
        else {
          assert.equal(error, undefined, error?.stack);
          assert.deepEqual(wire(value), target.value ?? null, sample.name + ': ' + request.name);
        }
        assert.equal(await database.getState(liveTvStateKey), baseline);
      }
      // File changes after the one-time import cannot become query authority.
      await writeFile(path.join(directory, 'timers.json'), '[]');
      assert.equal(await store.transaction(db => initializeLiveTvState(db, { dataPath })), false);
      assert.equal(await database.getState(liveTvStateKey), baseline);
    }
  } catch (error) { failure = error; }
  finally {
    const errors = [];
    try { await store?.close(); cleanup.storeClosed = true; } catch (error) { errors.push(error); }
    try { await dropPostgresTestDatabase(database); cleanup.postgresRemoved = true; } catch (error) { errors.push(error); }
    cleanup.errors = errors.map(error => error.message);
    await writeFile(path.join(output, 'comparison.json'), JSON.stringify({ passed: !failure && !errors.length,
      phaseAcceptance: false, releaseAcceptance: false, sourceSha256: hash(sourceBytes), comparisons, cleanup,
      error: failure?.stack }, (_key, value) => typeof value === 'bigint' ? JSON.rawJSON(String(value)) : value, 2) + '\n');
    if (!failure && errors.length) failure = new AggregateError(errors, 'Timer component cleanup failed.');
  }
  if (failure) throw failure;
});
