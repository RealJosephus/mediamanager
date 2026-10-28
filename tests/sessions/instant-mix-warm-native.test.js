import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import pg from 'pg';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';
import { tableDefinition } from '../../src/database/model.js';
import { cleanValue, idKey } from '../../src/library/records.js';
import { nativeMusicGenreIdentity } from '../../src/library/identity.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { compileOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { errorObservation } from '../helpers/error-observation.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { seedPostgresRuntime } from './postgres-seed.js';
import { samples, sourceId, rockId, jazzId, requestedIds } from './fixtures/instant-mix-warm-current/input.js';

export const requiredValidationServices = ['postgres', 'dotnet', 'jellyfinDll', 'nativeInstance'];
const enabled = process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_JELLYFIN_DLL
  && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE;
const hash = value => createHash('sha256').update(value).digest('hex');
const command = message => {
  assert.equal(message.MessageType, 'Play');
  assert.match(message.MessageId, /^[0-9a-f]{32}$/u);
  return { MessageType: message.MessageType, Data: { ...message.Data,
    ItemIds: message.Data.ItemIds.toSorted(), ControllingUserId: idKey(message.Data.ControllingUserId) } };
};
const persistentRows = rows => rows.map(value => Object.fromEntries(['Id', 'Type', 'Name', 'Genres', 'CleanName', 'Path']
  .map(key => [key, key === 'Id' ? idKey(value[key]) : value[key]]))).toSorted((left, right) => left.Id.localeCompare(right.Id));
const nativeProjection = observation => ({ name: observation.name, status: observation.status,
  errorResponse: observation.errorResponse, genreId: idKey(observation.genreId),
  initialRows: observation.initialRows, sourceAfterMutation: observation.sourceAfterMutation,
  genreCalls: observation.genreCalls, added: observation.added.map(idKey),
  messages: observation.messages.map(command), rows: persistentRows(observation.rows),
  genreDirectoryExists: observation.genreDirectoryExists, controllerDisposed: observation.controllerDisposed });

test('remote InstantMix preserves Native warm sources, sequential creation and failed delivery prefixes', {
  skip: !enabled, timeout: 300000,
}, async t => {
  const output = path.join(validationOutputRoot(), 'instant-mix-warm-' + randomUUID());
  await mkdir(output, { recursive: true });
  const inputFile = path.join(output, 'input.json');
  const bytes = Buffer.from(JSON.stringify({ sourceId, rockId, jazzId, samples }, null, 2) + '\n');
  await writeFile(inputFile, bytes, { flag: 'wx' });
  const report = { phaseAcceptance: false, releaseAcceptance: false, observations: [],
    scope: 'Same-run Native SessionManager/MusicManager/LibraryManager/EF SQLite and genre directory creation, compared with formal Node PG/HTTP/WebSocket commands, source rows and Added prefixes. Native transport is a controlled session sink; authentication, complete DTO projection and full instance exchange are outside this slice.' };
  let current, primary, failed = false;
  try {
    current = await currentNativeReference(); report.preparation = current.preparation;
    report.sourceBindings = await current.sourceBindings(['Emby.Server.Implementations/Session/SessionManager.cs',
      'Emby.Server.Implementations/Library/MusicManager.cs', 'Emby.Server.Implementations/Library/LibraryManager.cs',
      'Jellyfin.Server.Implementations/Item/BaseItemRepository.cs', 'Jellyfin.Server.Implementations/Item/BaseItemRepository.Querying.cs',
      'Jellyfin.Server.Implementations/Item/BaseItemRepository.QueryBuilding.cs', 'Jellyfin.Server.Implementations/Item/ItemPersistenceService.cs',
      'MediaBrowser.Controller/Entities/Audio/MusicGenre.cs', 'MediaBrowser.Model/Session/PlayRequest.cs', 'Jellyfin.Api/Middleware/ExceptionMiddleware.cs']);
    const oracle = await compileOracle({ project: 'tests/sessions/fixtures/instant-mix-warm-current/Oracle.csproj', output: path.join(output, 'build') });
    const captures = [];
    for (const label of ['native', 'native-repeat']) {
      const root = path.join(output, label);
      const receipt = await oracle.record({ output: root, args: [inputFile, '{output}/instances', '{output}/native.json'] });
      const nativeBytes = await readFile(path.join(root, 'native.json'));
      const native = parseLosslessJson(nativeBytes.toString('utf8'));
      assert.equal(receipt.passed, true); assert.equal(native.inputSha256, hash(bytes));
      assert.equal(receipt.outputs.find(value => path.basename(value.filename) === 'native.json').sha256, hash(nativeBytes));
      for (const flag of ['actualSessionManager', 'actualMusicManager', 'actualLibraryManager', 'actualSqliteRepository', 'actualGenreCreation', 'actualExceptionMiddleware'])
        assert.equal(native[flag], true, flag);
      for (const assembly of native.assemblies) assert.equal(hash(await readFile(assembly.filename)), assembly.sha256);
      assert.equal(native.nativeLibraries.length, 1);
      for (const library of native.nativeLibraries) {
        const supplied = path.join(current.runtimeRoot, 'runtimes', library.runtimeIdentifier, 'native', path.basename(library.filename));
        assert.equal(hash(await readFile(library.filename)), library.sha256);
        assert.equal(hash(await readFile(supplied)), library.sha256, 'The actual SQLite loader must use the supplied current-platform library.');
      }
      assert.equal(native.observations.length, samples.length);
      captures.push(native);
      report[label] = { receipt, sha256: hash(nativeBytes) };
    }
    const [native, repeat] = captures;
    assert.deepEqual(repeat.observations.map(nativeProjection), native.observations.map(nativeProjection));
    for (const [index, sample] of samples.entries()) await t.test(sample.name, async () => {
      const expected = native.observations[index];
      assert.equal(expected.name, sample.name); assert.equal(expected.status, sample.expectedStatus ?? 204);
      assert.equal(expected.controllerDisposed, true);
      const root = path.join(output, 'node-' + String(index).padStart(2, '0'));
      await mkdir(root);
      const database = await createPostgresTestDatabase(null, 'mix_warm');
      const schema = database.schemaName, controlSchema = database.controlSchema;
      let runtime, socket, closePromise;
      const errors = [], genreCalls = [], added = [], received = [];
      const actual = { name: sample.name, schema, controlSchema }; report.observations.push(actual);
      const close = () => closePromise ??= (async () => {
        socket?.terminate();
        if (runtime) await runtime.close();
        else await database.close();
        actual.databaseClosed = database.closed;
        await dropPostgresTestDatabase(database);
        const audit = new pg.Client({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES });
        try {
          await audit.connect();
          const remaining = (await audit.query('SELECT schema_name FROM information_schema.schemata WHERE schema_name = ANY($1)', [[schema, controlSchema]])).rows;
          assert.deepEqual(remaining, []); actual.ownedSchemasRemoved = true;
        } finally { await audit.end(); }
      })();
      try {
        runtime = await createTestRuntime({ database, serverId: 'instant-mix-warm',
          programDataPath: path.join(root, 'instance'), configurationDirectoryPath: path.join(root, 'config'),
          configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true, CacheSize: 64,
            EnableNormalizedItemByNameIds: true, EnableGroupingMoviesIntoCollections: false, EnableGroupingShowsIntoCollections: false },
          onError: error => errors.push(errorObservation(error)) });
        actual.bootstrapRows = await runtime.store.run(db => db.rows('BaseItems'));
        const bootstrapIds = new Set(actual.bootstrapRows.map(value => idKey(value.Id)));
        assert.ok(expected.initialRows.every(value => !bootstrapIds.has(idKey(value.Id))),
          'The frozen Native source identities must be separate from the explicit Node bootstrap identities.');
        await seedPostgresRuntime(database, { BaseItems: expected.initialRows });
        const valueIds = { Rock: 'a7b10000-0000-0000-0000-000000000021', Jazz: 'a7b10000-0000-0000-0000-000000000022' };
        for (const [genre, ItemValueId] of Object.entries(valueIds)) await database.insert('ItemValues', {
          ItemValueId, Type: 2, Value: genre, CleanValue: cleanValue(genre),
        });
        for (const [ItemId, genre] of [[sourceId, 'Rock'], [rockId, 'Rock'], [jazzId, 'Jazz']])
          await database.insert('ItemValuesMap', { ItemId, ItemValueId: valueIds[genre] });
        if (sample.warm) await runtime.itemCreation.getItemById(sourceId);
        if (sample.mutation === 'delete') await database.delete('BaseItems', { Id: sourceId });
        else if (sample.mutation) {
          await database.update('BaseItems', { Id: sourceId }, expected.sourceAfterMutation);
          for (const relation of await database.rows('ItemValuesMap', { where: { ItemId: sourceId } }))
            await database.delete('ItemValuesMap', Object.fromEntries(tableDefinition('ItemValuesMap').primaryKey.map(key => [key, relation[key]])));
          await database.insert('ItemValuesMap', { ItemId: sourceId, ItemValueId: valueIds.Jazz });
        }
        const identity = nativeMusicGenreIdentity('Rock', runtime.library.options);
        assert.equal(idKey(identity.Id), idKey(expected.genreId));
        const getMusicGenre = runtime.library.getMusicGenre.bind(runtime.library);
        runtime.library.getMusicGenre = name => { genreCalls.push(name); return getMusicGenre(name); };
        runtime.library.on('ItemAdded', event => added.push(event.Item.Id));
        const key = await runtime.apiKeys.create('InstantMixWarm');
        const target = await runtime.sessions.logActivity({ Client: 'InstantMixWarm', DeviceId: 'target', Device: 'Fixture', Version: '1', IsApiKey: true });
        await runtime.sessions.reportCapabilities(target.Id, { SupportsMediaControl: true, PlayableMediaTypes: ['Audio'] });
        const origin = 'http://127.0.0.1:' + runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port;
        const authorization = device => `MediaBrowser Client="InstantMixWarm", Device="Fixture", DeviceId="${device}", Version="1", Token="${key.AccessToken}"`;
        socket = new WebSocket(origin.replace('http', 'ws') + '/socket', { headers: { Authorization: authorization('target') } });
        socket.on('message', wire => received.push(parseLosslessJson(wire.toString())));
        await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
        const next = async type => {
          for (let attempt = 0; attempt < 200; attempt++) {
            const found = received.findIndex(value => value.MessageType === type);
            if (found >= 0) return received.splice(found, 1)[0];
            await delay(10, undefined, { signal: t.signal });
          }
          throw new Error(`Missing ${type} from the real InstantMix socket.`);
        };
        await next('ForceKeepAlive'); socket.send('{"MessageType":"KeepAlive"}'); await next('KeepAlive');
        const request = async ids => {
          const query = new URLSearchParams({ playCommand: 'PlayInstantMix', itemIds: ids.join(','), startPositionTicks: '9007199254740993',
            mediaSourceId: 'opaque-source', audioStreamIndex: '2', subtitleStreamIndex: '-1', startIndex: '0' });
          const response = await fetch(`${origin}/Sessions/${target.Id}/Playing?${query}`, {
            method: 'POST', headers: { Authorization: authorization('controller') },
            signal: AbortSignal.any([t.signal, AbortSignal.timeout(15000)]),
          });
          return { status: response.status, contentType: response.headers.get('content-type'), body: await response.text() };
        };
        actual.requestedIds = requestedIds(sample, identity.Id);
        Object.assign(actual, await request(actual.requestedIds));
        assert.equal(actual.status, expected.status);
        actual.messages = [];
        if (actual.status === 204) {
          const message = await next('Play'); actual.messages.push(message);
          assert.deepEqual(command(message), command(expected.messages[0]));
          if (sample.sourceFirst) assert.equal(message.Data.ItemIds[0], idKey(sourceId));
        } else {
          await delay(25, undefined, { signal: t.signal });
          assert.ok(!received.some(value => value.MessageType === 'Play'));
          assert.equal(expected.messages.length, 0);
          assert.deepEqual({ status: actual.status, contentType: actual.contentType, body: actual.body }, expected.errorResponse);
        }
        actual.genreCalls = [...genreCalls]; actual.added = [...added]; actual.errors = [...errors];
        assert.deepEqual(actual.genreCalls, expected.genreCalls);
        assert.deepEqual(actual.added.map(idKey), expected.added.map(idKey));
        actual.completeRows = await runtime.store.run(db => db.rows('BaseItems'));
        actual.bootstrapAfter = actual.completeRows.filter(value => bootstrapIds.has(idKey(value.Id)));
        const order = rows => rows.toSorted((left, right) => idKey(left.Id).localeCompare(idKey(right.Id)));
        assert.deepEqual(order(actual.bootstrapAfter), order(actual.bootstrapRows), 'The explicit Node bootstrap rows must remain unchanged.');
        actual.rows = actual.completeRows.filter(value => !bootstrapIds.has(idKey(value.Id)));
        assert.deepEqual(persistentRows(actual.rows), persistentRows(expected.rows));
        actual.genreDirectoryExists = await stat(identity.Path).then(value => value.isDirectory(), error => {
          if (error.code === 'ENOENT') return false; throw error;
        });
        assert.equal(actual.genreDirectoryExists, expected.genreDirectoryExists);
        if (actual.status !== 204) {
          assert.equal((await request([sourceId])).status, 204);
          actual.recovery = await next('Play');
          assert.deepEqual(actual.recovery.Data.ItemIds, [idKey(rockId)]);
        }
      } finally { await close(); }
      assert.equal(actual.databaseClosed, true);
      assert.equal(actual.ownedSchemasRemoved, true);
    });
  } catch (error) { primary = error; failed = true; report.failure = errorObservation(error); }
  finally {
    const failures = [];
    try { if (current) { await current.finish(); report.immutableInputsVerified = true; } }
    catch (error) { failures.push(error); report.inputVerificationFailure = errorObservation(error); }
    try { await writeFile(path.join(output, 'comparison.json'), stringifyNativeJson(report) + '\n'); }
    catch (error) { failures.push(error); }
    if (failures.length) {
      const reasons = [...(failed ? [primary] : []), ...failures];
      if (reasons.length === 1) throw reasons[0];
      throw new AggregateError(reasons, 'InstantMix comparison and immutable input verification failed.', { cause: reasons[0] });
    }
  }
  if (failed) throw primary;
});
